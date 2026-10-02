import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCloudflareStream } from "../src/cloudflare.mjs";
import { dailyReservation, inspectProviderStream } from "../src/core.mjs";

function nativeStream(events, { fragment = false } = {}) {
  const bytes = new TextEncoder().encode(events.map(value => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\r\n\r\n`).join(""));
  return new ReadableStream({
    start(controller) {
      if (fragment) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      } else controller.enqueue(bytes);
      controller.close();
    },
  });
}

test("Cloudflare native delta usage is not confused with the final total", async () => {
  const events = [
    { response: "<think>" },
    { response: "suy luận", usage: { completion_tokens: 1, neurons: 0.443756 } },
    { response: "</think>Xin chào", usage: { completion_tokens: 1, neurons: 0.443756 } },
    { usage: { prompt_tokens: 0, completion_tokens: 0, neurons: 0 } },
    { response: "", usage: { prompt_tokens: 20, completion_tokens: 42, neurons: 19.6 } },
    "[DONE]",
  ];
  const normalized = normalizeCloudflareStream(nativeStream(events, { fragment: true }));
  const [browser, accounting] = normalized.tee();
  const text = await new Response(browser).text();
  assert.match(text, /Xin chào/);
  assert.match(text, /suy luận/);
  assert.equal((text.match(/completion_tokens/g) || []).length, 1);
  assert.deepEqual(await inspectProviderStream(accounting), { completionTokens: 42, sawContent: true, neurons: 19.6 });
});

test("missing Cloudflare summary leaves accounting conservative even with zero delta usage", async () => {
  const normalized = normalizeCloudflareStream(nativeStream([
    { response: "answer", usage: { completion_tokens: 1 } },
    { response: "", usage: { prompt_tokens: 0, completion_tokens: 0 } },
    "[DONE]",
  ]));
  assert.deepEqual(await inspectProviderStream(normalized), { completionTokens: null, sawContent: true });
});

test("Cloudflare stream errors and premature EOF do not look like successful responses", async () => {
  for (const events of [
    [{ error: "private upstream detail" }, "[DONE]"],
    [{ response: "partial" }],
    ["not-json", "[DONE]"],
  ]) {
    await assert.rejects(() => new Response(normalizeCloudflareStream(nativeStream(events))).text());
  }
});

test("OpenAI-shaped provider streams remain compatible", async () => {
  const normalized = normalizeCloudflareStream(nativeStream([
    { choices: [{ delta: { reasoning_content: "thinking" } }] },
    { choices: [], usage: { completion_tokens: 8 } },
    "[DONE]",
  ]));
  assert.deepEqual(await inspectProviderStream(normalized), { completionTokens: 8, sawContent: true });
});

test("daily reservation includes UTF-8 bytes, template overhead and capped output", () => {
  const ascii = dailyReservation([{ content: "hello" }], 100);
  const vietnamese = dailyReservation([{ content: "chào!" }], 100);
  assert.ok(vietnamese > ascii);
  assert.ok(ascii > 100 * 443.756);
  assert.ok(Number.isInteger(ascii));
});
