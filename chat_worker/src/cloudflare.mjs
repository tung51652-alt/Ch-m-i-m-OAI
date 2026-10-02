// Convert Workers AI native SSE to the existing browser's Chat Completions shape.
// Native content chunks carry DELTA usage, not cumulative usage. Only the final
// empty-response summary is authoritative; never expose per-token usage to the
// session accounting collector.
export function normalizeCloudflareStream(upstream) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let summary = null;
  let done = false;

  const event = (controller, value) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
  const line = (raw, controller) => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("data:")) return;
    if (done) throw new Error("Provider sent events after completion");
    const data = trimmed.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") {
      done = true;
      if (summary) event(controller, { choices: [], usage: summary });
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      return;
    }
    const chunk = JSON.parse(data);
    if (chunk.error || chunk.errors || chunk.success === false) {
      throw new Error("Workers AI stream failed");
    }
    if (typeof chunk.response === "string") {
      if (chunk.response) {
        event(controller, { choices: [{ delta: { content: chunk.response } }] });
      } else if (Number.isInteger(chunk.usage?.prompt_tokens) && chunk.usage.prompt_tokens > 0
        && Number.isInteger(chunk.usage?.completion_tokens) && chunk.usage.completion_tokens >= 0) {
        summary = chunk.usage;
      }
    } else if (Array.isArray(chunk.choices)) {
      // Accept OpenAI-shaped streams if Cloudflare changes its response format.
      event(controller, chunk);
    }
  };

  return upstream.pipeThrough(new TransformStream({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      if (buffer.length > 65536) throw new Error("Provider SSE event too large");
      lines.forEach((value) => line(value, controller));
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.trim()) line(buffer, controller);
      if (!done) throw new Error("Provider stream ended before completion");
    },
  }));
}
