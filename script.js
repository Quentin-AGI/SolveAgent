const header = document.querySelector("[data-header]");
const menuToggle = document.querySelector("[data-menu-toggle]");
const mobileNav = document.querySelector("[data-mobile-nav]");
const mainContent = document.querySelector("main");
const siteFooter = document.querySelector(".site-footer");

const updateHeader = () => {
  header?.classList.toggle("scrolled", window.scrollY > 24);
};

updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

const setMenuState = (isOpen, returnFocus = false) => {
  menuToggle?.setAttribute("aria-expanded", String(isOpen));
  menuToggle?.setAttribute("aria-label", isOpen ? "关闭菜单" : "打开菜单");
  mobileNav?.classList.toggle("open", isOpen);
  document.body.classList.toggle("menu-open", isOpen);
  if (mainContent) mainContent.inert = isOpen;
  if (siteFooter) siteFooter.inert = isOpen;
  if (isOpen) window.requestAnimationFrame(() => mobileNav?.querySelector("a")?.focus());
  else if (returnFocus) menuToggle?.focus();
};

menuToggle?.addEventListener("click", () => {
  setMenuState(menuToggle.getAttribute("aria-expanded") !== "true");
});

mobileNav?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    const target = link.hash ? document.querySelector(link.hash) : null;
    setMenuState(false);
    window.requestAnimationFrame(() => {
      if (!target) {
        menuToggle?.focus();
        return;
      }
      const hadTabindex = target.hasAttribute("tabindex");
      if (!hadTabindex) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
      if (!hadTabindex) {
        target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
      }
    });
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menuToggle?.getAttribute("aria-expanded") === "true") {
    setMenuState(false, true);
  }
});

const desktopBreakpoint = window.matchMedia("(min-width: 861px)");
const resetMobileMenu = (event) => {
  if (!event.matches) return;
  setMenuState(false);
};
desktopBreakpoint.addEventListener?.("change", resetMobileMenu);

const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
const motionToggle = document.querySelector("[data-motion-toggle]");
const revealItems = document.querySelectorAll(".reveal");
const networkConnection = navigator.connection;
let dataSaverEnabled = networkConnection?.saveData === true;
let motionPausedByUser = false;
let motionIsPaused = motionPreference.matches || dataSaverEnabled;

if ("IntersectionObserver" in window && !motionPreference.matches) {
  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -40px" },
  );
  revealItems.forEach((item) => revealObserver.observe(item));
} else {
  revealItems.forEach((item) => item.classList.add("visible"));
}

const syncMotionState = () => {
  const reduced = motionPreference.matches || dataSaverEnabled;
  motionIsPaused = reduced || motionPausedByUser || document.hidden;
  document.body.classList.toggle("motion-paused", motionIsPaused);
  document.body.classList.toggle("motion-reduced", reduced);
  if (reduced) revealItems.forEach((item) => item.classList.add("visible"));
  if (motionToggle) {
    motionToggle.setAttribute("aria-pressed", String(motionPausedByUser));
    motionToggle.innerHTML = motionPausedByUser
      ? '<span aria-hidden="true">▶</span> 继续动态效果'
      : '<span aria-hidden="true">Ⅱ</span> 暂停动态效果';
  }
  window.dispatchEvent(
    new CustomEvent("solve:motionchange", {
      detail: { paused: motionIsPaused, reduced, userPaused: motionPausedByUser },
    }),
  );
};

motionToggle?.addEventListener("click", () => {
  motionPausedByUser = !motionPausedByUser;
  syncMotionState();
});

syncMotionState();
motionPreference.addEventListener?.("change", syncMotionState);
networkConnection?.addEventListener?.("change", () => {
  const nextDataSaverState = networkConnection.saveData === true;
  if (nextDataSaverState === dataSaverEnabled) return;
  dataSaverEnabled = nextDataSaverState;
  syncMotionState();
});
document.addEventListener("visibilitychange", syncMotionState);

const stateChangeAnimations = new WeakMap();
const stateChangeTimers = new WeakMap();
const activeStateChangeAnimations = new Set();

const animateStateChange = (target, options = {}) => {
  if (!target || motionIsPaused) return;
  if (typeof target.animate !== "function") {
    window.clearTimeout(stateChangeTimers.get(target));
    target.classList.remove("is-state-changing");
    window.requestAnimationFrame(() => {
      target.classList.add("is-state-changing");
      const timer = window.setTimeout(() => {
        target.classList.remove("is-state-changing");
        stateChangeTimers.delete(target);
      }, options.duration || 420);
      stateChangeTimers.set(target, timer);
    });
    return;
  }
  stateChangeAnimations.get(target)?.cancel();
  const animation = target.animate(
    [
      { opacity: 0.2, transform: "translate3d(0, 9px, 0)", offset: 0 },
      { opacity: 1, transform: "translate3d(0, 0, 0)", offset: 1 },
    ],
    {
      duration: options.duration || 420,
      easing: "cubic-bezier(.22,1,.36,1)",
      fill: "none",
    },
  );
  animation.id = "solve-state-change";
  stateChangeAnimations.set(target, animation);
  activeStateChangeAnimations.add(animation);
  const cleanup = () => {
    activeStateChangeAnimations.delete(animation);
    if (stateChangeAnimations.get(target) === animation) stateChangeAnimations.delete(target);
  };
  animation.onfinish = cleanup;
  animation.oncancel = cleanup;
};

window.addEventListener("solve:motionchange", (event) => {
  if (!event.detail.paused) return;
  activeStateChangeAnimations.forEach((animation) => animation.cancel());
  activeStateChangeAnimations.clear();
});

const fixStages = [
  {
    kicker: "设备证据",
    title: "识别到故障灯连续闪红 3 次",
    description: "FixAgent 正在结合设备图片、型号与用户描述，先把“看见了什么”整理清楚，不急着给出未经验证的结论。",
    action: "核对产品资料、售后 SOP 与同型号故障记录",
    signal: "已读取：红灯连续闪烁 3 次",
    label: "看懂设备",
  },
  {
    kicker: "原因假设",
    title: "优先排查供电保护或温度传感器异常",
    description: "FixAgent 会给出待验证的可能原因，并说明判断依据；此时仍是诊断假设，不会把概率最高的原因直接当成结论。",
    action: "安排一项无需拆机、风险更低的验证步骤",
    signal: "初步判断：2 个可能原因待验证",
    label: "判断原因",
  },
  {
    kicker: "测试指引",
    title: "断开电源 30 秒，再重新连接适配器",
    description: "测试被拆成用户可以理解和执行的单一步骤，同时说明观察重点，避免一次给出过多动作或引导高风险操作。",
    action: "请反馈：恢复正常 / 仍无法启动 / 出现新状态",
    signal: "正在引导：无需拆机的安全测试",
    label: "引导测试",
  },
  {
    kicker: "动态复诊",
    title: "设备仍无法启动，已排除短时保护",
    description: "FixAgent 读取测试反馈，排除不符合的原因并更新诊断路径，让下一轮问题建立在已经验证过的证据之上。",
    action: "继续检查适配器输出与设备温度状态",
    signal: "反馈已收到：故障仍然存在",
    label: "继续诊断",
  },
  {
    kicker: "闭环处理",
    title: "建议转交专业维修，诊断记录已整理",
    description: "无法远程安全排除时，FixAgent 会汇总型号、症状、图片、已做测试、测试结果、可能原因与建议动作，生成完整售后工单。",
    action: "工单已准备：可由售后人员审核后接管",
    signal: "诊断闭环：已生成结构化工单",
    label: "解决或建单",
  },
];

const fixElements = {
  kicker: document.querySelector("[data-fix-kicker]"),
  title: document.querySelector("[data-fix-title]"),
  description: document.querySelector("[data-fix-description]"),
  action: document.querySelector("[data-fix-action]"),
  signal: document.querySelector("[data-fix-signal]"),
  progress: document.querySelector("[data-fix-progress]"),
  progressText: document.querySelector("[data-fix-progress-text]"),
  status: document.querySelector("[data-fix-status]"),
};

document.querySelectorAll("[data-fix-step]").forEach((button) => {
  button.addEventListener("click", () => {
    const index = Number(button.dataset.fixStep);
    const stage = fixStages[index];
    if (!stage) return;

    document.querySelectorAll("[data-fix-step]").forEach((item) => item.removeAttribute("aria-current"));
    button.setAttribute("aria-current", "step");
    ["kicker", "title", "description", "action", "signal"].forEach((key) => {
      if (fixElements[key]) fixElements[key].textContent = stage[key];
    });
    if (fixElements.progress) {
      fixElements.progress.setAttribute("aria-valuenow", String(index + 1));
      fixElements.progress.setAttribute("aria-valuetext", `第 ${index + 1} 步，共 5 步`);
      const bar = fixElements.progress.querySelector("span");
      if (bar) bar.style.width = `${(index + 1) * 20}%`;
    }
    if (fixElements.progressText) fixElements.progressText.textContent = `0${index + 1} / 05`;
    if (fixElements.status) fixElements.status.textContent = `当前演示步骤 ${index + 1}：${stage.label}。${stage.title}。接下来：${stage.action}。`;
    animateStateChange(document.querySelector(".fix-diagnosis-panel"));
    const scanLine = document.querySelector(".fix-scan-line");
    if (scanLine && !motionIsPaused) {
      scanLine.classList.remove("is-restarting");
      window.requestAnimationFrame(() => scanLine.classList.add("is-restarting"));
    }
  });
});

const businessContent = {
  insight: {
    title: "本周生意，有哪些值得关注？",
    note: "巴西站点转化率增长 12%，来自新品推荐策略的优化。",
  },
  risk: {
    title: "哪些风险需要优先处理？",
    note: "3 个高销量商品的退款率异常上升，建议检查尺寸描述。",
  },
  growth: {
    title: "下一个增长机会在哪里？",
    note: "西班牙站老客复购窗口已到，预计可触达 1,240 位买家。",
  },
};

const businessTitle = document.querySelector("[data-business-title]");
const businessNote = document.querySelector("[data-business-note]");
const businessStatus = document.querySelector("[data-business-status]");
document.querySelectorAll("[data-business-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-business-tab]").forEach((item) => {
      item.classList.remove("active");
      item.setAttribute("aria-pressed", "false");
    });
    button.classList.add("active");
    button.setAttribute("aria-pressed", "true");
    const next = businessContent[button.dataset.businessTab];
    if (!next) return;
    if (businessTitle) businessTitle.textContent = next.title;
    if (businessNote) businessNote.innerHTML = `<strong>Agent 发现</strong>${next.note}`;
    if (businessStatus) businessStatus.textContent = `当前演示：${button.textContent.trim()}。${next.title} ${next.note}`;
    animateStateChange(document.querySelector(".dash-main"), { duration: 360 });
  });
});

const stories = [
  {
    quote:
      "面对“设备无法启动”这类问题，FixAgent 会先看设备照片与指示灯状态，再引导用户做安全测试，并根据结果继续缩小故障范围。",
    name: "消费电子售后团队",
    role: "典型应用场景 · 非客户背书",
    avatar: "3C",
    metric: "连续诊断",
    label: "从设备照片走到解决方案或完整工单",
  },
  {
    quote:
      "美妆个护需要理解成分、肤质与使用场景。把资深客服的判断方法沉淀成 Skill 后，新品上线也能快速形成一致、可审核的服务标准。",
    name: "美妆个护团队",
    role: "典型应用场景 · 非客户背书",
    avatar: "美",
    metric: "一致性",
    label: "让全球回复遵循同一套品牌标准",
  },
  {
    quote:
      "家居业务的商品、物流与售后链路都很长。经营 Agent 不只指出问题，还能解释原因并给出下一步动作，让团队从答案直接走向执行。",
    name: "家居生活团队",
    role: "典型应用场景 · 非客户背书",
    avatar: "家",
    metric: "洞察力",
    label: "从经营异常直接找到行动建议",
  },
];

const storyElements = {
  quote: document.querySelector("[data-story-quote]"),
  name: document.querySelector("[data-story-name]"),
  role: document.querySelector("[data-story-role]"),
  avatar: document.querySelector("[data-story-avatar]"),
  metric: document.querySelector("[data-story-metric]"),
  label: document.querySelector("[data-story-label]"),
};
const storyStatus = document.querySelector("[data-story-status]");

document.querySelectorAll("[data-story]").forEach((button) => {
  button.addEventListener("click", () => {
    const story = stories[Number(button.dataset.story)];
    if (!story) return;
    document.querySelectorAll("[data-story]").forEach((item) => {
      item.classList.remove("active");
      item.setAttribute("aria-pressed", "false");
    });
    button.classList.add("active");
    button.setAttribute("aria-pressed", "true");
    Object.entries(storyElements).forEach(([key, element]) => {
      if (element) element.textContent = story[key];
    });
    if (storyStatus) storyStatus.textContent = `当前示例场景：${story.name}。${story.label}`;
    animateStateChange(document.querySelector(".story-shell"), { duration: 480 });
  });
});

const dialog = document.querySelector("[data-demo-dialog]");
const demoForm = document.querySelector("[data-demo-form]");
const formSuccess = document.querySelector("[data-form-success]");
let lastDialogTrigger;

const openDialog = (event) => {
  if (!dialog) return;
  lastDialogTrigger = event?.currentTarget;
  demoForm?.reset();
  if (demoForm) demoForm.hidden = false;
  formSuccess?.classList.remove("show");
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  document.body.classList.add("dialog-open");
};

const closeDialog = () => {
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
  document.body.classList.remove("dialog-open");
};

document.querySelectorAll("[data-demo-open]").forEach((button) => {
  button.addEventListener("click", openDialog);
});

document.querySelector("[data-demo-close]")?.addEventListener("click", closeDialog);
dialog?.addEventListener("click", (event) => {
  if (event.target === dialog) closeDialog();
});
dialog?.addEventListener("close", () => {
  document.body.classList.remove("dialog-open");
  lastDialogTrigger?.focus();
});

demoForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  demoForm.hidden = true;
  formSuccess?.classList.add("show");
  formSuccess?.focus();
});

const clampMotion = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const easeMotion = (value) => {
  const t = clampMotion(value);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

const initCapabilityCardDeck = () => {
  const main = document.querySelector("main");
  const hero = document.querySelector(".hero");
  const heroVisual = hero?.querySelector(".hero-visual");
  const capabilityGrid = document.querySelector(".fixagent-capabilities");
  const cards = capabilityGrid ? [...capabilityGrid.querySelectorAll(":scope > article")] : [];
  const visualSources = heroVisual
    ? [
        heroVisual.querySelector(".agent-core"),
        heroVisual.querySelector(".chat-card"),
        heroVisual.querySelector(".action-card"),
        heroVisual.querySelector(".metric-card"),
      ]
    : [];
  if (!main || !hero || !heroVisual || !capabilityGrid || cards.length !== 4 || visualSources.some((item) => !item)) return;

  const ROTATE_MS = 2000;
  const SWITCH_MS = 760;
  const MIGRATION_MS = 850;
  const STAGGER_MS = 82;
  const EXPAND_AT = 0.2;
  const COLLAPSE_AT = 0.09;
  const MOBILE_MAX = 767;
  const STACK_CARD_WIDTH = 346;
  const STACK_CARD_HEIGHT = 468;
  const TRACK_MAX = 1200;
  const GAP = 28;
  const foldedStates = [
    { x: 0, y: 0, rotate: 0, scale: 1 },
    { x: 108, y: 58, rotate: 7, scale: 0.84 },
    { x: 204, y: 102, rotate: 14, scale: 0.7 },
    { x: 276, y: 138, rotate: 18, scale: 0.58 },
  ];
  const compactFoldedStates = [
    { x: 0, y: 0, rotate: 0, scale: 1 },
    { x: 76, y: 46, rotate: 6, scale: 0.86 },
    { x: 124, y: 76, rotate: 10, scale: 0.72 },
    { x: 150, y: 100, rotate: 14, scale: 0.6 },
  ];

  const stage = document.createElement("div");
  stage.className = "solve-card-stage";
  stage.setAttribute("role", "region");
  stage.setAttribute("aria-label", "FixAgent 核心能力动态卡片");

  const rowSpace = document.createElement("div");
  rowSpace.className = "solve-card-row-space";
  rowSpace.setAttribute("aria-hidden", "true");

  hero.insertAdjacentElement("afterend", rowSpace);
  rowSpace.insertAdjacentElement("beforebegin", stage);
  main.classList.add("has-solve-card-deck");
  hero.classList.add("has-solve-card-deck");
  capabilityGrid.classList.add("is-deck-source");

  const articlePlaceholders = cards.map((card, index) => {
    const placeholder = document.createComment(`solve-card-${index + 1}`);
    card.parentNode?.insertBefore(placeholder, card);
    return placeholder;
  });
  const visualPlaceholders = visualSources.map((visual, index) => {
    const placeholder = document.createComment(`solve-visual-${index + 1}`);
    visual.parentNode?.insertBefore(placeholder, visual);
    return placeholder;
  });

  cards.forEach((card, index) => {
    const surface = document.createElement("div");
    surface.className = "solve-deck-card__surface";
    const media = document.createElement("div");
    media.className = "solve-deck-card__media";
    media.setAttribute("aria-hidden", "true");
    media.appendChild(visualSources[index]);
    const copy = document.createElement("div");
    copy.className = "solve-deck-card__copy";
    while (card.firstChild) copy.appendChild(card.firstChild);
    surface.append(media, copy);
    card.appendChild(surface);
    card.classList.remove("reveal", "visible", "delay-1");
    card.classList.add("solve-deck-card");
    card.dataset.cardIndex = String(index);
    card.dataset.cardDepth = String(index);
    card.setAttribute("role", "group");
    card.setAttribute("aria-roledescription", "幻灯片");
    card.setAttribute("aria-label", `${index + 1} / ${cards.length} ${copy.querySelector("h3")?.textContent?.trim() || "FixAgent 能力"}`);
    stage.appendChild(card);
  });

  const originalHeroRole = heroVisual.getAttribute("role");
  const originalHeroLabel = heroVisual.getAttribute("aria-label");
  heroVisual.setAttribute("aria-hidden", "true");
  heroVisual.removeAttribute("role");
  heroVisual.removeAttribute("aria-label");

  let active = 0;
  let migrated = false;
  let mobile = window.innerWidth <= MOBILE_MAX;
  let ready = false;
  let paused = motionIsPaused;
  let inViewport = true;
  let layout = null;
  let carouselTimer = 0;
  let switchTimer = 0;
  let settleTimer = 0;
  let revealTimer = 0;
  let resizeFrame = 0;
  let scrollFrame = 0;

  const depthOf = (index) => (index - active + cards.length) % cards.length;

  const stopCarousel = () => {
    if (!carouselTimer) return;
    window.clearInterval(carouselTimer);
    carouselTimer = 0;
  };

  const startCarousel = () => {
    stopCarousel();
    if (!ready || mobile || migrated || paused || !inViewport || document.hidden) return;
    if (stage.matches(":hover") || stage.contains(document.activeElement)) return;
    carouselTimer = window.setInterval(() => setActive(active + 1), ROTATE_MS);
  };

  const syncCardAccessibility = () => {
    cards.forEach((card, index) => {
      const isCurrent = depthOf(index) === 0;
      if (mobile || migrated) {
        card.removeAttribute("aria-hidden");
        card.tabIndex = -1;
        card.removeAttribute("aria-current");
      } else {
        card.setAttribute("aria-hidden", String(!isCurrent));
        card.tabIndex = isCurrent ? 0 : -1;
        if (isCurrent) card.setAttribute("aria-current", "true");
        else card.removeAttribute("aria-current");
      }
    });
  };

  const applyLayout = () => {
    if (!layout) return;
    if (mobile) {
      rowSpace.classList.add("is-mobile", "is-expanded");
      stage.classList.add("is-mobile", "is-migrated", "is-light-settled");
      cards.forEach((card, index) => {
        card.classList.add("is-expanded", "is-light-settled");
        card.dataset.cardDepth = String(index);
        card.style.removeProperty("width");
        card.style.removeProperty("height");
        card.style.removeProperty("transform");
        card.style.removeProperty("transition-delay");
        card.style.zIndex = String(cards.length - index);
      });
      syncCardAccessibility();
      return;
    }

    rowSpace.classList.remove("is-mobile");
    rowSpace.classList.toggle("is-expanded", migrated);
    stage.classList.remove("is-mobile");
    stage.classList.toggle("is-migrated", migrated);
    cards.forEach((card, index) => {
      card.classList.toggle("is-expanded", migrated);
      if (migrated) {
        const column = index % layout.columns;
        const row = Math.floor(index / layout.columns);
        const hoverLift = card.matches(":hover") && card.classList.contains("is-light-settled") ? -6 : 0;
        const x = layout.trackLeft + column * (layout.expandedCardWidth + GAP);
        const y = layout.spreadY + row * (layout.expandedCardHeight + GAP) + hoverLift;
        card.style.width = `${layout.expandedCardWidth}px`;
        card.style.height = `${layout.expandedCardHeight}px`;
        card.style.transform = `translate3d(${x}px, ${y}px, 0) rotateZ(0deg) scale(1)`;
        card.style.transitionDelay = `${index * STAGGER_MS}ms`;
        card.style.zIndex = "10";
        return;
      }

      const depth = depthOf(index);
      const stackStates = layout.compactStack ? compactFoldedStates : foldedStates;
      const state = stackStates[depth] || stackStates[stackStates.length - 1];
      card.dataset.cardDepth = String(depth);
      card.classList.remove("is-expanded", "is-light-settled");
      card.style.width = `${STACK_CARD_WIDTH}px`;
      card.style.height = `${STACK_CARD_HEIGHT}px`;
      card.style.transform = `translate3d(${layout.stackX + state.x}px, ${layout.stackY + state.y}px, 0) rotateZ(${state.rotate}deg) scale(${state.scale})`;
      card.style.transitionDelay = stage.classList.contains("is-card-switch-settle") ? "0ms" : `${index * STAGGER_MS}ms`;
      card.style.zIndex = String(30 - depth);
    });
    syncCardAccessibility();
  };

  const measure = () => {
    const nextMobile = window.innerWidth <= MOBILE_MAX;
    if (nextMobile !== mobile) {
      mobile = nextMobile;
      stopCarousel();
      migrated = mobile || window.scrollY / Math.max(window.innerHeight, 1) >= EXPAND_AT;
    }

    if (mobile) {
      if (stage.parentNode !== rowSpace) rowSpace.appendChild(stage);
      rowSpace.removeAttribute("aria-hidden");
    } else {
      if (stage.parentNode === rowSpace) rowSpace.insertAdjacentElement("beforebegin", stage);
      rowSpace.setAttribute("aria-hidden", "true");
    }

    hero.classList.toggle("has-mobile-deck", mobile);
    if (mobile) {
      rowSpace.style.removeProperty("--solve-deck-row-height");
      stage.style.removeProperty("height");
      layout = { mobile: true };
      applyLayout();
      return;
    }

    const mainRect = main.getBoundingClientRect();
    const heroRect = hero.getBoundingClientRect();
    const visualRect = heroVisual.getBoundingClientRect();
    const rowRect = rowSpace.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const heroTop = heroRect.top - mainRect.top;
    const heroHeight = heroRect.height;
    const visualLeft = visualRect.left - mainRect.left;
    const visualTop = visualRect.top - mainRect.top;
    const visualWidth = visualRect.width;
    const trackWidth = Math.min(TRACK_MAX, Math.max(0, viewportWidth - 64));
    const trackLeft = (viewportWidth - trackWidth) / 2 - mainRect.left;
    const columns = viewportWidth < 1180 ? 2 : 4;
    const rows = Math.ceil(cards.length / columns);
    const expandedCardWidth = (trackWidth - GAP * (columns - 1)) / columns;
    const expandedMediaHeight = columns === 4
      ? Math.max(210, expandedCardWidth - 16)
      : Math.min(300, Math.max(230, expandedCardWidth * 0.62));
    const expandedCardHeight = Math.round(expandedMediaHeight + (columns === 4 ? 205 : 175));
    const rowHeight = Math.round(160 + rows * expandedCardHeight + (rows - 1) * GAP);
    const stackCenterY = Math.round(heroHeight * 0.5 - STACK_CARD_HEIGHT / 2 - 36);
    const stackY = viewportWidth <= 860
      ? Math.round(visualTop + Math.max(12, (visualRect.height - STACK_CARD_HEIGHT) / 2))
      : heroTop + clampMotion(
          stackCenterY,
          72,
          Math.max(72, heroHeight - 118 - STACK_CARD_HEIGHT),
        );
    const stackX = Math.round(
      visualLeft + Math.max(0, (visualWidth - STACK_CARD_WIDTH) / 2 - Math.min(70, visualWidth * 0.1)),
    );
    const spreadY = Math.round(rowRect.top - mainRect.top + 80);

    layout = {
      mobile: false,
      columns,
      trackLeft,
      stackX,
      stackY,
      spreadY,
      expandedCardWidth,
      expandedCardHeight,
      expandedMediaHeight,
      rowHeight,
      compactStack: viewportWidth < 1400,
    };
    rowSpace.style.setProperty("--solve-deck-row-height", `${rowHeight}px`);
    stage.style.height = `${Math.round(heroHeight + rowHeight)}px`;
    cards.forEach((card) => card.style.setProperty("--solve-deck-expanded-media-height", `${expandedMediaHeight}px`));
    applyLayout();
  };

  function setActive(next) {
    if (mobile || migrated) return;
    const normalized = ((next % cards.length) + cards.length) % cards.length;
    if (normalized === active) return;
    if (switchTimer) window.clearTimeout(switchTimer);
    active = normalized;
    stage.classList.add("is-card-switch-settle");
    applyLayout();
    switchTimer = window.setTimeout(() => {
      stage.classList.remove("is-card-switch-settle");
      switchTimer = 0;
      applyLayout();
    }, SWITCH_MS + 80);
  }

  const setMigrated = (next) => {
    if (mobile || migrated === next) return;
    migrated = next;
    if (settleTimer) window.clearTimeout(settleTimer);
    cards.forEach((card) => card.classList.remove("is-light-settled"));
    stage.classList.remove("is-light-settled", "is-card-switch-settle");
    rowSpace.classList.toggle("is-expanded", migrated);
    applyLayout();
    if (migrated) {
      stopCarousel();
      settleTimer = window.setTimeout(() => {
        cards.forEach((card) => card.classList.add("is-light-settled"));
        stage.classList.add("is-light-settled");
        settleTimer = 0;
      }, 660);
    } else {
      startCarousel();
    }
  };

  const revealDeck = () => {
    if (ready) return;
    if (revealTimer) {
      window.clearTimeout(revealTimer);
      revealTimer = 0;
    }
    ready = true;
    stage.classList.add("is-ready");
    hero.classList.add("is-deck-ready");
    if (document.body.classList.contains("motion-reduced") && !mobile) setMigrated(true);
    startCarousel();
  };

  const onScroll = () => {
    if (scrollFrame) return;
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = 0;
      if (mobile) return;
      const progress = window.scrollY / Math.max(window.innerHeight, 1);
      if (!migrated && progress >= EXPAND_AT) {
        revealDeck();
        setMigrated(true);
      } else if (migrated && progress <= COLLAPSE_AT && !document.body.classList.contains("motion-reduced")) {
        setMigrated(false);
      }
    });
  };

  const requestMeasure = () => {
    if (resizeFrame) return;
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0;
      measure();
      onScroll();
    });
  };

  cards.forEach((card, index) => {
    card.addEventListener("click", () => {
      if (!mobile && !migrated) {
        setActive(index);
        startCarousel();
      }
    });
    card.addEventListener("mouseenter", () => {
      stopCarousel();
      if (migrated) applyLayout();
    });
    card.addEventListener("mouseleave", () => {
      if (migrated) applyLayout();
      startCarousel();
    });
    card.addEventListener("keydown", (event) => {
      if (mobile || migrated) return;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        setActive(active + 1);
        cards[(active + cards.length) % cards.length]?.focus();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        setActive(active - 1);
        cards[(active + cards.length) % cards.length]?.focus();
      }
    });
  });

  stage.addEventListener("focusin", stopCarousel);
  stage.addEventListener("focusout", (event) => {
    if (!stage.contains(event.relatedTarget)) startCarousel();
  });

  const onMotionChange = (event) => {
    paused = event.detail.paused;
    if (document.hidden) {
      stopCarousel();
      return;
    }
    if (paused) {
      revealDeck();
      if (!mobile) setMigrated(true);
      stopCarousel();
      return;
    }
    if (!event.detail.reduced && !mobile) {
      const progress = window.scrollY / Math.max(window.innerHeight, 1);
      if (progress <= COLLAPSE_AT) setMigrated(false);
    }
    startCarousel();
  };

  window.addEventListener("solve:motionchange", onMotionChange);
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", requestMeasure, { passive: true });

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      ([entry]) => {
        inViewport = Boolean(entry?.isIntersecting);
        if (inViewport) startCarousel();
        else stopCarousel();
      },
      { threshold: 0.01 },
    );
    observer.observe(hero);
  }

  measure();
  onScroll();
  if (mobile || motionIsPaused) revealDeck();
  else revealTimer = window.setTimeout(revealDeck, 4400);

  return () => {
    stopCarousel();
    if (switchTimer) window.clearTimeout(switchTimer);
    if (settleTimer) window.clearTimeout(settleTimer);
    if (revealTimer) window.clearTimeout(revealTimer);
    window.removeEventListener("solve:motionchange", onMotionChange);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", requestMeasure);
    cards.forEach((card, index) => {
      const surface = card.querySelector(":scope > .solve-deck-card__surface");
      const copy = surface?.querySelector(":scope > .solve-deck-card__copy");
      if (copy) while (copy.firstChild) card.appendChild(copy.firstChild);
      surface?.remove();
      card.classList.remove("solve-deck-card", "is-expanded", "is-light-settled");
      card.removeAttribute("style");
      card.removeAttribute("aria-hidden");
      card.removeAttribute("aria-current");
      card.removeAttribute("role");
      card.removeAttribute("aria-roledescription");
      card.removeAttribute("aria-label");
      card.removeAttribute("tabindex");
      articlePlaceholders[index].parentNode?.insertBefore(card, articlePlaceholders[index].nextSibling);
      articlePlaceholders[index].remove();
      visualPlaceholders[index].parentNode?.insertBefore(visualSources[index], visualPlaceholders[index].nextSibling);
      visualPlaceholders[index].remove();
    });
    capabilityGrid.classList.remove("is-deck-source");
    hero.classList.remove("has-solve-card-deck", "has-mobile-deck", "is-deck-ready");
    main.classList.remove("has-solve-card-deck");
    if (originalHeroRole) heroVisual.setAttribute("role", originalHeroRole);
    if (originalHeroLabel) heroVisual.setAttribute("aria-label", originalHeroLabel);
    heroVisual.removeAttribute("aria-hidden");
    stage.remove();
    rowSpace.remove();
  };
};

const initQuantumField = () => {
  const hero = document.querySelector(".hero");
  const heroVisual = document.querySelector(".hero-visual");
  if (!hero || !heroVisual) return;
  if (motionPreference.matches || dataSaverEnabled) {
    document.body.classList.add("motion-intro-complete");
    const initializeWhenEnabled = (event) => {
      if (event.detail.paused || event.detail.reduced) return;
      window.removeEventListener("solve:motionchange", initializeWhenEnabled);
      initQuantumField();
    };
    window.addEventListener("solve:motionchange", initializeWhenEnabled);
    return;
  }

  const core = document.querySelector(".solve-card-stage .agent-core") || heroVisual.querySelector(".agent-core");
  const floatingCards = [
    ...document.querySelectorAll(".solve-card-stage .float-card, .hero-visual .float-card"),
  ];

  const canvas = document.createElement("canvas");
  canvas.className = "quantum-field";
  canvas.setAttribute("aria-hidden", "true");
  canvas.setAttribute("role", "presentation");
  hero.insertBefore(canvas, hero.firstChild);
  document.body.classList.add("motion-enhanced");
  const completeIntro = () => document.body.classList.add("motion-intro-complete");
  window.setTimeout(completeIntro, 1900);
  window.addEventListener("solve:motionchange", (event) => {
    if (event.detail.paused) completeIntro();
  });

  const context = canvas.getContext("2d", { alpha: true, desynchronized: true });
  if (!context) return;

  const staticCanvas = document.createElement("canvas");
  const staticContext = staticCanvas.getContext("2d", { alpha: true });
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  const coarsePointer = window.matchMedia("(pointer: coarse)");
  const pointerSurface = document.querySelector("main") || hero;
  const lowPowerDevice =
    (navigator.deviceMemory && navigator.deviceMemory <= 4) ||
    (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);

  let width = 0;
  let height = 0;
  let viewportHeight = 0;
  let dpr = 1;
  let particleCount = 0;
  let radii = new Float32Array(0);
  let angles = new Float32Array(0);
  let phases = new Float32Array(0);
  let sizes = new Float32Array(0);
  let tones = new Uint8Array(0);
  let drawX = new Float32Array(0);
  let drawY = new Float32Array(0);
  let surfaceCount = 0;
  let surfaceRings = 0;
  let surfaceSpokes = 0;
  let surfaceRadii = new Float32Array(0);
  let surfaceAngles = new Float32Array(0);
  let surfacePhases = new Float32Array(0);
  let surfaceSizes = new Float32Array(0);
  let surfaceBands = new Uint8Array(0);
  let surfaceCrests = new Float32Array(0);
  let surfaceDrawX = new Float32Array(0);
  let surfaceDrawY = new Float32Array(0);
  let surfaceGradient = null;
  let frameHandle = 0;
  let resizeHandle = 0;
  let lastFrameAt = 0;
  let elapsed = 0;
  let inViewport = true;
  let paused = motionIsPaused;
  let pointerInside = false;
  let pointerRect = null;
  let pointerTargetX = 0;
  let pointerTargetY = 0;
  let pointerX = 0;
  let pointerY = 0;
  let appliedPointerX = Number.NaN;
  let appliedPointerY = Number.NaN;

  const setParallax = (x, y, force = false) => {
    if (!force && Math.abs(x - appliedPointerX) < 0.001 && Math.abs(y - appliedPointerY) < 0.001) return;
    appliedPointerX = x;
    appliedPointerY = y;
    if (core) {
      core.style.setProperty("--core-x", `${(x * 11).toFixed(2)}px`);
      core.style.setProperty("--core-y", `${(y * 8).toFixed(2)}px`);
      core.style.setProperty("--deck-parallax-x", `${(x * 8).toFixed(2)}px`);
      core.style.setProperty("--deck-parallax-y", `${(y * 6).toFixed(2)}px`);
    }
    const depth = [0.46, 0.82, 1.08];
    floatingCards.forEach((card, index) => {
      const amount = depth[index] || 0.65;
      card.style.setProperty("--card-x", `${(x * 10 * amount).toFixed(2)}px`);
      card.style.setProperty("--card-y", `${(y * 8 * amount).toFixed(2)}px`);
      card.style.setProperty("--deck-parallax-x", `${(x * 7 * amount).toFixed(2)}px`);
      card.style.setProperty("--deck-parallax-y", `${(y * 5 * amount).toFixed(2)}px`);
    });
    heroVisual.style.setProperty("--light-x", `${50 + x * 15}%`);
    heroVisual.style.setProperty("--light-y", `${42 + y * 12}%`);
  };

  const resetParallax = () => {
    pointerTargetX = 0;
    pointerTargetY = 0;
    pointerX = 0;
    pointerY = 0;
    setParallax(0, 0, true);
  };

  const getFieldGeometry = () => {
    const visualHeight = width <= 1100 ? Math.min(height, viewportHeight || window.innerHeight) : height;
    const mobile = width <= 767;
    return {
      centerX: width * 0.68,
      centerY: mobile ? height * 0.76 : visualHeight * (width <= 1100 ? 0.72 : 0.75),
      radiusX: width * (mobile ? 0.72 : 0.57),
      radiusY: (mobile ? height : visualHeight) * (mobile ? 0.31 : width <= 1100 ? 0.43 : 0.46),
      sinkDepth: (mobile ? height : visualHeight) * (mobile ? 0.14 : 0.22),
    };
  };

  const drawStaticField = () => {
    if (!staticContext || !width || !height) return;
    staticContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    staticContext.clearRect(0, 0, width, height);

    const { centerX, centerY, radiusX, radiusY, sinkDepth } = getFieldGeometry();

    staticContext.lineWidth = 0.7;
    for (let ring = 1; ring <= 7; ring += 1) {
      const radius = 0.12 + ring * 0.12;
      staticContext.beginPath();
      for (let step = 0; step <= 100; step += 1) {
        const angle = (step / 100) * Math.PI * 2;
        const x = centerX + Math.cos(angle) * radiusX * radius;
        const y =
          centerY +
          Math.sin(angle) * radiusY * radius +
          sinkDepth * Math.pow(Math.max(0, 1 - radius), 2.15);
        if (step === 0) staticContext.moveTo(x, y);
        else staticContext.lineTo(x, y);
      }
      staticContext.strokeStyle = `rgba(111, 129, 255, ${0.018 + ring * 0.004})`;
      staticContext.stroke();
    }

    for (let spoke = 0; spoke < 14; spoke += 1) {
      const angle = (spoke / 14) * Math.PI * 2;
      staticContext.beginPath();
      for (let step = 0; step <= 24; step += 1) {
        const radius = 0.12 + (step / 24) * 0.88;
        const x = centerX + Math.cos(angle) * radiusX * radius;
        const y = centerY + Math.sin(angle) * radiusY * radius + sinkDepth * Math.pow(1 - radius, 2.15);
        if (step === 0) staticContext.moveTo(x, y);
        else staticContext.lineTo(x, y);
      }
      staticContext.strokeStyle = "rgba(105, 135, 255, .025)";
      staticContext.stroke();
    }

    const mobile = width <= 767;
    const constrained = width <= 1100 || lowPowerDevice || coarsePointer.matches;
    const staticCount = mobile ? 96 : constrained ? 180 : 260;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let index = 0; index < staticCount; index += 1) {
      const radius = 0.13 + Math.sqrt((index + 0.5) / staticCount) * 0.9;
      const angle = index * goldenAngle + Math.sin(index * 0.41) * 0.045;
      const x = centerX + Math.cos(angle) * radiusX * radius;
      const y =
        centerY +
        Math.sin(angle) * radiusY * radius +
        sinkDepth * Math.pow(Math.max(0, 1 - radius), 2.15);
      const textFade = clampMotion((x / width - 0.18) / 0.42, 0.12, 1);
      const front = 0.55 + Math.sin(angle) * 0.22;
      const alpha = (0.06 + (1 - radius) * 0.14) * textFade * front;
      const size = radius < 0.28 ? 1.15 : 0.72;
      staticContext.fillStyle = `rgba(185, 202, 255, ${alpha})`;
      staticContext.beginPath();
      staticContext.arc(x, y, size, 0, Math.PI * 2);
      staticContext.fill();
    }
  };

  const rebuild = () => {
    const bounds = hero.getBoundingClientRect();
    width = Math.max(1, Math.round(bounds.width));
    height = Math.max(1, Math.round(bounds.height));
    viewportHeight = Math.max(1, Math.round(window.innerHeight));
    const mobile = width <= 767;
    const cap = mobile ? 1 : 1.5;
    const areaCap = Math.sqrt(1990000 / Math.max(width * height, 1));
    dpr = Math.max(0.1, Math.min(window.devicePixelRatio || 1, cap, areaCap));

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    staticCanvas.width = canvas.width;
    staticCanvas.height = canvas.height;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    surfaceGradient = context.createLinearGradient(width * 0.14, 0, width, 0);
    surfaceGradient.addColorStop(0, "rgba(95, 120, 255, .24)");
    surfaceGradient.addColorStop(0.36, "rgba(145, 166, 255, .8)");
    surfaceGradient.addColorStop(0.7, "rgba(226, 237, 255, 1)");
    surfaceGradient.addColorStop(1, "rgba(126, 199, 255, .85)");

    const constrained = width <= 1100 || lowPowerDevice || coarsePointer.matches;
    particleCount = mobile ? 12 : constrained ? 28 : 64;
    radii = new Float32Array(particleCount);
    angles = new Float32Array(particleCount);
    phases = new Float32Array(particleCount);
    sizes = new Float32Array(particleCount);
    tones = new Uint8Array(particleCount);
    drawX = new Float32Array(particleCount);
    drawY = new Float32Array(particleCount);

    surfaceRings = mobile ? 16 : constrained ? 24 : 30;
    surfaceSpokes = mobile ? 48 : constrained ? 68 : 88;
    surfaceCount = surfaceRings * surfaceSpokes;
    surfaceRadii = new Float32Array(surfaceCount);
    surfaceAngles = new Float32Array(surfaceCount);
    surfacePhases = new Float32Array(surfaceCount);
    surfaceSizes = new Float32Array(surfaceCount);
    surfaceBands = new Uint8Array(surfaceCount);
    surfaceCrests = new Float32Array(surfaceCount);
    surfaceDrawX = new Float32Array(surfaceCount);
    surfaceDrawY = new Float32Array(surfaceCount);

    for (let ring = 0; ring < surfaceRings; ring += 1) {
      const ringProgress = ring / Math.max(1, surfaceRings - 1);
      const radius = 0.045 + Math.pow(ringProgress, 0.82) * 1.04;
      for (let spoke = 0; spoke < surfaceSpokes; spoke += 1) {
        const index = ring * surfaceSpokes + spoke;
        const angle = (spoke / surfaceSpokes) * Math.PI * 2 + (ring % 2) * 0.0025;
        const depth = (Math.sin(angle) + 1) * 0.5;
        surfaceRadii[index] = radius;
        surfaceAngles[index] = angle;
        surfacePhases[index] = Math.sin(angle * 2 + ringProgress * 5.4) * 0.42;
        surfaceSizes[index] = 1 + depth * 0.74 + ((ring + spoke) % 7 === 0 ? 0.22 : 0);
        surfaceBands[index] = depth > 0.68 ? 2 : depth > 0.34 ? 1 : 0;
      }
    }

    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let index = 0; index < particleCount; index += 1) {
      radii[index] = 0.14 + Math.sqrt((index + 0.6) / particleCount) * 0.88;
      angles[index] = index * goldenAngle;
      phases[index] = ((index * 37) % 101) / 101 * Math.PI * 2;
      sizes[index] = 0.8 + ((index * 17) % 13) / 13 * 1.8;
      tones[index] = index % 5;
    }
    pointerRect = hero.getBoundingClientRect();
    drawStaticField();
  };

  const requestRebuild = () => {
    if (resizeHandle) return;
    resizeHandle = window.requestAnimationFrame(() => {
      resizeHandle = 0;
      const bounds = hero.getBoundingClientRect();
      const nextWidth = Math.max(1, Math.round(bounds.width));
      const nextHeight = Math.max(1, Math.round(bounds.height));
      const nextViewportHeight = Math.max(1, Math.round(window.innerHeight));
      const nextMobile = nextWidth <= 767;
      const nextCap = nextMobile ? 1 : 1.5;
      const nextAreaCap = Math.sqrt(1990000 / Math.max(nextWidth * nextHeight, 1));
      const nextDpr = Math.max(0.1, Math.min(window.devicePixelRatio || 1, nextCap, nextAreaCap));
      pointerRect = hero.getBoundingClientRect();
      if (
        nextWidth === width &&
        nextHeight === height &&
        nextViewportHeight === viewportHeight &&
        Math.abs(nextDpr - dpr) < 0.001
      ) return;
      rebuild();
    });
  };

  const shapeMixAt = (time) => {
    if (time < 600) return 0;
    if (time < 1800) return easeMotion((time - 600) / 1200);
    if (time < 2700) return 1;
    if (time < 4400) return 1 - easeMotion((time - 2700) / 1700);
    return 0;
  };

  const drawWaveSurface = (time, centerX, centerY, radiusX, radiusY, sinkDepth) => {
    if (!surfaceCount || !surfaceGradient) return;
    const seconds = time * 0.001;

    for (let index = 0; index < surfaceCount; index += 1) {
      const radius = surfaceRadii[index];
      const angle = surfaceAngles[index];
      const phase = surfacePhases[index];
      const radialWave = Math.sin(radius * 19.5 - seconds * 1.34 + phase);
      const crossWave = Math.sin(angle * 3 + seconds * 0.68 + radius * 4.4);
      const travelingCrest = Math.sin(radius * 12.8 + angle * 2 - seconds * 0.92);
      const lift =
        radialWave * (2.4 + radius * 7.8) +
        crossWave * (1.2 + (1 - Math.min(radius, 1)) * 4.2) +
        travelingCrest * (1.4 + radius * 3.8);
      const breathing = 1 + Math.sin(seconds * 0.42 + radius * 5.2) * 0.012;
      const x =
        centerX +
        Math.cos(angle) * radiusX * radius * breathing +
        pointerX * (8 + (1 - Math.min(radius, 1)) * 8);
      const y =
        centerY +
        Math.sin(angle) * radiusY * radius +
        sinkDepth * Math.pow(Math.max(0, 1 - radius), 2.05) +
        lift +
        pointerY * (4 + (1 - Math.min(radius, 1)) * 6);
      surfaceDrawX[index] = x;
      surfaceDrawY[index] = y;
      surfaceCrests[index] = travelingCrest;
    }

    context.save();
    context.globalCompositeOperation = "lighter";
    context.fillStyle = surfaceGradient;
    const drawBand = (band, alpha) => {
      context.beginPath();
      for (let index = 0; index < surfaceCount; index += 1) {
        if (surfaceBands[index] !== band) continue;
        const size = surfaceSizes[index] * (0.92 + Math.max(0, surfaceCrests[index]) * 0.22);
        context.moveTo(surfaceDrawX[index] + size, surfaceDrawY[index]);
        context.arc(surfaceDrawX[index], surfaceDrawY[index], size, 0, Math.PI * 2);
      }
      context.globalAlpha = alpha;
      context.fill();
    };
    drawBand(0, 0.7);
    drawBand(1, 0.9);
    drawBand(2, 1);

    context.beginPath();
    for (let spoke = 0; spoke < surfaceSpokes; spoke += 8) {
      for (let ring = 0; ring < surfaceRings; ring += 1) {
        const index = ring * surfaceSpokes + spoke;
        if (ring === 0) context.moveTo(surfaceDrawX[index], surfaceDrawY[index]);
        else context.lineTo(surfaceDrawX[index], surfaceDrawY[index]);
      }
    }
    for (let ring = 4; ring < surfaceRings; ring += 6) {
      const offset = ring * surfaceSpokes;
      for (let spoke = 0; spoke <= surfaceSpokes; spoke += 1) {
        const index = offset + (spoke % surfaceSpokes);
        if (spoke === 0) context.moveTo(surfaceDrawX[index], surfaceDrawY[index]);
        else context.lineTo(surfaceDrawX[index], surfaceDrawY[index]);
      }
    }
    context.globalAlpha = 0.17;
    context.strokeStyle = "rgba(126, 154, 255, .72)";
    context.lineWidth = 0.58;
    context.stroke();

    context.beginPath();
    for (let index = 0; index < surfaceCount; index += 1) {
      if (surfaceCrests[index] <= 0.91 || (index + Math.floor(seconds * 5)) % 3 !== 0) continue;
      const crestSize = surfaceSizes[index] * 1.34;
      context.moveTo(surfaceDrawX[index] + crestSize, surfaceDrawY[index]);
      context.arc(surfaceDrawX[index], surfaceDrawY[index], crestSize, 0, Math.PI * 2);
    }
    context.globalAlpha = 0.86;
    context.fillStyle = "rgba(214, 232, 255, .95)";
    context.shadowColor = "rgba(90, 143, 255, .78)";
    context.shadowBlur = 7;
    context.fill();
    context.restore();
  };

  const drawFrame = (time) => {
    frameHandle = 0;
    if (paused || !inViewport || document.hidden) return;
    if (!lastFrameAt) lastFrameAt = time;
    const delta = Math.min(64, time - lastFrameAt);
    const targetFrameTime = lowPowerDevice || coarsePointer.matches ? (elapsed < 5000 ? 42 : 50) : 33;
    if (delta < targetFrameTime) {
      frameHandle = window.requestAnimationFrame(drawFrame);
      return;
    }
    lastFrameAt = time;
    elapsed += delta;

    pointerX += (pointerTargetX - pointerX) * 0.085;
    pointerY += (pointerTargetY - pointerY) * 0.085;
    setParallax(pointerX, pointerY);

    context.clearRect(0, 0, width, height);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.drawImage(staticCanvas, 0, 0, width, height);

    const mix = shapeMixAt(elapsed) * 0.28;
    const { centerX, centerY, radiusX, radiusY, sinkDepth } = getFieldGeometry();
    const logoCenterX = width * (width <= 860 ? 0.54 : 0.72);
    const logoCenterY = height * (width <= 860 ? 0.68 : 0.49);
    const logoRadiusX = Math.min(width * 0.115, 165);
    const logoRadiusY = Math.min(height * 0.085, 64);

    drawWaveSurface(elapsed, centerX, centerY, radiusX, radiusY, sinkDepth);

    for (let index = 0; index < particleCount; index += 1) {
      const radius = radii[index];
      const angle = angles[index] + elapsed * 0.000028 * (1.15 - radius);
      const wave = Math.sin(elapsed * 0.00125 - radius * 15 + phases[index]);
      const waveLift = wave * (2 + (1 - radius) * 7);
      const funnelX =
        centerX + Math.cos(angle) * radiusX * radius + pointerX * (5 + (1 - radius) * 5);
      const funnelY =
        centerY +
        Math.sin(angle) * radiusY * radius +
        sinkDepth * Math.pow(Math.max(0, 1 - radius), 2.15) +
        waveLift +
        pointerY * (3 + (1 - radius) * 4);
      const logoAngle = (index / particleCount) * Math.PI * 2;
      const logoX = logoCenterX + Math.sin(logoAngle) * logoRadiusX;
      const logoY = logoCenterY + Math.sin(logoAngle * 2) * logoRadiusY;
      drawX[index] = funnelX + (logoX - funnelX) * mix;
      drawY[index] = funnelY + (logoY - funnelY) * mix;
    }

    context.save();
    context.globalCompositeOperation = "lighter";
    if (width > 767) {
      context.beginPath();
      for (let index = 0; index < particleCount; index += 2) {
        const linked = (index + 5) % particleCount;
        const dx = drawX[index] - drawX[linked];
        const dy = drawY[index] - drawY[linked];
        if (dx * dx + dy * dy > width * width * 0.022) continue;
        context.moveTo(drawX[index], drawY[index]);
        context.lineTo(drawX[linked], drawY[linked]);
      }
      context.strokeStyle = `rgba(103, 134, 255, ${0.055 + mix * 0.035})`;
      context.lineWidth = 0.65;
      context.stroke();
    }

    for (let index = 0; index < particleCount; index += 1) {
      const radius = radii[index];
      const pulse = 0.72 + 0.28 * Math.sin(elapsed * 0.0016 + phases[index]);
      const alpha = (0.28 + (1 - radius) * 0.46) * pulse;
      const size = sizes[index] * (1 + mix * 0.38);
      const tone = tones[index];
      const rgb = tone === 0 ? "104, 218, 255" : tone <= 2 ? "118, 126, 255" : "214, 223, 255";
      context.fillStyle = `rgba(${rgb}, ${alpha * 0.18})`;
      context.beginPath();
      context.arc(drawX[index], drawY[index], size * 3.2, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = `rgba(${rgb}, ${Math.min(0.92, alpha + 0.18)})`;
      context.beginPath();
      context.arc(drawX[index], drawY[index], size, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();

    frameHandle = window.requestAnimationFrame(drawFrame);
  };

  const start = () => {
    if (frameHandle || paused || !inViewport || document.hidden) return;
    lastFrameAt = 0;
    frameHandle = window.requestAnimationFrame(drawFrame);
  };

  const stop = (resetPointer = false) => {
    if (frameHandle) window.cancelAnimationFrame(frameHandle);
    frameHandle = 0;
    lastFrameAt = 0;
    if (resetPointer) resetParallax();
  };

  const onMotionChange = (event) => {
    paused = event.detail.paused;
    canvas.classList.toggle("is-paused", paused);
    if (paused) stop(true);
    else start();
  };

  const onPointerMove = (event) => {
    if (!finePointer.matches || paused) return;
    if (!inViewport) {
      if (pointerInside) onPointerLeave();
      return;
    }
    pointerRect = hero.getBoundingClientRect();
    const insideHero =
      event.clientX >= pointerRect.left &&
      event.clientX <= pointerRect.right &&
      event.clientY >= pointerRect.top &&
      event.clientY <= pointerRect.bottom;
    if (!insideHero) {
      if (pointerInside) onPointerLeave();
      return;
    }
    if (!pointerInside) {
      pointerInside = true;
      heroVisual.classList.add("is-pointer-active");
    }
    pointerTargetX = clampMotion((event.clientX - pointerRect.left) / pointerRect.width, 0, 1) * 2 - 1;
    pointerTargetY = clampMotion((event.clientY - pointerRect.top) / pointerRect.height, 0, 1) * 2 - 1;
  };

  const onPointerLeave = () => {
    pointerInside = false;
    pointerTargetX = 0;
    pointerTargetY = 0;
    heroVisual.classList.remove("is-pointer-active");
  };

  pointerSurface.addEventListener("pointermove", onPointerMove, { passive: true });
  pointerSurface.addEventListener("pointerleave", onPointerLeave, { passive: true });
  window.addEventListener("solve:motionchange", onMotionChange);
  window.addEventListener("resize", requestRebuild, { passive: true });
  window.visualViewport?.addEventListener("resize", requestRebuild, { passive: true });

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      ([entry]) => {
        inViewport = Boolean(entry?.isIntersecting);
        if (inViewport) start();
        else stop(true);
      },
      { threshold: 0.01 },
    );
    observer.observe(hero);
  }

  rebuild();
  window.requestAnimationFrame(() => canvas.classList.add("is-ready"));
  start();
};

const initScrollMotion = () => {
  const hero = document.querySelector(".hero");
  const roadmap = document.querySelector(".skill-roadmap");
  const steps = roadmap ? [...roadmap.querySelectorAll(".skill-step")] : [];
  const cta = document.querySelector(".cta-section");
  if (!hero && !roadmap && !cta) return;

  let frameHandle = 0;
  const update = () => {
    frameHandle = 0;
    const viewportHeight = Math.max(window.innerHeight, 1);
    let heroShift = null;
    let heroFieldOpacity = null;
    let roadProgress = null;
    let activeIndex = -1;
    let ctaShift = null;

    if (hero) {
      const rect = hero.getBoundingClientRect();
      const progress = clampMotion(-rect.top / Math.max(rect.height, 1));
      heroShift = motionIsPaused ? "0px" : `${(-progress * 12).toFixed(2)}px`;
      heroFieldOpacity = `${(1 - progress * 0.18).toFixed(3)}`;
    }

    if (roadmap) {
      const rect = roadmap.getBoundingClientRect();
      const trigger = viewportHeight * 0.52;
      const progress = clampMotion((trigger - rect.top) / Math.max(rect.height, 1));
      roadProgress = `${(progress * 100).toFixed(2)}%`;
      activeIndex = 0;
      let closest = Number.POSITIVE_INFINITY;
      steps.forEach((step, index) => {
        const stepRect = step.getBoundingClientRect();
        const distance = Math.abs(stepRect.top + stepRect.height * 0.5 - trigger);
        if (distance < closest) {
          closest = distance;
          activeIndex = index;
        }
      });
    }

    if (cta) {
      const rect = cta.getBoundingClientRect();
      const progress = clampMotion((viewportHeight - rect.top) / (viewportHeight + rect.height));
      ctaShift = motionIsPaused ? "0px" : `${((progress - 0.5) * 24).toFixed(2)}px`;
    }

    if (heroShift !== null) {
      hero.style.setProperty("--hero-shift", heroShift);
      hero.style.setProperty("--hero-field-opacity", heroFieldOpacity);
    }
    if (roadProgress !== null) {
      roadmap.style.setProperty("--road-progress", roadProgress);
      roadmap.dataset.roadStage = String(activeIndex + 1);
      steps.forEach((step, index) => step.classList.toggle("is-current", index === activeIndex));
    }
    if (ctaShift !== null) cta.style.setProperty("--cta-orb-shift", ctaShift);
  };

  const requestUpdate = () => {
    if (frameHandle) return;
    frameHandle = window.requestAnimationFrame(update);
  };

  window.addEventListener("scroll", requestUpdate, { passive: true });
  window.addEventListener("resize", requestUpdate, { passive: true });
  window.addEventListener("solve:motionchange", requestUpdate);
  requestUpdate();
};

const initFeatureSpotlights = () => {
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  document.querySelectorAll(".feature-card").forEach((card) => {
    let bounds = null;
    let frameHandle = 0;
    let pointerX = 50;
    let pointerY = 50;

    const render = () => {
      frameHandle = 0;
      card.style.setProperty("--spot-x", `${pointerX.toFixed(2)}%`);
      card.style.setProperty("--spot-y", `${pointerY.toFixed(2)}%`);
    };
    const requestRender = () => {
      if (!frameHandle) frameHandle = window.requestAnimationFrame(render);
    };

    card.addEventListener(
      "pointerenter",
      () => {
        if (motionIsPaused) return;
        bounds = card.getBoundingClientRect();
        card.classList.add("is-spotlit");
      },
      { passive: true },
    );
    card.addEventListener(
      "pointermove",
      (event) => {
        if (!bounds || motionIsPaused) return;
        pointerX = clampMotion((event.clientX - bounds.left) / bounds.width) * 100;
        pointerY = clampMotion((event.clientY - bounds.top) / bounds.height) * 100;
        requestRender();
      },
      { passive: true },
    );
    card.addEventListener(
      "pointerleave",
      () => {
        bounds = null;
        pointerX = 50;
        pointerY = 50;
        card.classList.remove("is-spotlit");
        requestRender();
      },
      { passive: true },
    );
  });
};

try {
  initCapabilityCardDeck();
  initQuantumField();
  initScrollMotion();
  initFeatureSpotlights();
} catch (error) {
  document.body.classList.remove("motion-enhanced");
  revealItems.forEach((item) => item.classList.add("visible"));
}
