const appShell = document.querySelector(".app-shell");
const sidebar = document.querySelector("#sidebar");
const workspace = document.querySelector(".workspace");
const form = document.querySelector("#case-form");
const input = document.querySelector("#message");
const messages = document.querySelector("#messages");
const thread = document.querySelector("#thread");
const status = document.querySelector("#run-status");
const submitButton = document.querySelector("#submit-button");
const threadTitle = document.querySelector("#thread-title");
const caseList = document.querySelector("#case-list");
const noCases = document.querySelector("#no-cases");
const newCaseButton = document.querySelector("#new-case");
const composerDock = document.querySelector(".composer-dock");
const caseSearchButton = document.querySelector("#case-search");
const caseSearchPanel = document.querySelector("#case-search-panel");
const caseSearchInput = document.querySelector("#case-search-input");
const serviceIndicators = [
  document.querySelector("#nav-service-state"),
  document.querySelector("#footer-service-state"),
];
const environmentStatus = document.querySelector("#environment-status");
const emptyStateTemplate = document.querySelector("#empty-state-template");

let caseId;
let activeMessages = [];
let recentCases = [];
let navigationLocked = false;

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "REQUEST_FAILED");
  return body;
}

function showEmptyState() {
  messages.replaceChildren(emptyStateTemplate.content.cloneNode(true));
  messages.classList.add("is-empty");
}

function appendMessage(role, text, options = {}) {
  messages.querySelector(".empty-state")?.remove();
  messages.classList.remove("is-empty");

  const article = document.createElement("article");
  article.className = `message ${role}${options.error ? " error" : ""}`;

  const content = document.createElement("div");
  content.className = "message-content";
  const paragraph = document.createElement("p");
  const speaker = document.createElement("span");
  speaker.className = "visually-hidden";
  speaker.textContent = role === "user" ? "你：" : "FixAgent：";
  paragraph.append(speaker, document.createTextNode(text));
  content.append(paragraph);
  article.append(content);
  messages.append(article);

  if (options.record !== false) {
    activeMessages.push({ role, text, error: Boolean(options.error) });
  }

  scrollToLatest();
  return article;
}

function appendThinking() {
  messages.querySelector(".empty-state")?.remove();
  messages.classList.remove("is-empty");

  const article = document.createElement("article");
  article.className = "message agent thinking";
  article.setAttribute("aria-label", "FixAgent 正在分析");

  const content = document.createElement("div");
  content.className = "message-content";
  content.innerHTML =
    '<div class="thinking-dots" aria-hidden="true"><span></span><span></span><span></span></div>';
  article.append(content);
  messages.append(article);
  scrollToLatest();
  return article;
}

function scrollToLatest() {
  requestAnimationFrame(() => {
    thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" });
  });
}

function resizeInput() {
  const keepAtBottom =
    thread.scrollHeight - thread.scrollTop - thread.clientHeight < 96;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 164)}px`;
  requestAnimationFrame(() => {
    syncComposerSpace();
    if (keepAtBottom) thread.scrollTop = thread.scrollHeight;
  });
}

function syncComposerSpace() {
  const reservedSpace = Math.ceil(composerDock.getBoundingClientRect().height + 28);
  messages.style.setProperty("--composer-space", `${reservedSpace}px`);
}

function setServiceState(state) {
  const labels = {
    pending: "服务状态待验证",
    available: "服务可用",
    error: "服务请求失败",
  };
  const label = labels[state];

  for (const indicator of serviceIndicators) {
    indicator.classList.remove("is-pending", "is-available", "is-error");
    indicator.classList.add(`is-${state}`);
    if (indicator.getAttribute("aria-hidden") !== "true") {
      indicator.setAttribute("aria-label", label);
    }
    indicator.title = label;
  }
  environmentStatus.textContent = label;
}

function setBusy(isBusy) {
  navigationLocked = isBusy;
  submitButton.disabled = isBusy;
  newCaseButton.disabled = isBusy;
  input.readOnly = isBusy;
  form.setAttribute("aria-busy", String(isBusy));
  renderCaseList();
}

function titleFromMessage(message) {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 24 ? `${compact.slice(0, 24)}…` : compact;
}

function currentCaseStatus() {
  return caseId ? status.textContent : "尚未创建 Case";
}

function saveCurrentCase(title) {
  if (!caseId) return;

  const existing = recentCases.find((item) => item.id === caseId);
  const record = {
    id: caseId,
    title: title || existing?.title || "未命名诊断",
    status: currentCaseStatus(),
    messages: activeMessages,
    updatedAt: Date.now(),
  };

  recentCases = [
    record,
    ...recentCases.filter((item) => item.id !== caseId),
  ].slice(0, 8);
  renderCaseList();
}

function renderCaseList() {
  caseList.replaceChildren();
  newCaseButton.classList.toggle("active", !caseId);
  if (caseId) {
    newCaseButton.removeAttribute("aria-current");
  } else {
    newCaseButton.setAttribute("aria-current", "page");
  }
  const query = caseSearchInput.value.trim().toLocaleLowerCase();
  const visibleCases = query
    ? recentCases.filter((item) => item.title.toLocaleLowerCase().includes(query))
    : recentCases;
  noCases.hidden = visibleCases.length > 0;
  noCases.textContent = query ? "没有匹配的诊断记录" : "暂无诊断记录";

  for (const item of visibleCases) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `case-item${item.id === caseId ? " current" : ""}`;
    button.textContent = item.title;
    button.title = item.title;
    button.disabled = navigationLocked;
    if (item.id === caseId) button.setAttribute("aria-current", "page");
    button.addEventListener("click", () => activateCase(item));
    caseList.append(button);
  }
}

function activateCase(record) {
  if (navigationLocked) return;

  caseId = record.id;
  activeMessages = Array.isArray(record.messages) ? [...record.messages] : [];
  messages.replaceChildren();
  messages.classList.toggle("is-empty", activeMessages.length === 0);

  if (activeMessages.length === 0) {
    showEmptyState();
  } else {
    for (const message of activeMessages) {
      appendMessage(message.role, message.text, {
        error: message.error,
        record: false,
      });
    }
  }

  threadTitle.textContent = record.title || "诊断 Case";
  document.title = `${threadTitle.textContent} · FixAgent`;
  status.textContent = record.status || `Case ${caseId.slice(0, 8)}`;
  renderCaseList();
  closeSidebarOnMobile();
  input.focus();
}

function startNewCase() {
  if (navigationLocked) return;

  caseId = undefined;
  activeMessages = [];
  showEmptyState();
  threadTitle.textContent = "新建诊断 Case";
  document.title = "FixAgent";
  status.textContent = "尚未创建 Case";
  input.value = "";
  resizeInput();
  renderCaseList();
  closeSidebarOnMobile();
  input.focus();
}

function openSidebar() {
  if (window.matchMedia("(max-width: 780px)").matches) {
    appShell.classList.add("sidebar-visible");
  } else {
    appShell.classList.remove("sidebar-collapsed");
  }
  setSidebarAccessibility(true);
  requestAnimationFrame(() => document.querySelector("#sidebar-close").focus());
}

function closeSidebar() {
  if (window.matchMedia("(max-width: 780px)").matches) {
    appShell.classList.remove("sidebar-visible");
  } else {
    appShell.classList.add("sidebar-collapsed");
  }
  setSidebarAccessibility(false);
  document.querySelector("#sidebar-open").focus();
}

function closeSidebarOnMobile() {
  if (window.matchMedia("(max-width: 780px)").matches) {
    appShell.classList.remove("sidebar-visible");
    setSidebarAccessibility(false);
  }
}

function setSidebarAccessibility(isVisible) {
  const isMobile = window.matchMedia("(max-width: 780px)").matches;
  sidebar.inert = !isVisible;
  sidebar.setAttribute("aria-hidden", String(!isVisible));
  workspace.inert = isMobile && isVisible;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message || submitButton.disabled) return;

  const caseTitle = caseId
    ? recentCases.find((item) => item.id === caseId)?.title
    : titleFromMessage(message);

  setBusy(true);
  status.textContent = "正在分析…";
  appendMessage("user", message);
  input.value = "";
  resizeInput();
  const thinking = appendThinking();

  try {
    if (!caseId) {
      const created = await requestJson("/api/cases", { method: "POST" });
      caseId = created.case_id;
      threadTitle.textContent = caseTitle;
      document.title = `${caseTitle} · FixAgent`;
      saveCurrentCase(caseTitle);
    }

    const result = await requestJson(`/api/cases/${caseId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message,
        idempotency_key: crypto.randomUUID(),
      }),
    });

    thinking.remove();
    appendMessage("agent", result.response.message_markdown);
    status.textContent = result.handoff
      ? result.handoff.status === "PERSISTENCE_FAILED"
        ? `Case ${caseId.slice(0, 8)} · 安全停止（模拟工单写入失败，尚未联系真人）`
        : `Case ${caseId.slice(0, 8)} · 模拟安全工单（尚未联系真人）`
      : `Case ${caseId.slice(0, 8)} · ${result.response.response_type}`;
    setServiceState("available");
    saveCurrentCase(caseTitle);
  } catch (error) {
    thinking.remove();
    appendMessage("agent", "本次回答未通过发布校验，请稍后重试。", {
      error: true,
    });
    status.textContent = error instanceof Error ? error.message : "请求失败";
    setServiceState("error");
    saveCurrentCase(caseTitle);
  } finally {
    setBusy(false);
    input.focus();
  }
});

input.addEventListener("input", resizeInput);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

newCaseButton.addEventListener("click", startNewCase);
document.querySelector("#sidebar-open").addEventListener("click", openSidebar);
document.querySelector("#sidebar-close").addEventListener("click", closeSidebar);
document
  .querySelector("#sidebar-backdrop")
  .addEventListener("click", closeSidebar);
caseSearchButton.addEventListener("click", () => {
  const isOpening = caseSearchPanel.hidden;
  caseSearchPanel.hidden = !isOpening;
  caseSearchButton.setAttribute("aria-expanded", String(isOpening));
  if (isOpening) {
    caseSearchInput.focus();
  } else {
    caseSearchInput.value = "";
    renderCaseList();
  }
});

caseSearchInput.addEventListener("input", renderCaseList);
caseSearchInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.stopPropagation();
    caseSearchButton.click();
    caseSearchButton.focus();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && appShell.classList.contains("sidebar-visible")) {
    closeSidebar();
  }
});

window.addEventListener("resize", () => {
  if (window.matchMedia("(max-width: 780px)").matches) {
    appShell.classList.remove("sidebar-visible");
    setSidebarAccessibility(false);
  } else {
    appShell.classList.remove("sidebar-visible");
    setSidebarAccessibility(!appShell.classList.contains("sidebar-collapsed"));
  }
  syncComposerSpace();
});

showEmptyState();
renderCaseList();
resizeInput();
setServiceState("pending");
setSidebarAccessibility(!window.matchMedia("(max-width: 780px)").matches);
if ("ResizeObserver" in window) {
  new ResizeObserver(syncComposerSpace).observe(composerDock);
}
input.focus();
