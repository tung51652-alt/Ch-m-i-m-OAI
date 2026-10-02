import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.mjs";
import { sha256Hex } from "../src/core.mjs";

class FakePrepared {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.replace(/\s+/g, " ").trim();
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    if (this.sql.includes("FROM chat_sessions WHERE id = ?")) {
      return this.db.sessions.get(this.values[0]) || null;
    }
    if (this.sql.includes("FROM chat_tickets WHERE ticket_hash = ?")) {
      return [...this.db.tickets.values()].find((ticket) => (
        ticket.ticket_hash === this.values[0] && ticket.enabled === 1
      )) || null;
    }
    if (this.sql.includes("FROM chat_tickets WHERE id = ?")) {
      const ticket = this.db.tickets.get(this.values[0]) || null;
      if (this.sql.includes("enabled = 1") && ticket?.enabled !== 1) return null;
      return ticket;
    }
    throw new Error(`Unsupported first SQL: ${this.sql}`);
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO chat_daily_usage")) {
      const [day, amount, limit] = this.values;
      const current = this.db.dailyUsage.get(day) || 0;
      if (current + amount > limit) return { meta: { changes: 0 } };
      this.db.dailyUsage.set(day, current + amount);
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE chat_daily_usage")) {
      const [refund, day] = this.values;
      this.db.dailyUsage.set(day, Math.max(0, (this.db.dailyUsage.get(day) || 0) - refund));
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("INSERT INTO chat_sessions")) {
      const ticketSession = this.values.length === 5;
      const [id, ticketIdOrLimit, tokenLimitOrExpiry, expiresAtOrCreated, maybeCreatedAt] = this.values;
      const ticketId = ticketSession ? ticketIdOrLimit : null;
      const tokenLimit = ticketSession ? tokenLimitOrExpiry : ticketIdOrLimit;
      const expiresAt = ticketSession ? expiresAtOrCreated : tokenLimitOrExpiry;
      const createdAt = ticketSession ? maybeCreatedAt : expiresAtOrCreated;
      this.db.sessions.set(id, {
        id,
        ticket_id: ticketId,
        token_limit: tokenLimit,
        used_tokens: 0,
        reserved_tokens: 0,
        in_flight: 0,
        in_flight_at: null,
        expires_at: expiresAt,
        created_at: createdAt,
      });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE chat_tickets SET claimed_session_id")) {
      const [sessionId, claimedAt, ticketId, previousSessionId] = this.values;
      const ticket = this.db.tickets.get(ticketId);
      const claimMatches = previousSessionId === undefined
        ? ticket?.claimed_session_id == null
        : ticket?.claimed_session_id === previousSessionId;
      if (!ticket || ticket.enabled !== 1 || !claimMatches) return { meta: { changes: 0 } };
      ticket.claimed_session_id = sessionId;
      ticket.claimed_at = claimedAt;
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("DELETE FROM chat_sessions WHERE id = ?")) {
      const deleted = this.db.sessions.delete(this.values[0]);
      return { meta: { changes: deleted ? 1 : 0 } };
    }
    if (this.sql.startsWith("UPDATE chat_sessions SET reserved_tokens = ?, in_flight = 1")) {
      const [reservation, reservedAt, id, required, now] = this.values;
      const row = this.db.sessions.get(id);
      if (!row || row.in_flight || row.used_tokens + required > row.token_limit || row.expires_at <= now) {
        return { meta: { changes: 0 } };
      }
      row.reserved_tokens = reservation;
      row.in_flight = 1;
      row.in_flight_at = reservedAt;
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE chat_sessions SET used_tokens = MIN")) {
      const [charged, id] = this.values;
      const row = this.db.sessions.get(id);
      row.used_tokens = Math.min(row.token_limit, row.used_tokens + charged);
      row.reserved_tokens = 0;
      row.in_flight = 0;
      row.in_flight_at = null;
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE chat_sessions SET reserved_tokens = 0")) {
      const row = this.db.sessions.get(this.values[0]);
      row.reserved_tokens = 0;
      row.in_flight = 0;
      row.in_flight_at = null;
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unsupported run SQL: ${this.sql}`);
  }
}

class FakeD1 {
  constructor() {
    this.sessions = new Map();
    this.tickets = new Map();
    this.dailyUsage = new Map();
  }

  prepare(sql) {
    return new FakePrepared(this, sql);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

function request(path, init = {}) {
  return new Request(`https://chat-worker.example${path}`, {
    ...init,
    headers: { Origin: "https://example.github.io", ...(init.headers || {}) },
  });
}

function environment(db) {
  return {
    CHAT_DB: db,
    AI: { async run() { throw new Error("AI not stubbed"); } },
    SESSION_SIGNING_KEY: "a-secure-session-signing-key-for-worker-tests",
    ALLOWED_ORIGINS: "https://example.github.io",
    PRACTICE_MODE: "true",
    SESSION_TOKEN_LIMIT: "2000",
    TURN_TOKEN_LIMIT: "768",
    PROVIDER_TIMEOUT_MS: "10000",
  };
}

async function addTicket(db, code = "OAI-ABCDE-23456") {
  db.tickets.set(1, {
    id: 1,
    ticket_hash: await sha256Hex(code),
    label: "Đội kiểm thử",
    claimed_session_id: null,
    claimed_at: null,
    expires_at: null,
    enabled: 1,
  });
  return code;
}

test("practice session streams a response and settles quota from provider usage", async () => {
  const db = new FakeD1();
  const env = environment(db);
  const waits = [];
  const context = { waitUntil(promise) { waits.push(promise); } };

  const sessionResponse = await worker.fetch(request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }), env, context);
  assert.equal(sessionResponse.status, 200);
  const opened = await sessionResponse.json();
  assert.equal(opened.session.remainingTokens, 2000);

  let providerBody;
  env.AI.run = async (model, inputs, options) => {
    assert.equal(model, "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b");
    assert.equal(options.returnRawResponse, true);
    assert.ok(options.signal instanceof AbortSignal);
    providerBody = inputs;
    const sse = [
      "data: {\"response\":\"Xin chào\",\"usage\":{\"completion_tokens\":1}}\n\n",
      "data: {\"response\":\"\",\"usage\":{\"prompt_tokens\":20,\"completion_tokens\":42,\"neurons\":19.6}}\n\n",
      "data: [DONE]\n\n",
    ].join("");
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };

  {
    const chatResponse = await worker.fetch(request("/api/chat", {
      method: "POST",
      headers: { Authorization: `Bearer ${opened.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Chào bạn" }] }),
    }), env, context);
    assert.equal(chatResponse.status, 200);
    assert.match(await chatResponse.text(), /Xin chào/);
    await Promise.all(waits);
  }

  assert.equal(providerBody.max_tokens, 768);
  assert.equal(providerBody.stream_options.include_usage, true);
  assert.equal(providerBody.messages.some((message) => message.role === "system"), false);
  assert.match(providerBody.messages[0].content, /2\.000 token/);

  const statusResponse = await worker.fetch(request("/api/session", {
    headers: { Authorization: `Bearer ${opened.token}` },
  }), env, context);
  const status = await statusResponse.json();
  assert.equal(status.session.usedTokens, 42);
  assert.equal(status.session.remainingTokens, 1958);
  assert.equal(status.session.inFlight, false);
  assert.equal([...db.dailyUsage.values()][0], 19600);
});

test("worker rejects an unlisted browser origin", async () => {
  const response = await worker.fetch(new Request("https://chat-worker.example/health", {
    headers: { Origin: "https://evil.example" },
  }), environment(new FakeD1()), { waitUntil() {} });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("missing provider usage conservatively charges the full reservation", async () => {
  const db = new FakeD1();
  const env = environment(db);
  const waits = [];
  const context = { waitUntil(promise) { waits.push(promise); } };
  const opened = await (await worker.fetch(request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }), env, context)).json();

  env.AI.run = async () => new Response(
    "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\ndata: [DONE]\n\n",
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
  {
    const response = await worker.fetch(request("/api/chat", {
      method: "POST",
      headers: { Authorization: `Bearer ${opened.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "test" }] }),
    }), env, context);
    await response.text();
    await Promise.all(waits);
  }

  const row = [...db.sessions.values()][0];
  assert.equal(row.used_tokens, 768);
  assert.equal(row.reserved_tokens, 0);
  assert.equal(row.in_flight, 0);
});

test("provider rate limit releases the reservation for a retry", async () => {
  const db = new FakeD1();
  const env = environment(db);
  const context = { waitUntil() {} };
  const opened = await (await worker.fetch(request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }), env, context)).json();

  env.AI.run = async () => new Response("rate limited", { status: 429, headers: { "Retry-After": "10" } });
  {
    const response = await worker.fetch(request("/api/chat", {
      method: "POST",
      headers: { Authorization: `Bearer ${opened.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "test" }] }),
    }), env, context);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "10");
  }

  const row = [...db.sessions.values()][0];
  assert.equal(row.used_tokens, 0);
  assert.equal(row.reserved_tokens, 0);
  assert.equal(row.in_flight, 0);
  assert.equal([...db.dailyUsage.values()][0], 0);
});

test("a session rejects a second concurrent generation", async () => {
  const db = new FakeD1();
  const env = environment(db);
  const context = { waitUntil() {} };
  const opened = await (await worker.fetch(request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }), env, context)).json();
  [...db.sessions.values()][0].in_flight = 1;
  [...db.sessions.values()][0].in_flight_at = new Date().toISOString();

  const response = await worker.fetch(request("/api/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${opened.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "test" }] }),
  }), env, context);
  assert.equal(response.status, 409);
  assert.match((await response.json()).message, /đang có một câu trả lời khác/);
});

test("an abandoned in-flight lock is recovered after the provider timeout", async () => {
  const db = new FakeD1();
  const env = environment(db);
  const context = { waitUntil() {} };
  const opened = await (await worker.fetch(request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }), env, context)).json();
  const row = [...db.sessions.values()][0];
  row.in_flight = 1;
  row.reserved_tokens = 768;
  row.in_flight_at = "2000-01-01T00:00:00.000Z";

  const response = await worker.fetch(request("/api/session", {
    headers: { Authorization: `Bearer ${opened.token}` },
  }), env, context);
  const status = await response.json();
  assert.equal(status.session.inFlight, false);
  assert.equal(status.session.reservedTokens, 0);
  assert.equal(status.session.remainingTokens, 2000);
});

test("an exhausted ticket session can create a fresh session", async () => {
  const db = new FakeD1();
  const env = { ...environment(db), PRACTICE_MODE: "false" };
  const code = await addTicket(db);
  const context = { waitUntil() {} };
  const opened = await (await worker.fetch(request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket: code }),
  }), env, context)).json();
  const firstId = db.tickets.get(1).claimed_session_id;
  db.sessions.get(firstId).used_tokens = 2000;

  const response = await worker.fetch(request("/api/session/new", {
    method: "POST",
    headers: { Authorization: `Bearer ${opened.token}` },
  }), env, context);
  assert.equal(response.status, 200);
  const renewed = await response.json();
  const secondId = db.tickets.get(1).claimed_session_id;
  assert.notEqual(secondId, firstId);
  assert.equal(renewed.session.remainingTokens, 2000);
  assert.equal(db.sessions.size, 2);
  assert.equal(db.sessions.get(firstId).used_tokens, 2000);
});

test("a ticket re-entry replaces an exhausted or expired session", async () => {
  const db = new FakeD1();
  const env = { ...environment(db), PRACTICE_MODE: "false" };
  const code = await addTicket(db);
  const context = { waitUntil() {} };
  await worker.fetch(request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket: code }),
  }), env, context);
  const firstId = db.tickets.get(1).claimed_session_id;
  db.sessions.get(firstId).expires_at = "2000-01-01T00:00:00.000Z";

  const response = await worker.fetch(request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket: code }),
  }), env, context);
  assert.equal(response.status, 200);
  const reopened = await response.json();
  assert.equal(reopened.session.remainingTokens, 2000);
  assert.notEqual(db.tickets.get(1).claimed_session_id, firstId);
});

test("a new session is rejected while the current session still has tokens", async () => {
  const db = new FakeD1();
  const env = { ...environment(db), PRACTICE_MODE: "false" };
  const code = await addTicket(db);
  const context = { waitUntil() {} };
  const opened = await (await worker.fetch(request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket: code }),
  }), env, context)).json();

  const response = await worker.fetch(request("/api/session/new", {
    method: "POST",
    headers: { Authorization: `Bearer ${opened.token}` },
  }), env, context);
  assert.equal(response.status, 409);
  assert.match((await response.json()).message, /dùng hết token/);
  assert.equal(db.sessions.size, 1);
});

async function practiceSession(env) {
  return (await worker.fetch(request("/api/session", { method: "POST", body: "{}" }), env)).json();
}

function chatRequest(token) {
  return request("/api/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "test" }] }),
  });
}

test("health describes Cloudflare configuration but does not call inference", async () => {
  const env = environment(new FakeD1());
  const health = await (await worker.fetch(request("/health"), env)).json();
  assert.equal(health.provider, "cloudflare-workers-ai");
  assert.equal(health.model, "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b");
  assert.equal(health.configured, true);
  assert.equal(health.dailyNeuronLimit, 9000);
  delete env.AI;
  assert.equal((await (await worker.fetch(request("/health"), env)).json()).configured, false);
});

test("daily exhaustion blocks inference without consuming any session tokens", async () => {
  const db = new FakeD1();
  const env = environment(db);
  db.dailyUsage.set(new Date().toISOString().slice(0, 10), 9000000);
  const opened = await practiceSession(env);
  let called = false;
  env.AI.run = async () => { called = true; throw new Error("must not be reached"); };
  const response = await worker.fetch(chatRequest(opened.token), env);
  assert.equal(response.status, 429);
  assert.match((await response.json()).message, /7 giờ sáng/);
  assert.equal(called, false);
  const row = [...db.sessions.values()][0];
  assert.equal(row.used_tokens, 0);
  assert.equal(row.reserved_tokens, 0);
  assert.equal(row.in_flight, 0);
});

test("fresh sessions share today's budget but yesterday's budget does not block today", async () => {
  const db = new FakeD1();
  const env = environment(db);
  db.dailyUsage.set("2000-01-01", 9000000);
  env.AI.run = async () => new Response('data: {"response":"ok"}\n\ndata: [DONE]\n\n', {
    headers: { "Content-Type": "text/event-stream" },
  });
  const first = await practiceSession(env);
  const response = await worker.fetch(chatRequest(first.token), env);
  assert.equal(response.status, 200);
  await response.text();
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(db.dailyUsage.get(today) > 0);
  db.dailyUsage.set(today, 9000000);
  const second = await practiceSession(env);
  assert.equal((await worker.fetch(chatRequest(second.token), env)).status, 429);
});

test("a failed connection releases session tokens but retains uncertain daily cost", async () => {
  const db = new FakeD1();
  const env = environment(db);
  const opened = await practiceSession(env);
  const response = await worker.fetch(chatRequest(opened.token), env);
  assert.equal(response.status, 502);
  const row = [...db.sessions.values()][0];
  assert.equal(row.used_tokens, 0);
  assert.equal(row.in_flight, 0);
  assert.ok([...db.dailyUsage.values()][0] > 0);
});

test("stream failure before output releases tokens; partial output is charged conservatively", async () => {
  for (const partial of [false, true]) {
    const db = new FakeD1();
    const env = environment(db);
    const opened = await practiceSession(env);
    env.AI.run = async () => new Response(partial ? 'data: {"response":"partial"}\n\n' : 'data: {"error":"failure"}\n\n', {
      headers: { "Content-Type": "text/event-stream" },
    });
    const response = await worker.fetch(chatRequest(opened.token), env);
    await assert.rejects(() => response.text());
    const row = [...db.sessions.values()][0];
    assert.equal(row.used_tokens, partial ? 768 : 0);
    assert.equal(row.in_flight, 0);
    assert.equal(row.reserved_tokens, 0);
    assert.ok([...db.dailyUsage.values()][0] > 0);
  }
});

test("last turn is capped by the remaining session quota", async () => {
  const db = new FakeD1();
  const env = environment(db);
  const opened = await practiceSession(env);
  const row = [...db.sessions.values()][0];
  row.used_tokens = 1990;
  env.AI.run = async (_model, inputs) => {
    assert.equal(inputs.max_tokens, 10);
    return new Response('data: {"response":"<think>thinking</think>ok"}\n\ndata: {"response":"","usage":{"prompt_tokens":20,"completion_tokens":10,"neurons":5.4}}\n\ndata: [DONE]\n\n', {
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  await (await worker.fetch(chatRequest(opened.token), env)).text();
  assert.equal(row.used_tokens, 2000);
  assert.equal((await worker.fetch(chatRequest(opened.token), env)).status, 429);
});

test("daily limit cannot be configured above Cloudflare's free allowance", async () => {
  const env = { ...environment(new FakeD1()), DAILY_NEURON_LIMIT: "10001" };
  assert.equal((await (await worker.fetch(request("/health"), env)).json()).dailyNeuronLimit, 9000);
});

test("concurrent sessions cannot both reserve the last daily budget", async () => {
  const db = new FakeD1();
  const env = environment(db);
  const first = await practiceSession(env);
  const second = await practiceSession(env);
  db.dailyUsage.set(new Date().toISOString().slice(0, 10), 8500000);
  let calls = 0;
  env.AI.run = async () => {
    calls += 1;
    return new Response('data: {"response":"ok"}\n\ndata: [DONE]\n\n', {
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  const responses = await Promise.all([worker.fetch(chatRequest(first.token), env), worker.fetch(chatRequest(second.token), env)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 429]);
  await responses.find(response => response.status === 200).text();
  assert.equal(calls, 1);
  assert.ok([...db.dailyUsage.values()][0] <= 9000000);
});

test("client cancellation aborts inference and settles both quotas once", async () => {
  const db = new FakeD1();
  const env = environment(db);
  const opened = await practiceSession(env);
  let signal;
  let upstreamCancelled = false;
  env.AI.run = async (_model, _inputs, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"response":"partial"}\n\n')); },
      cancel() { upstreamCancelled = true; },
    }), { headers: { "Content-Type": "text/event-stream" } });
  };
  const response = await worker.fetch(chatRequest(opened.token), env);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  // Let cancellation propagate through the native-stream transform.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  assert.equal(upstreamCancelled, true);
  const row = [...db.sessions.values()][0];
  assert.equal(row.used_tokens, 768);
  assert.equal(row.reserved_tokens, 0);
  assert.equal(row.in_flight, 0);
});

test("unexpected JSON responses are not forwarded as successful SSE", async () => {
  const db = new FakeD1();
  const env = environment(db);
  const opened = await practiceSession(env);
  env.AI.run = async () => Response.json({response: "not streamed"});
  assert.equal((await worker.fetch(chatRequest(opened.token), env)).status, 502);
  assert.equal([...db.sessions.values()][0].used_tokens, 0);
  assert.ok([...db.dailyUsage.values()][0] > 0);
});
