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
const modelPicker = document.querySelector("#model-picker");
const modelPickerButton = document.querySelector("#model-picker-button");
const selectedModelName = document.querySelector("#selected-model-name");
const modelMenu = document.querySelector("#model-menu");
const modelOptionsContainer = document.querySelector("#model-options");
const modelSettingsButton = document.querySelector("#model-settings-button");
const modelSettingsOverlay = document.querySelector("#model-settings-overlay");
const modelSettingsClose = document.querySelector("#model-settings-close");
const settingsProviderList = document.querySelector("#settings-provider-list");
const modelSettingsForm = document.querySelector("#model-settings-form");
const settingsProviderName = document.querySelector("#settings-provider-name");
const settingsProviderLabel = document.querySelector("#settings-provider-label");
const settingsProviderStatus = document.querySelector("#settings-provider-status");
const settingsBaseUrl = document.querySelector("#settings-base-url");
const settingsCredential = document.querySelector("#settings-credential");
const settingsSaveStatus = document.querySelector("#settings-save-status");
const settingsDelete = document.querySelector("#settings-delete");
const settingsSave = document.querySelector("#settings-save");
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
let modelOptions = [];
let selectedModelId;
let defaultModelId;
let modelConfigurationEnabled = false;
let selectedSettingsProviderId = "qwen";
let settingsBusy = false;

const providerDefaultApiUrls = {
  qwen: "https://dashscope.aliyuncs.com/apps/anthropic",
  kimi: "https://api.moonshot.cn/anthropic",
  zhipu: "https://open.bigmodel.cn/api/anthropic",
  deepseek: "https://api.deepseek.com/anthropic",
};

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
  newCaseButton.disabled = isBusy;
  input.readOnly = isBusy;
  form.setAttribute("aria-busy", String(isBusy));
  syncModelPickerState();
  renderCaseList();
}

function configuredModelOptions() {
  return modelOptions.filter((model) => model.configured);
}

function selectedModel() {
  return modelOptions.find((model) => model.id === selectedModelId);
}

function syncModelPickerState() {
  const model = selectedModel();
  selectedModelName.textContent =
    model?.display_name ||
    (configuredModelOptions().length > 0 ? "选择模型" : "暂无可用模型");
  const isLocked = navigationLocked || Boolean(caseId);
  const canChoose = configuredModelOptions().length > 0 && !isLocked;
  const canOpen = modelOptions.length > 0 && !isLocked;
  submitButton.disabled = navigationLocked || (!caseId && !model?.configured);
  modelPickerButton.disabled = !canOpen;
  modelPickerButton.title = caseId
    ? "模型已随 Case 冻结；新建 Case 后可重新选择"
    : canChoose
      ? "选择模型"
      : "查看模型配置状态";
  if (!canOpen) closeModelMenu();
  renderModelOptions();
  syncModelSettingsButton();
}

function syncModelSettingsButton() {
  const isLocked = navigationLocked || settingsBusy;
  modelSettingsButton.disabled = !modelConfigurationEnabled || isLocked;
  modelSettingsButton.title = !modelConfigurationEnabled
    ? "当前服务未启用模型设置"
    : settingsBusy
      ? "正在保存模型设置"
      : "模型设置";
}

function setSelectedModel(modelId) {
  const model = modelOptions.find(
    (candidate) => candidate.id === modelId && candidate.configured,
  );
  if (!model || caseId || navigationLocked) return;
  selectedModelId = model.id;
  syncModelPickerState();
  closeModelMenu({ restoreFocus: true });
}

function providerInitial(model) {
  const label = model.display_name || model.provider_label || "M";
  return label.trim().slice(0, 1).toLocaleUpperCase();
}

function renderModelOptions() {
  modelOptionsContainer.replaceChildren();

  for (const model of modelOptions) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "model-option";
    option.dataset.modelId = model.id;
    option.dataset.provider = model.provider_id || model.id;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(model.id === selectedModelId));
    option.tabIndex = model.id === selectedModelId && model.configured ? 0 : -1;
    option.disabled = !model.configured;

    const avatar = document.createElement("span");
    avatar.className = "model-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = providerInitial(model);

    const copy = document.createElement("span");
    copy.className = "model-option-copy";
    const name = document.createElement("strong");
    name.textContent = model.display_name;
    const detail = document.createElement("span");
    detail.textContent = model.configured
      ? `${model.provider_label} · 已配置`
      : `${model.provider_label} · 待配置`;
    copy.append(name, detail);

    const state = document.createElement("span");
    state.className = "model-option-state";
    state.textContent = model.configured
      ? model.id === selectedModelId
        ? "当前"
        : "可用"
      : "待配置";

    option.append(avatar, copy, state);
    option.addEventListener("click", () => setSelectedModel(model.id));
    modelOptionsContainer.append(option);
  }
}

function openModelMenu() {
  if (modelPickerButton.disabled) return;
  modelMenu.hidden = false;
  modelPickerButton.setAttribute("aria-expanded", "true");
  const current = modelOptionsContainer.querySelector(
    `[data-model-id="${CSS.escape(selectedModelId || "")}"]`,
  );
  requestAnimationFrame(() => current?.focus());
}

function closeModelMenu(options = {}) {
  if (modelMenu.hidden) return;
  modelMenu.hidden = true;
  modelPickerButton.setAttribute("aria-expanded", "false");
  if (options.restoreFocus) modelPickerButton.focus();
}

function moveModelFocus(direction) {
  const enabledOptions = [
    ...modelOptionsContainer.querySelectorAll(".model-option:not(:disabled)"),
  ];
  if (enabledOptions.length === 0) return;
  const currentIndex = enabledOptions.indexOf(document.activeElement);
  let nextIndex;
  if (direction === "first") nextIndex = 0;
  else if (direction === "last") nextIndex = enabledOptions.length - 1;
  else {
    const offset = direction === "next" ? 1 : -1;
    nextIndex =
      (Math.max(currentIndex, 0) + offset + enabledOptions.length) %
      enabledOptions.length;
  }
  enabledOptions[nextIndex].focus();
}

function applyModelCatalog(catalog, preferredModelId) {
  modelOptions = Array.isArray(catalog.models) ? catalog.models : [];
  defaultModelId = catalog.default_model_id || undefined;
  modelConfigurationEnabled = Boolean(catalog.configuration_enabled);
  const configuredIds = new Set(
    configuredModelOptions().map((model) => model.id),
  );
  if (!caseId) {
    selectedModelId =
      (preferredModelId && configuredIds.has(preferredModelId)
        ? preferredModelId
        : undefined) ||
      (selectedModelId && configuredIds.has(selectedModelId)
        ? selectedModelId
        : undefined) ||
      (defaultModelId && configuredIds.has(defaultModelId)
        ? defaultModelId
        : undefined) ||
      configuredModelOptions()[0]?.id;
  }
  syncModelPickerState();
  if (!modelSettingsOverlay.hidden) {
    renderSettingsProviderList();
    renderSettingsForm();
  }
}

async function loadModelCatalog() {
  try {
    const catalog = await requestJson("/api/models");
    applyModelCatalog(catalog);
  } catch {
    modelOptions = [];
    selectedModelId = undefined;
    selectedModelName.textContent = "模型目录不可用";
    modelPickerButton.disabled = true;
    modelPickerButton.title = "模型目录加载失败";
    modelConfigurationEnabled = false;
    syncModelSettingsButton();
    setServiceState("error");
  }
}

function settingsProvider() {
  return modelOptions.find((model) => model.id === selectedSettingsProviderId);
}

function renderSettingsProviderList() {
  settingsProviderList.replaceChildren();
  for (const model of modelOptions.filter((item) =>
    ["qwen", "kimi", "zhipu", "deepseek"].includes(item.id),
  )) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `settings-provider-button${model.configured ? " is-configured" : ""}`;
    button.dataset.provider = model.provider_id || model.id;
    button.disabled = settingsBusy;
    button.setAttribute(
      "aria-current",
      String(model.id === selectedSettingsProviderId),
    );

    const mark = document.createElement("span");
    mark.className = "settings-provider-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = providerInitial(model);
    const name = document.createElement("strong");
    name.textContent = model.display_name;
    const dot = document.createElement("span");
    dot.className = "settings-provider-dot";
    dot.setAttribute("aria-hidden", "true");
    button.append(mark, name, dot);
    button.addEventListener("click", () => {
      if (settingsBusy) return;
      selectedSettingsProviderId = model.id;
      settingsSaveStatus.textContent = "";
      renderSettingsProviderList();
      renderSettingsForm();
      settingsBaseUrl.focus();
    });
    settingsProviderList.append(button);
  }
}

function renderSettingsForm() {
  const model = settingsProvider();
  if (!model) return;
  settingsProviderName.textContent = model.display_name;
  settingsProviderLabel.textContent = model.provider_label;
  settingsProviderStatus.textContent = model.configured ? "已配置" : "待配置";
  settingsProviderStatus.classList.toggle("is-configured", model.configured);
  settingsBaseUrl.value =
    model.anthropic_base_url || providerDefaultApiUrls[model.id] || "";
  settingsCredential.value = "";
  settingsCredential.required = true;
  settingsCredential.placeholder = "输入 API Key";
  settingsDelete.disabled = !model.configured || settingsBusy;
  for (const control of modelSettingsForm.elements) {
    control.disabled = !modelConfigurationEnabled || settingsBusy;
  }
  settingsDelete.disabled = !model.configured || settingsBusy;
  settingsSave.disabled = !modelConfigurationEnabled || settingsBusy;
}

function openModelSettings() {
  if (modelSettingsButton.disabled) return;
  closeModelMenu();
  const selectedIsKnown = modelOptions.some(
    (model) => model.id === selectedModelId && model.id !== "default",
  );
  if (selectedIsKnown) selectedSettingsProviderId = selectedModelId;
  modelSettingsOverlay.hidden = false;
  appShell.inert = true;
  settingsSaveStatus.textContent = "";
  renderSettingsProviderList();
  renderSettingsForm();
  requestAnimationFrame(() => modelSettingsClose.focus());
}

function closeModelSettings() {
  if (settingsBusy || modelSettingsOverlay.hidden) return;
  modelSettingsOverlay.hidden = true;
  appShell.inert = false;
  modelSettingsButton.focus();
}

function setSettingsBusy(isBusy) {
  settingsBusy = isBusy;
  modelSettingsForm.setAttribute("aria-busy", String(isBusy));
  renderSettingsProviderList();
  renderSettingsForm();
  syncModelSettingsButton();
}

function settingsErrorMessage(error) {
  if (!(error instanceof Error)) return "保存失败";
  if (error.message === "PROVIDER_CREDENTIAL_REQUIRED") {
    return "请填写 API Key";
  }
  if (error.message === "INVALID_REQUEST") return "请检查配置内容";
  return "保存失败";
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
    providerProfileId: selectedModelId,
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
  if (record.providerProfileId) selectedModelId = record.providerProfileId;
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
  syncModelPickerState();
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
  syncModelPickerState();
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
      const created = await requestJson("/api/cases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(selectedModelId ? { provider_profile_id: selectedModelId } : {}),
        }),
      });
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

modelSettingsButton.addEventListener("click", openModelSettings);
modelSettingsClose.addEventListener("click", closeModelSettings);
modelSettingsOverlay.addEventListener("pointerdown", (event) => {
  if (event.target === modelSettingsOverlay) closeModelSettings();
});

modelSettingsOverlay.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeModelSettings();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [
    ...modelSettingsOverlay.querySelectorAll(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
    ),
  ].filter((element) => element.offsetParent !== null);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

modelSettingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const model = settingsProvider();
  if (!model || settingsBusy || !modelSettingsForm.reportValidity()) return;
  const credential = settingsCredential.value.trim();
  const body = {
    api_url: settingsBaseUrl.value.trim(),
    ...(credential ? { api_key: credential } : {}),
  };

  setSettingsBusy(true);
  settingsSaveStatus.textContent = "正在保存…";
  try {
    const catalog = await requestJson(`/api/models/${model.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    applyModelCatalog(catalog, model.id);
    settingsSaveStatus.textContent = "已保存";
    setServiceState("available");
  } catch (error) {
    settingsSaveStatus.textContent = settingsErrorMessage(error);
  } finally {
    setSettingsBusy(false);
  }
});

settingsDelete.addEventListener("click", async () => {
  const model = settingsProvider();
  if (!model?.configured || settingsBusy) return;
  if (!window.confirm(`移除 ${model.display_name} 的模型配置？`)) return;

  setSettingsBusy(true);
  settingsSaveStatus.textContent = "正在移除…";
  try {
    const catalog = await requestJson(`/api/models/${model.id}`, {
      method: "DELETE",
    });
    applyModelCatalog(catalog);
    settingsSaveStatus.textContent = "配置已移除";
  } catch (error) {
    settingsSaveStatus.textContent = settingsErrorMessage(error);
  } finally {
    setSettingsBusy(false);
  }
});

modelPickerButton.addEventListener("click", () => {
  if (modelMenu.hidden) openModelMenu();
  else closeModelMenu({ restoreFocus: true });
});

modelMenu.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveModelFocus("next");
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveModelFocus("previous");
  } else if (event.key === "Home") {
    event.preventDefault();
    moveModelFocus("first");
  } else if (event.key === "End") {
    event.preventDefault();
    moveModelFocus("last");
  } else if (event.key === "Escape") {
    event.stopPropagation();
    closeModelMenu({ restoreFocus: true });
  }
});

document.addEventListener("pointerdown", (event) => {
  if (!modelMenu.hidden && !modelPicker.contains(event.target)) {
    closeModelMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!modelMenu.hidden) closeModelMenu({ restoreFocus: true });
    else if (appShell.classList.contains("sidebar-visible")) closeSidebar();
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
void loadModelCatalog();
setSidebarAccessibility(!window.matchMedia("(max-width: 780px)").matches);
if ("ResizeObserver" in window) {
  new ResizeObserver(syncComposerSpace).observe(composerDock);
}
input.focus();
