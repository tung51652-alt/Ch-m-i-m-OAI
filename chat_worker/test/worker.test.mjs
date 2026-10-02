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
    HF_TOKEN: "hf_test",
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

  const originalFetch = globalThis.fetch;
  let providerBody;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://router.huggingface.co/v1/chat/completions");
    providerBody = JSON.parse(init.body);
    const sse = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"Xin chào\"}}]}\n\n",
      "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":20,\"completion_tokens\":42}}\n\n",
      "data: [DONE]\n\n",
    ].join("");
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };

  try {
    const chatResponse = await worker.fetch(request("/api/chat", {
      method: "POST",
      headers: { Authorization: `Bearer ${opened.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Chào bạn" }] }),
    }), env, context);
    assert.equal(chatResponse.status, 200);
    assert.match(await chatResponse.text(), /Xin chào/);
    await Promise.all(waits);
  } finally {
    globalThis.fetch = originalFetch;
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

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\ndata: [DONE]\n\n",
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
  try {
    const response = await worker.fetch(request("/api/chat", {
      method: "POST",
      headers: { Authorization: `Bearer ${opened.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "test" }] }),
    }), env, context);
    await response.text();
    await Promise.all(waits);
  } finally {
    globalThis.fetch = originalFetch;
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

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("rate limited", { status: 429, headers: { "Retry-After": "10" } });
  try {
    const response = await worker.fetch(request("/api/chat", {
      method: "POST",
      headers: { Authorization: `Bearer ${opened.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "test" }] }),
    }), env, context);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "10");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const row = [...db.sessions.values()][0];
  assert.equal(row.used_tokens, 0);
  assert.equal(row.reserved_tokens, 0);
  assert.equal(row.in_flight, 0);
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
