export const DEFAULT_MODEL = "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B:featherless-ai";
export const DEFAULT_SESSION_TOKEN_LIMIT = 2000;
export const DEFAULT_TURN_TOKEN_LIMIT = 768;
export const DEFAULT_SESSION_TTL_SECONDS = 3 * 60 * 60;

export const MODEL_INSTRUCTION = [
  "Trả lời bằng tiếng Việt, ngắn gọn và tập trung vào yêu cầu.",
  "Trình bày kết luận rõ ràng. Không lặp lại đề bài và không kéo dài phần suy luận không cần thiết.",
  "Bạn đang hỗ trợ thí sinh trong một phiên có tổng ngân sách đầu ra 2.000 token, kể cả token suy luận.",
].join(" ");

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function positiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function allowedOrigins(raw) {
  return new Set(String(raw || "").split(",").map((item) => item.trim()).filter(Boolean));
}

export function isOriginAllowed(origin, rawAllowedOrigins) {
  if (!origin) return true;
  return allowedOrigins(rawAllowedOrigins).has(origin);
}

export function corsHeaders(origin, rawAllowedOrigins) {
  if (!origin || !isOriginAllowed(origin, rawAllowedOrigins)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function normalizeMessages(input, {
  maxMessages = 9,
  maxMessageCharacters = 4000,
  maxTotalCharacters = 12000,
} = {}) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new HttpError(400, "Cuộc hội thoại phải có ít nhất một câu hỏi.");
  }
  if (input.length > maxMessages) {
    throw new HttpError(400, `Chỉ gửi tối đa ${maxMessages} tin nhắn gần nhất.`);
  }

  let total = 0;
  const messages = input.map((message) => {
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      throw new HttpError(400, "Vai trò tin nhắn không hợp lệ.");
    }
    if (typeof message.content !== "string") {
      throw new HttpError(400, "Nội dung tin nhắn phải là văn bản.");
    }
    const content = message.content.trim();
    if (!content) throw new HttpError(400, "Tin nhắn không được để trống.");
    if (content.length > maxMessageCharacters) {
      throw new HttpError(400, `Mỗi tin nhắn tối đa ${maxMessageCharacters.toLocaleString("vi-VN")} ký tự.`);
    }
    total += content.length;
    return { role: message.role, content };
  });

  if (total > maxTotalCharacters) {
    throw new HttpError(400, "Ngữ cảnh hội thoại quá dài. Hãy bắt đầu câu hỏi mới ngắn gọn hơn.");
  }
  if (messages[messages.length - 1].role !== "user") {
    throw new HttpError(400, "Tin nhắn cuối cùng phải là câu hỏi của người dùng.");
  }

  const last = messages.length - 1;
  messages[last] = {
    role: "user",
    content: `${MODEL_INSTRUCTION}\n\nCâu hỏi:\n${messages[last].content}`,
  };
  return messages;
}

export function providerRequest(messages, { model = DEFAULT_MODEL, maxTokens }) {
  return {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.6,
    top_p: 0.95,
    stream: true,
    stream_options: { include_usage: true },
  };
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signingKey(secret, usages) {
  if (!secret || String(secret).length < 24) {
    throw new Error("SESSION_SIGNING_KEY phải có ít nhất 24 ký tự.");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

export async function signSessionToken(sessionId, expiresAtEpochSeconds, secret) {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ sid: sessionId, exp: expiresAtEpochSeconds })));
  const key = await signingKey(secret, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `${payload}.${bytesToBase64Url(signature)}`;
}

export async function verifySessionToken(token, secret, nowEpochSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof token !== "string" || !token.includes(".")) throw new HttpError(401, "Phiên chat không hợp lệ.");
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) throw new HttpError(401, "Phiên chat không hợp lệ.");
  let parsed;
  try {
    const key = await signingKey(secret, ["verify"]);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(signature),
      new TextEncoder().encode(payload),
    );
    if (!valid) throw new Error("invalid signature");
    parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "Phiên chat không hợp lệ.");
  }
  if (!parsed || typeof parsed.sid !== "string" || !Number.isInteger(parsed.exp)) {
    throw new HttpError(401, "Phiên chat không hợp lệ.");
  }
  if (parsed.exp <= nowEpochSeconds) throw new HttpError(401, "Phiên chat đã hết hạn.");
  return parsed;
}

export async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value))));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createUsageCollector() {
  let buffer = "";
  let completionTokens = null;
  let sawContent = false;

  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const chunk = JSON.parse(data);
      const usage = Number(chunk?.usage?.completion_tokens);
      if (Number.isInteger(usage) && usage >= 0) completionTokens = usage;
      if (chunk?.choices?.some((choice) => {
        const delta = choice?.delta || {};
        return [delta.content, delta.reasoning_content, delta.reasoning]
          .some((value) => typeof value === "string" && value.length > 0);
      })) {
        sawContent = true;
      }
    } catch (error) {
      // Ignore malformed provider events here. The client still receives the original stream.
    }
  };

  return {
    push(text) {
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      lines.forEach(processLine);
    },
    finish() {
      if (buffer) processLine(buffer);
      return { completionTokens, sawContent };
    },
  };
}

export async function inspectProviderStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const collector = createUsageCollector();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      collector.push(decoder.decode(value, { stream: true }));
    }
    collector.push(decoder.decode());
    return collector.finish();
  } finally {
    reader.releaseLock();
  }
}

export function sessionView(row) {
  const tokenLimit = Number(row.token_limit);
  const usedTokens = Number(row.used_tokens);
  const reservedTokens = Number(row.reserved_tokens || 0);
  return {
    tokenLimit,
    usedTokens,
    reservedTokens,
    remainingTokens: Math.max(0, tokenLimit - usedTokens - reservedTokens),
    inFlight: Boolean(row.in_flight),
    expiresAt: row.expires_at,
  };
}
