import { createClientUuid } from "/client-id.js";

const appShell = document.querySelector(".app-shell");
const sidebar = document.querySelector("#sidebar");
const workspace = document.querySelector(".workspace");
const form = document.querySelector("#case-form");
const input = document.querySelector("#message");
const messages = document.querySelector("#messages");
const thread = document.querySelector("#thread");
const status = document.querySelector("#run-status");
const submitButton = document.querySelector("#submit-button");
const attachmentButton = document.querySelector("#attachment-button");
const attachmentInput = document.querySelector("#attachment-input");
const attachmentTray = document.querySelector("#attachment-tray");
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
let pendingAttachments = [];

const maxAttachmentCount = 4;
const maxAttachmentBytes = 4 * 1024 * 1024;
const maxAttachmentTotalBytes = 8 * 1024 * 1024;
const maxSourceVideoBytes = 32 * 1024 * 1024;
const supportedAttachmentTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/json",
  "text/plain",
  "text/markdown",
  "text/csv",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);
const attachmentTypeByExtension = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  json: "application/json",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

const providerDefaultApiUrls = {
  qwen: "https://token-plan.maas.qianwenaiapi.com/apps/anthropic",
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

  const attachmentNames = Array.isArray(options.attachments)
    ? options.attachments
    : [];
  if (attachmentNames.length > 0) {
    const attachmentList = document.createElement("div");
    attachmentList.className = "message-attachments";
    for (const name of attachmentNames) {
      const attachment = document.createElement("span");
      attachment.textContent = name;
      attachment.title = name;
      attachmentList.append(attachment);
    }
    content.append(attachmentList);
  }
  article.append(content);
  messages.append(article);

  if (options.record !== false) {
    activeMessages.push({
      role,
      text,
      error: Boolean(options.error),
      attachments: attachmentNames,
    });
  }

  scrollToLatest();
  return article;
}

function appendAnalysisProgress() {
  messages.querySelector(".empty-state")?.remove();
  messages.classList.remove("is-empty");

  const article = document.createElement("article");
  article.className = "message agent analysis-progress";
  article.setAttribute("aria-label", "FixAgent 正在分析");

  const details = document.createElement("details");
  details.open = true;
  const summary = document.createElement("summary");
  const dots = document.createElement("span");
  dots.className = "thinking-dots";
  dots.setAttribute("aria-hidden", "true");
  dots.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
  const title = document.createElement("strong");
  title.textContent = "分析过程";
  const state = document.createElement("span");
  state.className = "analysis-progress-state";
  state.textContent = "准备中";
  summary.append(dots, title, state);

  const list = document.createElement("ol");
  list.className = "analysis-progress-list";
  const placeholder = document.createElement("li");
  placeholder.className = "is-running";
  placeholder.textContent = "准备分析请求";
  list.append(placeholder);
  details.append(summary, list);
  article.append(details);
  messages.append(article);
  scrollToLatest();

  return {
    article,
    render(events) {
      if (!Array.isArray(events) || events.length === 0) return;
      list.replaceChildren();
      for (const event of events) {
        const item = document.createElement("li");
        item.className = `is-${event.status}`;
        const label = document.createElement("span");
        label.textContent = event.label;
        item.append(label);
        if (event.detail) {
          const detail = document.createElement("small");
          detail.textContent = event.detail;
          item.append(detail);
        }
        list.append(item);
      }
      const last = events.at(-1);
      state.textContent =
        last?.status === "error"
          ? "失败"
          : last?.status === "completed" && last?.stage === "turn_completed"
            ? "完成"
            : "进行中";
      article.classList.toggle("has-error", last?.status === "error");
      scrollToLatest();
    },
    finish(hasError = false) {
      article.classList.toggle("has-error", hasError);
      state.textContent = hasError ? "失败" : "完成";
      dots.hidden = true;
    },
  };
}

function startProgressPolling(activeCaseId, turnId, view) {
  let stopped = false;
  let timeout;

  const poll = async () => {
    try {
      const progress = await requestJson(
        `/api/cases/${activeCaseId}/progress?turn_id=${encodeURIComponent(turnId)}`,
      );
      view.render(progress.events);
    } catch {
      // The message request owns the user-visible error; progress polling is best-effort.
    }
    if (!stopped) timeout = window.setTimeout(poll, 650);
  };

  void poll();
  return async () => {
    if (stopped) return;
    stopped = true;
    window.clearTimeout(timeout);
    await poll();
  };
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
  const hasContent = Boolean(input.value.trim()) || pendingAttachments.length > 0;
  submitButton.disabled =
    navigationLocked || !hasContent || (!caseId && !model?.configured);
  attachmentButton.disabled = navigationLocked;
  attachmentInput.disabled = navigationLocked;
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

function renderAttachmentTray() {
  attachmentTray.replaceChildren();
  attachmentTray.hidden = pendingAttachments.length === 0;

  pendingAttachments.forEach((attachment, index) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";

    const name = document.createElement("span");
    name.textContent = attachment.name;
    name.title = attachment.name;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.setAttribute("aria-label", `移除文件 ${attachment.name}`);
    remove.title = "移除文件";
    remove.innerHTML = '<svg><use href="#icon-x"></use></svg>';
    remove.addEventListener("click", () => {
      pendingAttachments.splice(index, 1);
      renderAttachmentTray();
      syncModelPickerState();
      input.focus();
    });

    chip.append(name, remove);
    attachmentTray.append(chip);
  });
  syncComposerSpace();
}

function clearPendingAttachments() {
  pendingAttachments = [];
  attachmentInput.value = "";
  renderAttachmentTray();
}

function attachmentMediaType(file) {
  if (supportedAttachmentTypes.has(file.type)) return file.type;
  const extension = file.name.split(".").at(-1)?.toLocaleLowerCase();
  return extension ? attachmentTypeByExtension[extension] : undefined;
}

function readAttachment(file, mediaType) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const separator = result.indexOf(",");
      if (separator < 0) {
        reject(new Error("ATTACHMENT_READ_FAILED"));
        return;
      }
      resolve({
        name: file.name,
        media_type: mediaType,
        data_base64: result.slice(separator + 1),
        size: file.size,
      });
    });
    reader.addEventListener("error", () =>
      reject(reader.error || new Error("ATTACHMENT_READ_FAILED")),
    );
    reader.readAsDataURL(file);
  });
}

function waitForVideoEvent(video, eventName) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener(eventName, handleEvent);
      video.removeEventListener("error", handleError);
    };
    const handleEvent = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("VIDEO_DECODE_FAILED"));
    };
    video.addEventListener(eventName, handleEvent, { once: true });
    video.addEventListener("error", handleError, { once: true });
  });
}

async function extractVideoKeyframes(file) {
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.src = objectUrl;

  try {
    await waitForVideoEvent(video, "loadedmetadata");
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error("VIDEO_DURATION_INVALID");
    }
    const times = [0.1, 0.5, 0.9].map((ratio) =>
      Math.min(Math.max(video.duration * ratio, 0), video.duration - 0.01),
    );
    const longestEdge = 1280;
    const scale = Math.min(
      1,
      longestEdge / Math.max(video.videoWidth, video.videoHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("VIDEO_CANVAS_UNAVAILABLE");
    const baseName = file.name.replace(/\.[^.]+$/u, "");
    const frames = [];

    for (let index = 0; index < times.length; index += 1) {
      const seeked = waitForVideoEvent(video, "seeked");
      video.currentTime = times[index];
      await seeked;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve, reject) =>
        canvas.toBlob(
          (candidate) =>
            candidate ? resolve(candidate) : reject(new Error("VIDEO_FRAME_FAILED")),
          "image/jpeg",
          0.82,
        ),
      );
      const frame = new File(
        [blob],
        `${baseName}-frame-${index + 1}.jpg`,
        { type: "image/jpeg" },
      );
      frames.push(await readAttachment(frame, "image/jpeg"));
    }
    return frames;
  } finally {
    URL.revokeObjectURL(objectUrl);
    video.removeAttribute("src");
    video.load();
  }
}

async function addAttachments(fileList) {
  const files = [...fileList];
  const selected = [];
  for (const file of files) {
    const mediaType = attachmentMediaType(file);
    if (!mediaType) {
      window.alert(`不支持文件“${file.name}”。`);
      return;
    }
    const isVideo = mediaType.startsWith("video/");
    const sizeLimit = isVideo ? maxSourceVideoBytes : maxAttachmentBytes;
    if (!file.size || file.size > sizeLimit) {
      window.alert(
        isVideo
          ? `视频“${file.name}”必须小于 32 MB。`
          : `文件“${file.name}”必须小于 4 MB。`,
      );
      return;
    }
    selected.push({ file, mediaType, isVideo });
  }

  try {
    const converted = await Promise.all(
      selected.map(({ file, mediaType, isVideo }) =>
        isVideo
          ? extractVideoKeyframes(file)
          : readAttachment(file, mediaType).then((attachment) => [attachment]),
      ),
    );
    const attachments = converted.flat();
    if (pendingAttachments.length + attachments.length > maxAttachmentCount) {
      window.alert(
        `每次最多发送 ${maxAttachmentCount} 个附件；每段视频会生成 3 张关键帧。`,
      );
      return;
    }
    const totalBytes = [...pendingAttachments, ...attachments].reduce(
      (sum, item) => sum + item.size,
      0,
    );
    if (totalBytes > maxAttachmentTotalBytes) {
      window.alert("转换后的附件总大小不能超过 8 MB。");
      return;
    }
    pendingAttachments.push(...attachments);
    renderAttachmentTray();
    syncModelPickerState();
  } catch {
    window.alert("文件或视频关键帧读取失败，请重新选择。");
  }
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
        attachments: message.attachments,
        record: false,
      });
    }
  }

  clearPendingAttachments();
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
  clearPendingAttachments();
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
  const attachments = [...pendingAttachments];
  if ((!message && attachments.length === 0) || submitButton.disabled) return;

  const visibleMessage = message || "请分析我上传的附件。";
  const attachmentNames = attachments.map((attachment) => attachment.name);

  const caseTitle = caseId
    ? recentCases.find((item) => item.id === caseId)?.title
    : titleFromMessage(message || attachmentNames[0] || "附件分析");

  setBusy(true);
  status.textContent = "正在分析…";
  appendMessage("user", visibleMessage, { attachments: attachmentNames });
  input.value = "";
  clearPendingAttachments();
  resizeInput();
  const progressView = appendAnalysisProgress();
  const turnId = createClientUuid();
  let stopProgressPolling = async () => {};

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

    stopProgressPolling = startProgressPolling(caseId, turnId, progressView);

    const result = await requestJson(`/api/cases/${caseId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message,
        idempotency_key: turnId,
        attachments: attachments.map(
          ({ name, media_type, data_base64 }) => ({
            name,
            media_type,
            data_base64,
          }),
        ),
      }),
    });

    await stopProgressPolling();
    progressView.finish(false);
    appendMessage("agent", result.response.message_markdown);
    status.textContent = result.handoff
      ? result.handoff.status === "PERSISTENCE_FAILED"
        ? `Case ${caseId.slice(0, 8)} · 安全停止（模拟工单写入失败，尚未联系真人）`
        : `Case ${caseId.slice(0, 8)} · 模拟安全工单（尚未联系真人）`
      : `Case ${caseId.slice(0, 8)} · ${result.response.response_type}`;
    setServiceState("available");
    saveCurrentCase(caseTitle);
  } catch (error) {
    await stopProgressPolling();
    progressView.finish(true);
    const errorMessage =
      error instanceof Error && error.message === "PROVIDER_AUTHENTICATION_FAILED"
        ? "API Key 无效或与当前 API 地址不匹配，请在左下角模型设置中重新配置。"
        : error instanceof Error && error.message === "PROVIDER_ACCESS_DENIED"
          ? "当前 API Key 没有调用该模型的权限，请检查套餐或模型授权。"
          : error instanceof Error && error.message === "PROVIDER_REQUEST_REJECTED"
            ? "供应商拒绝了模型请求，请检查 API 地址和模型配置。"
            : error instanceof Error && error.message === "PROVIDER_RATE_LIMITED"
              ? "模型调用频率或额度已达上限，请稍后重试。"
              : error instanceof Error &&
                  ["INVALID_REQUEST", "REQUEST_TOO_LARGE"].includes(error.message)
        ? "文件或消息不符合上传要求，请检查后重试。"
        : error instanceof Error &&
            error.message === "AGENT_RESPONSE_NOT_PUBLISHED"
          ? "模型未完成回答发布，请重试。"
          : "请求未完成，请稍后重试。";
    appendMessage("agent", errorMessage, {
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

input.addEventListener("input", () => {
  resizeInput();
  syncModelPickerState();
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

attachmentButton.addEventListener("click", () => attachmentInput.click());
attachmentInput.addEventListener("change", async () => {
  const files = [...(attachmentInput.files || [])];
  attachmentInput.value = "";
  if (files.length) await addAttachments(files);
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
