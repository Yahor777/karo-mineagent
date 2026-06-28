import { spawn } from "node:child_process";
import type { CommandEvidence } from "./gradleTools";

// Фаза 3 (P3): Git-инструменты поверх git CLI.
// Формат результата — CommandEvidence (как gradleTools), чтобы orchestrator и
// логика diagnose/evidence работали единообразно. Опасные операции
// (commit/push/pull/checkout) помечены requiresApproval:true в ToolContracts —
// dispatcher проводит их через ApprovalGate с превью.
//
// Безопасность: аргументы НЕ собираются конкатенацией строк — каждый передаётся
// отдельным элементом argv в spawn (никакого shell-инъекшена). shell включаем
// только на win32 для поиска git в PATH.

export class GitTools {
  public constructor(private readonly root: string) {}

  public status(): Promise<CommandEvidence> {
    return this.run(["status", "--porcelain=v1", "--branch"]);
  }

  public branchList(): Promise<CommandEvidence> {
    return this.run(["branch", "--all", "--no-color"]);
  }

  public createBranch(name: string): Promise<CommandEvidence> {
    return this.run(["checkout", "-b", name]);
  }

  public checkout(ref: string): Promise<CommandEvidence> {
    return this.run(["checkout", ref]);
  }

  // commit -a: индексирует уже отслеживаемые изменения. message обязателен.
  public commit(message: string, all: boolean = true): Promise<CommandEvidence> {
    const args = ["commit", "-m", message];
    if (all) {
      args.splice(1, 0, "-a");
    }
    return this.run(args);
  }

  public add(paths: string[]): Promise<CommandEvidence> {
    return this.run(["add", ...(paths.length ? paths : ["-A"])]);
  }

  public push(remote: string = "origin", branch?: string): Promise<CommandEvidence> {
    const args = ["push", remote];
    if (branch) {
      args.push(branch);
    }
    return this.run(args);
  }

  public pull(remote: string = "origin", branch?: string): Promise<CommandEvidence> {
    const args = ["pull", remote];
    if (branch) {
      args.push(branch);
    }
    return this.run(args);
  }

  // Текущая ветка (rev-parse) — удобно для PR (head) без парсинга status.
  public currentBranch(): Promise<CommandEvidence> {
    return this.run(["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  private run(args: string[]): Promise<CommandEvidence> {
    const startedAt = new Date().toISOString();
    const command = `git ${args.join(" ")}`;
    return new Promise((resolve) => {
      const child = spawn("git", args, {
        cwd: this.root,
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
          command,
          cwd: this.root,
          exitCode,
          startedAt,
          completedAt: new Date().toISOString(),
          stdout,
          stderr
        });
      });
    });
  }
}