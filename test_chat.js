"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

global.window = globalThis;
require("./site/chat-core.js");

const { SSEParser, splitReasoning, normalizeApiUrl, formatTokens, isHttpUrl } = global.OAIChatCore;

test("SSE parser handles events split across network chunks", () => {
  const events = [];
  const parser = new SSEParser((event) => events.push(event));
  parser.push("data: {\"choices\":[{\"delta\":");
  parser.push("{\"content\":\"xin\"}}]}\n\n");
  parser.push("event: ignored\ndata: [DO");
  parser.push("NE]\n\n");
  parser.finish();
  assert.deepEqual(events, ["{\"choices\":[{\"delta\":{\"content\":\"xin\"}}]}", "[DONE]"]);
});

test("reasoning tags are separated without rendering provider HTML", () => {
  assert.deepEqual(splitReasoning("<think>phân tích</think>Kết luận"), {
    reasoning: "phân tích",
    answer: "Kết luận",
    thinking: false,
  });
  assert.deepEqual(splitReasoning("<think>đang nghĩ"), {
    reasoning: "đang nghĩ",
    answer: "",
    thinking: true,
  });
  assert.deepEqual(splitReasoning("<script>alert(1)</script>"), {
    reasoning: "",
    answer: "<script>alert(1)</script>",
    thinking: false,
  });
});

test("chat configuration helpers normalize and validate URLs", () => {
  assert.equal(normalizeApiUrl(" https://chat.example.com/// "), "https://chat.example.com");
  assert.equal(isHttpUrl("https://chat.example.com"), true);
  assert.equal(isHttpUrl("javascript:alert(1)"), false);
  assert.equal(formatTokens(2000), "2.000");
});
