(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.OAIChatCore = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  "use strict";

  class SSEParser {
    constructor(onEvent) {
      this.onEvent = onEvent;
      this.buffer = "";
    }

    push(text) {
      this.buffer += text;
      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop() || "";
      lines.forEach((line) => this.processLine(line));
    }

    finish() {
      if (this.buffer) this.processLine(this.buffer);
      this.buffer = "";
    }

    processLine(line) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const data = trimmed.slice(5).trim();
      if (data) this.onEvent(data);
    }
  }

  function splitReasoning(text) {
    const source = String(text || "");
    const open = source.indexOf("<think>");
    if (open < 0) return { reasoning: "", answer: source, thinking: false };
    const close = source.indexOf("</think>", open + 7);
    const before = source.slice(0, open).trim();
    if (close < 0) {
      return { reasoning: source.slice(open + 7).trim(), answer: before, thinking: true };
    }
    const after = source.slice(close + 8).trim();
    return {
      reasoning: source.slice(open + 7, close).trim(),
      answer: [before, after].filter(Boolean).join("\n\n"),
      thinking: false,
    };
  }

  function normalizeApiUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function formatTokens(value) {
    return Math.max(0, Number(value) || 0).toLocaleString("vi-VN");
  }

  function isHttpUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch (error) {
      return false;
    }
  }

  return { SSEParser, splitReasoning, normalizeApiUrl, formatTokens, isHttpUrl };
});
