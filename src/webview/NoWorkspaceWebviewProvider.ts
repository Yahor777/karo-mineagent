import * as vscode from "vscode";
import { getWorkbenchHtml } from "./html";

export class NoWorkspaceWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly lastFolder?: string
  ) {}

  public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")]
    };
    webviewView.webview.html = getWorkbenchHtml(webviewView.webview, this.extensionUri);
    webviewView.webview.onDidReceiveMessage((message: { type: string }) => {
      void this.handleMessage(message);
    });
    this.postWorkspaceMissing();
  }

  private async handleMessage(message: { type: string }): Promise<void> {
    if (message.type === "ready") {
      this.postWorkspaceMissing();
      return;
    }

    if (message.type === "openWorkspace") {
      // Если есть запомненная папка — открываем сразу её, не заставляя выбирать.
      if (this.lastFolder) {
        await vscode.commands.executeCommand(
          "vscode.openFolder",
          vscode.Uri.file(this.lastFolder),
          { forceReuseWindow: true }
        );
        return;
      }
      await vscode.commands.executeCommand("workbench.action.files.openFolder");
      return;
    }

    this.post("error", "Open a Minecraft mod workspace folder before using MineAgent tools.");
  }

  private postWorkspaceMissing(): void {
    this.post("state", {
      workspaceMissing: true,
      config: undefined,
      providerStatuses: [],
      rules: "# MineAgent Workspace Rules\n\nOpen a Minecraft mod workspace folder to load project rules.\n",
      projectMap: undefined,
      evidence: []
    });
  }

  private post(type: string, payload: unknown): void {
    void this.view?.webview.postMessage({ type, payload });
  }
}
