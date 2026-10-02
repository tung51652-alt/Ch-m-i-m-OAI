import {
  DEFAULT_MODEL,
  DEFAULT_SESSION_TOKEN_LIMIT,
  DEFAULT_SESSION_TTL_SECONDS,
  DEFAULT_TURN_TOKEN_LIMIT,
  HttpError,
  corsHeaders,
  createUsageCollector,
  isOriginAllowed,
  normalizeMessages,
  positiveInteger,
  providerRequest,
  sessionView,
  sha256Hex,
  signSessionToken,
  verifySessionToken,
} from "./core.mjs";

const OPENROUTER_CHAT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const TICKET_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SESSION_COLUMNS = "id, ticket_id, token_limit, used_tokens, reserved_tokens, in_flight, in_flight_at, expires_at";

function responseJson(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function withHeaders(response, extraHeaders) {
  const headers = new Headers(response.headers);
  Object.entries(extraHeaders).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function requireDatabase(env) {
  if (!env.CHAT_DB) throw new Error("Thiếu D1 binding CHAT_DB.");
  return env.CHAT_DB;
}

function bearerToken(request) {
  const match = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new HttpError(401, "Thiếu thông tin phiên chat.");
  return match[1];
}

async function readJson(request, maxCharacters = 50000) {
  const raw = await request.text();
  if (raw.length > maxCharacters) throw new HttpError(413, "Dữ liệu gửi lên quá lớn.");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    throw new HttpError(400, "Dữ liệu JSON không hợp lệ.");
  }
}

function practiceMode(env) {
  return String(env.PRACTICE_MODE || "").toLowerCase() === "true";
}

function nowIso() {
  return new Date().toISOString();
}

function randomId() {
  return crypto.randomUUID();
}

function randomTicket() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const code = [...bytes].map((byte) => TICKET_ALPHABET[byte % TICKET_ALPHABET.length]).join("");
  return `OAI-${code.slice(0, 5)}-${code.slice(5)}`;
}

function normalizeTicket(value) {
  return String(value || "").trim().toUpperCase();
}

function parseExpiry(value, fallbackEpochSeconds) {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : fallbackEpochSeconds;
}

function providerTimeoutMs(env) {
  return positiveInteger(env.PROVIDER_TIMEOUT_MS, 90000, { min: 10000, max: 300000 });
}

async function loadAuthorizedSession(request, env) {
  const payload = await verifySessionToken(bearerToken(request), env.SESSION_SIGNING_KEY);
  const db = requireDatabase(env);
  let row = await db.prepare(
    `SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE id = ?`,
  ).bind(payload.sid).first();
  if (!row) throw new HttpError(401, "Phiên chat không tồn tại.");
  if (Date.parse(row.expires_at) <= Date.now()) throw new HttpError(401, "Phiên chat đã hết hạn.");
  const staleBefore = new Date(Date.now() - providerTimeoutMs(env) - 15000).toISOString();
  if (row.in_flight && (!row.in_flight_at || row.in_flight_at < staleBefore)) {
    await db.prepare(
      "UPDATE chat_sessions SET reserved_tokens = 0, in_flight = 0, in_flight_at = NULL WHERE id = ? AND in_flight = 1 AND (in_flight_at IS NULL OR in_flight_at < ?)",
    ).bind(row.id, staleBefore).run();
    row = await db.prepare(
      `SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE id = ?`,
    ).bind(payload.sid).first();
  }
  return row;
}

async function sessionResponse(row, env) {
  const expiry = Math.floor(Date.parse(row.expires_at) / 1000);
  const token = await signSessionToken(row.id, expiry, env.SESSION_SIGNING_KEY);
  return { ok: true, token, session: { ...sessionView(row), practice: practiceMode(env) } };
}

async function createPracticeSession(env) {
  const db = requireDatabase(env);
  const tokenLimit = positiveInteger(env.SESSION_TOKEN_LIMIT, DEFAULT_SESSION_TOKEN_LIMIT, { min: 1, max: 20000 });
  const ttl = positiveInteger(env.SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS, { min: 300, max: 86400 });
  const id = randomId();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  await db.prepare(
    "INSERT INTO chat_sessions (id, ticket_id, token_limit, used_tokens, reserved_tokens, in_flight, expires_at, created_at) VALUES (?, NULL, ?, 0, 0, 0, ?, ?)",
  ).bind(id, tokenLimit, expiresAt, createdAt).run();
  return db.prepare(
    `SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE id = ?`,
  ).bind(id).first();
}

async function createTicketSession(record, env, previousSessionId = null) {
  const db = requireDatabase(env);
  const tokenLimit = positiveInteger(env.SESSION_TOKEN_LIMIT, DEFAULT_SESSION_TOKEN_LIMIT, { min: 1, max: 20000 });
  const ttl = positiveInteger(env.SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS, { min: 300, max: 86400 });
  const id = randomId();
  const createdAt = nowIso();
  const defaultExpiry = Math.floor(Date.now() / 1000) + ttl;
  const expiry = Math.min(defaultExpiry, parseExpiry(record.expires_at, defaultExpiry));
  const expiresAt = new Date(expiry * 1000).toISOString();
  const claim = previousSessionId
    ? db.prepare(
      "UPDATE chat_tickets SET claimed_session_id = ?, claimed_at = ? WHERE id = ? AND claimed_session_id = ? AND enabled = 1",
    ).bind(id, createdAt, record.id, previousSessionId)
    : db.prepare(
      "UPDATE chat_tickets SET claimed_session_id = ?, claimed_at = ? WHERE id = ? AND claimed_session_id IS NULL AND enabled = 1",
    ).bind(id, createdAt, record.id);

  const [claimResult] = await db.batch([
    claim,
    db.prepare(
      "INSERT INTO chat_sessions (id, ticket_id, token_limit, used_tokens, reserved_tokens, in_flight, expires_at, created_at) VALUES (?, ?, ?, 0, 0, 0, ?, ?)",
    ).bind(id, record.id, tokenLimit, expiresAt, createdAt),
  ]);

  if (!claimResult.meta?.changes) {
    await db.prepare("DELETE FROM chat_sessions WHERE id = ?").bind(id).run();
    const current = await db.prepare(
      "SELECT claimed_session_id FROM chat_tickets WHERE id = ? AND enabled = 1",
    ).bind(record.id).first();
    if (!current?.claimed_session_id) throw new HttpError(409, "Không thể mở phiên thi. Vui lòng thử lại.");
    return db.prepare(`SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE id = ?`).bind(current.claimed_session_id).first();
  }

  return db.prepare(`SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE id = ?`).bind(id).first();
}

async function claimTicketSession(ticket, env) {
  const db = requireDatabase(env);
  const normalized = normalizeTicket(ticket);
  if (!normalized) throw new HttpError(400, "Vui lòng nhập mã phiên thi.");
  if (normalized.length > 64) throw new HttpError(400, "Mã phiên thi không hợp lệ.");

  const ticketHash = await sha256Hex(normalized);
  let record = await db.prepare(
    "SELECT id, claimed_session_id, expires_at FROM chat_tickets WHERE ticket_hash = ? AND enabled = 1",
  ).bind(ticketHash).first();
  if (!record) throw new HttpError(401, "Mã phiên thi không hợp lệ.");
  if (record.expires_at && Date.parse(record.expires_at) <= Date.now()) {
    throw new HttpError(401, "Mã phiên thi đã hết hạn.");
  }

  if (record.claimed_session_id) {
    const existing = await db.prepare(
      `SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE id = ?`,
    ).bind(record.claimed_session_id).first();
    const canContinue = existing
      && Date.parse(existing.expires_at) > Date.now()
      && (existing.in_flight || Number(existing.used_tokens) < Number(existing.token_limit));
    if (canContinue) {
      return existing;
    }
    return createTicketSession(record, env, record.claimed_session_id);
  }

  return createTicketSession(record, env);
}

async function openSession(request, env) {
  const body = await readJson(request, 1000);
  const row = practiceMode(env) ? await createPracticeSession(env) : await claimTicketSession(body.ticket, env);
  return responseJson(await sessionResponse(row, env));
}

async function getSession(request, env) {
  const row = await loadAuthorizedSession(request, env);
  return responseJson({ ok: true, session: { ...sessionView(row), practice: practiceMode(env) } });
}

async function createNextSession(request, env) {
  const current = await loadAuthorizedSession(request, env);
  if (current.in_flight) throw new HttpError(409, "Hãy chờ câu trả lời hiện tại hoàn tất trước khi tạo phiên mới.");
  if (Number(current.used_tokens) < Number(current.token_limit)) {
    throw new HttpError(409, "Chỉ có thể tạo phiên mới sau khi dùng hết token của phiên hiện tại.");
  }
  if (practiceMode(env) || !current.ticket_id) {
    return responseJson(await sessionResponse(await createPracticeSession(env), env));
  }

  const db = requireDatabase(env);
  const record = await db.prepare(
    "SELECT id, claimed_session_id, expires_at FROM chat_tickets WHERE id = ? AND enabled = 1",
  ).bind(current.ticket_id).first();
  if (!record) throw new HttpError(401, "Mã phiên thi không còn hiệu lực.");
  if (record.expires_at && Date.parse(record.expires_at) <= Date.now()) {
    throw new HttpError(401, "Mã phiên thi đã hết hạn.");
  }
  const next = record.claimed_session_id === current.id
    ? await createTicketSession(record, env, current.id)
    : await db.prepare(`SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE id = ?`).bind(record.claimed_session_id).first();
  if (!next) throw new HttpError(409, "Không thể tạo phiên mới. Vui lòng thử lại.");
  return responseJson(await sessionResponse(next, env));
}

async function releaseReservation(db, sessionId) {
  await db.prepare(
    "UPDATE chat_sessions SET reserved_tokens = 0, in_flight = 0, in_flight_at = NULL WHERE id = ?",
  ).bind(sessionId).run();
}

async function settleReservation(db, sessionId, reservation, usage) {
  let charged = reservation;
  if (Number.isInteger(usage?.completionTokens) && usage.completionTokens >= 0) {
    charged = usage.completionTokens;
  } else if (!usage?.sawContent) {
    charged = 0;
  }
  await db.prepare(
    "UPDATE chat_sessions SET used_tokens = MIN(token_limit, used_tokens + ?), reserved_tokens = 0, in_flight = 0, in_flight_at = NULL WHERE id = ?",
  ).bind(Math.max(0, charged), sessionId).run();
}

function auditedProviderStream(upstream, { db, sessionId, reservation, abortController, timeoutId }) {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const collector = createUsageCollector();
  let settlement = null;

  const settleOnce = (usage) => {
    if (!settlement) {
      clearTimeout(timeoutId);
      settlement = settleReservation(db, sessionId, reservation, usage);
    }
    return settlement;
  };

  return new ReadableStream({
    start(controller) {
      // Keep accounting inside the response stream lifetime. Cloudflare may stop waitUntil work
      // 30 seconds after headers are returned, while reasoning responses often run longer.
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            collector.push(decoder.decode(value, { stream: true }));
            controller.enqueue(value);
          }
          collector.push(decoder.decode());
          await settleOnce(collector.finish());
          controller.close();
        } catch (error) {
          try {
            await settleOnce({ completionTokens: null, sawContent: true });
          } finally {
            controller.error(error);
          }
        } finally {
          reader.releaseLock();
        }
      };
      void pump();
    },
    async cancel(reason) {
      abortController.abort();
      try { await reader.cancel(reason); } catch (error) { /* upstream may already be closed */ }
      await settleOnce({ completionTokens: null, sawContent: true });
    },
  });
}

async function chat(request, env) {
  if (!env.OPENROUTER_API_KEY) throw new Error("Thiếu secret OPENROUTER_API_KEY.");
  const db = requireDatabase(env);
  const session = await loadAuthorizedSession(request, env);
  const body = await readJson(request);
  const messages = normalizeMessages(body.messages);
  const remaining = Number(session.token_limit) - Number(session.used_tokens);
  if (remaining <= 0) throw new HttpError(429, "Phiên chat đã dùng hết 2.000 token.");
  if (session.in_flight) throw new HttpError(409, "Phiên chat đang có một câu trả lời khác.");

  const turnLimit = positiveInteger(env.TURN_TOKEN_LIMIT, DEFAULT_TURN_TOKEN_LIMIT, { min: 64, max: 2000 });
  const reservation = Math.min(turnLimit, remaining);
  const reservedAt = nowIso();
  const reserved = await db.prepare(
    "UPDATE chat_sessions SET reserved_tokens = ?, in_flight = 1, in_flight_at = ? WHERE id = ? AND in_flight = 0 AND used_tokens + ? <= token_limit AND expires_at > ?",
  ).bind(reservation, reservedAt, session.id, reservation, reservedAt).run();
  if (!reserved.meta?.changes) throw new HttpError(409, "Không thể giữ quota cho lượt này. Vui lòng tải lại trạng thái phiên.");

  const abortController = new AbortController();
  const timeoutMs = providerTimeoutMs(env);
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
  let upstream;
  try {
    upstream = await fetch(OPENROUTER_CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "HTTP-Referer": "https://tung51652-alt.github.io/Ch-m-i-m-OAI/",
        "X-Title": "OAI T7 Chat",
      },
      body: JSON.stringify(providerRequest(messages, {
        model: env.OPENROUTER_MODEL || DEFAULT_MODEL,
        maxTokens: reservation,
      })),
      signal: abortController.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    await releaseReservation(db, session.id);
    throw new HttpError(502, "Không kết nối được dịch vụ mô hình.");
  }

  if (!upstream.ok || !upstream.body) {
    clearTimeout(timeoutId);
    abortController.abort();
    await releaseReservation(db, session.id);
    const retryAfter = upstream.headers.get("Retry-After");
    return responseJson(
      { ok: false, message: upstream.status === 429 ? "Dịch vụ mô hình đang giới hạn lượt gọi. Vui lòng thử lại sau." : "Dịch vụ mô hình tạm thời không sẵn sàng." },
      upstream.status === 429 ? 429 : 502,
      retryAfter ? { "Retry-After": retryAfter } : {},
    );
  }

  const clientStream = auditedProviderStream(upstream.body, {
    db,
    sessionId: session.id,
    reservation,
    abortController,
    timeoutId,
  });
  return new Response(clientStream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      "X-Token-Reservation": String(reservation),
    },
  });
}

function timingSafeEqual(left, right) {
  const leftBytes = new TextEncoder().encode(String(left || ""));
  const rightBytes = new TextEncoder().encode(String(right || ""));
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }
  return difference === 0;
}

async function createTickets(request, env) {
  if (!env.ADMIN_KEY || !timingSafeEqual(bearerToken(request), env.ADMIN_KEY)) {
    throw new HttpError(401, "Không có quyền quản trị.");
  }
  const body = await readJson(request, 5000);
  const label = String(body.label || "").trim();
  if (!label || label.length > 80) throw new HttpError(400, "Nhãn ticket phải dài từ 1 đến 80 ký tự.");
  const count = positiveInteger(body.count, 1, { min: 1, max: 100 });
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
    throw new HttpError(400, "Thời hạn ticket không hợp lệ.");
  }

  const db = requireDatabase(env);
  const tickets = [];
  const statements = [];
  for (let index = 0; index < count; index += 1) {
    const ticket = randomTicket();
    tickets.push(ticket);
    statements.push(db.prepare(
      "INSERT INTO chat_tickets (ticket_hash, label, expires_at, enabled, created_at) VALUES (?, ?, ?, 1, ?)",
    ).bind(await sha256Hex(ticket), count === 1 ? label : `${label} ${index + 1}`, expiresAt?.toISOString() || null, nowIso()));
  }
  await db.batch(statements);
  return responseJson({ ok: true, tickets, expiresAt: expiresAt?.toISOString() || null }, 201);
}

async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return responseJson({ ok: true, service: "oai-chat", configured: Boolean(env.OPENROUTER_API_KEY && env.SESSION_SIGNING_KEY && env.CHAT_DB) });
  }
  if (request.method === "POST" && url.pathname === "/api/session") return openSession(request, env);
  if (request.method === "GET" && url.pathname === "/api/session") return getSession(request, env);
  if (request.method === "POST" && url.pathname === "/api/session/new") return createNextSession(request, env);
  if (request.method === "POST" && url.pathname === "/api/chat") return chat(request, env);
  if (request.method === "POST" && url.pathname === "/api/admin/tickets") return createTickets(request, env);
  throw new HttpError(404, "Không tìm thấy endpoint.");
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const headers = corsHeaders(origin, env.ALLOWED_ORIGINS);
    if (origin && !isOriginAllowed(origin, env.ALLOWED_ORIGINS)) {
      return responseJson({ ok: false, message: "Origin không được phép." }, 403);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    try {
      return withHeaders(await route(request, env), headers);
    } catch (error) {
      if (error instanceof HttpError) {
        return responseJson({ ok: false, message: error.message }, error.status, headers);
      }
      console.error("chat worker error", error?.name || "Error", error?.message || "unknown");
      return responseJson({ ok: false, message: "Lỗi nội bộ của dịch vụ chat." }, 500, headers);
    }
  },
};
