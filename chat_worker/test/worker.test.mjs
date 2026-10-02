import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.mjs";

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
    throw new Error(`Unsupported first SQL: ${this.sql}`);
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO chat_sessions")) {
      const [id, tokenLimit, expiresAt, createdAt] = this.values;
      this.db.sessions.set(id, {
        id,
        ticket_id: null,
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
  }

  prepare(sql) {
    return new FakePrepared(this, sql);
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
