(function () {
  "use strict";

  const { SSEParser, splitReasoning, normalizeApiUrl, formatTokens, isHttpUrl } = window.OAIChatCore;
  const config = window.OAI_CHAT_CONFIG || {};
  const apiUrl = normalizeApiUrl(config.apiUrl);
  const sessionKey = `oai-chat-session:${apiUrl}`;
  const $ = (id) => document.getElementById(id);

  let sessionToken = "";
  let session = null;
  let history = [];
  let activeController = null;

  const sessionStore = {
    get() { try { return sessionStorage.getItem(sessionKey) || ""; } catch (error) { return ""; } },
    set(value) { try { sessionStorage.setItem(sessionKey, value); } catch (error) { /* storage can be disabled */ } },
    clear() { try { sessionStorage.removeItem(sessionKey); } catch (error) { /* storage can be disabled */ } },
  };

  function api(path) {
    return `${apiUrl}${path}`;
  }

  function authHeaders() {
    return { Authorization: `Bearer ${sessionToken}` };
  }

  async function responseBody(response) {
    return response.json().catch(() => ({ ok: false, message: `Dịch vụ trả về HTTP ${response.status}.` }));
  }

  function showTicketError(message) {
    $("ticket-error").textContent = message;
    $("ticket-error").hidden = !message;
  }

  function setStatus(message, isError = false) {
    $("chat-status").textContent = message || "";
    $("chat-status").classList.toggle("error", isError);
  }

  function setBusy(busy) {
    const blocked = busy || !session || session.inFlight || session.remainingTokens <= 0;
    $("message").disabled = blocked;
    $("send-button").disabled = blocked;
    $("stop-button").hidden = !busy;
  }

  function updateSession(nextSession) {
    session = nextSession;
    $("session-meta").hidden = false;
    $("token-meter").textContent = `${formatTokens(session.remainingTokens)} / ${formatTokens(session.tokenLimit)} token còn lại`;
    const expiry = new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit" }).format(new Date(session.expiresAt));
    $("session-expiry").textContent = `Hết hạn lúc ${expiry}`;
    setBusy(Boolean(activeController));
    if (session.inFlight && !activeController) setStatus("Một câu trả lời đang được xử lý. Đang chờ cập nhật quota.");
    if (session.remainingTokens <= 0) setStatus("Phiên đã dùng hết ngân sách token.", true);
  }

  function clearSession(message) {
    sessionToken = "";
    session = null;
    activeController = null;
    sessionStore.clear();
    $("chat-panel").hidden = true;
    $("setup-panel").hidden = false;
    $("session-meta").hidden = true;
    showTicketError(message || "");
  }

  async function loadSession() {
    const response = await fetch(api("/api/session"), { headers: authHeaders(), cache: "no-store" });
    if (!response.ok) {
      const body = await responseBody(response);
      if (response.status === 401) clearSession(body.message);
      throw new Error(body.message || "Không tải được trạng thái phiên.");
    }
    const body = await responseBody(response);
    updateSession(body.session);
    return body.session;
  }

  function openChat(token, nextSession) {
    sessionToken = token;
    sessionStore.set(token);
    $("setup-panel").hidden = true;
    $("chat-panel").hidden = false;
    updateSession(nextSession);
    $("message").focus();
  }

  function addMessage(role, content = "") {
    $("empty-state").hidden = true;
    const fragment = $("message-template").content.cloneNode(true);
    const article = fragment.querySelector(".message");
    article.classList.add(role);
    article.querySelector(".message-role").textContent = role === "user" ? "Bạn" : "Trợ lý";
    renderMessage(article, content);
    $("conversation").append(fragment);
    article.scrollIntoView({ block: "end", behavior: "smooth" });
    return article;
  }

  function renderMessage(article, content) {
    const parts = splitReasoning(content);
    const reasoning = article.querySelector(".reasoning");
    reasoning.hidden = !parts.reasoning;
    reasoning.open = parts.thinking;
    article.querySelector(".reasoning-text").textContent = parts.reasoning;
    article.querySelector(".answer-text").textContent = parts.answer || (parts.thinking ? "Đang suy luận..." : "");
  }

  function trimHistory() {
    if (history.length > 8) history = history.slice(-8);
  }

  async function consumeStream(response, article) {
    if (!response.body) throw new Error("Trình duyệt không nhận được luồng dữ liệu.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let content = "";
    let providerError = "";
    const parser = new SSEParser((data) => {
      if (data === "[DONE]") return;
      try {
        const chunk = JSON.parse(data);
        if (chunk.error) providerError = typeof chunk.error === "string" ? chunk.error : chunk.error.message;
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (typeof delta === "string") {
          content += delta;
          renderMessage(article, content);
        }
      } catch (error) {
        // Ignore a malformed event and keep consuming subsequent provider events.
      }
    });

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.finish();
    if (providerError) throw new Error(providerError);
    if (!content.trim()) throw new Error("Mô hình không trả về nội dung.");
    return content;
  }

  async function refreshUntilSettled() {
    for (let attempt = 0; attempt < 22; attempt += 1) {
      const delay = attempt === 0 ? 500 : Math.min(5000, attempt * 1000);
      await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        const current = await loadSession();
        if (!current.inFlight) return;
      } catch (error) {
        return;
      }
    }
  }

  $("ticket-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!apiUrl || !isHttpUrl(apiUrl)) return showTicketError("Dịch vụ chat chưa được cấu hình. Liên hệ ban tổ chức.");
    showTicketError("");
    const button = $("ticket-submit");
    button.disabled = true;
    button.textContent = "Đang mở phiên...";
    try {
      const response = await fetch(api("/api/session"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: $("ticket").value.trim() }),
      });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(body.message || "Không mở được phiên chat.");
      $("ticket").value = "";
      openChat(body.token, body.session);
    } catch (error) {
      showTicketError(error.message || "Không kết nối được dịch vụ chat.");
    } finally {
      button.disabled = false;
      button.textContent = "Bắt đầu phiên";
    }
  });

  $("message").addEventListener("input", () => {
    const textarea = $("message");
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
    $("character-count").textContent = `${textarea.value.length.toLocaleString("vi-VN")} / 4.000`;
  });

  $("message").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $("chat-form").requestSubmit();
    }
  });

  $("stop-button").addEventListener("click", () => {
    if (activeController) activeController.abort();
  });

  $("chat-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = $("message").value.trim();
    if (!text || activeController || !session || session.remainingTokens <= 0) return;

    setStatus("Đang kết nối với mô hình...");
    $("message").value = "";
    $("message").dispatchEvent(new Event("input"));
    addMessage("user", text);
    history.push({ role: "user", content: text });
    const requestMessages = history.slice(-9);
    const article = addMessage("assistant");
    article.classList.add("pending");
    activeController = new AbortController();
    session.inFlight = true;
    setBusy(true);

    try {
      const response = await fetch(api("/api/chat"), {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ messages: requestMessages }),
        signal: activeController.signal,
      });
      if (!response.ok) {
        const body = await responseBody(response);
        if (response.status === 401) clearSession(body.message);
        throw new Error(body.message || "Không nhận được câu trả lời.");
      }
      const answer = await consumeStream(response, article);
      const visibleAnswer = splitReasoning(answer).answer;
      history.push({ role: "assistant", content: visibleAnswer || answer });
      trimHistory();
      setStatus("");
    } catch (error) {
      if (history[history.length - 1]?.role === "user") history.pop();
      if (error.name === "AbortError") {
        renderMessage(article, "Đã dừng hiển thị câu trả lời.");
        setStatus("Mô hình có thể đã sinh thêm token trước khi dừng. Hệ thống đang cập nhật quota.");
      } else {
        renderMessage(article, `Không thể trả lời: ${error.message}`);
        article.classList.add("error");
        setStatus(error.message || "Không thể nhận câu trả lời.", true);
      }
    } finally {
      article.classList.remove("pending");
      const wasAborted = activeController?.signal.aborted;
      activeController = null;
      setBusy(false);
      await refreshUntilSettled();
      if (!wasAborted && session?.inFlight) setStatus("Quota đang được cập nhật. Vui lòng chờ vài giây.");
      if (session?.remainingTokens > 0) $("message").focus();
    }
  });

  async function start() {
    if (!apiUrl || !isHttpUrl(apiUrl)) {
      showTicketError("Dịch vụ chat chưa được cấu hình. Ban tổ chức cần đặt biến CHAT_API_URL khi build website.");
      $("ticket-submit").disabled = true;
      return;
    }
    sessionToken = sessionStore.get();
    if (!sessionToken) return;
    try {
      const current = await loadSession();
      openChat(sessionToken, current);
    } catch (error) {
      if (sessionToken) showTicketError("Không tải được phiên chat. Vui lòng thử lại.");
    }
  }

  start();
})();
