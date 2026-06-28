import { spawn } from "node:child_process";
import type { CommandEvidence } from "./gradleTools";

// Фаза 3 (P3): GitHub-инструменты.
// - clone: через git CLI (CommandEvidence, как остальные git-операции).
// - PR: через GitHub REST API (POST /repos/{owner}/{repo}/pulls). Токен НЕ
//   хранится в config — приходит параметром из VS Code SecretStorage.
// Опасное (clone в произвольный путь, создание PR) идёт через ApprovalGate
// (requiresApproval:true в ToolContracts).

export interface CreatePullRequestInput {
  owner: string;
  repo: string;
  title: string;
  head: string;            // ветка с изменениями
  base: string;            // целевая ветка (обычно main)
  body?: string;
  token: string;           // из SecretStorage
  signal?: AbortSignal;
}

export interface PullRequestResult {
  number: number;
  url: string;
  state: string;
}

export class GitHubTools {
  // git clone <url> [dir] — выполняется в указанной рабочей директории.
  public static clone(url: string, dir: string, targetDir?: string): Promise<CommandEvidence> {
    const args = ["clone", url];
    if (targetDir) {
      args.push(targetDir);
    }
    const startedAt = new Date().toISOString();
    return new Promise((resolve) => {
      const child = spawn("git", args, {
        cwd: dir,
        shell: process.platform === "win32"
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c.toString()));
      child.stderr.on("data", (c) => (stderr += c.toString()));
      child.on("error", (e) => (stderr += e.message));
      child.on("close", (exitCode) => {
        resolve({
          command: `git ${args.join(" ")}`,
          cwd: dir,
          exitCode,
          startedAt,
          completedAt: new Date().toISOString(),
          stdout,
          stderr
        });
      });
    });
  }

  public static async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestResult> {
    const response = await fetch(
      `https://api.github.com/repos/${input.owner}/${input.repo}/pulls`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${input.token}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "MineAgent-Workbench"
        },
        body: JSON.stringify({
          title: input.title,
          head: input.head,
          base: input.base,
          body: input.body ?? ""
        }),
        signal: input.signal
      }
    );
    const data = (await response.json()) as {
      number?: number;
      html_url?: string;
      state?: string;
      message?: string;
    };
    if (!response.ok) {
      throw new Error(`GitHub PR failed: ${response.status} ${data.message ?? ""}`.trim());
    }
    return {
      number: data.number ?? 0,
      url: data.html_url ?? "",
      state: data.state ?? "open"
    };
  }
}