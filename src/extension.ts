import * as vscode from "vscode";
import { ConfigService } from "./config/configService";
import type { ProviderId } from "./config/types";
import { ProviderRegistry } from "./providers/providerRegistry";
import { RepoIndexer, isMinecraftModDir } from "./repo/repoIndexer";
import { GradleTools } from "./tools/gradleTools";
import { VIEW_ID } from "./constants";
import { MineAgentWebviewProvider } from "./webview/MineAgentWebviewProvider";
import { NoWorkspaceWebviewProvider } from "./webview/NoWorkspaceWebviewProvider";
import { McpServer } from "./mcp/mcpServer";

// Ключ globalState для последней открытой папки воркспейса. Используется,
// чтобы при запуске без папки предложить переоткрыть последнюю.
const LAST_WORKSPACE_KEY = "mineagent.lastWorkspaceFolder";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Этап 6: ищем первый workspace folder, который является Minecraft-модом.
  // Если ни один не подходит — fallback на первый (старый behavior).
  const allFolders = vscode.workspace.workspaceFolders ?? [];
  let workspaceFolder = allFolders[0];
  if (allFolders.length > 1) {
    for (const folder of allFolders) {
      if (await isMinecraftModDir(folder.uri.fsPath)) {
        workspaceFolder = folder;
        break;
      }
    }
  }
  if (!workspaceFolder) {
    // Запоминаем последнюю папку: если она сохранена с прошлой сессии —
    // предлагаем переоткрыть её, а не заставляем выбирать заново.
    const lastFolder = context.globalState.get<string>(LAST_WORKSPACE_KEY);
    const webviewProvider = new NoWorkspaceWebviewProvider(context.extensionUri, lastFolder);
    if (lastFolder) {
      void offerReopenLastFolder(lastFolder);
    }
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(VIEW_ID, webviewProvider, {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }),
      vscode.commands.registerCommand("mineagent.openWorkbench", async () => {
        await vscode.commands.executeCommand("workbench.view.extension.mineagent");
      }),
      registerNoWorkspaceCommand("mineagent.initializeWorkspace"),
      registerNoWorkspaceCommand("mineagent.refreshRepoIndex"),
      registerNoWorkspaceCommand("mineagent.runGradleBuild"),
      registerNoWorkspaceCommand("mineagent.runClient"),
      registerNoWorkspaceCommand("mineagent.openAgentsRules"),
      registerNoWorkspaceCommand("mineagent.setProviderKey"),
      registerNoWorkspaceCommand("mineagent.testFireworks"),
      registerNoWorkspaceCommand("mineagent.testConfiguredProvider")
    );
    return;
  }

  const configService = new ConfigService(context, workspaceFolder);
  // Запоминаем текущую рабочую папку, чтобы при следующем запуске без папки
  // предложить переоткрыть именно её.
  void context.globalState.update(LAST_WORKSPACE_KEY, workspaceFolder.uri.fsPath);
  const config = await configService.ensureWorkspaceFiles();
  const providers = new ProviderRegistry(configService, config);
  const webviewProvider = new MineAgentWebviewProvider(context.extensionUri, configService, providers);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, webviewProvider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }),
    vscode.commands.registerCommand("mineagent.openWorkbench", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.mineagent");
    }),
    vscode.commands.registerCommand("mineagent.initializeWorkspace", async () => {
      await configService.ensureWorkspaceFiles();
      vscode.window.showInformationMessage("MineAgent workspace files are ready.");
      webviewProvider.refresh();
    }),
    vscode.commands.registerCommand("mineagent.refreshRepoIndex", async () => {
      await runWithProgress("Indexing Minecraft project", async () => {
        const projectMap = await new RepoIndexer(workspaceFolder.uri.fsPath).buildProjectMap();
        webviewProvider.setProjectMap(projectMap);
      });
    }),
    vscode.commands.registerCommand("mineagent.runGradleBuild", async () => {
      await runWithProgress("Running Gradle build", async () => {
        const latestConfig = await configService.readConfig();
        const task = latestConfig?.minecraft.gradleBuildTask ?? "build";
        const evidence = await new GradleTools(workspaceFolder.uri.fsPath).build(task);
        webviewProvider.addEvidence(evidence);
      });
    }),
    vscode.commands.registerCommand("mineagent.runClient", async () => {
      const approved = await vscode.window.showWarningMessage(
        "MineAgent will launch the Minecraft dev client for this workspace.",
        { modal: true },
        "Launch"
      );
      if (approved !== "Launch") {
        return;
      }
      await runWithProgress("Launching Minecraft client", async () => {
        const latestConfig = await configService.readConfig();
        const task = latestConfig?.minecraft.runClientTask ?? "runClient";
        const evidence = await new GradleTools(workspaceFolder.uri.fsPath).runClient(task);
        webviewProvider.addEvidence(evidence);
      });
    }),
    vscode.commands.registerCommand("mineagent.openAgentsRules", async () => {
      const uri = vscode.Uri.joinPath(workspaceFolder.uri, "AGENTS.md");
      await vscode.window.showTextDocument(uri);
    }),
    vscode.commands.registerCommand("mineagent.setProviderKey", async (requestedProvider?: ProviderId) => {
      const providerOptions: ProviderId[] = ["cloudflare", "fireworks", "wavespeed", "kimchi", "openai", "anthropic", "custom"];
      const providerId = requestedProvider ?? await vscode.window.showQuickPick(providerOptions, {
        placeHolder: "Выбери провайдера"
      }) as ProviderId | undefined;
      if (!providerId) {
        return;
      }
      if (providerId === "cloudflare") {
        const config = await configService.ensureWorkspaceFiles();
        const accountId = await vscode.window.showInputBox({
          title: "Cloudflare Account ID",
          ignoreFocusOut: true,
          value: config.providers.cloudflare.accountId,
          prompt: "Stored in .mineagent/config.json. API token stays in VS Code SecretStorage."
        });
        if (!accountId) {
          return;
        }
        await configService.writeConfig({
          ...config,
          providers: {
            ...config.providers,
            cloudflare: {
              accountId: accountId.trim()
            }
          }
        });
      }
      if (providerId === "custom") {
        const config = await configService.ensureWorkspaceFiles();
        const baseUrl = await vscode.window.showInputBox({
          title: "Custom OpenAI-compatible base URL",
          ignoreFocusOut: true,
          value: config.providers.custom.baseUrl,
          prompt: "Example: https://api.example.com"
        });
        if (!baseUrl) {
          return;
        }
        const modelsEndpoint = await vscode.window.showInputBox({
          title: "Custom models endpoint",
          ignoreFocusOut: true,
          value: config.providers.custom.modelsEndpoint || "/v1/models"
        });
        if (!modelsEndpoint) {
          return;
        }
        const chatEndpoint = await vscode.window.showInputBox({
          title: "Custom chat completions endpoint",
          ignoreFocusOut: true,
          value: config.providers.custom.chatEndpoint || "/v1/chat/completions"
        });
        if (!chatEndpoint) {
          return;
        }
        await configService.writeConfig({
          ...config,
          providers: {
            ...config.providers,
            custom: {
              baseUrl: baseUrl.trim(),
              modelsEndpoint: modelsEndpoint.trim(),
              chatEndpoint: chatEndpoint.trim()
            }
          }
        });
      }
      const key = await vscode.window.showInputBox({
        title: `Set ${providerId} API key`,
        password: true,
        ignoreFocusOut: true,
        prompt: providerId === "cloudflare"
          ? "Paste Cloudflare Workers AI API token. Stored in VS Code SecretStorage, not in workspace files."
          : "Stored in VS Code SecretStorage, not in workspace files."
      });
      if (!key) {
        return;
      }
      await configService.setProviderKey(providerId, key);
      vscode.window.showInformationMessage(`Stored ${providerId} API key.`);
      webviewProvider.refresh();
    }),
    vscode.commands.registerCommand("mineagent.testFireworks", async () => {
      await runWithProgress("Testing Fireworks provider", async () => {
        await webviewProvider.testFireworks();
      });
    }),
    vscode.commands.registerCommand("mineagent.testConfiguredProvider", async () => {
      await runWithProgress("Testing configured MineAgent provider", async () => {
        await webviewProvider.testProvider();
      });
    })
  );

  // MCP Server Bridge: запускаем ПОСЛЕ регистрации webview, неблокирующим
  // fire-and-forget способом. Если MCP-сервер упадёт — панель MineAgent
  // всё равно будет работать, активация расширения не зависнет.
  if (config.mcp.server.enabled) {
    const port = config.mcp.server.port;
    const token = config.mcp.server.token || undefined;
    const mcpServer = new McpServer(
      { port, token },
      () => webviewProvider.getMcpServerContext()
    );
    context.subscriptions.push({ dispose: () => { void mcpServer.stop(); } });

    // Fire-and-forget: не блокируем активацию.
    void mcpServer.start().then(
      () => vscode.window.showInformationMessage(`MineAgent MCP server listening on port ${port}.`),
      (error) => vscode.window.showWarningMessage(`MineAgent MCP server failed to start: ${error instanceof Error ? error.message : String(error)}`)
    );
  }
}

export function deactivate(): void {
  // VS Code automatically disposes context.subscriptions on deactivation,
  // which includes the MCP server's stop() handler registered above.
}

function registerNoWorkspaceCommand(command = "mineagent.openWorkbench"): vscode.Disposable {
  return vscode.commands.registerCommand(command, () => {
    vscode.window.showInformationMessage("Open a Minecraft mod workspace before using MineAgent.");
  });
}

// Предлагает переоткрыть последнюю рабочую папку, если расширение запущено без
// открытой папки. Путь берётся из globalState (см. LAST_WORKSPACE_KEY).
async function offerReopenLastFolder(folderPath: string): Promise<void> {
  const name = folderPath.split(/[\\/]/).filter(Boolean).pop() ?? folderPath;
  const choice = await vscode.window.showInformationMessage(
    `MineAgent: открыть последнюю папку «${name}»?`,
    "Открыть",
    "Не сейчас"
  );
  if (choice === "Открыть") {
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(folderPath),
      { forceReuseWindow: true }
    );
  }
}

async function runWithProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false
    },
    task
  );
}
