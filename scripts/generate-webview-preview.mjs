import { writeFile } from "node:fs/promises";
import Module from "node:module";
import { join } from "node:path";

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "vscode") {
    return {
      Uri: {
        joinPath(base, ...parts) {
          return {
            path: [base.path, ...parts].join("/"),
            fsPath: [base.fsPath, ...parts].join("/")
          };
        }
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { getWorkbenchHtml } = await import("../out/src/webview/html.js");

const extensionUri = {
  path: "..",
  fsPath: ".."
};
const webview = {
  cspSource: "file:",
  asWebviewUri(uri) {
    return uri.path.replace("../", "../");
  }
};

const previewState = {
  config: {
    providers: {
      defaultProvider: "cloudflare",
      defaultModel: "@cf/moonshotai/kimi-k2.7-code",
      cloudflare: { accountId: "preview-account" }
    },
    agent: { approvalMode: "ask" },
    minecraft: { gradleBuildTask: "build", runClientTask: "runClient", devBridgeEnabled: false },
    paths: { referencePacks: ".mineagent/reference-packs" }
  },
  providerStatuses: [
    { id: "openai", hasKey: false },
    { id: "anthropic", hasKey: false },
    { id: "fireworks", hasKey: true },
    { id: "cloudflare", hasKey: true },
    { id: "custom", hasKey: false }
  ],
  rules: "# MineAgent Workspace Rules\n\nPreview uses mocked workspace data.\n",
  projectMap: {
    indexedAt: new Date().toISOString(),
    root: "D:/projects/karo-mine-test",
    loader: "forge",
    minecraftVersion: "1.20.1",
    javaVersion: "17",
    gradleTasks: ["build", "runClient"],
    mainModId: "karo_test",
    registries: [
      { type: "item", name: "debug_wand", file: "src/main/java/ModItems.java" },
      { type: "block", name: "test_ore", file: "src/main/java/ModBlocks.java" }
    ],
    eventHandlers: ["CommonEvents.java"],
    networkPackets: [],
    clientOnlyClasses: ["ClientSetup.java"],
    resources: {
      lang: ["en_us.json"],
      models: ["item/debug_wand.json"],
      textures: ["item/debug_wand.png"],
      recipes: ["debug_wand.json"],
      lootTables: [],
      tags: [],
      sounds: []
    },
    mixins: [],
    accessWideners: [],
    datagen: [],
    architectureHints: ["Forge-style deferred registration"]
  },
  referenceRequests: [
    {
      query: "Forge 1.20.1 capability lifecycle",
      createdAt: new Date(Date.now() - 180000).toISOString(),
      status: "нужно подтверждение"
    }
  ],
  evidence: [
    {
      command: "gradlew build",
      cwd: "D:/projects/karo-mine-test",
      exitCode: 0,
      startedAt: new Date(Date.now() - 12000).toISOString(),
      completedAt: new Date().toISOString(),
      stdout: "> Task :compileJava\n> Task :processResources\nBUILD SUCCESSFUL",
      stderr: ""
    }
  ]
};

const previewBridge = `<script>
  const previewState = ${JSON.stringify(previewState, null, 2)};
  window.acquireVsCodeApi = () => ({
    postMessage(message) {
      handlePreviewMessage(message);
    }
  });
  function emitPreview(type, payload) {
    window.postMessage({ type, payload }, "*");
  }
  function handlePreviewMessage(message) {
    if (message.type === "ready") {
      emitPreview("state", previewState);
      // Этап 3: индикатор Blockbench. В preview показываем «подключено»
      // с двумя инструментами, чтобы видеть chip в шапке.
      emitPreview("blockbenchStatus", {
        status: "connected",
        url: "http://localhost:3000/bb-mcp",
        toolCount: 8,
        toolNames: ["blockbench.render", "blockbench.add_cube"],
        serverName: "blockbench-mcp"
      });
      // Этап 4: индикатор Minecraft Dev Bridge. В preview показываем «подключено»
      // с 6 инструментами моста, чтобы видеть второй chip рядом с Blockbench.
      emitPreview("minecraftStatus", {
        status: "connected",
        url: "http://127.0.0.1:3100/mc-mcp",
        toolCount: 6,
        toolNames: ["minecraft.summon", "minecraft.apply_effect", "minecraft.set_camera", "minecraft.screenshot", "minecraft.get_state", "minecraft.reload_resources"],
        serverName: "mineagent-bridge",
        hasToken: true
      });
      // Демонстрация approval modal: шлём фейковый запрос после старта.
      setTimeout(() => {
        emitPreview("approvalRequest", {
          requestId: "preview-approval-1",
          toolName: "gradle.run",
          scope: "tool",
          scopeId: "gradle.run",
          description: "Gradle build (build)",
          risk: "command",
          input: { task: "build" }
        });
      }, 600);
      return;
    }
    if (message.type === "blockbenchConnect") {
      emitPreview("blockbenchStatus", {
        status: "connected",
        url: "http://localhost:3000/bb-mcp",
        toolCount: 8,
        toolNames: ["blockbench.render", "blockbench.add_cube"],
        serverName: "blockbench-mcp"
      });
      return;
    }
    if (message.type === "blockbenchDisconnect") {
      emitPreview("blockbenchStatus", { status: "disconnected", url: "http://localhost:3000/bb-mcp", toolCount: 0, toolNames: [] });
      return;
    }
    if (message.type === "listSessions") {
      emitPreview("sessionsList", [
        { id: "session-preview-1", title: "Добавить debug_wand предмет", updatedAt: new Date(Date.now() - 3600_000).toISOString(), messageCount: 6 },
        { id: "session-preview-2", title: "Регистрация test_ore блока", updatedAt: new Date(Date.now() - 86_400_000).toISOString(), messageCount: 12 },
        { id: "session-preview-3", title: "Без названия", updatedAt: new Date(Date.now() - 172_800_000).toISOString(), messageCount: 0 }
      ]);
      return;
    }
    if (message.type === "loadSession") {
      emitPreview("sessionRestored", {
        id: message.payload?.id ?? "session-preview-1",
        title: "Добавить debug_wand предмет",
        messages: [
          { role: "user", text: "Создай предмет debug_wand для Forge 1.20.1.", timestamp: new Date(Date.now() - 3700_000).toISOString() },
          { role: "assistant", text: "Принял. Обновлю карту проекта и предложу патч для ModItems.java с регистрацией deferred-предмета.", timestamp: new Date(Date.now() - 3650_000).toISOString() }
        ]
      });
      return;
    }
    if (message.type === "newSession") {
      emitPreview("sessionCleared", {});
      return;
    }
    if (message.type === "subagents.list") {
      emitPreview("subagentsList", [
        { id: "reviewer-jjk", displayName: "Ревизор JJK", model: "@cf/zai-org/glm-4.7-flash", specialty: "reviewer", allowedTools: ["repo.read", "repo.search"], memoryMode: "task", enabled: true },
        { id: "researcher-1", displayName: "Исследователь источников", model: "@cf/moonshotai/kimi-k2.7-code", specialty: "researcher", allowedTools: ["web.research"], memoryMode: "session", enabled: false }
      ]);
      return;
    }
    if (message.type === "subagents.add" || message.type === "subagents.update" || message.type === "subagents.remove" || message.type === "subagents.toggle") {
      // Echo back updated list.
      emitPreview("subagentsList", [
        { id: "reviewer-jjk", displayName: "Ревизор JJK", model: "@cf/zai-org/glm-4.7-flash", specialty: "reviewer", allowedTools: ["repo.read", "repo.search"], memoryMode: "task", enabled: true }
      ]);
      return;
    }
    if (message.type === "deleteSession") {
      emitPreview("sessionsList", []);
      return;
    }
    if (message.type === "refreshIndex") {
      emitPreview("projectMap", previewState.projectMap);
      return;
    }
    if (message.type === "runGradleBuild") {
      emitPreview("evidence", previewState.evidence);
      return;
    }
    if (message.type === "parseLog") {
      emitPreview("logSummary", {
        fatalLines: [],
        warnings: ["Preview warning: mocked log parser output."],
        exceptions: [],
        likelyCause: "В preview нет настоящего latest.log."
      });
      return;
    }
    if (message.type === "useFireworksKimi" || message.type === "selectFireworksModel" || message.type === "selectProviderModel") {
      previewState.config.providers.defaultProvider = message.payload?.provider || "fireworks";
      previewState.config.providers.defaultModel = message.payload?.model || "accounts/fireworks/models/kimi-k2p7-code";
      emitPreview("state", previewState);
      return;
    }
    if (message.type === "refreshFireworksModels" || message.type === "refreshProviderModels") {
      const provider = message.payload?.provider || previewState.config.providers.defaultProvider || "fireworks";
      const cloudflareModels = [
        { id: "@cf/moonshotai/kimi-k2.7-code", label: "Kimi K2.7 Code", capabilities: { contextWindow: 262144, vision: true, tools: true, jsonMode: true, reasoning: true, fixedContext: true } },
        { id: "@cf/openai/gpt-oss-120b", label: "GPT OSS 120B", capabilities: { contextWindow: 128000, vision: false, tools: true, jsonMode: true, reasoning: true, fixedContext: true } },
        { id: "@cf/zai-org/glm-4.7-flash", label: "GLM 4.7 Flash", capabilities: { contextWindow: 131072, vision: false, tools: true, jsonMode: true, reasoning: true, fixedContext: true } },
        { id: "@cf/meta/llama-3.1-8b-instruct", label: "Llama 3.1 8B Instruct", capabilities: { contextWindow: 128000, vision: false, tools: false, jsonMode: true, fixedContext: true } }
      ];
      const fireworksModels = [
        { id: "accounts/fireworks/models/kimi-k2p7-code", label: "Kimi K2.7 Code", capabilities: { contextWindow: 262000, vision: false, tools: true, jsonMode: true, fixedContext: true } },
        { id: "accounts/fireworks/models/kimi-k2p7-code-fast", label: "Kimi K2.7 Code Fast", capabilities: { contextWindow: 262000, vision: false, tools: true, jsonMode: true, fixedContext: true } },
        { id: "accounts/fireworks/models/deepseek-v3", label: "DeepSeek V3", capabilities: { contextWindow: 128000, vision: false, tools: true, jsonMode: true, fixedContext: true } },
        { id: "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct", label: "Qwen3 Coder 480B", capabilities: { contextWindow: 128000, vision: false, tools: true, jsonMode: true, fixedContext: true } }
      ];
      emitPreview("providerModels", {
        provider,
        models: provider === "cloudflare" ? cloudflareModels : fireworksModels
      });
      return;
    }
    if (message.type === "setFireworksKey" || message.type === "setCloudflareKey" || message.type === "setProviderKey") {
      const providerId = message.payload?.provider || (message.type === "setCloudflareKey" ? "cloudflare" : "fireworks");
      previewState.providerStatuses = previewState.providerStatuses.map((provider) =>
        provider.id === providerId ? { ...provider, hasKey: true } : provider
      );
      emitPreview("state", previewState);
      return;
    }
    if (message.type === "startRun") {
      emitPreview("runReport", {
        id: "preview-run",
        summary: "Preview: модель Fireworks/Kimi настроена, индекс проекта доступен.",
        projectMap: previewState.projectMap,
        phases: [
          { name: "Understand", status: "complete" },
          { name: "Research", status: "skipped", summary: "Нужен разрешенный поиск источников." },
          { name: "Patch", status: "skipped", summary: "Патч не запрошен." },
          { name: "Build", status: "complete" },
          { name: "Launch", status: "skipped", summary: "Запуск клиента требует подтверждения." },
          { name: "Playtest", status: "skipped", summary: "Dev-world не настроен." },
          { name: "Diagnose", status: "skipped", summary: "Нет ошибки для диагностики." },
          { name: "Report", status: "complete" }
        ]
      });
    }
  }
</script>`;

let html = getWorkbenchHtml(webview, extensionUri);
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]+>\n\s*/u, "");
html = html.replace(/<script nonce="[^"]+" src="([^"]+)"><\/script>/u, `${previewBridge}\n  <script src="$1"></script>`);

await writeFile(join("scripts", "webview-preview.html"), html, "utf8");
console.log("generated scripts/webview-preview.html");
