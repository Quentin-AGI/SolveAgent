const form = document.querySelector("#case-form");
const input = document.querySelector("#message");
const messages = document.querySelector("#messages");
const status = document.querySelector("#run-status");

let caseId;

const requestJson = async (url, options) => {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "REQUEST_FAILED");
  return body;
};

const appendMessage = (role, text) => {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  const label = document.createElement("strong");
  label.textContent = role === "user" ? "你" : "FixAgent";
  const content = document.createElement("p");
  content.textContent = text;
  article.append(label, content);
  messages.querySelector(".empty")?.remove();
  messages.append(article);
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message) return;

  form.querySelector("button").disabled = true;
  status.textContent = "正在分析";
  appendMessage("user", message);
  input.value = "";

  try {
    if (!caseId) {
      const created = await requestJson("/api/cases", { method: "POST" });
      caseId = created.case_id;
    }

    const result = await requestJson(`/api/cases/${caseId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message,
        idempotency_key: crypto.randomUUID(),
      }),
    });
    appendMessage("agent", result.response.message_markdown);
    status.textContent = result.handoff
      ? result.handoff.status === "PERSISTENCE_FAILED"
        ? `Case ${caseId.slice(0, 8)} · 安全停止（模拟工单写入失败，尚未联系真人）`
        : `Case ${caseId.slice(0, 8)} · 模拟安全工单（尚未联系真人）`
      : `Case ${caseId.slice(0, 8)} · ${result.response.response_type}`;
  } catch (error) {
    appendMessage("agent", "本次回答未通过发布校验，请稍后重试。");
    status.textContent = error instanceof Error ? error.message : "请求失败";
  } finally {
    form.querySelector("button").disabled = false;
    input.focus();
  }
});
