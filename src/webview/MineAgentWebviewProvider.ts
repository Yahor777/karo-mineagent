import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { ConfigService } from "../config/configService";
import type { ProviderId, ResearchLedger, MineAgentConfig } from "../config/types";
import { MineAgentOrchestrator, type RunReport } from "../orchestrator/orchestrator";
import { ProviderRequestError } from "../providers/openaiCompatibleProvider";
import type { ProviderModel } from "../providers/ProviderAdapter";
import { ProviderRegistry } from "../providers/providerRegistry";
import { TokenBudgetService } from "../providers/tokenBudget";
import type { ProjectMap } from "../repo/projectMap";
import { RepoIndexer } from "../repo/repoIndexer";
import type { CommandEvidence } from "../tools/gradleTools";
import { GradleTools } from "../tools/gradleTools";
import { GitTools } from "../tools/gitTools";
import { GitHubTools } from "../tools/githubTools";
import { webSearch } from "../tools/webSearch";
import { readWorkspaceFile, searchWorkspace, gitDiff } from "../tools/repoReadTools";
import { parseGradleOutput, tailMinecraftLogs, parseCrashReport } from "../tools/buildDiagnostics";
import { parseMinecraftLog } from "../tools/logParser";
import { SessionService } from "../session/sessionService";
import { ProjectMemoryService } from "../memory/projectMemory";
import { ApprovalGate } from "../approval/approvalGate";
import type { ApprovalRequest, ApprovalResponse } from "../approval/types";
import { SubAgentStore } from "../agents/subAgentStore";
import type { SubAgentConfig } from "../agents/types";
import { SubAgentRunner } from "../agents/subAgentRunner";
import { ToolRegistry } from "../tools/toolRegistry";
import { EmbeddingService } from "../providers/embeddingService";
import { LocalEmbeddingProvider } from "../providers/localEmbeddingProvider";
import { KnowledgeBaseService } from "../knowledge/knowledgeBase";
import type { KnowledgeEntry, KnowledgeCategory } from "../knowledge/types";
import { SkillService } from "../skills/skillService";
import type { Skill } from "../skills/types";
import { ToolDispatcher } from "../tools/toolDispatcher";
import { BlockbenchBridge } from "../mcp/blockbenchBridge";
import { MinecraftBridge } from "../mcp/minecraftBridge";
import type { McpServerContext, RunResult } from "../mcp/mcpServerTools";
import { VisionEvaluator } from "../orchestrator/visionEvaluator";
import { CriticRunner } from "../orchestrator/criticRunner";
import { parseBridgeReadyLine } from "../tools/logParser";
import { getWorkbenchHtml } from "./html";

interface WebviewState {
  projectMap?: ProjectMap;
  evidence: CommandEvidence[];
  researchLedger?: ResearchLedger;
  lastReport?: RunReport;
  providerModelsByProvider: Partial<Record<ProviderId, ProviderModel[]>>;
}

export class MineAgentWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private currentRunAbort?: AbortController;
  // Token-бюджет живёт весь lifetime webview-провайдера (т.е. вся сессия VS Code).
  private readonly tokenBudget = new TokenBudgetService();
  // Session persistence: сохраняет chat history между перезапусками VS Code.
  // Инициализируется в конструкторе — нужен configService.workspaceRoot.
  private readonly sessions: SessionService;
  // Фаза 1: живая память проекта (.mineagent/project.md), провайдеро-независимая.
  private readonly projectMemory: ProjectMemoryService;
  // Approval gateway + tool registry/dispatcher — ядро Этапа 1.
  // gate/dispatcher/registry/store создаются лениво в resolveWebviewView,
  // когда config уже вычитан (нужен для gate.updateConfig).
  private gate?: ApprovalGate;
  private dispatcher?: ToolDispatcher;
  private blockbenchBridge?: BlockbenchBridge;
  // Этап 4: Minecraft Dev Bridge (MCP-сервер внутри dev-сборки мода). Lifecycle
  // сложнее Blockbench: подключение требует поднятого dev-клиента + токена из лога.
  private minecraftBridge?: MinecraftBridge;
  private readonly registry = new ToolRegistry();
  private store?: SubAgentStore;
  // Этап 6: Knowledge Base + Skills сервисы.
  private knowledgeBase?: KnowledgeBaseService;
  private skillService?: SkillService;
  private currentSessionId?: string;
  private state: WebviewState = {
    evidence: [],
    providerModelsByProvider: {}
  };

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly configService: ConfigService,
    private readonly providers: ProviderRegistry
  ) {
    this.sessions = new SessionService(configService.workspaceRoot.fsPath);
    this.projectMemory = new ProjectMemoryService(configService.workspaceRoot.fsPath);
  }

  public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")]
    };
    webviewView.webview.html = getWorkbenchHtml(webviewView.webview, this.extensionUri);
    webviewView.webview.onDidReceiveMessage((message: { type: string; payload?: unknown }) => {
      void this.handleMessage(message);
    });
    try {
      await this.refresh();
    } catch (error) {
      this.post("notice", humanizeWorkbenchError(error));
    }
    // Approval gateway + tool dispatcher: конфиг уже вычитан в refresh().
    try {
      await this.initApprovalStack();
    } catch (error) {
      this.post("notice", humanizeWorkbenchError(error));
    }
    await this.refreshIndexOnOpen();
    void this.refreshConfiguredProviderModels();
    // Auto-resume последней сессии: пользователь не теряет chat history
    // после перезапуска VS Code.
    void this.resumeLatestSession();
  }

  // Создаёт gate/registry/dispatcher/store и регистрирует handlers существующих
  // tool-вызовов. Вызывается после refresh(), когда config гарантированно есть.
  private async initApprovalStack(): Promise<void> {
    const config = await this.configService.ensureWorkspaceFiles();
    // Registry: handlers для tools, которые реально вызываются сейчас.
    const root = this.configService.workspaceRoot.fsPath;
    // Этап 1 (новое): базовые read-only «руки» — ИИ видит проект перед изменениями.
    this.registry.register("repo.read", async (input) => {
      const rel = String((input as { path?: string })?.path ?? "");
      return readWorkspaceFile(root, rel);
    });
    this.registry.register("repo.search", async (input) => {
      const query = String((input as { query?: string })?.query ?? "");
      const regex = Boolean((input as { regex?: boolean })?.regex);
      return searchWorkspace(root, query, { regex });
    });
    this.registry.register("repo.index", async () => {
      const projectMap = await new RepoIndexer(root).buildProjectMap();
      this.setProjectMap(projectMap);
      return projectMap;
    });
    this.registry.register("gradle.tasks", async () => {
      const projectMap = await new RepoIndexer(root).buildProjectMap();
      return { tasks: projectMap.gradleTasks ?? [] };
    });
    this.registry.register("git.diff", async (input) => {
      const path = (input as { path?: string })?.path;
      return gitDiff(root, typeof path === "string" ? path : undefined);
    });
    // Фаза 3 (P3): Git-инструменты (опасное идёт через ApprovalGate).
    this.registry.register("git.status", async () => new GitTools(root).status());
    this.registry.register("git.commit", async (input) => {
      const message = String((input as { message?: string })?.message ?? "MineAgent commit");
      return new GitTools(root).commit(message);
    });
    this.registry.register("git.branch", async (input) => {
      const name = (input as { name?: string })?.name;
      return name ? new GitTools(root).createBranch(String(name)) : new GitTools(root).branchList();
    });
    this.registry.register("git.checkout", async (input) => {
      const ref = String((input as { ref?: string })?.ref ?? "");
      return new GitTools(root).checkout(ref);
    });
    this.registry.register("git.push", async (input) => {
      const remote = String((input as { remote?: string })?.remote ?? "origin");
      const branch = (input as { branch?: string })?.branch;
      return new GitTools(root).push(remote, typeof branch === "string" ? branch : undefined);
    });
    this.registry.register("git.pull", async (input) => {
      const remote = String((input as { remote?: string })?.remote ?? "origin");
      const branch = (input as { branch?: string })?.branch;
      return new GitTools(root).pull(remote, typeof branch === "string" ? branch : undefined);
    });
    // Фаза 3 (P3): GitHub-инструменты. Токен — из окружения GITHUB_TOKEN (не в конфиге).
    this.registry.register("github.clone", async (input) => {
      const record = input as { url?: string; targetDir?: string };
      return GitHubTools.clone(String(record.url ?? ""), root, record.targetDir);
    });
    this.registry.register("github.pr", async (input) => {
      const r = input as { owner?: string; repo?: string; title?: string; head?: string; base?: string; body?: string };
      const token = process.env.GITHUB_TOKEN ?? "";
      if (!token) {
        return { error: "GITHUB_TOKEN не задан в окружении." };
      }
      return GitHubTools.createPullRequest({
        owner: String(r.owner ?? ""), repo: String(r.repo ?? ""), title: String(r.title ?? ""),
        head: String(r.head ?? ""), base: String(r.base ?? "main"), body: r.body, token
      });
    });
    // Фаза 2 (P2.3): memory.note — агент пишет находки/решения в project.md.
    this.registry.register("memory.note", async (input) => {
      const r = input as { text?: string; section?: "conventions" | "content" | "decisions" | "open" };
      const written = await this.projectMemory.appendToSection(r.section ?? "decisions", String(r.text ?? ""), "agent");
      return { written };
    });
    // Этап 2: диагностика сборки и крашей — ИИ получает структурированные ошибки.
    this.registry.register("build.diagnose", async (input) => {
      const task = String((input as { task?: string })?.task ?? "compileJava");
      const evidence = await new GradleTools(root).runTask(task);
      return parseGradleOutput(evidence, task);
    });
    this.registry.register("minecraft.tailLogs", async (input) => {
      const lines = Number((input as { lines?: number })?.lines ?? 200);
      return tailMinecraftLogs(root, Number.isFinite(lines) ? lines : 200);
    });
    this.registry.register("minecraft.parseCrash", async (input) => {
      const path = (input as { path?: string })?.path;
      return parseCrashReport(root, typeof path === "string" ? path : undefined);
    });
    this.registry.register("gradle.run", async (input) => {
      const task = String((input as { task?: string })?.task ?? "build");
      return new GradleTools(root).runTask(task);
    });
    this.registry.register("repo.patch", async (input) => {
      const diff = String((input as { patch?: string })?.patch ?? "");
      return runGitApply(root, diff);
    });
    this.registry.register("minecraft.runClient", async (input) => {
      const task = String((input as { task?: string })?.task ?? "runClient");
      return new GradleTools(root).runClient(task);
    });
    // Этап 6: Knowledge Base tools — модель может искать и добавлять записи.
    this.registry.register("knowledge.search", async (input) => {
      const query = String((input as { query?: string })?.query ?? "");
      const category = (input as { category?: string })?.category as KnowledgeCategory | undefined;
      if (!query.trim() || !this.knowledgeBase) {
        return { added: 0, error: "query пуст или Knowledge Base не инициализирована" };
      }
      // Фаза 2 (P2.4/P2.5): реальный веб-поиск вместо DuckDuckGo Instant Answer.
      const found = await webSearch(query, {
        mode: config.agent.webSearchMode ?? "free",
        firecrawlApiKey: process.env.FIRECRAWL_API_KEY,
        limit: 5
      });
      const sources = found.map((s) => ({ url: s.url, title: s.title, summary: s.summary, learned: s.summary }));
      const cat = category ?? this.knowledgeBase.suggestCategory(query);
      let added = 0;
      for (const source of sources.slice(0, 5)) {
        await this.knowledgeBase.add({
          url: source.url,
          title: source.title,
          category: cat,
          tags: query.toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 5),
          summary: source.summary,
          fullNotes: source.learned,
          source: "model",
          status: "candidate"
        });
        added += 1;
      }
      return { added, query };
    });
    this.registry.register("knowledge.add", async (input) => {
      const record = input as { url?: string; summary?: string; title?: string; category?: string; tags?: string[] };
      if (!record.url || !record.summary || !this.knowledgeBase) {
        return { error: "url и summary обязательны" };
      }
      const category = (record.category ?? "misc") as KnowledgeCategory;
      const entry = await this.knowledgeBase.add({
        url: record.url,
        title: record.title,
        category,
        tags: Array.isArray(record.tags) ? record.tags : [],
        summary: record.summary,
        source: "model",
        status: "candidate"
      });
      return { id: entry.id };
    });

    this.gate = new ApprovalGate(
      config,
      async (next) => this.configService.writeConfig(next),
      (msg) => this.post(msg.type, msg.payload),
      (msg) => this.post("notice", msg)
    );
    this.dispatcher = new ToolDispatcher(this.registry, this.gate);
    this.store = new SubAgentStore({
      readConfig: () => this.configService.readConfig(),
      writeConfig: (cfg) => this.configService.writeConfig(cfg)
    });
    // Этап 3: Blockbench-bridge. Создаётся лениво здесь (после registry/dispatcher/gate),
    // чтобы handler'ы blockbench.* регистрировались в том же реестре. Подключение
    // инициируется пользователем (blockbenchConnect) — см. connectBlockbench().
    this.blockbenchBridge = new BlockbenchBridge(
      { registry: this.registry },
      {
        url: config.mcp.blockbench.url,
        timeoutMs: config.mcp.blockbench.timeoutMs
      }
    );
    this.blockbenchBridge.onChange((snapshot) => this.post("blockbenchStatus", snapshot));
    // Подключение к Blockbench при открытии воркбенча:
    //   enabled=true            → авто-подключение в фоне (как раньше);
    //   connectPrompt="always"  → авто-подключение без вопроса;
    //   connectPrompt="never"   → ничего не делаем (пользователь отказался);
    //   иначе ("ask")           → спрашиваем подтверждение + «Больше не спрашивать».
    if (config.mcp.blockbench.enabled || config.mcp.blockbench.connectPrompt === "always") {
      void this.connectBlockbench().catch((error) => {
        this.post("notice", humanizeWorkbenchError(error));
      });
    } else if (config.mcp.blockbench.connectPrompt !== "never") {
      void this.promptConnectBlockbench();
    }

    // Этап 4: Minecraft Dev Bridge. Создаётся здесь же (после registry), но БЕЗ
    // токена — token парсится из лога dev-клиента при подключении (мод генерирует
    // его каждый старт). Подключение инициируется пользователем
    // (minecraftConnect) или авто-подключением, но требует поднятого клиента.
    this.minecraftBridge = new MinecraftBridge(
      { registry: this.registry },
      {
        url: config.mcp.minecraft.url,
        timeoutMs: config.mcp.minecraft.timeoutMs
        // token не задаём здесь — resolveMinecraftBridgeToken() читает лог
      }
    );
    this.minecraftBridge.onChange((snapshot) => this.post("minecraftStatus", snapshot));
    // Авто-подключение minecraft-bridge: отличается от blockbench — нужно
    // сначала убедиться, что dev-клиент запущен (endpoint поднят). Если клиент
    // не запущен, авто-подключение тихо пропускается (пользователь запустит
    // вручную через runClient → connect).
    if (config.mcp.minecraft.enabled) {
      void this.connectMinecraft().catch((error) => {
        this.post("notice", humanizeWorkbenchError(error));
      });
    }

    // Этап 6: Knowledge Base + Skills сервисы. Создаются после registry/dispatcher,
    // используют EmbeddingService (через провайдера) для retrieval.
    const embeddingProvider = await this.providers.get(config.providers.defaultProvider);
    // Фаза 2 (P2.2): если у провайдера нет embeddings (как у kimchi) — локальные
    // оффлайн-embeddings (bge-m3). RAG (Knowledge Base + Skills) работает всегда.
    const embeddingService = embeddingProvider.embeddings
      ? new EmbeddingService({
          provider: embeddingProvider,
          embeddingModel: config.agent.embeddingModel
        })
      : new EmbeddingService({ provider: new LocalEmbeddingProvider() });
    this.knowledgeBase = new KnowledgeBaseService(
      {
        readBase: () => this.readKnowledgeBase(),
        writeBase: (base) => this.writeKnowledgeBase(base)
      },
      embeddingService
    );
    this.skillService = new SkillService(
      this.configService.toFsPath(config.paths.skills),
      embeddingService
    );
  }

  private async resumeLatestSession(): Promise<void> {
    try {
      const latest = await this.sessions.latestSession();
      if (!latest || !latest.messages.length) {
        // Нет истории — начинаем новую сессию при первом сообщении.
        return;
      }
      this.currentSessionId = latest.id;
      this.post("sessionRestored", {
        id: latest.id,
        title: latest.title,
        messages: latest.messages
      });
    } catch (error) {
      this.post("notice", humanizeWorkbenchError(error));
    }
  }

  public async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }
    const [config, providerStatuses, rules, researchLedger] = await Promise.all([
      this.configService.ensureWorkspaceFiles(),
      this.providers.providerStatuses(),
      this.configService.readAgentsRules(),
      this.configService.readResearchLedger()
    ]);
    this.state.researchLedger = researchLedger;
    // Держим gate в актуальном состоянии с config (для autoApproveTools/approvalMode).
    this.gate?.updateConfig(config);
    // Этап 3/4: шлём текущий статус обоих MCP-bridge'ей вместе с state (для
    // индикаторов подключения в UI).
    this.postBlockbenchStatus();
    this.postMinecraftStatus();
    this.post("state", {
      config,
      providerStatuses,
      rules,
      researchLedger,
      providerModelsByProvider: this.state.providerModelsByProvider,
      projectMap: this.state.projectMap,
      evidence: this.state.evidence.slice(-5)
    });
  }

  public setProjectMap(projectMap: ProjectMap): void {
    this.state.projectMap = projectMap;
    this.post("projectMap", projectMap);
  }

  public addEvidence(evidence: CommandEvidence): void {
    this.state.evidence.push(evidence);
    this.post("evidence", this.state.evidence.slice(-5));
  }

  private async handleMessage(message: { type: string; payload?: unknown }): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          await this.refresh();
          break;
        case "openWorkspace":
          await vscode.commands.executeCommand("workbench.action.files.openFolder");
          break;
        case "initializeWorkspace":
          await this.configService.ensureWorkspaceFiles();
          await this.refresh();
          break;
        case "refreshIndex": {
          const projectMap = await new RepoIndexer(this.configService.workspaceRoot.fsPath).buildProjectMap();
          this.setProjectMap(projectMap);
          break;
        }
        case "saveRules":
          await this.configService.saveAgentsRules(String((message.payload as { text?: string })?.text ?? ""));
          vscode.window.showInformationMessage("Saved AGENTS.md.");
          break;
        case "saveResearchLedger": {
          const ledger = await this.configService.saveResearchLedger(parseResearchLedgerPayload(message.payload));
          this.state.researchLedger = ledger;
          this.post("researchLedger", ledger);
          break;
        }
        case "researchWeb":
          await this.researchWeb(String((message.payload as { topic?: string })?.topic ?? ""));
          break;
        case "openRules":
          await vscode.commands.executeCommand("mineagent.openAgentsRules");
          break;
        case "setProviderKey":
          // BUG#11 FIX: refresh() вызывается внутри setProviderKey command (extension.ts).
          // Здесь только обновляем модели — без двойного refresh().
          await vscode.commands.executeCommand("mineagent.setProviderKey", parseProviderId((message.payload as { provider?: string })?.provider));
          await this.refreshProviderModels(parseProviderId((message.payload as { provider?: string })?.provider), { silent: true });
          break;
        case "setFireworksKey":
          await vscode.commands.executeCommand("mineagent.setProviderKey", "fireworks");
          await this.refresh();
          break;
        case "setCloudflareKey":
          await vscode.commands.executeCommand("mineagent.setProviderKey", "cloudflare");
          await this.refresh();
          break;
        case "useFireworksKimi":
          await this.selectProviderModel("fireworks", String((message.payload as { model?: string })?.model ?? ""));
          break;
        case "selectFireworksModel":
        case "selectProviderModel": {
          // ФИКС: fallback на config.defaultProvider, не на "fireworks".
          const config = await this.configService.readConfig();
          const providerId = parseProviderId((message.payload as { provider?: string })?.provider)
            ?? config?.providers.defaultProvider
            ?? "cloudflare";
          await this.selectProviderModel(
            providerId,
            String((message.payload as { model?: string })?.model ?? "")
          );
          break;
        }
        case "refreshFireworksModels":
        case "refreshProviderModels":
          await this.refreshProviderModels(parseProviderId((message.payload as { provider?: string })?.provider));
          break;
        case "testFireworks":
          await this.testProvider("fireworks");
          break;
        case "testProvider":
          await this.testProvider(parseProviderId((message.payload as { provider?: string })?.provider));
          break;
        case "runGradleBuild":
          await this.runGradle("build");
          break;
        case "applyLastPatch":
          await this.applyLastPatch();
          break;
        case "runClient":
          await vscode.commands.executeCommand("mineagent.runClient");
          break;
        case "parseLog":
          await this.parseLogFile();
          break;
        case "cancelRun":
          this.cancelRun();
          break;
        case "blockbenchConnect":
          await this.connectBlockbench();
          break;
        case "blockbenchDisconnect":
          await this.disconnectBlockbench();
          break;
        case "minecraftConnect":
          await this.connectMinecraft();
          break;
        case "minecraftDisconnect":
          await this.disconnectMinecraft();
          break;
        case "startRun":
          await this.startRun(
            String((message.payload as { prompt?: string })?.prompt ?? ""),
            parseRunMode((message.payload as { mode?: string })?.mode)
          );
          break;
        case "budgetResponse": {
          // Ответ пользователя на стоп-предложение по токен-бюджету.
          // Запрос НЕ прерывается — предложение приходит только после ответа модели.
          const action = String((message.payload as { action?: string })?.action ?? "");
          if (action === "hideForSession") {
            this.tokenBudget.hideForSession();
          } else if (action === "stop") {
            this.cancelRun();
          }
          // action === "continue" — ничего не делаем, пользователь осознанно продолжает.
          break;
        }
        case "newSession":
          this.currentSessionId = undefined;
          this.post("sessionCleared", {});
          break;
        case "loadSession": {
          const sessionId = String((message.payload as { id?: string })?.id ?? "");
          if (sessionId) {
            const session = await this.sessions.loadSession(sessionId);
            this.currentSessionId = session.id;
            this.post("sessionRestored", {
              id: session.id,
              title: session.title,
              messages: session.messages
            });
          }
          break;
        }
        case "listSessions": {
          const sessions = await this.sessions.listSessions();
          this.post("sessionsList", sessions);
          break;
        }
        case "deleteSession": {
          const sessionId = String((message.payload as { id?: string })?.id ?? "");
          if (sessionId) {
            await this.sessions.deleteSession(sessionId);
            if (this.currentSessionId === sessionId) {
              this.currentSessionId = undefined;
            }
            const sessions = await this.sessions.listSessions();
            this.post("sessionsList", sessions);
          }
          break;
        }
        // === Approval Gateway ===
        case "approvalResponse": {
          const response = message.payload as ApprovalResponse | undefined;
          if (response?.requestId && this.gate) {
            this.gate.resolve(response);
          }
          break;
        }
        // === Sub-агенты CRUD ===
        case "subagents.list": {
          const agents = await this.store?.list() ?? [];
          this.post("subagentsList", agents);
          break;
        }
        case "subagents.add": {
          const agent = parseSubAgentPayload(message.payload);
          if (agent && this.store) {
            await this.store.add(agent);
            this.post("subagentsList", await this.store.list());
            this.post("notice", `Sub-агент «${agent.displayName}» добавлен.`);
          }
          break;
        }
        case "subagents.update": {
          const id = String((message.payload as { id?: string })?.id ?? "");
          const patch = (message.payload as { patch?: Partial<SubAgentConfig> })?.patch ?? {};
          if (id && this.store) {
            await this.store.update(id, patch);
            this.post("subagentsList", await this.store.list());
          }
          break;
        }
        case "subagents.remove": {
          const id = String((message.payload as { id?: string })?.id ?? "");
          if (id && this.store) {
            await this.store.remove(id);
            this.post("subagentsList", await this.store.list());
          }
          break;
        }
        case "subagents.toggle": {
          const id = String((message.payload as { id?: string })?.id ?? "");
          if (id && this.store) {
            await this.store.toggle(id);
            this.post("subagentsList", await this.store.list());
          }
          break;
        }
        case "subagent.run": {
          await this.runSubAgent(
            String((message.payload as { id?: string })?.id ?? ""),
            String((message.payload as { task?: string })?.task ?? "")
          );
          break;
        }
        case "critic.resolve": {
          // Этап 5: ответ пользователя на модалку разногласия critic.
          // action: "apply" | "reject" | "decide-self" — пользователь решил.
          // Пока просто логируем; реальное применение в orchestrator-run later.
          const action = String((message.payload as { action?: string })?.action ?? "");
          this.post("notice", `Critic: пользователь решил — ${action}.`);
          break;
        }
        // === Этап 6: Knowledge Base + Skills ===
        case "knowledge.list": {
          const entries = await this.knowledgeBase?.list() ?? [];
          this.post("knowledgeList", entries);
          break;
        }
        case "knowledge.add": {
          const payload = message.payload as Partial<KnowledgeEntry> | undefined;
          if (payload && this.knowledgeBase) {
            const category = (payload.category ?? "misc") as KnowledgeCategory;
            await this.knowledgeBase.add({
              url: String(payload.url ?? ""),
              title: payload.title,
              category,
              tags: Array.isArray(payload.tags) ? payload.tags : [],
              summary: String(payload.summary ?? ""),
              fullNotes: payload.fullNotes,
              source: payload.source === "user" ? "user" : "model",
              status: payload.status === "accepted" || payload.status === "rejected" ? payload.status : "candidate"
            });
            this.post("knowledgeList", await this.knowledgeBase.list());
            this.post("notice", "Запись добавлена в базу знаний.");
          }
          break;
        }
        case "knowledge.remove": {
          const id = String((message.payload as { id?: string })?.id ?? "");
          if (id && this.knowledgeBase) {
            await this.knowledgeBase.remove(id);
            this.post("knowledgeList", await this.knowledgeBase.list());
          }
          break;
        }
        case "knowledge.update": {
          // Этап 6: UI-редактирование записи (source:user priority).
          const payload = message.payload as { id?: string; patch?: Partial<KnowledgeEntry> } | undefined;
          if (payload?.id && this.knowledgeBase) {
            await this.knowledgeBase.update(payload.id, payload.patch ?? {});
            this.post("knowledgeList", await this.knowledgeBase.list());
          }
          break;
        }
        case "knowledge.searchViaModel": {
          await this.searchKnowledgeViaModel(String((message.payload as { topic?: string })?.topic ?? ""));
          break;
        }
        case "skills.list": {
          const skills = await this.skillService?.list() ?? [];
          this.post("skillsList", skills);
          break;
        }
        case "skills.create": {
          await this.createSkillViaAI(String((message.payload as { topic?: string })?.topic ?? ""));
          break;
        }
        case "skills.delete": {
          const name = String((message.payload as { name?: string })?.name ?? "");
          if (name && this.skillService) {
            try {
              await this.skillService.remove(name);
              this.post("skillsList", await this.skillService.list());
            } catch (error) {
              this.post("notice", humanizeWorkbenchError(error));
            }
          }
          break;
        }
      }
    } catch (error) {
      this.post("error", humanizeWorkbenchError(error));
    }
  }

  private async refreshIndexOnOpen(): Promise<void> {
    try {
      const projectMap = await new RepoIndexer(this.configService.workspaceRoot.fsPath).buildProjectMap();
      this.setProjectMap(projectMap);
    } catch (error) {
      this.post("notice", humanizeWorkbenchError(error));
    }
  }

  private async runGradle(kind: "build"): Promise<void> {
    const config = await this.configService.readConfig();
    const task = kind === "build" ? config?.minecraft.gradleBuildTask ?? "build" : "build";
    const evidence = await new GradleTools(this.configService.workspaceRoot.fsPath).build(task);
    this.addEvidence(evidence);
  }

  private async selectProviderModel(providerId: ProviderId, model: string): Promise<void> {
    const config = await this.configService.ensureWorkspaceFiles();
    const chosenModel = model.trim() || fallbackModelForProvider(providerId);
    // ФИКС: при ручном выборе модели сбрасываем routineModel/complexModel,
    // чтобы auto-tiering не подменял выбор пользователя на дефолтную дорогую модель.
    const nextConfig = {
      ...config,
      providers: {
        ...config.providers,
        defaultProvider: providerId,
        defaultModel: chosenModel,
        routineModel: "",
        complexModel: ""
      }
    };
    await this.configService.writeConfig(nextConfig);
    vscode.window.showInformationMessage(`MineAgent использует ${providerId} / ${chosenModel}.`);
    await this.refresh();
  }

  public async testFireworks(): Promise<void> {
    await this.testProvider("fireworks");
  }

  public async testProvider(providerId?: ProviderId): Promise<void> {
    const config = await this.configService.ensureWorkspaceFiles();
    const selectedProvider = providerId ?? config.providers.defaultProvider;
    const provider = await this.providers.get(selectedProvider);
    this.post("agentActivity", {
      status: "progress",
      message: `Проверяю ${provider.displayName}: получаю список моделей.`
    });
    const models = await provider.listModels();
    const candidates = selectModelCandidates(config.providers.defaultModel, models, selectedProvider);
    if (!candidates.length) {
      throw new Error(`${provider.displayName}: ключ работает, но список моделей пуст.`);
    }

    let lastError: unknown;
    for (const model of candidates) {
      try {
        this.post("agentActivity", {
          status: "progress",
          message: `Отправляю короткий тестовый запрос в ${provider.displayName}: ${model}.`
        });
        const response = await provider.chat({
          model,
          temperature: 0,
          maxTokens: 32,
          messages: [
            {
              role: "user",
              content: "Ответь одним словом: ok"
            }
          ]
        });
        if (!response.content.trim()) {
          lastError = new Error(`${provider.displayName} returned an empty response for ${model}. ${describeRawResponseShape(response.raw)}`);
          continue;
        }
        // BUG#9 FIX: testProvider — read-only проверка. НЕ перезаписываем
        // defaultProvider/defaultModel в config. Раньше это вызывало "claude flared":
        // тест Anthropic навсегда записывал anthropic как дефолтный провайдер.
        this.post("providerCheck", {
          summary: `${provider.displayName} проверен: модель ${model} отвечает. Тестовый ответ: ${response.content || "empty"}.`
        });
        return;
      } catch (error) {
        lastError = error;
        if (!(error instanceof ProviderRequestError) || !error.isModelNotFound()) {
          throw error;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  public async refreshFireworksModels(): Promise<void> {
    await this.refreshProviderModels("fireworks");
  }

  public async refreshProviderModels(providerId?: ProviderId, options?: { silent?: boolean }): Promise<void> {
    const config = await this.configService.ensureWorkspaceFiles();
    const selectedProvider = providerId ?? config.providers.defaultProvider;
    const provider = await this.providers.get(selectedProvider);
    if (!options?.silent) {
      this.post("agentActivity", {
        status: "progress",
        message: `Обновляю модели ${provider.displayName}.`
      });
    }
    const models = await provider.listModels();
    this.state.providerModelsByProvider[selectedProvider] = models;
    this.post("providerModels", {
      provider: selectedProvider,
      models,
      silent: Boolean(options?.silent)
    });
  }

  private async refreshConfiguredProviderModels(): Promise<void> {
    try {
      const config = await this.configService.ensureWorkspaceFiles();
      await this.refreshProviderModels(config.providers.defaultProvider, { silent: true });
    } catch (error) {
      this.post("notice", humanizeWorkbenchError(error));
    }
  }

  private async parseLogFile(): Promise<void> {
    const candidates = [
      "run/logs/latest.log",
      "logs/latest.log"
    ];
    for (const candidate of candidates) {
      try {
        const text = await readFile(this.configService.toFsPath(candidate), "utf8");
        this.post("logSummary", parseMinecraftLog(text));
        return;
      } catch {
        // Try the next conventional log location.
      }
    }
    this.post("logSummary", {
      fatalLines: [],
      warnings: [],
      exceptions: [],
      likelyCause: "No latest.log found in run/logs or logs."
    });
  }

  private async startRun(prompt: string, mode: "ask" | "plan" | "build" | "playtest"): Promise<void> {
    if (this.currentRunAbort) {
      throw new Error("MineAgent is already running. Stop the current request before starting another one.");
    }
    const config = await this.configService.readConfig();
    if (!config) {
      throw new Error("MineAgent config is missing.");
    }
    const abort = new AbortController();
    this.currentRunAbort = abort;
    // Синхронизируем лимит из конфига (0 = без лимита, но сервис всё равно считает).
    const limit = config.agent.tokenLimit ?? 1_000_000;
    this.tokenBudget.setSessionLimit(limit > 0 ? limit : Number.MAX_SAFE_INTEGER);
    // Сообщаем budget-сервису активного провайдера — нейроны Cloudflare
    // считаются только для cloudflare. Для других провайдеров UI показывает
    // только токены, не нейроны.
    this.tokenBudget.setProviderId(config.providers.defaultProvider);
    // Persistence: создаём сессию, если её ещё нет, и сохраняем user prompt.
    if (!this.currentSessionId) {
      const session = await this.sessions.createSession(prompt);
      this.currentSessionId = session.id;
    } else {
      await this.sessions.appendMessage(this.currentSessionId, {
        role: "user",
        text: prompt,
        timestamp: new Date().toISOString()
      });
    }
    this.post("agentActivity", {
      status: "started",
      message: `Принял запрос. Режим: ${mode}; провайдер: ${config.providers.defaultProvider}; модель: ${tierModelForMode(config, mode)}.`
    });
    try {
      // Этап 5: создаются опциональные vision/critic сервисы если включены в config.
      // Vision — если config.agent.visionTriggers непуст и есть visionModel.
      // Critic — если config.agent.criticMode !== "off".
      const provider = await this.providers.get(config.providers.defaultProvider);
      const models = await provider.listModels();
      const visionEvaluator = config.agent.visionTriggers?.length
        ? new VisionEvaluator({
            provider,
            models,
            tokenBudget: this.tokenBudget,
            visionModel: config.agent.visionModel
          })
        : undefined;
      const criticRunner = config.agent.criticMode !== "off"
        ? new CriticRunner({
            provider,
            models,
            tokenBudget: this.tokenBudget,
            criticModel: config.agent.criticModel,
            mainModel: config.providers.complexModel || config.providers.defaultModel
          })
        : undefined;
      const orchestrator = new MineAgentOrchestrator(this.configService.workspaceRoot.fsPath, config, this.providers, this.tokenBudget, this.dispatcher, this.blockbenchBridge, this.minecraftBridge, visionEvaluator, criticRunner, this.skillService, this.knowledgeBase, this.projectMemory);
      const report = await orchestrator.run({
        prompt,
        mode,
        researchLedger: this.state.researchLedger,
        signal: abort.signal,
        onActivity: (event) => {
          this.post("agentActivity", event);
          // Шлём свежий снапшот бюджета в UI после каждого события.
          if (event.budgetExceeded) {
            this.post("tokenBudgetExceeded", event.budgetExceeded);
          }
          this.post("tokenBudget", this.tokenBudget.snapshot());
        }
      });
      this.state.lastReport = report;
      this.setProjectMap(report.projectMap);
      this.post("runReport", report);
      // Persistence: сохраняем ответ модели в текущую сессию.
      if (this.currentSessionId) {
        await this.sessions.appendMessage(this.currentSessionId, {
          role: "assistant",
          text: report.summary,
          timestamp: new Date().toISOString()
        }).catch(() => {
          // Ошибка сохранения не должна валить основной flow.
        });
      }
    } finally {
      this.currentRunAbort = undefined;
      this.post("runFinished", {});
      this.post("tokenBudget", this.tokenBudget.snapshot());
    }
  }

  private cancelRun(): void {
    if (!this.currentRunAbort) {
      this.post("runFinished", {});
      return;
    }
    this.currentRunAbort.abort();
    this.post("agentActivity", {
      status: "failed",
      message: "Запрос остановлен пользователем."
    });
  }

  // Этап 3: подключение к живому Blockbench через MCP. Проводится через
  // ApprovalGate как game-control-действие (как dev-bridge/runClient): модель
  // получает доступ к изменению 3D-проекта — пользователь должен подтвердить.
  // Если одобрено — bridge.connect() → tools/list → регистрация blockbench.*.
  private async connectBlockbench(): Promise<void> {
    if (!this.blockbenchBridge || !this.dispatcher) {
      throw new Error("Blockbench bridge ещё не инициализирован.");
    }
    if (this.blockbenchBridge.isConnected()) {
      this.postBlockbenchStatus();
      return;
    }
    try {
      // Синтетический dispatch через game-control для approval round-trip.
      // Используем зарегистрированный handler minecraft.devBridge-контракта? Нет —
      // bridge сам делает подключение. Идём через прямой gate-запрос.
      if (this.gate) {
        const approved = await this.gate.request({
          requestId: `bb-connect-${Date.now()}`,
          toolName: "blockbench.connect",
          scope: "tool",
          scopeId: "blockbench.connect",
          description: `Подключение к Blockbench MCP: ${this.blockbenchBridge.getUrl()}`,
          risk: "game-control",
          input: { url: this.blockbenchBridge.getUrl() }
        });
        if (!approved) {
          this.post("notice", "Подключение к Blockbench отклонено.");
          return;
        }
      }
      this.post("blockbenchStatus", this.blockbenchBridge.snapshot());
      const snapshot = await this.blockbenchBridge.connect();
      this.post("blockbenchStatus", snapshot);
      this.post("notice", `Blockbench подключён: ${snapshot.toolCount} инструментов.`);
    } catch (error) {
      this.post("blockbenchStatus", this.blockbenchBridge.snapshot());
      this.post("notice", humanizeWorkbenchError(error));
    }
  }

  // Предлагает подключиться к Blockbench при открытии воркбенча. Пользователь
  // подтверждает (тогда connectBlockbench), отказывается (разово) или жмёт
  // «Больше не спрашивать» (connectPrompt="never" в config — больше не покажем).
  private async promptConnectBlockbench(): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      "Подключить MineAgent к Blockbench? Нужен запущенный Blockbench с включённым MCP-сервером.",
      "Подключить",
      "Не сейчас",
      "Больше не спрашивать"
    );
    if (choice === "Подключить") {
      await this.connectBlockbench().catch((error) => {
        this.post("notice", humanizeWorkbenchError(error));
      });
    } else if (choice === "Больше не спрашивать") {
      await this.setBlockbenchConnectPrompt("never");
    }
    // "Не сейчас" / закрытие — ничего не меняем, спросим в следующий раз.
  }

  private async setBlockbenchConnectPrompt(value: "ask" | "always" | "never"): Promise<void> {
    const config = await this.configService.readConfig();
    if (!config) {
      return;
    }
    await this.configService.writeConfig({
      ...config,
      mcp: {
        ...config.mcp,
        blockbench: { ...config.mcp.blockbench, connectPrompt: value }
      }
    });
  }

  private async disconnectBlockbench(): Promise<void> {
    if (!this.blockbenchBridge) {
      return;
    }
    await this.blockbenchBridge.disconnect();
    this.postBlockbenchStatus();
  }

  private postBlockbenchStatus(): void {
    if (this.blockbenchBridge) {
      this.post("blockbenchStatus", this.blockbenchBridge.snapshot());
    }
  }

  // --- Этап 4: Minecraft Dev Bridge ---
  //
  // Lifecycle сложнее Blockbench: MCP-сервер живёт ВНУТРИ dev-сборки мода.
  // Подключение:
  //   1. resolveMinecraftBridgeToken() — читаем лог dev-клиента, ищем маркер
  //      мода «[mineagent-bridge] MCP endpoint ready url=... token=...». Token
  //      НЕ хранится в config — мод генерирует его каждый старт.
  //   2. waitForEndpoint — health-poll, пока мод не поднимет HTTP-сервер
  //      (dev-клиент стартует десятки секунд).
  //   3. Approval (game-control) — мост меняет живой игровой мир.
  //   4. bridge.connect() — initialize → tools/list → регистрация minecraft.*.
  //
  // Если клиент не запущен — connectMinecraft не падает, а предлагает запустить
  // dev-клиент кнопкой/с подтверждения (offerLaunchDevClient → gradle runClient),
  // затем сам ждёт токен и подключается. Терминал от пользователя не требуется.

  private async resolveMinecraftBridgeToken(): Promise<{ url?: string; token?: string } | undefined> {
    const candidates = ["run/logs/latest.log", "logs/latest.log"];
    for (const candidate of candidates) {
      try {
        const text = await readFile(this.configService.toFsPath(candidate), "utf8");
        const info = parseBridgeReadyLine(text);
        if (info) {
          return info;
        }
      } catch {
        // Лог не найден — клиент не запущен. Пробуем следующую локацию.
      }
    }
    return undefined;
  }

  private async connectMinecraft(): Promise<void> {
    if (!this.minecraftBridge || !this.dispatcher) {
      throw new Error("Minecraft bridge ещё не инициализирован.");
    }
    if (this.minecraftBridge.isConnected()) {
      this.postMinecraftStatus();
      return;
    }

    // Шаг 1: токен + url из лога dev-клиента.
    const tokenInfo = await this.resolveMinecraftBridgeToken();
    if (!tokenInfo?.token) {
      this.postMinecraftStatus();
      // Dev-клиент не запущен (нет токена в логе). Вместо требования открыть
      // терминал — предлагаем запустить dev-клиент кнопкой (с подтверждения).
      const launched = await this.offerLaunchDevClient();
      if (!launched) {
        return;
      }
      // Клиент стартует десятки секунд; токен появится в логе позже. Повторно
      // пытаемся подключиться (waitForEndpoint внутри ждёт поднятия endpoint'а).
      const retryInfo = await this.waitForBridgeToken();
      if (!retryInfo?.token) {
        this.post("notice", "Dev-клиент запускается. Подключусь к Minecraft, как только мод поднимет MCP-endpoint — нажми индикатор Minecraft ещё раз, если нужно.");
        return;
      }
      return this.connectMinecraftWithToken(retryInfo);
    }
    return this.connectMinecraftWithToken(tokenInfo);
  }

  // Предлагает запустить dev-клиент Minecraft (runClient через gradle) кнопкой.
  // Возвращает true, если запуск инициирован. Учитывает launchPrompt:
  //   "always" — запускаем без вопроса; "never" — не предлагаем; иначе спрашиваем.
  private async offerLaunchDevClient(): Promise<boolean> {
    const config = await this.configService.readConfig();
    const mode = config?.mcp.minecraft.launchPrompt ?? "ask";
    if (mode === "never") {
      this.post("notice", "Dev-клиент Minecraft не запущен. Запусти его через меню Инструменты → Run Client, чтобы мод поднял MCP-endpoint.");
      return false;
    }
    if (mode !== "always") {
      const choice = await vscode.window.showInformationMessage(
        "Dev-клиент Minecraft не запущен — мод ещё не поднял MCP-endpoint. Запустить dev-клиент сейчас?",
        "Запустить dev-клиент",
        "Не сейчас",
        "Больше не спрашивать"
      );
      if (choice === "Больше не спрашивать") {
        await this.setMinecraftLaunchPrompt("never");
        return false;
      }
      if (choice !== "Запустить dev-клиент") {
        return false;
      }
    }
    // Запускаем runClient через зарегистрированный handler (тот же, что вызывает
    // модель), чтобы запуск шёл единым путём и логировался как evidence.
    const task = config?.minecraft.runClientTask ?? "runClient";
    this.post("notice", "Запускаю dev-клиент Minecraft (gradle runClient)… это может занять до минуты.");
    void new GradleTools(this.configService.workspaceRoot.fsPath).runClient(task)
      .then((evidence) => this.addEvidence(evidence))
      .catch((error) => this.post("notice", humanizeWorkbenchError(error)));
    return true;
  }

  // Ждёт появления токена моста в логе dev-клиента (клиент стартует не мгновенно).
  // Опрашивает лог раз в 3с в пределах launchWaitMs.
  private async waitForBridgeToken(): Promise<{ url?: string; token?: string } | undefined> {
    const config = await this.configService.readConfig();
    const deadline = Date.now() + (config?.mcp.minecraft.launchWaitMs ?? 90_000);
    while (Date.now() < deadline) {
      const info = await this.resolveMinecraftBridgeToken();
      if (info?.token) {
        return info;
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    return undefined;
  }

  private async setMinecraftLaunchPrompt(value: "ask" | "always" | "never"): Promise<void> {
    const config = await this.configService.readConfig();
    if (!config) {
      return;
    }
    await this.configService.writeConfig({
      ...config,
      mcp: {
        ...config.mcp,
        minecraft: { ...config.mcp.minecraft, launchPrompt: value }
      }
    });
  }

  // Завершает подключение к Minecraft Dev Bridge, имея токен/url из лога:
  // пересоздаёт мост, ждёт endpoint, проводит approval (game-control), connect.
  private async connectMinecraftWithToken(tokenInfo: { url?: string; token?: string }): Promise<void> {
    if (!this.minecraftBridge) {
      return;
    }
    // Пересоздаём мост с найденным токеном (url тоже мог измениться, если мод
    // сконфигурирован на другой порт — берём из лога как авторитетный).
    const config = await this.configService.readConfig();
    const timeoutMs = config?.mcp.minecraft.timeoutMs ?? 60_000;
    const url = tokenInfo.url ?? config?.mcp.minecraft.url ?? this.minecraftBridge.getUrl();
    this.minecraftBridge = new MinecraftBridge(
      { registry: this.registry },
      { url, timeoutMs, token: tokenInfo.token }
    );
    this.minecraftBridge.onChange((snapshot) => this.post("minecraftStatus", snapshot));

    // Шаг 2: ждём поднятия endpoint'а (мод мог залогировать токен, но HTTP-сервер
    // ещё не стартовал). Health-poll с launchWaitMs из config.
    const launchWaitMs = config?.mcp.minecraft.launchWaitMs ?? 90_000;
    this.post("notice", "Жду поднятия endpoint'а модом…");
    this.postMinecraftStatus();
    const ready = await this.minecraftBridge.waitForEndpoint(launchWaitMs);
    if (!ready) {
      this.post("notice", `MCP-endpoint мода не поднялся за ${launchWaitMs}мс. Проверь, что mineagent-bridge собран и включён в dev-клиенте.`);
      this.postMinecraftStatus();
      return;
    }

    // Шаг 3: approval (game-control) — мост меняет живой игровой мир.
    try {
      if (this.gate) {
        const approved = await this.gate.request({
          requestId: `mc-connect-${Date.now()}`,
          toolName: "minecraft.connect",
          scope: "tool",
          scopeId: "minecraft.connect",
          description: `Подключение к Minecraft Dev Bridge: ${this.minecraftBridge.getUrl()}`,
          risk: "game-control",
          input: { url: this.minecraftBridge.getUrl() }
        });
        if (!approved) {
          this.post("notice", "Подключение к Minecraft bridge отклонено.");
          return;
        }
      }
      // Шаг 4: connect.
      this.postMinecraftStatus();
      const snapshot = await this.minecraftBridge.connect();
      this.postMinecraftStatus();
      this.post("notice", `Minecraft bridge подключён: ${snapshot.toolCount} инструментов.`);
    } catch (error) {
      this.postMinecraftStatus();
      this.post("notice", humanizeWorkbenchError(error));
    }
  }

  private async disconnectMinecraft(): Promise<void> {
    if (!this.minecraftBridge) {
      return;
    }
    await this.minecraftBridge.disconnect();
    this.postMinecraftStatus();
  }

  private postMinecraftStatus(): void {
    if (this.minecraftBridge) {
      this.post("minecraftStatus", this.minecraftBridge.snapshot());
    }
  }

  // --- Этап 6: Knowledge Base + Skills ---

  private async readKnowledgeBase(): Promise<{ entries: KnowledgeEntry[]; lastUpdated: string | null } | undefined> {
    try {
      const text = await readFile(this.configService.toFsPath(".mineagent/knowledge-base.json"), "utf8");
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  private async writeKnowledgeBase(base: { entries: KnowledgeEntry[]; lastUpdated: string | null }): Promise<void> {
    const path = this.configService.toFsPath(".mineagent/knowledge-base.json");
    const { writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await import("node:fs/promises").then((fs) => fs.mkdir(dirname(path), { recursive: true }));
    await writeFile(path, `${JSON.stringify(base, null, 2)}\n`, "utf8");
  }

  // Этап 6: поиск через модель — модель ищет веб-источники и добавляет в базу.
  private async searchKnowledgeViaModel(topic: string): Promise<void> {
    if (!this.knowledgeBase) {
      throw new Error("Knowledge Base ещё не инициализирована.");
    }
    const query = topic.trim() || "Minecraft modding";
    this.post("agentActivity", {
      status: "progress",
      message: `Модель ищет источники для базы знаний: ${query}`
    });
    // Используем существующий DuckDuckGo-поиск (как в researchWeb).
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const response = await fetch(url, { headers: { "user-agent": "MineAgent Workbench/0.1" } });
    if (!response.ok) {
      throw new Error(`Web search failed: ${response.status}`);
    }
    const data = await response.json() as DuckDuckGoResponse;
    const sources = collectDuckDuckGoSources(data);
    const category = this.knowledgeBase.suggestCategory(query);
    for (const source of sources.slice(0, 5)) {
      await this.knowledgeBase.add({
        url: source.url,
        title: source.title,
        category,
        tags: [query.toLowerCase()],
        summary: source.summary,
        fullNotes: source.learned,
        source: "model",
        status: "candidate"
      });
    }
    this.post("knowledgeList", await this.knowledgeBase.list());
    this.post("notice", `Найдено и добавлено ${Math.min(sources.length, 5)} записей в базу знаний.`);
  }

  // Этап 6: создание скилла через ИИ — модель пишет .md с frontmatter.
  private async createSkillViaAI(topic: string): Promise<void> {
    if (!this.skillService) {
      throw new Error("Skills service ещё не инициализирован.");
    }
    const skillTopic = topic.trim();
    if (!skillTopic) {
      this.post("notice", "Опиши тему скилла.");
      return;
    }
    this.post("agentActivity", {
      status: "progress",
      message: `Модель создаёт скилл: ${skillTopic}`
    });
    const config = await this.configService.readConfig();
    const provider = await this.providers.get(config?.providers.defaultProvider ?? "cloudflare");
    const models = await provider.listModels();
    const model = config?.providers.complexModel || config?.providers.defaultModel || models[0]?.id || "";
    const projectMap = this.state.projectMap ?? await new RepoIndexer(this.configService.workspaceRoot.fsPath).buildProjectMap();
    // Промт для модели: создать скилл на основе контекста проекта.
    const response = await provider.chat({
      model,
      temperature: 0.3,
      maxTokens: 2000,
      messages: [
        {
          role: "system",
          content: [
            "Ты создаёшь скилл для MineAgent — markdown-файл с инструкцией для AI-ассистента.",
            "Формат: YAML frontmatter + markdown тело.",
            "Frontmatter: name, description, triggers (массив ключевых слов).",
            "Тело: конкретные паттерны/код/правила для Minecraft моддинга.",
            "Отвечай ТОЛЬКО содержимым .md файла, без пояснений."
          ].join("\n")
        },
        {
          role: "user",
          content: [
            `Тема скилла: ${skillTopic}`,
            `Контекст проекта: loader=${projectMap.loader}, MC=${projectMap.minecraftVersion}, mod=${projectMap.mainModId}`,
            "Создай скилл с конкретными паттернами и примерами кода."
          ].join("\n")
        }
      ]
    });
    // Парсим ответ — извлекаем name из frontmatter.
    const nameMatch = response.content.match(/^---\s*\n[\s\S]*?name:\s*(\S+)/m);
    const skillName = nameMatch?.[1]?.trim() || `custom-${Date.now().toString(36)}`;
    await this.skillService.create(
      {
        name: skillName,
        description: skillTopic,
        triggers: skillTopic.toLowerCase().split(/[\s,]+/).filter(Boolean)
      },
      response.content
    );
    this.post("skillsList", await this.skillService.list());
    this.post("notice", `Скилл «${skillName}» создан.`);
  }

  // Этап 5: запуск sub-агента через SubAgentRunner. Пользователь может
  // триггерить из UI (кнопка «Запустить» в форме sub-агента) ИЛИ main-модель
  // может делегировать через tool-call subagent.run (в orchestrator, later).
  // В обоих случаях вызов идёт через ApprovalGate (scope "subagent").
  private async runSubAgent(agentId: string, task: string): Promise<void> {
    if (!this.store || !this.gate) {
      throw new Error("Sub-агент infrastructure ещё не инициализирована.");
    }
    const agents = await this.store.list();
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) {
      throw new Error(`Sub-агент «${agentId}» не найден.`);
    }
    this.post("agentActivity", {
      status: "progress",
      message: `Запускаю sub-агента «${agent.displayName}»…`
    });
    const config = await this.configService.readConfig();
    const provider = await this.providers.get(config?.providers.defaultProvider ?? "cloudflare");
    const models = await provider.listModels();
    const baseSystemPrompt = await this.configService.readAgentsRules();
    const projectMap = this.state.projectMap ?? await new RepoIndexer(this.configService.workspaceRoot.fsPath).buildProjectMap();
    const runner = new SubAgentRunner(this.gate);
    try {
      const result = await runner.run(agent, {
        baseSystemPrompt,
        task,
        projectMap,
        provider,
        dispatcher: this.dispatcher
      });
      this.post("subagentResult", {
        id: agentId,
        displayName: agent.displayName,
        content: result.content,
        timedOut: result.timedOut
      });
    } catch (error) {
      this.post("notice", humanizeWorkbenchError(error));
    }
  }

  private async applyLastPatch(): Promise<void> {
    const summary = this.state.lastReport?.summary ?? "";
    const diff = extractDiffBlocks(summary);
    if (!diff.trim()) {
      throw new Error("Last model response does not contain a markdown diff block.");
    }
    this.post("agentActivity", {
      status: "progress",
      message: "Применяю последний patch через git apply."
    });
    // repo.patch — write-risk, идёт через ApprovalGate (если dispatcher готов).
    const evidence = this.dispatcher
      ? await this.dispatcher.dispatch("repo.patch", { patch: diff }, "Применить последний patch (git apply)") as CommandEvidence
      : await runGitApply(this.configService.workspaceRoot.fsPath, diff);
    this.addEvidence(evidence);
    if (evidence.exitCode === 0) {
      const projectMap = await new RepoIndexer(this.configService.workspaceRoot.fsPath).buildProjectMap();
      this.setProjectMap(projectMap);
    }
  }

  private async researchWeb(topic: string): Promise<void> {
    const current = this.state.researchLedger ?? await this.configService.readResearchLedger();
    const query = topic.trim() || current.topic || "JJK-inspired Minecraft mod combat design";
    this.post("agentActivity", {
      status: "progress",
      message: `Ищу web sources для research ledger: ${query}.`
    });
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const response = await fetch(url, {
      headers: {
        "user-agent": "MineAgent Workbench/0.1"
      }
    });
    if (!response.ok) {
      throw new Error(`Web research failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json() as DuckDuckGoResponse;
    const sources = mergeResearchSources(current.sources, collectDuckDuckGoSources(data));
    const ledger = await this.configService.saveResearchLedger({
      ...current,
      topic: query,
      status: "draft",
      sources,
      lastUpdated: null
    });
    this.state.researchLedger = ledger;
    this.post("researchLedger", ledger);
  }

  // --- MCP Server API (выставляет оркестратор наружу для внешних клиентов) ---

  /**
   * Создаёт контекст для MCP-сервера: ссылки на текущий конфиг, dispatcher,
   * tokenBudget и функцию запуска run. Вызывается сервером при каждом tools/call.
   */
  public getMcpServerContext(): McpServerContext {
    return {
      root: this.configService.workspaceRoot.fsPath,
      getConfig: () => this.configService.readConfig().then((c) => c ?? this.configService.ensureWorkspaceFiles()),
      providers: this.providers,
      dispatcher: this.dispatcher,
      tokenBudget: this.tokenBudget,
      currentRunAbort: this.currentRunAbort,
      startRun: (prompt, mode, onActivity) => this.startRunForMcp(prompt, mode, onActivity)
    };
  }

  /**
   * Публичная обёртка над startRun для MCP-сервера. Возвращает RunResult
   * (id, summary, toolCallCount) вместо внутреннего RunReport.
   * Активность стримится через onActivity callback (если задан).
   */
  public async startRunForMcp(
    prompt: string,
    mode: "ask" | "plan" | "build" | "playtest",
    onActivity?: (event: unknown) => void
  ): Promise<RunResult> {
    if (this.currentRunAbort) {
      throw new Error("MineAgent is already running. Cancel the current run first.");
    }
    // Делегируем в существующий startRun, но перехватываем activity-события.
    const originalPost = this.post.bind(this);
    // Временный override: дублируем activity в onActivity callback.
    if (onActivity) {
      this.post = (type: string, payload: unknown) => {
        originalPost(type, payload);
        if (type === "agentActivity") {
          onActivity(payload);
        }
      };
    }
    try {
      await this.startRun(prompt, mode);
      const report = this.state.lastReport;
      return {
        id: report?.id ?? "unknown",
        summary: report?.summary ?? "",
        toolCallCount: report?.toolCalls?.length ?? 0
      };
    } finally {
      // Восстанавливаем post.
      if (onActivity) {
        this.post = originalPost;
      }
    }
  }

  private post(type: string, payload: unknown): void {
    void this.view?.webview.postMessage({ type, payload });
  }
}

function describeRawResponseShape(raw: unknown): string {
  if (!raw || typeof raw !== "object") {
    return "Raw response is not an object.";
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).slice(0, 10);
  const firstChoice = Array.isArray(record.choices) ? record.choices[0] as Record<string, unknown> | undefined : undefined;
  const firstMessage = firstChoice?.message as Record<string, unknown> | undefined;
  const details = [
    `top-level keys: ${keys.join(", ") || "none"}`,
    firstChoice?.finish_reason ? `finish_reason: ${String(firstChoice.finish_reason)}` : undefined,
    firstMessage ? `message keys: ${Object.keys(firstMessage).join(", ") || "none"}` : undefined
  ].filter(Boolean);
  return details.join("; ");
}

function extractDiffBlocks(text: string): string {
  const blocks = Array.from(text.matchAll(/```(?:diff|patch)?\s*\r?\n([\s\S]*?)```/gi))
    .map((match) => match[1]?.trim())
    .filter((block): block is string => Boolean(block));
  return blocks.join("\n\n");
}

function runGitApply(cwd: string, diff: string): Promise<CommandEvidence> {
  const startedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const child = spawn("git", ["apply", "--whitespace=nowarn", "-"], {
      cwd,
      shell: process.platform === "win32"
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      stderr += error.message;
    });
    child.on("close", (exitCode) => {
      resolve({
        command: "git apply --whitespace=nowarn -",
        cwd,
        exitCode,
        startedAt,
        completedAt: new Date().toISOString(),
        stdout,
        stderr
      });
    });
    child.stdin.write(diff);
    child.stdin.end();
  });
}

interface DuckDuckGoResponse {
  AbstractText?: string;
  AbstractURL?: string;
  Heading?: string;
  RelatedTopics?: DuckDuckGoTopic[];
}

interface DuckDuckGoTopic {
  Text?: string;
  FirstURL?: string;
  Result?: string;
  Topics?: DuckDuckGoTopic[];
}

function collectDuckDuckGoSources(data: DuckDuckGoResponse) {
  const sources: ResearchLedger["sources"] = [];
  if (data.AbstractURL && data.AbstractText) {
    sources.push(createResearchSource(data.AbstractURL, data.Heading, data.AbstractText));
  }
  for (const topic of flattenDuckDuckGoTopics(data.RelatedTopics ?? [])) {
    if (topic.FirstURL && topic.Text) {
      sources.push(createResearchSource(topic.FirstURL, undefined, topic.Text));
    }
  }
  return sources.slice(0, 8);
}

function flattenDuckDuckGoTopics(topics: DuckDuckGoTopic[]): DuckDuckGoTopic[] {
  return topics.flatMap((topic) => topic.Topics ? flattenDuckDuckGoTopics(topic.Topics) : [topic]);
}

function createResearchSource(url: string, title: string | undefined, text: string): ResearchLedger["sources"][number] {
  const summary = text.length > 500 ? `${text.slice(0, 497)}...` : text;
  return {
    url,
    title,
    summary,
    learned: summary,
    usedFor: "Candidate reference for mechanics/theme translation. Review before use; do not copy protected names, text, assets, or lore.",
    status: "candidate"
  };
}

function mergeResearchSources(existing: ResearchLedger["sources"], incoming: ResearchLedger["sources"]): ResearchLedger["sources"] {
  const byUrl = new Map<string, ResearchLedger["sources"][number]>();
  for (const source of existing) {
    byUrl.set(source.url, source);
  }
  for (const source of incoming) {
    if (!byUrl.has(source.url)) {
      byUrl.set(source.url, source);
    }
  }
  return Array.from(byUrl.values());
}

function parseResearchLedgerPayload(payload: unknown): ResearchLedger {
  const value = typeof payload === "object" && payload !== null ? payload as Partial<ResearchLedger> : {};
  return {
    topic: String(value.topic ?? ""),
    status: value.status === "reviewed" ? "reviewed" : "draft",
    sources: Array.isArray(value.sources) ? value.sources.map((source) => {
      const item = typeof source === "object" && source !== null ? source as unknown as Record<string, unknown> : {};
      return {
        url: String(item.url ?? ""),
        title: item.title ? String(item.title) : undefined,
        summary: String(item.summary ?? ""),
        learned: String(item.learned ?? ""),
        usedFor: String(item.usedFor ?? ""),
        status: item.status === "accepted" || item.status === "rejected" ? item.status : "candidate"
      };
    }) : [],
    userNotes: String(value.userNotes ?? ""),
    lastUpdated: value.lastUpdated ? String(value.lastUpdated) : null
  };
}

function parseRunMode(value: string | undefined): "ask" | "plan" | "build" | "playtest" {
  return value === "plan" || value === "build" || value === "playtest" ? value : "ask";
}

// Парсит payload sub-агента из webview в строгий SubAgentConfig.
// allowedTools приходит строкой (через запятую) из формы — разбираем в массив.
function parseSubAgentPayload(payload: unknown): SubAgentConfig | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const value = payload as Record<string, unknown>;
  const specialty = value.specialty === "reviewer" || value.specialty === "researcher" || value.specialty === "vision" || value.specialty === "custom"
    ? value.specialty
    : "custom";
  const memoryMode = value.memoryMode === "none" || value.memoryMode === "task" || value.memoryMode === "session" || value.memoryMode === "ask"
    ? value.memoryMode
    : "task";
  const rawTools = typeof value.allowedTools === "string"
    ? (value.allowedTools as string).split(",").map((s) => s.trim()).filter(Boolean)
    : Array.isArray(value.allowedTools) ? value.allowedTools.map((s) => String(s)) : [];
  return {
    id: String(value.id ?? "").trim(),
    displayName: String(value.displayName ?? "").trim(),
    model: String(value.model ?? "").trim(),
    specialty,
    promptOverride: value.promptOverride ? String(value.promptOverride) : undefined,
    allowedTools: rawTools,
    memoryMode,
    enabled: value.enabled !== false
  };
}

function parseProviderId(value: string | undefined): ProviderId | undefined {
  return value === "openai" || value === "anthropic" || value === "fireworks" || value === "cloudflare" || value === "wavespeed" || value === "kimchi" || value === "custom"
    ? value
    : undefined;
}

function selectModelCandidates(configuredModel: string | undefined, models: ProviderModel[], providerId: ProviderId): string[] {
  const ids = models.map((model) => model.id).filter(Boolean);
  const preferred = ids.filter((id) => /kimi|code|coder|deepseek|qwen/i.test(id));
  return Array.from(new Set([
    configuredModel?.trim(),
    ...preferred,
    ...ids,
    fallbackModelForProvider(providerId)
  ].filter((value): value is string => Boolean(value))));
}

function fallbackModelForProvider(providerId: ProviderId): string {
  switch (providerId) {
    case "cloudflare":
      return "@cf/moonshotai/kimi-k2.7-code";
    case "fireworks":
      return "accounts/fireworks/models/glm-5p2";
    case "wavespeed":
      return "z-ai/glm-5.2";
    case "kimchi":
      return "kimi-k2.7";
    case "openai":
      return "openai-default";
    case "anthropic":
      return "claude-default";
    case "custom":
      return "";
  }
}

// Auto-tiering: выбирает модель под режим (зеркалит логику orchestrator).
// ask → routineModel (дешёвая), build/plan/playtest → complexModel (дорогая).
function tierModelForMode(config: MineAgentConfig, mode: "ask" | "plan" | "build" | "playtest"): string {
  const providers = config.providers;
  const fallback = providers.defaultModel || fallbackModelForProvider(providers.defaultProvider);
  if (mode === "ask") {
    return providers.routineModel?.trim() || fallback;
  }
  return providers.complexModel?.trim() || fallback;
}

function humanizeWorkbenchError(error: unknown): string {
  if (error instanceof ProviderRequestError && error.isModelNotFound()) {
    return `${error.providerName}: выбранная модель не отвечает или недоступна для этого ключа. Нажми Refresh models и выбери модель из актуального списка провайдера.`;
  }
  if (error instanceof ProviderRequestError && error.isBillingBlocked()) {
    return `${error.providerName} отклонил API-запрос из-за биллинга или статуса аккаунта, привязанного к сохраненному ключу. Проверь выбранный аккаунт/организацию, кредиты, лимит расходов и неоплаченные счета, затем нажми Test или Refresh models.`;
  }
  if (error instanceof ProviderRequestError && error.status === 405) {
    return `${error.providerName}: этот API endpoint не поддерживает выбранный HTTP метод. Обнови список моделей еще раз; MineAgent использует catalog fallback, если live endpoint недоступен.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === "AbortError") {
    return "Запрос остановлен.";
  }
  if (/Missing API key/i.test(message)) {
    return "Для этого провайдера не сохранен API key. Открой Tools -> Configure provider keys; ключ будет сохранен только в VS Code SecretStorage.";
  }
  if (/Missing Cloudflare Account ID/i.test(message)) {
    return "Для Cloudflare нужен Account ID. Открой Model -> Provider: Cloudflare -> Configure key/account и вставь Account ID плюс Workers AI API token.";
  }
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
    return "Не удалось связаться с провайдером модели. Проверь сеть и попробуй Refresh models.";
  }
  return message.replace(/^Error:\s*/i, "");
}
