const vscode = acquireVsCodeApi();

const PROVIDER_FALLBACK_MODELS = {
  cloudflare: "@cf/moonshotai/kimi-k2.7-code",
  fireworks: "accounts/fireworks/models/glm-5p2",
  wavespeed: "z-ai/glm-5.2",
  kimchi: "kimi-k2.7",
  openai: "openai-default",
  anthropic: "claude-default",
  custom: ""
};

const PROVIDER_LABELS = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  fireworks: "Fireworks",
  cloudflare: "Cloudflare",
  wavespeed: "WaveSpeed",
  kimchi: "Kimchi (Kimi)",
  custom: "Custom"
};

const VENDOR_LABELS = {
  moonshotai: "Moonshot AI",
  openai: "OpenAI",
  google: "Google",
  nvidia: "NVIDIA",
  deepseek: "DeepSeek",
  qwen: "Qwen (Alibaba)",
  zai: "Z.AI (Zhipu)",
  meta: "Meta",
  mistralai: "Mistral AI",
  "ibm-granite": "IBM Granite",
  microsoft: "Microsoft",
  other: "Другие"
};

const CATEGORY_LABELS = {
  flagship: "флагман",
  reasoning: "reasoning",
  fast: "быстрая",
  vision: "vision"
};

const ICON_PATHS = {
  history: '<circle cx="8" cy="8" r="6"/><path d="M8 4.8v3.2l2.2 1.3"/>',
  agent: '<rect x="3.5" y="5" width="9" height="7.5" rx="1.5"/><path d="M8 5V3"/><circle cx="6.2" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="9.8" cy="8" r="1" fill="currentColor" stroke="none"/><path d="M6 11h4"/>',
  knowledge: '<path d="M8 4.5c-1-1-3-1.2-4.5-1v8c1.5-.2 3.5 0 4.5 1 1-1 3-1.2 4.5-1v-8c-1.5.2-3.5 0-4.5-1z"/><path d="M8 4.5v8"/>',
  skills: '<path d="M9 2L4 9h3l-1 5 5-7H8l1-5z" fill="currentColor" stroke="none"/>',
  refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/>',
  settings: '<circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v2.2M8 12.3v2.2M14.5 8h-2.2M3.7 8H1.5M12.6 3.4l-1.6 1.6M5 11l-1.6 1.6M12.6 12.6L11 11M5 5L3.4 3.4"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>',
  build: '<path d="M10.5 2.5l3 3-2 2-3-3z"/><path d="M8.5 4.5L3 10l-.5 3 3-.5 5.5-5.5"/>',
  play: '<path d="M5 3l8 5-8 5z" fill="currentColor" stroke="none"/>',
  log: '<path d="M4 2h6l3 3v9H4z"/><path d="M10 2v3h3"/><path d="M6 8h5M6 10.5h5M6 5h2.5"/>',
  tools: '<path d="M11 2.5a2.5 2.5 0 0 0-1.8 4.3L3 13l1.5 1.5 6.2-6.2A2.5 2.5 0 0 0 13 5.5l-2 2-1.5-1.5 2-2A2.5 2.5 0 0 0 11 2.5z"/>',
  send: '<path d="M14 2.5L2 7.5l4.5 1.5L8 13l6-10.5z"/><path d="M6.5 9L14 2.5"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  warning: '<path d="M8 2.5L14 13H2z"/><path d="M8 7v3"/><path d="M8 11.5v.5"/>',
  stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1"/>',
  activity: '<path d="M2 8h3l2-4 2 8 2-4h3"/>',
  check: '<path d="M3 8.5l3.5 3.5L13 4.5"/>',
  error: '<circle cx="8" cy="8" r="6"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/>',
  dot: '<circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/>',
  edit: '<path d="M2.5 13.5l2-1 8-8-1-1-8 8-1 2z"/><path d="M10.5 3.5l2 2"/>',
  lock: '<rect x="4" y="7.5" width="8" height="6" rx="1"/><path d="M5.5 7.5V6a2.5 2.5 0 0 1 5 0v1.5"/>',
  brain: '<path d="M5 6c-1.5 0-2.5 1-2.5 2.5 0 .8.3 1.4.8 1.8-.3.4-.5.9-.5 1.5C2.8 12.7 4 13.5 5 13.5c1.2 0 2-.7 2.2-1.8V6.5C7 6 6 6 5 6z"/><path d="M11 6c1.5 0 2.5 1 2.5 2.5 0 .8-.3 1.4-.8 1.8.3.4.5.9.5 1.5.5 1.4-.7 2.2-1.7 2.2-1.2 0-2-.7-2.2-1.8V6.5C9 6 10 6 11 6z"/><path d="M7 4.5c0-.8-.3-1.5-1-2M9 4.5c0-.8.3-1.5 1-2"/>',
  cube: '<path d="M8 1.5L2.5 4.5v7L8 14.5l5.5-3v-7z"/><path d="M2.5 4.5L8 7.5l5.5-3"/><path d="M8 7.5v7"/>',
  game: '<rect x="2" y="6" width="12" height="7" rx="2"/><path d="M5 9v2M4 10h2"/><circle cx="10.5" cy="9.5" r="0.7" fill="currentColor" stroke="none"/><circle cx="12" cy="11" r="0.7" fill="currentColor" stroke="none"/>'
};

function icon(name) {
  const body = ICON_PATHS[name];
  if (!body) {
    return "";
  }
  return `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

const state = {
  config: undefined,
  providerStatuses: [],
  providerModelsByProvider: {},
  providerModels: [],
  providerModelProvider: undefined,
  filteredModels: [],
  projectMap: undefined,
  evidence: [],
  researchLedger: undefined,
  rules: "",
  lastRun: undefined,
  logSummary: undefined,
  budget: undefined,
  // Накопленные токены истории чата (оценка chars/4) — для кружка context-fill.
  chatHistoryTokens: 0,
  // Список сохранённых сессий (для UI-панели истории).
  sessionsList: [],
  // Список sub-агентов из config.subAgents (для панели sub-агентов).
  subagentsList: [],
  currentSessionId: undefined,
  busy: false,
  running: false,
  selectedVendorModel: undefined,
  activeMenu: undefined,
  // Текущий pending approval requestId — для round-trip ответа в backend.
  pendingApprovalRequestId: undefined
};

bindActions();
bindMenus();
bindModelPicker();
bindBlockbenchChip();
renderBlockbenchChip();
bindMinecraftChip();
renderMinecraftChip();
bindCriticModal();
post("ready");

window.addEventListener("message", (event) => {
  const { type, payload } = event.data;
  if (type === "state") {
    Object.assign(state, payload);
    syncProviderSelect();
    setReady("ready");
    render();
  }
  if (type === "projectMap") {
    state.projectMap = payload;
    setReady("indexed");
    // Информацию об индексе не спамим в чат — она живёт в статус-полосе
    // (renderStatusFacts внутри render). Это убирает повтор «Индекс готов…».
    render();
  }
  if (type === "evidence") {
    state.evidence = payload ?? [];
    setReady("evidence");
    const ev = describeEvidence(payload?.[payload.length - 1]);
    if (ev) {
      addMessage("activity", ev.text, ev.icon);
    }
  }
  if (type === "logSummary") {
    state.logSummary = payload;
    setReady("logs parsed");
    addMessage("activity", describeLogSummary(payload));
  }
  if (type === "runReport") {
    state.lastRun = payload;
    state.projectMap = payload.projectMap ?? state.projectMap;
    state.running = false;
    setReady("run complete");
    addMessage("assistant", payload.summary);
    render();
  }
  if (type === "runFinished") {
    state.running = false;
    setReady("ready");
    renderRunButton();
  }
  if (type === "providerCheck") {
    setReady("model ready");
    addMessage("assistant", payload.summary);
  }
  if (type === "providerModels") {
    state.providerModels = payload.models ?? [];
    state.providerModelProvider = payload.provider;
    state.providerModelsByProvider = {
      ...(state.providerModelsByProvider ?? {}),
      [payload.provider]: state.providerModels
    };
    state.filteredModels = state.providerModels;
    setReady("models loaded");
    renderModelOptions();
    renderComposer();
    if (!payload.silent) {
      addMessage("activity", `Загружено моделей ${providerLabel(payload.provider)}: ${state.providerModels.length}.`);
    }
  }
  if (type === "researchLedger") {
    state.researchLedger = payload;
    setReady("research saved");
    renderResearchLedger();
    addMessage("assistant", "Source Ledger сохранён. Следующий запрос будет учитывать твои правки (source:user приоритетнее).");
  }
  if (type === "agentActivity") {
    const msg = payload.message ?? String(payload);
    // Reasoning (chain-of-thought) передаётся отдельным полем — показываем
    // особым стилем, отделяя ход мыслей от обычных activity-событий.
    if (payload.reasoningContent) {
      addMessage("reasoning", payload.reasoningContent);
    }
    addMessage("activity", msg);
    if (payload.visionVerdict) {
      renderVisionVerdict(payload.visionVerdict);
    }
    if (payload.criticVerdict) {
      renderCriticVerdict(payload.criticVerdict);
    }
  }
  if (type === "tokenBudget") {
    state.budget = payload;
    renderBudget();
  }
  if (type === "tokenBudgetExceeded") {
    showBudgetExceeded(payload);
  }
  if (type === "sessionRestored") {
    restoreSession(payload);
  }
  if (type === "sessionsList") {
    state.sessionsList = payload ?? [];
    renderSessionsList();
  }
  if (type === "sessionCleared") {
    clearChatFeed();
  }
  if (type === "approvalRequest") {
    showApprovalModal(payload);
  }
  if (type === "subagentsList") {
    state.subagentsList = payload ?? [];
    renderSubAgentsList();
  }
  if (type === "subagentResult") {
    addMessage("assistant", `Sub-агент «${payload.displayName}»: ${payload.content}`);
  }
  if (type === "knowledgeList") {
    state.knowledgeList = payload ?? [];
    renderKnowledgeList();
  }
  if (type === "skillsList") {
    state.skillsList = payload ?? [];
    renderSkillsList();
  }
  if (type === "notice") {
    // ФИКС: дедупликация — не показываем одну и ту же ошибку дважды.
    // Берём ПОСЛЕДНЕЕ assistant-сообщение в ленте, а не последний дочерний
    // элемент: между двумя notice могут появиться activity/reasoning/прогресс,
    // и старый селектор `.message.assistant:last-child` переставал срабатывать.
    const text = String(payload);
    const feed = document.getElementById("chatFeed");
    const assistantMessages = feed?.querySelectorAll(".message.assistant");
    const lastAssistant = assistantMessages?.length ? assistantMessages[assistantMessages.length - 1] : undefined;
    const lastMsg = lastAssistant?.querySelector(".message-body")?.textContent?.trim();
    if (lastMsg !== text) {
      addMessage("assistant", text);
    }
  }
  if (type === "blockbenchStatus") {
    state.blockbench = payload;
    renderBlockbenchChip();
  }
  if (type === "minecraftStatus") {
    state.minecraft = payload;
    renderMinecraftChip();
  }
  if (type === "error") {
    state.running = false;
    setReady("error");
    renderRunButton();
    addMessage("assistant", String(payload));
  }
});

function bindActions() {
  bindAction("openWorkspace", "openWorkspace");
  bindAction("refreshIndexTop", "refreshIndex", "Индексирую проект");
  bindAction("refreshIndex", "refreshIndex", "Индексирую проект");
  bindAction("runBuild", "runGradleBuild", "Запускаю build");
  bindAction("applyLastPatch", "applyLastPatch", "Применяю patch");
  bindAction("runClient", "runClient", "Запускаю клиент");
  bindAction("parseLog", "parseLog", "Читаю latest.log");
  bindAction("openRules", "openRules");
  bindAction("setProviderKey", "setProviderKey", "Открываю настройку ключа", currentProviderPayload);
  bindAction("setCurrentProviderKey", "setProviderKey", "Открываю настройку ключа", currentProviderPayload);
  bindAction("refreshProviderModels", "refreshProviderModels", "Обновляю модели", currentProviderPayload);
  bindAction("testProvider", "testProvider", "Проверяю модель", currentProviderPayload);
  bindAction("useProviderModel", "selectProviderModel", "Сохраняю модель", selectedProviderModelPayload);

  document.getElementById("saveRules")?.addEventListener("click", () => {
    setBusy("Сохраняю правила");
    post("saveRules", { text: document.getElementById("rulesEditor")?.value ?? "" });
  });

  document.getElementById("saveResearchLedger")?.addEventListener("click", () => saveResearchLedger());
  document.getElementById("searchWebResearch")?.addEventListener("click", () => {
    const ledger = parseResearchEditor();
    setBusy("Ищу в web");
    post("researchWeb", { topic: ledger?.topic || "JJK-inspired Minecraft mod combat design" });
  });

  document.getElementById("runPrompt")?.addEventListener("click", () => {
    if (state.running) {
      cancelPromptRun();
      return;
    }
    startPromptRun();
  });
  document.getElementById("promptInput")?.addEventListener("keydown", (event) => {
    // Enter — отправка, Shift+Enter — новая строка.
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      startPromptRun();
    }
  });
}

function bindMenus() {
  document.querySelectorAll("[data-menu-toggle]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMenu(button.dataset.menuToggle);
    });
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".composer-menu") && !event.target.closest(".sessions-panel") && !event.target.closest(".subagents-panel") && !event.target.closest(".knowledge-panel") && !event.target.closest(".skills-panel") && !event.target.closest("[data-menu-toggle]") && !event.target.closest("#toggleSessions") && !event.target.closest("#toggleSubAgents") && !event.target.closest("#toggleKnowledge") && !event.target.closest("#toggleSkills")) {
      closeMenus();
      closeSessionsPanel();
      closeSubAgentsPanel();
      closeKnowledgePanel();
      closeSkillsPanel();
      updateActivePanelButton();
    }
  });
  // Кнопка "История" в topbar открывает панель сессий и запрашивает свежий список.
  document.getElementById("toggleSessions")?.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePanel("sessionsPanel", "listSessions");
  });
  document.getElementById("newSessionBtn")?.addEventListener("click", () => {
    post("newSession");
    closeSessionsPanel();
  });
  document.getElementById("closeSessions")?.addEventListener("click", () => {
    closeSessionsPanel();
  });
  // Sub-агенты: кнопка в topbar + кнопки панели.
  document.getElementById("toggleSubAgents")?.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePanel("subagentsPanel", "subagents.list");
  });
  document.getElementById("closeSubAgents")?.addEventListener("click", () => {
    closeSubAgentsPanel();
  });
  // Этап 6: Knowledge Base панель.
  document.getElementById("toggleKnowledge")?.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePanel("knowledgePanel", "knowledge.list");
  });
  document.getElementById("closeKnowledge")?.addEventListener("click", () => {
    closeKnowledgePanel();
  });
  document.getElementById("knowledgeSearchBtn")?.addEventListener("click", () => {
    const topic = document.getElementById("knowledgeSearchInput")?.value?.trim() ?? "";
    post("knowledge.searchViaModel", { topic });
  });
  document.getElementById("knowledgeSearchInput")?.addEventListener("input", (event) => {
    const query = event.target.value?.trim() ?? "";
    filterKnowledgeList(query);
  });
  // Этап 6: Skills панель.
  document.getElementById("toggleSkills")?.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePanel("skillsPanel", "skills.list");
  });
  document.getElementById("closeSkills")?.addEventListener("click", () => {
    closeSkillsPanel();
  });
  document.getElementById("skillCreateBtn")?.addEventListener("click", () => {
    const row = document.getElementById("skillsCreateRow");
    if (row) {
      row.hidden = !row.hidden;
    }
  });
  document.getElementById("skillCreateConfirm")?.addEventListener("click", () => {
    const topic = document.getElementById("skillTopicInput")?.value?.trim() ?? "";
    if (topic) {
      post("skills.create", { topic });
      document.getElementById("skillsCreateRow").hidden = true;
      document.getElementById("skillTopicInput").value = "";
    }
  });
  document.getElementById("addSubAgentBtn")?.addEventListener("click", () => {
    showSubAgentForm();
  });
  document.getElementById("cancelSubAgent")?.addEventListener("click", () => {
    hideSubAgentForm();
  });
  document.getElementById("saveSubAgent")?.addEventListener("click", () => {
    saveSubAgentFromForm();
  });
  // Approval modal: кнопки решения.
  document.getElementById("approvalConfirmOnce")?.addEventListener("click", () => {
    sendApprovalDecision("confirm-once");
  });
  document.getElementById("approvalAlwaysInSession")?.addEventListener("click", () => {
    sendApprovalDecision("always-in-session");
  });
  document.getElementById("approvalAlwaysAll")?.addEventListener("click", () => {
    sendApprovalDecision("always-all-in-session");
  });
  document.getElementById("approvalAlways")?.addEventListener("click", () => {
    sendApprovalDecision("always");
  });
  document.getElementById("approvalDeny")?.addEventListener("click", () => {
    sendApprovalDecision("deny");
  });
}

function bindModelPicker() {
  const input = document.getElementById("providerModelInput");
  const search = document.getElementById("modelSearch");
  const providerSelect = document.getElementById("providerSelect");
  input?.addEventListener("input", () => renderCapabilities());
  providerSelect?.addEventListener("change", () => {
    state.filteredModels = [];
    state.providerModelProvider = providerSelect.value;
    state.providerModels = state.providerModelsByProvider?.[providerSelect.value] ?? [];
    // BUG#1 FIX: сохраняем провайдера в config немедленно при смене dropdown.
    // Без этого refresh() сбрасывает dropdown обратно к старому значению.
    post("selectProviderModel", {
      provider: providerSelect.value,
      model: ""
    });
    // BUG#5 FIX: очищаем выбранную модель — она от старого провайдера.
    state.selectedVendorModel = undefined;
    // Запрашиваем модели для нового провайдера.
    post("refreshProviderModels", { provider: providerSelect.value });
    renderModelOptions();
    renderComposer();
  });
  search?.addEventListener("input", () => {
    renderModelOptions();
  });
}

function bindAction(id, type, busyLabel, payloadFactory) {
  document.getElementById(id)?.addEventListener("click", () => {
    if (busyLabel) {
      setBusy(busyLabel);
    }
    post(type, payloadFactory?.());
    if (!["refreshProviderModels", "setCurrentProviderKey"].includes(id)) {
      closeMenus();
    }
  });
}

function startPromptRun() {
  const promptInput = document.getElementById("promptInput");
  const prompt = promptInput?.value?.trim();
  if (!prompt) {
    return;
  }
  addMessage("user", prompt);
  if (promptInput) {
    promptInput.value = "";
    promptInput.style.height = "";
  }
  const selectedMode = document.getElementById("agentMode")?.value ?? "ask";
  const mode = inferRunMode(prompt, selectedMode);
  addMessage("activity", activityIntroForMode(mode));
  state.running = true;
  setBusy("Выполняю");
  renderRunButton();
  post("startRun", {
    prompt,
    mode
  });
}

function inferRunMode(prompt, selectedMode) {
  if (selectedMode !== "ask") {
    return selectedMode;
  }
  return /PATCH PLAN|UNIFIED DIFF|buildable|skeleton|создай|сгенерируй|реализуй|добавь/i.test(prompt)
    ? "build"
    : selectedMode;
}

function cancelPromptRun() {
  addMessage("activity", "Останавливаю текущий запрос...");
  post("cancelRun", {});
}

function activityIntroForMode(mode) {
  if (mode === "build") {
    return "Принял build-задачу: обновлю индекс, передам карту проекта в модель и попрошу черновик patch.";
  }
  if (mode === "plan") {
    return "Принял plan-задачу: обновлю индекс и попрошу модель составить план без прямых правок файлов.";
  }
  if (mode === "playtest") {
    return "Принял playtest-задачу: соберу build evidence, затем попрошу модель описать проверки dev world.";
  }
  return "Принял задачу. Обновлю карту проекта и отправлю контекст выбранной модели.";
}

function currentProviderPayload() {
  return {
    provider: currentProvider()
  };
}

function selectedProviderModelPayload() {
  return {
    provider: currentProvider(),
    model: selectedModelId()
  };
}

function currentProvider() {
  return document.getElementById("providerSelect")?.value
    || state.config?.providers?.defaultProvider
    || "cloudflare";
}

function selectedModelId() {
  const input = document.getElementById("providerModelInput");
  const fromVendor = state.selectedVendorModel;
  return fromVendor || input?.value?.trim() || fallbackModelForProvider(currentProvider());
}

function toggleMenu(id) {
  if (!id) {
    return;
  }
  const next = state.activeMenu === id ? undefined : id;
  closeMenus();
  state.activeMenu = next;
  if (next) {
    document.getElementById(next)?.removeAttribute("hidden");
    if (next === "modelMenu") {
      syncProviderSelect();
      // BUG#5 FIX: очищаем выбранную модель при открытии меню —
      // иначе может остаться модель от другого провайдера.
      state.selectedVendorModel = undefined;
      // Синхронизируем state.providerModelProvider с dropdown.
      const providerSelect = document.getElementById("providerSelect");
      if (providerSelect?.value) {
        state.providerModelProvider = providerSelect.value;
        state.providerModels = state.providerModelsByProvider?.[providerSelect.value] ?? [];
      }
      renderModelOptions();
      document.getElementById("modelSearch")?.focus();
    }
  }
}

function closeMenus() {
  document.querySelectorAll(".composer-menu").forEach((menu) => {
    menu.setAttribute("hidden", "");
  });
  state.activeMenu = undefined;
}

function post(type, payload) {
  vscode.postMessage({ type, payload });
}

function render() {
  setText("rulesEditor", state.rules ?? "", "value");
  renderStatusFacts();
  renderComposer();
  renderProviders();
  renderResearchLedger();
  renderModelOptions();
  renderEmptyWorkspace();
  renderRunButton();
  renderBudget();
  renderCtxRing();
}

function renderStatusFacts() {
  const el = document.getElementById("statusFacts");
  if (!el) {
    return;
  }
  const map = state.projectMap;
  if (!map) {
    el.innerHTML = `<span class="status-fact placeholder">Обнови индекс, чтобы увидеть проект</span>`;
    return;
  }
  const facts = [
    labelLoader(map.loader),
    map.minecraftVersion ? `MC ${map.minecraftVersion}` : "MC unknown",
    map.javaVersion ? `Java ${map.javaVersion}` : "Java unknown",
    map.mainModId ?? "mod id unknown"
  ];
  el.innerHTML = facts.map((fact) => `<span class="status-fact">${escapeHtml(fact)}</span>`).join("");
}

function renderEmptyWorkspace() {
  const empty = document.getElementById("emptyWorkspace");
  const welcome = document.getElementById("welcomeMessage");
  if (empty) {
    empty.hidden = !state.workspaceMissing;
  }
  if (welcome) {
    welcome.hidden = state.workspaceMissing;
  }
}

function renderComposer() {
  const configuredModel = currentConfiguredModel();
  const provider = currentProvider();
  const input = document.getElementById("providerModelInput");
  // ФИКС: НЕ перезаписываем providerSelect здесь — это ломает ручной выбор.
  // Синхронизация dropdown с config происходит только в syncProviderSelect()
  // при получении state-сообщения от бэкенда, а не при каждом renderComposer.
  if (input && configuredModel && !input.matches(":focus")) {
    input.value = configuredModel;
  }
  setText("modelButtonLabel", shortModelLabel(configuredModel));
  setText("composerStatus", `Готов · ${providerLabel(provider)}: ${shortModelLabel(configuredModel)}`);
  renderCapabilities();
  renderCtxRing();
}

function renderProviders() {
  const el = document.getElementById("providers");
  if (!el) {
    return;
  }
  el.innerHTML = (state.providerStatuses ?? []).map((provider) => `
    <div class="provider ${provider.hasKey ? "ready" : "missing"}">
      <span>${escapeHtml(providerLabel(provider.id))}</span>
      <code>${provider.hasKey ? "ключ сохранён" : "нет ключа"}</code>
    </div>
  `).join("");
}

function renderResearchLedger() {
  const ledger = state.researchLedger ?? defaultResearchLedger();
  const summary = document.getElementById("researchSummary");
  const editor = document.getElementById("researchEditor");
  if (summary) {
    const accepted = (ledger.sources ?? []).filter((source) => source.status !== "rejected").length;
    const total = ledger.sources?.length ?? 0;
    summary.textContent = total
      ? `${accepted}/${total} источников принято. Status: ${ledger.status ?? "draft"}.`
      : "Источников пока нет.";
  }
  if (editor && !editor.matches(":focus")) {
    editor.value = JSON.stringify(ledger, null, 2);
  }
}

function saveResearchLedger() {
  const ledger = parseResearchEditor();
  if (!ledger) {
    return;
  }
  setBusy("Сохраняю источники");
  post("saveResearchLedger", ledger);
}

function parseResearchEditor() {
  const editor = document.getElementById("researchEditor");
  try {
    return JSON.parse(editor?.value || "{}");
  } catch (error) {
    addMessage("assistant", `Source Ledger JSON не сохранён: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function defaultResearchLedger() {
  return {
    topic: "Original Minecraft mod inspired by JJK-style combat structure",
    status: "draft",
    sources: [],
    userNotes: "",
    lastUpdated: null
  };
}

function syncProviderSelect() {
  const select = document.getElementById("providerSelect");
  if (!select) {
    return;
  }
  // BUG#6/7 FIX: только обновляем dropdown если config.defaultProvider
  // реально изменился с прошлого раза. Раньше каждый state message
  // сбрасывал dropdown, даже если пользователь только что выбрал другой.
  const configProvider = state.config?.providers?.defaultProvider;
  if (configProvider && configProvider !== state._lastSyncedProvider) {
    state._lastSyncedProvider = configProvider;
    if (!select.matches(":focus")) {
      select.value = configProvider;
      state.providerModelProvider = configProvider;
      state.providerModels = state.providerModelsByProvider?.[configProvider] ?? [];
    }
  }
}

// === Model list — двухуровневая группировка ===
// Верхний уровень: apiType (Чат/Код · Изображения · Звуки).
// Внутри: по вендору. Это разделяет main-модели (для чата) и tool-модели
// (image/audio), которые нельзя ставить как main.

const API_TYPE_LABELS = {
  text: "Чат и код",
  image: "Изображения (через tool-calling)",
  audio: "Звуки и речь"
};

function renderModelOptions() {
  const el = document.getElementById("modelList");
  const input = document.getElementById("providerModelInput");
  if (!el) {
    return;
  }
  const models = filteredActiveModels();
  const configured = currentConfiguredModel();
  el.innerHTML = "";

  if (!models.length) {
    el.innerHTML = `<div class="model-empty">Нет моделей. Нажми «Обновить модели» или впиши custom id.</div>`;
    setText("modelCapabilities", "");
    return;
  }

  // Верхний уровень: apiType. text — основной, image/audio — ниже.
  const apiTypeOrder = ["text", "image", "audio"];
  const byApiType = new Map();
  for (const model of models) {
    const apiType = model.apiType || inferApiTypeFromId(model.id);
    if (!byApiType.has(apiType)) {
      byApiType.set(apiType, []);
    }
    byApiType.get(apiType).push(model);
  }

  for (const apiType of apiTypeOrder) {
    const apiTypeModels = byApiType.get(apiType);
    if (!apiTypeModels?.length) {
      continue;
    }

    const sectionEl = document.createElement("div");
    sectionEl.className = "model-section";
    const sectionLabel = document.createElement("div");
    sectionLabel.className = "model-section-label";
    sectionLabel.textContent = API_TYPE_LABELS[apiType] ?? apiType;
    sectionEl.appendChild(sectionLabel);

    // Внутри секции — группировка по вендору.
    const vendorGroups = new Map();
    for (const model of apiTypeModels) {
      const vendor = model.vendor || inferVendorFromId(model.id);
      if (!vendorGroups.has(vendor)) {
        vendorGroups.set(vendor, []);
      }
      vendorGroups.get(vendor).push(model);
    }

    const vendorOrder = ["moonshotai", "zai", "openai", "google", "nvidia", "deepseek", "qwen", "meta", "mistralai", "ibm-granite", "microsoft", "other"];
    const sortedVendors = Array.from(vendorGroups.keys()).sort((a, b) => {
      const ai = vendorOrder.indexOf(a);
      const bi = vendorOrder.indexOf(b);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

    for (const vendor of sortedVendors) {
      const groupModels = vendorGroups.get(vendor);
      const groupEl = document.createElement("div");
      groupEl.className = "model-vendor-group";
      if (vendor !== "other" || sortedVendors.length > 1) {
        const labelEl = document.createElement("div");
        labelEl.className = "model-vendor-label";
        labelEl.textContent = VENDOR_LABELS[vendor] ?? vendor;
        groupEl.appendChild(labelEl);
      }
      for (const model of groupModels) {
        groupEl.appendChild(renderModelOption(model, configured, apiType));
      }
      sectionEl.appendChild(groupEl);
    }
    el.appendChild(sectionEl);
  }

  if (input && !input.matches(":focus") && models.some((m) => m.id === configured)) {
    input.value = configured;
  }
  renderCapabilities();
}

function renderModelOption(model, configured, apiType) {
  // ФИКС: только configured (из config) даёт is-selected.
  // selectedVendorModel убран — иначе два огонька горят одновременно.
  const isSelected = model.id === configured;
  const option = document.createElement("button");
  option.type = "button";
  option.className = `model-option${isSelected ? " is-selected" : ""}`;
  option.dataset.modelId = model.id;
  option.dataset.apiType = apiType;

  const caps = model.capabilities;
  const ctx = caps?.contextWindow;
  const cat = model.category || inferCategoryFromId(model.id);
  const price = formatNeurons(caps, apiType);

  option.innerHTML = `
    <span class="model-option-radio"></span>
    <span class="model-option-name">${escapeHtml(model.label || shortModelLabel(model.id))}</span>
    <span class="model-option-meta">
      ${cat && apiType === "text" ? `<span class="model-category-chip cat-${escapeHtml(cat)}">${escapeHtml(CATEGORY_LABELS[cat] ?? cat)}</span>` : ""}
      ${ctx ? `<span class="model-context">${escapeHtml(formatContext(ctx))}</span>` : ""}
      ${price ? `<span class="model-price" title="Стоимость за 1M токенов">${escapeHtml(price)}</span>` : ""}
    </span>
  `;
  option.addEventListener("click", (event) => {
    event.stopPropagation();
    selectVendorModel(model.id);
  });
  return option;
}

function inferApiTypeFromId(id) {
  const s = String(id || "").toLowerCase();
  if (/flux|stable-diffusion|leonardo|dreamshaper|text-to-image/.test(s)) {
    return "image";
  }
  if (/whisper|aura|melo|tts|asr|voice/.test(s)) {
    return "audio";
  }
  return "text";
}

// Форматирует цену модели.
// Для Cloudflare: "5k/36k N" (нейроны за 1M input/output).
// Для остальных провайдеров: не показываем (у них своя биллинговая модель).
function formatNeurons(caps, apiType) {
  if (!caps) {
    return "";
  }
  // Только Cloudflare использует нейроны.
  const provider = state.providerModelProvider || currentProvider();
  if (provider !== "cloudflare") {
    return "";
  }
  const inputN = caps.neuronsPerMInput;
  const outputN = caps.neuronsPerMOutput;
  if (!inputN && !outputN) {
    return "";
  }
  const inStr = inputN ? formatTokens(inputN) : "—";
  const outStr = outputN ? formatTokens(outputN) : "—";
  return `${inStr}/${outStr} N`;
}

function selectVendorModel(modelId) {
  state.selectedVendorModel = modelId;
  const input = document.getElementById("providerModelInput");
  if (input) {
    input.value = modelId;
  }
  // BUG#4 FIX: берём провайдера из state.providerModelProvider — это провайдер
  // чьи модели сейчас отображаются в списке. currentProvider() (dropdown)
  // может быть сброшен syncProviderSelect() между кликом и обработкой.
  const provider = state.providerModelProvider || currentProvider();
  post("selectProviderModel", {
    provider: provider,
    model: modelId
  });
  setBusy("Сохраняю модель");
  renderModelOptions();
  renderComposer();
  closeMenus();
}

function inferVendorFromId(id) {
  const match = String(id || "").match(/^@cf\/([\w-]+)\//i);
  if (!match) {
    return "other";
  }
  const owner = match[1].toLowerCase();
  const aliases = {
    "moonshotai": "moonshotai", "moonshot": "moonshotai",
    "openai": "openai", "google": "google", "nvidia": "nvidia",
    "deepseek-ai": "deepseek", "deepseek": "deepseek",
    "qwen": "qwen", "alibaba": "qwen",
    "zai-org": "zai", "zai": "zai", "zhipu": "zai",
    "meta": "meta", "meta-llama": "meta",
    "mistralai": "mistralai", "mistral": "mistralai",
    "microsoft": "microsoft",
    "ibm-granite": "ibm-granite", "ibm": "ibm-granite"
  };
  return aliases[owner] ?? "other";
}

function inferCategoryFromId(id) {
  const s = String(id || "").toLowerCase();
  if (/kimi-k2\.7|glm-5|qwen2\.5-coder|gpt-oss-120b/.test(s)) {
    return "flagship";
  }
  if (/vision|multimodal|llama-4|gemma-[34]/.test(s)) {
    return "vision";
  }
  if (/reasoning|reasoner|deepseek-r1|qwq|gpt-oss|nemotron/.test(s)) {
    return "reasoning";
  }
  if (/flash|fast|8b|small|mini/.test(s)) {
    return "fast";
  }
  return "flagship";
}

function filteredActiveModels() {
  const search = document.getElementById("modelSearch");
  const query = search?.value?.trim().toLowerCase();
  const models = activeModels();
  if (!query) {
    return models;
  }
  return models.filter((model) => {
    const haystack = `${model.label ?? ""} ${model.id ?? ""} ${model.vendor ?? ""}`.toLowerCase();
    return haystack.includes(query);
  });
}

function renderCapabilities() {
  const model = selectedModelMetadata();
  const capabilities = model?.capabilities;
  const el = document.getElementById("modelCapabilities");
  if (!el) {
    return;
  }
  const chips = [];
  if (capabilities?.contextWindow) {
    chips.push({ text: `ctx ${formatContext(capabilities.contextWindow)}`, ok: true });
  }
  if (capabilities?.vision) {
    chips.push({ text: "vision", ok: true });
  } else {
    chips.push({ text: "только текст", ok: false });
  }
  if (capabilities?.tools) {
    chips.push({ text: "tools", ok: true });
  }
  if (capabilities?.jsonMode) {
    chips.push({ text: "json", ok: true });
  }
  if (capabilities?.reasoning) {
    chips.push({ text: "reasoning", ok: true });
  }
  el.innerHTML = chips.map((chip) => `<span class="${chip.ok ? "ok" : ""}">${escapeHtml(chip.text)}</span>`).join("");
}

function renderBudget() {
  const chip = document.getElementById("budgetChip");
  const valueEl = document.getElementById("budgetValue");
  if (!chip || !valueEl) {
    return;
  }
  const usage = state.budget;
  if (!usage || !usage.sessionUsed) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  chip.classList.remove("is-warning", "is-exceeded");

  const used = usage.sessionUsed ?? 0;
  const limit = usage.sessionLimit ?? 1_000_000;
  const neurons = usage.neuronsSpent ?? 0;
  const neuronsLimit = usage.neuronsDailyLimit ?? 10_000;
  const providerId = usage.providerId || state.config?.providers?.defaultProvider || "";
  const isCloudflare = providerId === "cloudflare";

  // Cloudflare: показываем нейроны (реальные деньги free tier).
  // Остальные провайдеры: только токены за сессию.
  if (isCloudflare && neurons > 0) {
    valueEl.textContent = `${formatNeuronsShort(neurons)}/${formatNeuronsShort(neuronsLimit)} N`;
    const ratio = neuronsLimit > 0 ? neurons / neuronsLimit : 0;
    if (ratio >= 1) {
      chip.classList.add("is-exceeded");
    } else if (ratio >= 0.8) {
      chip.classList.add("is-warning");
    }
    chip.title = `Нейроны Cloudflare за сессию: ${neurons} из ${neuronsLimit} (free tier = 10к/день). Токенов: ${formatTokens(used)}.`;
  } else {
    valueEl.textContent = formatTokens(used);
    const ratio = limit > 0 ? used / limit : 0;
    if (ratio >= 1) {
      chip.classList.add("is-exceeded");
    } else if (ratio >= 0.8) {
      chip.classList.add("is-warning");
    }
    const providerLabel = isCloudflare ? "Cloudflare" : providerId;
    chip.title = `${providerLabel}: токены за сессию: ${formatTokens(used)} из ${formatTokens(limit)}.`;
  }
}

// Этап 3: индикатор подключения Blockbench. data-status управляет цветом точки
// (CSS), title показывает число инструментов или ошибку. Клик = toggle connect.
function renderBlockbenchChip() {
  const chip = document.getElementById("blockbenchChip");
  if (!chip) {
    return;
  }
  const bb = state.blockbench;
  const status = bb?.status ?? "disconnected";
  chip.dataset.status = status;
  const labelEl = chip.querySelector(".blockbench-label");
  if (status === "connected") {
    const count = bb?.toolCount ?? 0;
    chip.title = `Blockbench подключён: ${count} инструментов. ${bb?.url ?? ""}`;
    if (labelEl) {
      labelEl.textContent = `Blockbench · ${count}`;
    }
    chip.setAttribute("aria-label", `Blockbench подключён, ${count} инструментов. Клик — отключить.`);
  } else if (status === "connecting") {
    chip.title = "Blockbench: подключение…";
    if (labelEl) {
      labelEl.textContent = "Blockbench…";
    }
    chip.setAttribute("aria-label", "Blockbench подключается.");
  } else if (status === "error") {
    chip.title = `Blockbench: ошибка подключения. ${bb?.error ?? ""}`;
    if (labelEl) {
      labelEl.innerHTML = "Blockbench " + icon("close");
    }
    chip.setAttribute("aria-label", `Blockbench: ошибка подключения. ${bb?.error ?? ""}. Клик — повторить.`);
  } else {
    chip.title = "Blockbench: отключено. Клик — подключить.";
    if (labelEl) {
      labelEl.textContent = "Blockbench";
    }
    chip.setAttribute("aria-label", "Blockbench отключён. Клик — подключить.");
  }
}

function bindBlockbenchChip() {
  const chip = document.getElementById("blockbenchChip");
  if (!chip) {
    return;
  }
  chip.addEventListener("click", () => {
    const status = (state.blockbench?.status) ?? "disconnected";
    if (status === "connected" || status === "connecting") {
      post("blockbenchDisconnect", {});
    } else {
      post("blockbenchConnect", {});
    }
  });
}

// Этап 4: индикатор подключения Minecraft Dev Bridge (MCP-сервер внутри dev-сборки
// мода). Паттерн идентичен Blockbench-чипу, но свой state.minecraft и сообщения
// minecraftStatus/minecraftConnect/minecraftDisconnect. Если токен не найден в
// логе — подсказка «сначала запусти dev-клиент».
function renderMinecraftChip() {
  const chip = document.getElementById("minecraftChip");
  if (!chip) {
    return;
  }
  const mc = state.minecraft;
  const status = mc?.status ?? "disconnected";
  chip.dataset.status = status;
  const labelEl = chip.querySelector(".blockbench-label");
  if (status === "connected") {
    const count = mc?.toolCount ?? 0;
    chip.title = `Minecraft bridge подключён: ${count} инструментов. ${mc?.url ?? ""}`;
    if (labelEl) {
      labelEl.textContent = `Minecraft · ${count}`;
    }
    chip.setAttribute("aria-label", `Minecraft bridge подключён, ${count} инструментов. Клик — отключить.`);
  } else if (status === "connecting") {
    chip.title = "Minecraft bridge: подключение…";
    if (labelEl) {
      labelEl.textContent = "Minecraft…";
    }
    chip.setAttribute("aria-label", "Minecraft bridge подключается.");
  } else if (status === "error") {
    chip.title = `Minecraft bridge: ошибка подключения. ${mc?.error ?? ""}`;
    if (labelEl) {
      labelEl.innerHTML = "Minecraft " + icon("close");
    }
    chip.setAttribute("aria-label", `Minecraft bridge: ошибка. ${mc?.error ?? ""}. Клик — повторить.`);
  } else {
    const hint = mc?.hasToken === false
      ? " Dev-клиент не запущен — клик предложит запустить его."
      : "";
    chip.title = `Minecraft bridge: отключено.${hint} Клик — подключить.`;
    if (labelEl) {
      labelEl.textContent = "Minecraft";
    }
    chip.setAttribute("aria-label", `Minecraft bridge отключён.${hint} Клик — подключить.`);
  }
}

function bindMinecraftChip() {
  const chip = document.getElementById("minecraftChip");
  if (!chip) {
    return;
  }
  chip.addEventListener("click", () => {
    const status = (state.minecraft?.status) ?? "disconnected";
    if (status === "connected" || status === "connecting") {
      post("minecraftDisconnect", {});
    } else {
      post("minecraftConnect", {});
    }
  });
}

// Краткий формат нейронов: 1234 → "1.2k", 10000 → "10k".
function formatNeuronsShort(n) {
  if (!n) {
    return "0";
  }
  if (n >= 1000) {
    return n >= 10_000 ? `${Math.round(n / 1000)}k` : `${(n / 1000).toFixed(1)}k`;
  }
  return String(n);
}

// Кружок context-fill: заполнение context window текущей модели.
// Берёт contextWindow выбранной модели и накопленную оценку токенов истории чата.
function renderCtxRing() {
  const ring = document.getElementById("ctxRing");
  const fill = document.querySelector(".ctx-ring-fill");
  const label = document.getElementById("ctxRingLabel");
  if (!ring || !fill || !label) {
    return;
  }
  const model = selectedModelMetadata();
  const ctxWindow = model?.capabilities?.contextWindow;
  if (!ctxWindow) {
    ring.hidden = true;
    return;
  }
  ring.hidden = false;
  const used = state.chatHistoryTokens ?? 0;
  const ratio = ctxWindow > 0 ? used / ctxWindow : 0;
  const pct = Math.min(100, Math.round(ratio * 100));

  // SVG-кольцо: длина окружности при r=10 ≈ 62.83.
  const circumference = 62.83;
  const offset = circumference * (1 - Math.min(1, ratio));
  fill.style.strokeDashoffset = String(offset);

  ring.classList.remove("is-warning", "is-critical");
  if (ratio >= 0.9) {
    ring.classList.add("is-critical");
  } else if (ratio >= 0.6) {
    ring.classList.add("is-warning");
  }

  label.textContent = `${pct}%`;
  ring.title = `Контекст модели: ${formatTokens(used)} из ${formatTokens(ctxWindow)} (${pct}%). Модель: ${shortModelLabel(currentConfiguredModel())}.`;
}

function showBudgetExceeded(snapshot) {
  const used = snapshot?.sessionUsed ?? 0;
  const limit = snapshot?.sessionLimit ?? 0;
  const msg = `Лимит токенов за сессию превышен: ${formatTokens(used)} из ${formatTokens(limit)}. Запрос НЕ прерван — он уже завершён. Продолжаю по умолчанию.`;
  addMessage("activity", msg, "warning");
  post("budgetResponse", { action: "continue" });
}

function renderRunButton() {
  const button = document.getElementById("runPrompt");
  if (!button) {
    return;
  }
  button.classList.toggle("is-running", state.running);
  button.innerHTML = state.running ? icon("stop") : icon("send");
  button.title = state.running ? "Остановить" : "Отправить";
  button.setAttribute("aria-label", state.running ? "Остановить" : "Отправить");
}

function activeModels() {
  const provider = currentProvider();
  if (state.providerModelProvider === provider && state.providerModels.length) {
    return state.providerModels;
  }
  const cached = state.providerModelsByProvider?.[provider];
  if (cached?.length) {
    return cached;
  }
  return defaultModelList(provider);
}

function selectedModelMetadata() {
  const selected = selectedModelId();
  return activeModels().find((model) => model.id === selected);
}

function defaultModelList(provider = currentProvider()) {
  const fallback = fallbackModelForProvider(provider);
  if (!fallback) {
    return [];
  }
  return [
    {
      id: fallback,
      label: shortModelLabel(fallback),
      vendor: inferVendorFromId(fallback),
      category: inferCategoryFromId(fallback),
      capabilities: undefined
    }
  ];
}

function currentConfiguredModel() {
  const provider = state.config?.providers?.defaultProvider ?? currentProvider();
  return state.config?.providers?.defaultModel || fallbackModelForProvider(provider);
}

function fallbackModelForProvider(provider = "cloudflare") {
  return PROVIDER_FALLBACK_MODELS[provider] ?? "";
}

function addMessage(role, text, iconName) {
  if (!text) {
    return;
  }
  const feed = document.getElementById("chatFeed");
  if (!feed) {
    return;
  }
  // Накапливаем оценку токенов истории для кружка context-fill ДО ранних
  // return'ов веток reasoning/activity. Раньше этот учёт стоял в самом низу
  // функции и был недостижим для activity/reasoning (они выходят раньше),
  // из-за чего кружок context-fill не реагировал на технический трафик.
  const tokens = Math.ceil(String(text).length / 4);
  state.chatHistoryTokens += (role === "activity" || role === "reasoning") ? Math.ceil(tokens / 2) : tokens;
  renderCtxRing();
  // Reasoning (chain-of-thought) — компактный сворачиваемый блок.
  // ВАЖНО: рендерим МГНОВЕННО и целиком. Раньше тут был typewriter
  // (revealSequentially ~1.5с), из-за которого финальный ответ модели,
  // приходящий следом и рисующийся сразу, успевал появиться РАНЬШЕ, чем
  // дорисовывался ход мыслей. Это и создавало ощущение «мысли пишутся
  // после ответа». Мгновенный рендер сохраняет правильный порядок:
  // сначала reasoning, затем ответ.
  if (role === "reasoning") {
    const details = document.createElement("details");
    details.className = "reasoning-line";
    details.open = false;
    const summary = document.createElement("summary");
    summary.className = "reasoning-summary";
    summary.innerHTML = `<span class="reasoning-icon">${icon("brain")}</span><span class="reasoning-label">Ход мыслей модели</span>`;
    const target = document.createElement("div");
    target.className = "reasoning-text";
    target.textContent = String(text ?? "");
    details.appendChild(summary);
    details.appendChild(target);
    feed.appendChild(details);
    feed.scrollTop = feed.scrollHeight;
    return;
  }
  // ФИКС: activity-сообщения делаем компактными — тонкая полоска без аватара.
  if (role === "activity") {
    const feed = document.getElementById("chatFeed");
    if (!feed) return;
    // Tool-loop прогресс: если в тексте есть "Tool-loop итерация" — показываем прогресс-бар.
    const iterMatch = text.match(/Tool-loop итерация (\d+) из (\d+)/);
    if (iterMatch) {
      const current = parseInt(iterMatch[1]);
      const total = parseInt(iterMatch[2]);
      let progress = feed.querySelector(".tool-loop-progress");
      if (!progress) {
        progress = document.createElement("div");
        progress.className = "tool-loop-progress";
        progress.innerHTML = '<div class="tool-loop-bar"><div class="tool-loop-fill"></div></div><div class="tool-loop-text"></div><div class="tool-loop-tools"></div>';
        feed.appendChild(progress);
      }
      const fill = progress.querySelector(".tool-loop-fill");
      const txt = progress.querySelector(".tool-loop-text");
      if (fill) fill.style.width = `${(current / total) * 100}%`;
      if (txt) txt.textContent = `Итерация ${current} / ${total}`;
      feed.scrollTop = feed.scrollHeight;
      return;
    }
    // Tool execution: добавляем chip к tool-loop прогрессу.
    // describeToolCall теперь отдаёт человекочитаемое описание ("Чтение файла: X",
    // "Gradle task: build") — извлекаем tool-имя из описания.
    const toolMatch = text.match(/Выполняю tool: (.+)/);
    if (toolMatch) {
      const description = toolMatch[1];
      const progress = feed.querySelector(".tool-loop-progress");
      if (progress) {
        const tools = progress.querySelector(".tool-loop-tools");
        if (tools) {
          const toolIcon = description.includes("Чтение файла") ? "search" :
                           description.includes("patch") ? "build" :
                           description.includes("Gradle") ? "build" :
                           description.includes("Knowledge") ? "knowledge" :
                           description.includes("Blockbench") ? "cube" :
                           description.includes("Minecraft") ? "game" : "tools";
          const chip = document.createElement("span");
          chip.className = "tool-chip";
          chip.innerHTML = `${icon(toolIcon)} <span>${escapeHtml(description)}</span>`;
          tools.appendChild(chip);
        }
      }
      // Также добавляем в activity log
      const existing = feed.querySelector(".activity-log:last-child");
      let log = existing?.classList?.contains("activity-log") ? existing : null;
      if (!log) {
        log = document.createElement("div");
        log.className = "activity-log";
        feed.appendChild(log);
      }
      const line = document.createElement("div");
      line.className = "activity-line";
      line.innerHTML = `<span class="activity-dot"></span><span class="activity-text">${escapeHtml(text)}</span>`;
      log.appendChild(line);
      feed.scrollTop = feed.scrollHeight;
      return;
    }
    // Patch accepted / Gradle build — удаляем старый прогресс, начинаем новый лог.
    if (text.includes("Patch принят") || text.includes("Достигнут лимит") || text.includes("ответил")) {
      const progress = feed.querySelector(".tool-loop-progress");
      if (progress) {
        // Анимируем завершение
        const fill = progress.querySelector(".tool-loop-fill");
        if (fill) fill.classList.add("complete");
        setTimeout(() => progress.remove(), 1500);
      }
    }
    // Обычное activity-сообщение
    const existing = feed.querySelector(".activity-log:last-child");
    let log = existing?.classList?.contains("activity-log") ? existing : null;
    if (!log) {
      log = document.createElement("div");
      log.className = "activity-log";
      feed.appendChild(log);
    }
    const line = document.createElement("div");
    line.className = "activity-line";
    line.innerHTML = `<span class="activity-dot"></span><span class="activity-text">${escapeHtml(text)}</span>`;
    log.appendChild(line);
    feed.scrollTop = feed.scrollHeight;
    return;
  }
  const message = document.createElement("article");
  message.className = `message ${role}`;
  const avatarEl = document.createElement("span");
  avatarEl.className = "avatar";
  avatarEl.textContent = role === "user" ? "U" : "M";
  const body = document.createElement("div");
  body.className = "message-body";
  let p;
  if (iconName) {
    p = document.createElement("p");
    p.innerHTML = `<span class="msg-icon">${icon(iconName)}</span> ${escapeHtml(text)}`;
  } else if (role === "assistant" || role === "user") {
    // Ответы модели и реплики пользователя рендерим как markdown
    // (жирный/курсив/код/списки/заголовки/ссылки), чтобы текст был читаемым.
    // ВАЖНО: контейнер — <div>, а НЕ <p>. renderMarkdown возвращает блочные
    // элементы (<p>, <ul>, <ol>, <pre>, <h*>), и вложение <p> в <p> невалидно:
    // браузер разрывал внешний <p>, оставляя пустой первый абзац — из-за этого
    // ломалась дедупликация notice и плыли отступы.
    p = document.createElement("div");
    p.className = "md-body";
    p.innerHTML = renderMarkdown(text);
  } else {
    p = document.createElement("p");
    p.textContent = text;
  }
  body.appendChild(p);
  message.appendChild(avatarEl);
  message.appendChild(body);
  feed.appendChild(message);
  feed.scrollTop = feed.scrollHeight;
}

// === Session persistence: восстановление / сброс / список ===

// Грузит сохранённую сессию в feed. Сбрасывает chatHistoryTokens, чтобы
// кружок context-fill отражал загруженную историю, а не дублировал её.
function restoreSession(payload) {
  const session = payload ?? {};
  state.currentSessionId = session.id;
  clearChatMessages();
  state.chatHistoryTokens = 0;
  const welcome = document.getElementById("welcomeMessage");
  if (welcome) {
    welcome.hidden = true;
  }
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (const message of messages) {
    addMessage(message.role, message.text);
  }
  if (session.title) {
    document.title = `MineAgent · ${session.title}`;
  }
}

// Очищает feed при старте новой сессии (команда newSession от бэкенда).
function clearChatFeed() {
  state.currentSessionId = undefined;
  state.chatHistoryTokens = 0;
  clearChatMessages();
  const welcome = document.getElementById("welcomeMessage");
  if (welcome) {
    welcome.hidden = false;
  }
  document.title = "MineAgent Workbench";
  renderCtxRing();
}

// Удаляет из feed все сообщения, кроме welcome-блока.
function clearChatMessages() {
  const feed = document.getElementById("chatFeed");
  if (!feed) {
    return;
  }
  feed.querySelectorAll(".message:not(.welcome)").forEach((node) => node.remove());
}

// Рендерит выезжающую панель истории. Источник — state.sessionsList
// (метаданные: id/title/updatedAt/messageCount), наполненный из sessionsList.
function renderSessionsList() {
  const panel = document.getElementById("sessionsPanel");
  const list = document.getElementById("sessionsList");
  if (!panel || !list) {
    return;
  }
  panel.hidden = false;
  updateActivePanelButton();
  const sessions = Array.isArray(state.sessionsList) ? state.sessionsList : [];
  if (!sessions.length) {
    list.innerHTML = `<div class="session-empty">${icon("history")}<br>Сохранённых сессий нет.<br><span class="empty-action">Нажми «Новая» для старта</span></div>`;
    return;
  }
  list.innerHTML = "";
  for (const session of sessions) {
    const item = document.createElement("div");
    item.className = "session-item";
    if (session.id === state.currentSessionId) {
      item.classList.add("is-active");
    }
    const title = document.createElement("button");
    title.type = "button";
    title.className = "session-item-title";
    title.textContent = session.title || "Без названия";
    title.title = session.title || "Без названия";
    title.addEventListener("click", (event) => {
      event.stopPropagation();
      post("loadSession", { id: session.id });
      closeSessionsPanel();
    });
    const meta = document.createElement("span");
    meta.className = "session-item-meta";
    meta.textContent = `${session.messageCount ?? 0} · ${formatSessionDate(session.updatedAt)}`;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "session-item-delete";
    del.title = "Удалить сессию";
    del.innerHTML = icon("close");
    del.addEventListener("click", (event) => {
      event.stopPropagation();
      post("deleteSession", { id: session.id });
    });
    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(del);
    list.appendChild(item);
  }
  panel.hidden = false;
}

function togglePanel(panelId, postType) {
  const panel = document.getElementById(panelId);
  if (panel && !panel.hidden) {
    panel.hidden = true;
    updateActivePanelButton();
    return;
  }
  closeAllPanels();
  post(postType);
}

function closeAllPanels() {
  closeSessionsPanel();
  closeSubAgentsPanel();
  closeKnowledgePanel();
  closeSkillsPanel();
}

function updateActivePanelButton() {
  const map = {
    toggleSessions: "sessionsPanel",
    toggleSubAgents: "subagentsPanel",
    toggleKnowledge: "knowledgePanel",
    toggleSkills: "skillsPanel"
  };
  for (const [btnId, panelId] of Object.entries(map)) {
    const btn = document.getElementById(btnId);
    const panel = document.getElementById(panelId);
    if (btn && panel) {
      btn.classList.toggle("is-active", !panel.hidden);
    }
  }
}

function closeSessionsPanel() {
  const panel = document.getElementById("sessionsPanel");
  if (panel) {
    panel.hidden = true;
  }
  updateActivePanelButton();
}

function formatSessionDate(value) {
  if (!value) {
    return "";
  }
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    return date.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return "";
  }
}

function describeEvidence(item) {
  if (!item) {
    return null;
  }
  if (item.exitCode === 0) {
    return { text: `Команда завершена успешно: ${item.command}.`, icon: "check" };
  }
  return { text: `Команда завершена с exit ${item.exitCode}: ${item.command}. Пришлите ошибку мне в задаче — помогу разобрать.`, icon: "error" };
}

function describeLogSummary(summary) {
  const fatal = summary.fatalLines?.length ?? 0;
  const exceptions = summary.exceptions?.length ?? 0;
  return `latest.log разобран. Вероятная причина: ${summary.likelyCause}. Fatal: ${fatal}, exceptions: ${exceptions}.`;
}

function resourceTotal(resources = {}) {
  return Object.values(resources ?? {}).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
}

function labelLoader(loader) {
  const labels = {
    forge: "Forge",
    fabric: "Fabric",
    neoforge: "NeoForge",
    unknown: "Unknown"
  };
  return labels[loader] ?? loader;
}

function providerLabel(provider) {
  return PROVIDER_LABELS[provider] ?? provider;
}

function shortModelLabel(model) {
  const s = String(model ?? "").trim();
  if (!s) {
    return "Auto";
  }
  const tail = s.split("/").filter(Boolean).pop();
  return tail || s;
}

function formatContext(tokens) {
  if (!tokens) {
    return "unknown";
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}k`;
  }
  return `${tokens}`;
}

function formatTokens(n) {
  if (!n) {
    return "0";
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${Math.round(n / 1000)}k`;
  }
  return String(n);
}

function setBusy(label) {
  state.busy = true;
  setStatusPill(label ?? "работаю", "busy");
}

function setReady(label) {
  state.busy = false;
  if (state.workspaceMissing) {
    setStatusPill("no workspace", "error");
  } else if (label === "error") {
    setStatusPill("error", "error");
  } else {
    setStatusPill("idle", "");
  }
}

function setStatusPill(text, cls) {
  const pill = document.getElementById("statusPill");
  if (!pill) {
    return;
  }
  pill.textContent = text;
  pill.classList.remove("busy", "error");
  if (cls) {
    pill.classList.add(cls);
  }
}

function setText(id, value, property = "textContent") {
  const el = document.getElementById(id);
  if (el) {
    el[property] = value;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Минималистичный безопасный markdown-рендер для ответов модели.
// Сначала экранируем HTML, затем применяем разметку — XSS невозможен,
// внешних зависимостей нет (CSP допускает только наш nonce-скрипт).
function renderMarkdown(text) {
  const src = String(text ?? "");
  // Вырезаем блоки кода до построчной обработки, подменяя плейсхолдерами.
  const codeBlocks = [];
  let work = src.replace(/```([\w+-]*)\r?\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    const langClass = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
    codeBlocks.push(`<pre class="md-code"${langClass}><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000CODE${idx}\u0000`;
  });
  work = escapeHtml(work);

  const lines = work.split(/\r?\n/);
  const html = [];
  let listType = null; // "ul" | "ol" | null
  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };
  for (const rawLine of lines) {
    const line = rawLine;
    const placeholder = line.match(/^\u0000CODE(\d+)\u0000$/);
    if (placeholder) {
      closeList();
      html.push(codeBlocks[Number(placeholder[1])]);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level} class="md-h">${formatInline(heading[2])}</h${level}>`);
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ol) {
      if (listType !== "ol") {
        closeList();
        html.push('<ol class="md-list">');
        listType = "ol";
      }
      html.push(`<li>${formatInline(ol[1])}</li>`);
      continue;
    }
    if (ul) {
      if (listType !== "ul") {
        closeList();
        html.push('<ul class="md-list">');
        listType = "ul";
      }
      html.push(`<li>${formatInline(ul[1])}</li>`);
      continue;
    }
    closeList();
    html.push(`<p class="md-p">${formatInline(line)}</p>`);
  }
  closeList();
  return html.join("");
}

// Inline-разметка для уже экранированного текста: `код`, **жирный**, *курсив*,
// ~~зачёркнутый~~, [текст](url). url валидируем — только http(s).
function formatInline(escaped) {
  let s = escaped;
  s = s.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) =>
    `<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>`);
  return s;
}

// === Approval Gateway modal ===

const RISK_LABELS = {
  read: "Чтение",
  write: "Запись",
  command: "Команда",
  network: "Сеть",
  "game-control": "Управление игрой"
};

// Показывает модалку approval. payload = ApprovalRequest от backend.
// Запоминаем requestId — sendApprovalDecision пошлёт его обратно.
function showApprovalModal(payload) {
  const req = payload ?? {};
  state.pendingApprovalRequestId = req.requestId;
  const overlay = document.getElementById("approvalOverlay");
  if (!overlay) {
    return;
  }
  // description уже человекочитаемый («Blockbench: add_group (…)»),
  // поэтому не дублируем scopeId/toolName перед ним.
  setText("approvalDescription", req.description || req.toolName || req.scopeId || "Действие инструмента");
  const riskEl = document.getElementById("approvalRisk");
  if (riskEl) {
    const risk = req.risk ?? "command";
    riskEl.textContent = RISK_LABELS[risk] ?? risk;
    riskEl.className = `approval-risk-value risk-${risk}`;
  }
  const inputEl = document.getElementById("approvalInput");
  if (inputEl) {
    const inputText = req.input ? JSON.stringify(req.input, null, 2) : "";
    if (inputText) {
      inputEl.textContent = inputText;
      inputEl.hidden = false;
    } else {
      inputEl.hidden = true;
    }
  }
  overlay.hidden = false;
}

function hideApprovalModal() {
  const overlay = document.getElementById("approvalOverlay");
  if (overlay) {
    overlay.hidden = true;
  }
  state.pendingApprovalRequestId = undefined;
}

// Шлёт решение в backend и закрывает модалку.
function sendApprovalDecision(decision) {
  const requestId = state.pendingApprovalRequestId;
  if (!requestId) {
    hideApprovalModal();
    return;
  }
  post("approvalResponse", { requestId, decision });
  hideApprovalModal();
}

// === Sub-агенты panel ===

function closeSubAgentsPanel() {
  const panel = document.getElementById("subagentsPanel");
  if (panel) {
    panel.hidden = true;
  }
  hideSubAgentForm();
  updateActivePanelButton();
}

// Рендерит список sub-агентов из state.subagentsList.
function renderSubAgentsList() {
  const panel = document.getElementById("subagentsPanel");
  const list = document.getElementById("subagentsList");
  if (!panel || !list) {
    return;
  }
  panel.hidden = false;
  updateActivePanelButton();
  const agents = Array.isArray(state.subagentsList) ? state.subagentsList : [];
  if (!agents.length) {
    list.innerHTML = `<div class="subagent-empty">${icon("agent")}<br>Sub-агентов пока нет.<br><span class="empty-action">Добавьте через «${icon("plus")} Добавить»</span></div>`;
    return;
  }
  list.innerHTML = "";
  for (const agent of agents) {
    list.appendChild(renderSubAgentItem(agent));
  }
  panel.hidden = false;
}

function renderSubAgentItem(agent) {
  const item = document.createElement("div");
  item.className = `subagent-item${agent.enabled ? "" : " disabled"}`;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "subagent-toggle";
  toggle.title = agent.enabled ? "Выключить" : "Включить";
  toggle.innerHTML = agent.enabled ? icon("check") : icon("dot");
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    post("subagents.toggle", { id: agent.id });
  });

  const info = document.createElement("div");
  info.className = "subagent-info";
  const name = document.createElement("span");
  name.className = "subagent-name";
  name.textContent = agent.displayName || agent.id;
  const meta = document.createElement("span");
  meta.className = "subagent-meta";
  meta.textContent = `${agent.specialty ?? "custom"} · ${agent.model || "default"} · ${agent.allowedTools?.length ?? 0} tools`;
  info.appendChild(name);
  info.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "subagent-actions";
  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "subagent-action";
  editBtn.title = "Изменить";
  editBtn.innerHTML = icon("edit");
  editBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    showSubAgentForm(agent);
  });
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "subagent-action danger";
  delBtn.title = "Удалить";
  delBtn.innerHTML = icon("close");
  delBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (window.confirm(`Удалить sub-агента «${agent.displayName || agent.id}»?`)) {
      post("subagents.remove", { id: agent.id });
    }
  });
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);

  item.appendChild(toggle);
  item.appendChild(info);
  item.appendChild(actions);
  return item;
}

// Показывает форму. agent = undefined → режим создания.
function showSubAgentForm(agent) {
  const form = document.getElementById("subagentForm");
  if (!form) {
    return;
  }
  document.getElementById("subagentFormId").value = agent?.id ?? "";
  setText("saId", agent?.id ?? "", "value");
  setText("saDisplayName", agent?.displayName ?? "", "value");
  setText("saModel", agent?.model ?? "", "value");
  const specialty = document.getElementById("saSpecialty");
  if (specialty) {
    specialty.value = agent?.specialty ?? "custom";
  }
  const memory = document.getElementById("saMemoryMode");
  if (memory) {
    memory.value = agent?.memoryMode ?? "task";
  }
  setText("saAllowedTools", Array.isArray(agent?.allowedTools) ? agent.allowedTools.join(", ") : "", "value");
  setText("saPrompt", agent?.promptOverride ?? "", "value");
  // В режиме редактирования id нельзя менять.
  const idInput = document.getElementById("saId");
  if (idInput) {
    idInput.disabled = Boolean(agent);
  }
  form.hidden = false;
}

function hideSubAgentForm() {
  const form = document.getElementById("subagentForm");
  if (form) {
    form.hidden = true;
  }
}

// Собирает поля формы и шлёт в backend: add (новый) или update (существующий).
function saveSubAgentFromForm() {
  const editingId = document.getElementById("subagentFormId").value;
  const payload = {
    id: document.getElementById("saId")?.value?.trim() ?? "",
    displayName: document.getElementById("saDisplayName")?.value?.trim() ?? "",
    model: document.getElementById("saModel")?.value?.trim() ?? "",
    specialty: document.getElementById("saSpecialty")?.value ?? "custom",
    memoryMode: document.getElementById("saMemoryMode")?.value ?? "task",
    allowedTools: document.getElementById("saAllowedTools")?.value ?? "",
    promptOverride: document.getElementById("saPrompt")?.value ?? "",
    enabled: true
  };
  if (!payload.id || !payload.displayName) {
    addMessage("assistant", "Идентификатор и название обязательны.");
    return;
  }
  if (editingId) {
    post("subagents.update", { id: editingId, patch: payload });
  } else {
    post("subagents.add", payload);
  }
  hideSubAgentForm();
}

// === Этап 5: Vision + Critic UI ===

// === Этап 6: Knowledge Base + Skills UI ===

function closeKnowledgePanel() {
  const panel = document.getElementById("knowledgePanel");
  if (panel) {
    panel.hidden = true;
  }
  updateActivePanelButton();
}

function closeSkillsPanel() {
  const panel = document.getElementById("skillsPanel");
  if (panel) {
    panel.hidden = true;
  }
  const row = document.getElementById("skillsCreateRow");
  if (row) {
    row.hidden = true;
  }
  updateActivePanelButton();
}

function renderKnowledgeList() {
  const panel = document.getElementById("knowledgePanel");
  const list = document.getElementById("knowledgeList");
  if (!panel || !list) {
    return;
  }
  panel.hidden = false;
  updateActivePanelButton();
  const entries = state.knowledgeList ?? [];
  if (!entries.length) {
    list.innerHTML = `<div class="empty-hint">${icon("knowledge")}<br>База знаний пуста.<br><span class="empty-action">Добавь записи через поиск или вручную</span></div>`;
    return;
  }
  list.innerHTML = entries.map((entry) => {
    const sourceBadge = entry.source === "user" ? '<span class="kb-source-badge user">user</span>' : '<span class="kb-source-badge model">model</span>';
    const statusBadge = entry.status === "accepted" ? icon("check") : entry.status === "rejected" ? icon("close") : "?";
    // Все поля записи приходят из web-research/пользователя — экранируем,
    // иначе HTML/скрипт из заголовка/summary/тегов попадёт в innerHTML.
    const tags = (entry.tags ?? []).map((t) => `<span class="kb-tag">${escapeHtml(t)}</span>`).join("");
    const id = escapeHtml(entry.id);
    return `<div class="kb-entry" data-id="${id}">
      <div class="kb-entry-header">
        <span class="kb-category kb-cat-${escapeHtml(entry.category)}">${escapeHtml(entry.category)}</span>
        ${sourceBadge}
        <span class="kb-status">${statusBadge}</span>
        <button class="text-button kb-remove" data-id="${id}">Удалить</button>
      </div>
      <div class="kb-title">${escapeHtml(entry.title ?? entry.url)}</div>
      <div class="kb-summary">${escapeHtml(entry.summary ?? "")}</div>
      <div class="kb-tags">${tags}</div>
    </div>`;
  }).join("");
  // Bind remove buttons
  list.querySelectorAll(".kb-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      if (id) {
        post("knowledge.remove", { id });
      }
    });
  });
}

function filterKnowledgeList(query) {
  const list = document.getElementById("knowledgeList");
  if (!list) {
    return;
  }
  const q = (query ?? "").toLowerCase().trim();
  const entries = list.querySelectorAll(".kb-entry");
  entries.forEach((el) => {
    if (!q) {
      el.style.display = "";
      return;
    }
    const text = el.textContent?.toLowerCase() ?? "";
    el.style.display = text.includes(q) ? "" : "none";
  });
}

function renderSkillsList() {
  const panel = document.getElementById("skillsPanel");
  const list = document.getElementById("skillsList");
  if (!panel || !list) {
    return;
  }
  panel.hidden = false;
  updateActivePanelButton();
  const skills = state.skillsList ?? [];
  if (!skills.length) {
    list.innerHTML = `<div class="empty-hint">${icon("skills")}<br>Скиллов пока нет.<br><span class="empty-action">Создай через ИИ или добавь .md в .mineagent/skills/</span></div>`;
    return;
  }
  list.innerHTML = skills.map((skill) => {
    const readOnly = skill.readOnly ? `<span class="skill-readonly">${icon("lock")}</span>` : "";
    // Имя/описание/триггеры скилла могут прийти из .md или из ИИ-генерации —
    // экранируем перед вставкой в innerHTML.
    const triggers = (skill.triggers ?? []).map((t) => `<span class="kb-tag">${escapeHtml(t)}</span>`).join("");
    const name = escapeHtml(skill.name);
    return `<div class="skill-entry" data-name="${name}">
      <div class="skill-entry-header">
        <strong>${name}</strong> ${readOnly}
        ${!skill.readOnly ? `<button class="text-button skill-delete" data-name="${name}">Удалить</button>` : ""}
      </div>
      <div class="skill-desc">${escapeHtml(skill.description ?? "")}</div>
      <div class="kb-tags">${triggers}</div>
    </div>`;
  }).join("");
  list.querySelectorAll(".skill-delete").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.getAttribute("data-name");
      if (name && confirm(`Удалить скилл «${name}»?`)) {
        post("skills.delete", { name });
      }
    });
  });
}

// === Этап 5: Vision + Critic UI (продолжение) ===

// Vision-вердикт: показывает результат vision-оценки в чате как activity-сообщение
// с цветовым индикатором (matches = зелёный, mismatch = красный, uncertain = жёлтый).
function renderVisionVerdict(verdict) {
  const confidence = Math.round((verdict.confidence ?? 0) * 100);
  const text = `Vision [${verdict.sourceTool}]:${verdict.matches ? "" : " ?"} confidence ${confidence}% — ${verdict.notes ?? ""}`;
  addMessage("activity", text, verdict.matches ? "check" : undefined);
}

// Critic-вердикт: при action="ask-user" показывает модалку с обоими мнениями
// (main + critic) и кнопками «Применить» / «Отклонить» / «Решить самому».
// При action="apply" (консенсус) — просто activity-сообщение.
// При self-critique — предупреждение «объективность ниже».
function renderCriticVerdict(verdict) {
  if (verdict.isSelfCritique) {
    addMessage("activity", "Self-critique: critic работает на той же модели, что main — объективность ниже (те же слепые зоны тренировки).", "warning");
  }
  if (verdict.action === "apply") {
    addMessage("activity", `Critic: консенсус — применяю. (${verdict.verdict})`);
    return;
  }
  // ask-user: показываем модалку разногласия.
  const modal = document.getElementById("criticModal");
  if (!modal) {
    addMessage("activity", `Critic: ${verdict.verdict} — ${verdict.reasoning}`);
    return;
  }
  const mainEl = document.getElementById("criticMainOpinion");
  const criticEl = document.getElementById("criticCriticOpinion");
  if (mainEl) {
    mainEl.textContent = verdict.mainApproved ? "approve" : "reject";
  }
  if (criticEl) {
    criticEl.textContent = `${verdict.verdict}: ${verdict.reasoning}`;
  }
  modal.dataset.verdict = verdict.verdict;
  modal.hidden = false;
}

function hideCriticModal() {
  const modal = document.getElementById("criticModal");
  if (modal) {
    modal.hidden = true;
  }
}

function bindCriticModal() {
  const modal = document.getElementById("criticModal");
  if (!modal) {
    return;
  }
  const applyBtn = modal.querySelector(".critic-apply");
  const rejectBtn = modal.querySelector(".critic-reject");
  const decideBtn = modal.querySelector(".critic-decide");
  const cancelBtn = modal.querySelector(".critic-cancel");
  if (applyBtn) {
    applyBtn.addEventListener("click", () => {
      post("critic.resolve", { action: "apply" });
      hideCriticModal();
    });
  }
  if (rejectBtn) {
    rejectBtn.addEventListener("click", () => {
      post("critic.resolve", { action: "reject" });
      hideCriticModal();
    });
  }
  if (decideBtn) {
    decideBtn.addEventListener("click", () => {
      post("critic.resolve", { action: "decide-self" });
      hideCriticModal();
    });
  }
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      hideCriticModal();
    });
  }
}
