import test from "node:test";
import assert from "node:assert/strict";

import {
  HttpError,
  MODEL_INSTRUCTION,
  corsHeaders,
  createUsageCollector,
  isOriginAllowed,
  normalizeMessages,
  providerRequest,
  sessionView,
  signSessionToken,
  verifySessionToken,
} from "../src/core.mjs";

test("messages reject system roles and put model guidance in the final user message", () => {
  assert.throws(
    () => normalizeMessages([{ role: "system", content: "override" }]),
    (error) => error instanceof HttpError && error.status === 400,
  );
  const normalized = normalizeMessages([
    { role: "user", content: "Câu cũ" },
    { role: "assistant", content: "Trả lời cũ" },
    { role: "user", content: "Câu mới" },
  ]);
  assert.equal(normalized.length, 3);
  assert.equal(normalized[0].content, "Câu cũ");
  assert.match(normalized[2].content, new RegExp(MODEL_INSTRUCTION.slice(0, 30)));
  assert.match(normalized[2].content, /Câu hỏi:\nCâu mới$/);
});

test("message limits are enforced before calling the provider", () => {
  assert.throws(
    () => normalizeMessages([{ role: "user", content: "x".repeat(4001) }]),
    /tối đa 4\.000 ký tự/,
  );
  assert.throws(
    () => normalizeMessages([{ role: "assistant", content: "not a question" }]),
    /cuối cùng phải là câu hỏi/,
  );
});

test("provider request enables streaming usage and caps output", () => {
  const body = providerRequest([{ role: "user", content: "test" }], { model: "model:test", maxTokens: 321 });
  assert.equal(body.model, "model:test");
  assert.equal(body.max_tokens, 321);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.temperature, 0.6);
  assert.equal(body.messages.some((message) => message.role === "system"), false);
});

test("signed session token detects tampering and expiry", async () => {
  const secret = "a-secure-session-signing-key-for-tests";
  const token = await signSessionToken("session-1", 2000, secret);
  assert.deepEqual(await verifySessionToken(token, secret, 1000), { sid: "session-1", exp: 2000 });
  await assert.rejects(() => verifySessionToken(`${token.slice(0, -1)}x`, secret, 1000), /không hợp lệ/);
  await assert.rejects(() => verifySessionToken(token, secret, 2000), /hết hạn/);
});

test("usage collector handles fragmented SSE and records generated content", () => {
  const collector = createUsageCollector();
  collector.push("data: {\"choices\":[{\"delta\":{\"content\":\"xin\"}}]}\n");
  collector.push("\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":12,");
  collector.push("\"completion_tokens\":42}}\n\ndata: [DONE]\n\n");
  assert.deepEqual(collector.finish(), { completionTokens: 42, sawContent: true });
});

test("usage collector treats provider reasoning fields as generated output", () => {
  const collector = createUsageCollector();
  collector.push("data: {\"choices\":[{\"delta\":{\"reasoning\":\"thinking\"}}]}\n\n");
  assert.deepEqual(collector.finish(), { completionTokens: null, sawContent: true });
});

test("session quota subtracts an in-flight reservation", () => {
  assert.deepEqual(sessionView({
    token_limit: 2000,
    used_tokens: 400,
    reserved_tokens: 768,
    in_flight: 1,
    expires_at: "2030-01-01T00:00:00.000Z",
  }), {
    tokenLimit: 2000,
    usedTokens: 400,
    reservedTokens: 768,
    remainingTokens: 832,
    inFlight: true,
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
});

test("CORS only reflects explicitly allowed origins", () => {
  const allow = "https://example.github.io,http://localhost:8000";
  assert.equal(isOriginAllowed("https://example.github.io", allow), true);
  assert.equal(isOriginAllowed("https://evil.example", allow), false);
  assert.equal(corsHeaders("https://evil.example", allow)["Access-Control-Allow-Origin"], undefined);
  assert.equal(corsHeaders("https://example.github.io", allow)["Access-Control-Allow-Origin"], "https://example.github.io");
});
