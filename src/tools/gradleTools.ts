import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface CommandEvidence {
  command: string;
  cwd: string;
  exitCode: number | null;
  startedAt: string;
  completedAt: string;
  stdout: string;
  stderr: string;
}

export class GradleTools {
  public constructor(private readonly root: string) {}

  public async runTask(task: string): Promise<CommandEvidence> {
    const gradleCommand = this.findGradleCommand();
    return runCommand(gradleCommand.command, [...gradleCommand.args, task], this.root);
  }

  public async build(task = "build"): Promise<CommandEvidence> {
    return this.runTask(task);
  }

  public async runClient(task = "runClient"): Promise<CommandEvidence> {
    return this.runTask(task);
  }

  private findGradleCommand(): { command: string; args: string[] } {
    const wrapper = process.platform === "win32" ? "gradlew.bat" : "gradlew";
    const wrapperPath = join(this.root, wrapper);
    if (existsSync(wrapperPath)) {
      return {
        command: wrapperPath,
        args: []
      };
    }
    return {
      command: "gradle",
      args: []
    };
  }
}

function runCommand(command: string, args: string[], cwd: string): Promise<CommandEvidence> {
  const startedAt = new Date().toISOString();
  const child = spawn(command, args, {
    cwd,
    shell: process.platform === "win32"
  });
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        command: [command, ...args].join(" "),
        cwd,
        exitCode,
        startedAt,
        completedAt: new Date().toISOString(),
        stdout,
        stderr
      });
    });
  });
}
