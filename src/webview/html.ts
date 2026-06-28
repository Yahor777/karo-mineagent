import * as vscode from "vscode";

export function getWorkbenchHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = createNonce();
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "mineagent.css"));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "mineagent.js"));

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${cssUri}">
  <title>MineAgent Workbench</title>
</head>
<body>
  <div id="app" class="mineagent-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <div class="brand-copy">
          <span class="brand-name">MineAgent</span>
          <span class="brand-subtitle">Minecraft mod agent</span>
        </div>
      </div>
      <div class="top-actions">
        <span class="ctx-ring" id="ctxRing" title="Заполнение context window модели" hidden>
          <svg class="ctx-ring-svg" viewBox="0 0 24 24" aria-hidden="true">
            <circle class="ctx-ring-track" cx="12" cy="12" r="10"></circle>
            <circle class="ctx-ring-fill" cx="12" cy="12" r="10"></circle>
          </svg>
          <span class="ctx-ring-label" id="ctxRingLabel">0%</span>
        </span>
        <span class="budget-chip" id="budgetChip" title="Потрачено токенов за сессию" hidden>
          <span class="budget-chip-dot"></span><span id="budgetValue">0</span>
        </span>
        <button class="blockbench-chip" id="blockbenchChip" title="Blockbench: отключено" data-status="disconnected" aria-label="Blockbench статус">
          <span class="blockbench-dot" aria-hidden="true"></span><span class="blockbench-label">Blockbench</span>
        </button>
        <button class="blockbench-chip minecraft-chip" id="minecraftChip" title="Minecraft dev bridge: отключено" data-status="disconnected" aria-label="Minecraft dev bridge статус">
          <span class="blockbench-dot" aria-hidden="true"></span><span class="blockbench-label">Minecraft</span>
        </button>
        <button class="icon-button" id="toggleSessions" title="История сессий" aria-label="История сессий">${iconSvg("history")}</button>
        <button class="icon-button" id="toggleSubAgents" title="Sub-агенты" aria-label="Sub-агенты">${iconSvg("agent")}</button>
        <button class="icon-button" id="toggleKnowledge" title="База знаний" aria-label="База знаний">${iconSvg("knowledge")}</button>
        <button class="icon-button" id="toggleSkills" title="Скиллы" aria-label="Скиллы">${iconSvg("skills")}</button>
        <button class="icon-button" id="refreshIndexTop" title="Обновить индекс" aria-label="Обновить индекс">${iconSvg("refresh")}</button>
        <button class="icon-button" data-menu-toggle="settingsMenu" title="Настройки" aria-label="Настройки">${iconSvg("settings")}</button>
      </div>
    </header>

    <section class="sessions-panel" id="sessionsPanel" aria-label="История сессий" hidden>
      <div class="sessions-panel-heading">
        <strong>История</strong>
        <div class="sessions-panel-actions">
          <button class="text-button" id="newSessionBtn">${iconSvg("plus")} Новая</button>
          <button class="text-button" id="closeSessions">Закрыть</button>
        </div>
      </div>
      <div class="sessions-list" id="sessionsList"></div>
    </section>

    <section class="subagents-panel" id="subagentsPanel" aria-label="Sub-агенты" hidden>
      <div class="subagents-panel-heading">
        <strong>Sub-агенты</strong>
        <div class="subagents-panel-actions">
          <button class="text-button" id="addSubAgentBtn">${iconSvg("plus")} Добавить</button>
          <button class="text-button" id="closeSubAgents">Закрыть</button>
        </div>
      </div>
      <div class="subagents-list" id="subagentsList"></div>
      <!-- Форму показываем по кнопке Добавить/Изменить, JS заполняет поля -->
      <div class="subagent-form" id="subagentForm" hidden>
        <input type="hidden" id="subagentFormId" />
        <label class="field">
          <span>Идентификатор</span>
          <input id="saId" class="input mono" placeholder="reviewer-jjk" />
        </label>
        <label class="field">
          <span>Название</span>
          <input id="saDisplayName" class="input" placeholder="Ревизор JJK" />
        </label>
        <label class="field">
          <span>Модель</span>
          <input id="saModel" class="input mono" placeholder="@cf/moonshotai/kimi-k2.7-code" />
        </label>
        <label class="field">
          <span>Специализация</span>
          <select id="saSpecialty" class="select">
            <option value="reviewer">Ревизор</option>
            <option value="researcher">Исследователь</option>
            <option value="vision">Vision-оценщик</option>
            <option value="custom">Свой</option>
          </select>
        </label>
        <label class="field">
          <span>Память контекста</span>
          <select id="saMemoryMode" class="select">
            <option value="none">Без памяти</option>
            <option value="task" selected>В пределах задачи</option>
            <option value="session">Вся сессия</option>
            <option value="ask">Спрашивать</option>
          </select>
        </label>
        <label class="field">
          <span>Разрешённые инструменты (через запятую)</span>
          <input id="saAllowedTools" class="input mono" placeholder="repo.read, repo.search" />
        </label>
        <label class="field">
          <span>Системный промт (переопределяет дефолт)</span>
          <textarea id="saPrompt" class="rules-editor" rows="3" spellcheck="false"></textarea>
        </label>
        <div class="menu-actions">
          <button class="primary-button" id="saveSubAgent">Сохранить</button>
          <button class="primary-button secondary" id="cancelSubAgent">Отмена</button>
        </div>
      </div>
    </section>

    <!-- Этап 6: Knowledge Base панель -->
    <section class="knowledge-panel" id="knowledgePanel" aria-label="База знаний" hidden>
      <div class="sessions-panel-heading">
        <strong>База знаний</strong>
        <div class="sessions-panel-actions">
          <button class="text-button" id="knowledgeSearchBtn">${iconSvg("search")} Поиск через модель</button>
          <button class="text-button" id="closeKnowledge">Закрыть</button>
        </div>
      </div>
      <input id="knowledgeSearchInput" class="input" placeholder="Поиск по базе знаний…" />
      <div class="knowledge-list" id="knowledgeList"></div>
    </section>

    <!-- Этап 6: Skills панель -->
    <section class="skills-panel" id="skillsPanel" aria-label="Скиллы" hidden>
      <div class="sessions-panel-heading">
        <strong>Скиллы</strong>
        <div class="sessions-panel-actions">
          <button class="text-button" id="skillCreateBtn">${iconSvg("plus")} Создать через ИИ</button>
          <button class="text-button" id="closeSkills">Закрыть</button>
        </div>
      </div>
      <div class="skills-create-row" id="skillsCreateRow" hidden>
        <input id="skillTopicInput" class="input" placeholder="Опиши тему скилла (например «регистрация предметов в Forge»)…" />
        <button class="primary-button" id="skillCreateConfirm">Создать</button>
      </div>
      <div class="skills-list" id="skillsList"></div>
    </section>

    <section class="status-strip" id="statusStrip" aria-label="Статус проекта">
      <div class="status-facts" id="statusFacts">
        <span class="status-fact placeholder">Обнови индекс, чтобы увидеть проект</span>
      </div>
      <span class="status-pill" id="statusPill">idle</span>
    </section>

    <main class="chat-feed" id="chatFeed">
      <section class="empty-workspace" id="emptyWorkspace" hidden>
        <strong>Открой папку Minecraft-мода</strong>
        <span>Через File → Open Folder. MineAgent работает с текущим workspace VS Code.</span>
        <button class="primary-button" id="openWorkspace">Open Folder</button>
      </section>

      <article class="message assistant welcome" id="welcomeMessage">
        <span class="avatar">M</span>
        <div class="message-body">
          <p>Я MineAgent — помогаю разрабатывать Minecraft-моды. Выбери модель через кнопку внизу и опиши задачу.</p>
        </div>
      </article>
    </main>

    <footer class="composer">
      <div class="composer-menus">
        <section class="composer-menu model-menu" id="modelMenu" hidden>
          <div class="menu-heading">
            <strong>Модель</strong>
            <button class="text-button" id="refreshProviderModels">Обновить модели</button>
          </div>
          <select id="providerSelect" class="select compact-input" aria-label="Провайдер">
            <option value="cloudflare">Cloudflare Workers AI</option>
            <option value="fireworks">Fireworks AI</option>
            <option value="wavespeed">WaveSpeed AI</option>
            <option value="kimchi">Kimchi (Kimi)</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="custom">Custom OpenAI-compatible</option>
          </select>
          <input id="modelSearch" class="input" placeholder="Поиск по имени или id" />
          <div class="model-list" id="modelList" role="listbox" aria-label="Список моделей">
            <!-- модели рендерятся JS-кодом, сгруппированные по вендорам -->
          </div>
          <input id="providerModelInput" class="input mono" value="@cf/moonshotai/kimi-k2.7-code" placeholder="Custom model id" />
          <div class="capability-strip" id="modelCapabilities"></div>
          <div class="menu-actions">
            <button class="primary-button" id="useProviderModel">Выбрать</button>
            <button class="primary-button secondary" id="testProvider">Проверить</button>
            <button class="primary-button secondary" id="setCurrentProviderKey">Key</button>
          </div>
        </section>

        <section class="composer-menu" id="toolsMenu" hidden>
          <button class="menu-row" id="runBuild">${iconSvg("build")} Gradle build</button>
          <button class="menu-row" id="applyLastPatch">Применить patch</button>
          <button class="menu-row" id="runClient">${iconSvg("play")} Run Client</button>
          <button class="menu-row" id="parseLog">${iconSvg("log")} Разобрать latest.log</button>
          <button class="menu-row" id="refreshIndex">${iconSvg("refresh")} Обновить индекс</button>
        </section>

        <section class="composer-menu settings-menu" id="settingsMenu" hidden>
          <div class="providers" id="providers"></div>
          <button class="menu-row" id="openRules">Открыть AGENTS.md</button>
          <button class="menu-row" id="setProviderKey">Настроить ключ провайдера</button>
          <details class="rules-block">
            <summary>Правила (AGENTS.md)</summary>
            <textarea id="rulesEditor" class="rules-editor" spellcheck="false" aria-label="AGENTS.md rules"></textarea>
            <button class="primary-button" id="saveRules">Сохранить правила</button>
          </details>
          <details class="rules-block">
            <summary>Internet research</summary>
            <div id="researchSummary" class="inline-summary">Источников пока нет.</div>
            <textarea id="researchEditor" class="rules-editor research-editor" spellcheck="false" aria-label="Research ledger JSON"></textarea>
            <div class="research-actions">
              <button class="primary-button secondary" id="searchWebResearch">Поиск в web</button>
              <button class="primary-button secondary" id="saveResearchLedger">Сохранить</button>
            </div>
          </details>
        </section>
      </div>

      <div class="composer-toolbar" aria-label="Управление composer">
        <select class="select" id="agentMode" title="Режим" aria-label="Режим">
          <option value="ask">Спросить</option>
          <option value="plan">План</option>
          <option value="build">Собрать</option>
          <option value="playtest">Плейтест</option>
        </select>
        <button class="select-button model-trigger" data-menu-toggle="modelMenu" id="modelButton" title="Модель">
          <span class="model-trigger-label" id="modelButtonLabel">Kimi K2.7 Code</span>
        </button>
        <button class="tool-button" data-menu-toggle="toolsMenu" title="Инструменты" aria-label="Инструменты">${iconSvg("tools")}</button>
        <span class="composer-status" id="composerStatus">Готов</span>
      </div>
      <div class="composer-input-row">
        <textarea id="promptInput" class="prompt-input" rows="2" placeholder="Опиши задачу: техника, структура, моб, 3D модель..."></textarea>
        <button class="run-button" id="runPrompt" title="Отправить" aria-label="Отправить">${iconSvg("send")}</button>
      </div>
    </footer>

    <!-- Approval Gateway modal: показывается при запросе tool/sub-agent approval -->
    <div class="approval-overlay" id="approvalOverlay" hidden>
      <div class="approval-modal" role="dialog" aria-modal="true" aria-labelledby="approvalTitle">
        <h2 class="approval-title" id="approvalTitle">MineAgent хочет выполнить действие</h2>
        <p class="approval-description" id="approvalDescription"></p>
        <div class="approval-risk">
          <span class="approval-risk-label">Уровень риска:</span>
          <span class="approval-risk-value" id="approvalRisk"></span>
        </div>
        <pre class="approval-input" id="approvalInput" hidden></pre>
        <div class="approval-modal-buttons">
          <button class="primary-button" id="approvalConfirmOnce">Подтвердить один раз</button>
          <button class="primary-button secondary" id="approvalAlwaysInSession">Всегда в этой сессии</button>
          <button class="primary-button secondary" id="approvalAlwaysAll">Всегда (все инструменты в сессии)</button>
          <button class="primary-button secondary" id="approvalAlways">Всегда</button>
          <button class="primary-button secondary danger" id="approvalDeny">Отклонить</button>
        </div>
      </div>
    </div>

    <!-- Этап 5: Critic modal — модалка разногласия main vs critic -->
    <div class="approval-overlay" id="criticModal" hidden>
      <div class="approval-modal" role="dialog" aria-modal="true" aria-labelledby="criticTitle">
        <h2 class="approval-title" id="criticTitle">Разногласие между main и critic</h2>
        <div class="critic-opinions">
          <div class="critic-opinion">
            <span class="critic-opinion-label">Мнение main-агента:</span>
            <span id="criticMainOpinion"></span>
          </div>
          <div class="critic-opinion">
            <span class="critic-opinion-label">Мнение critic:</span>
            <span id="criticCriticOpinion"></span>
          </div>
        </div>
        <div class="approval-modal-buttons">
          <button class="primary-button critic-apply">Применить</button>
          <button class="primary-button secondary danger critic-reject">Отклонить</button>
          <button class="primary-button secondary critic-decide">Решить самому</button>
          <button class="primary-button secondary critic-cancel">Отмена</button>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

function iconSvg(name: string): string {
  const paths: Record<string, string> = {
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
    lock: '<rect x="4" y="7.5" width="8" height="6" rx="1"/><path d="M5.5 7.5V6a2.5 2.5 0 0 1 5 0v1.5"/>'
  };
  const body = paths[name];
  if (!body) {
    return "";
  }
  return `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
