// Скрипт-симуляция: запускает MineAgentOrchestrator напрямую.
// Запуск:
//   $env:CLOUDFLARE_API_TOKEN="твой_токен"
//   node scripts/test-orchestrator.mjs

import { defaultMineAgentConfig } from "../out/src/config/defaultConfig.js";
import { MineAgentOrchestrator } from "../out/src/orchestrator/orchestrator.js";
import { CloudflareProvider } from "../out/src/providers/cloudflareProvider.js";
import { ApprovalGate } from "../out/src/approval/approvalGate.js";
import { ToolRegistry } from "../out/src/tools/toolRegistry.js";
import { ToolDispatcher } from "../out/src/tools/toolDispatcher.js";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const WORKSPACE = "mod-workspaces/kimi-jjk-lab";
const PROMPT = "создай мод по jjk используй все возможности этой среды";
const MODE = "build";
const TIMEOUT_MS = 600_000; // 10 минут

const configPath = join(WORKSPACE, ".mineagent/config.json");
const configRaw = await readFile(configPath, "utf8");
const userConfig = JSON.parse(configRaw);
const config = {
  ...defaultMineAgentConfig,
  ...userConfig,
  providers: { ...defaultMineAgentConfig.providers, ...userConfig.providers,
    cloudflare: { ...defaultMineAgentConfig.providers.cloudflare, ...userConfig.providers.cloudflare }
  },
  agent: { ...defaultMineAgentConfig.agent, ...userConfig.agent },
  minecraft: { ...defaultMineAgentConfig.minecraft, ...userConfig.minecraft },
  mcp: { ...defaultMineAgentConfig.mcp, ...userConfig.mcp },
  paths: { ...defaultMineAgentConfig.paths, ...userConfig.paths }
};

const accountId = config.providers.cloudflare.accountId;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;

if (!apiToken) {
  console.error("ERROR: CLOUDFLARE_API_TOKEN not set.");
  console.error("Run: $env:CLOUDFLARE_API_TOKEN=\"your_token\"");
  process.exit(1);
}

console.log("=== MineAgent Simulator ===");
console.log(`Model: ${config.providers.defaultModel}`);
console.log(`MaxToolIterations: ${config.agent.maxToolIterations}`);
console.log(`Account: ${accountId.substring(0, 8)}...`);
console.log(`Token: ${apiToken.substring(0, 6)}...${apiToken.substring(apiToken.length - 4)}`);
console.log(`Token length: ${apiToken.length}`);
console.log("");

const provider = new CloudflareProvider(apiToken, accountId);
const registry = new ToolRegistry();
const root = join(process.cwd(), WORKSPACE);

registry.register("repo.read", async (input) => {
  const path = String(input?.path ?? "");
  try {
    const text = await readFile(join(root, path), "utf8");
    return { text: text.slice(0, 3000) };
  } catch (e) {
    return { error: `Cannot read ${path}: ${e.message}` };
  }
});

registry.register("repo.patch", async (input) => {
  const diff = String(input?.patch ?? "");
  return new Promise((resolve) => {
    const child = spawn("git", ["apply", "--whitespace=nowarn", "-"], {
      cwd: root, shell: process.platform === "win32"
    });
    let stderr = "";
    child.stderr.on("data", (c) => stderr += c);
    child.on("close", (exitCode) => resolve({ accepted: exitCode === 0, exitCode, stderr: stderr.slice(0, 500) }));
    child.stdin.write(diff);
    child.stdin.end();
  });
});

registry.register("gradle.run", async (input) => {
  const task = String(input?.task ?? "build");
  return new Promise((resolve) => {
    const cmd = process.platform === "win32" ? ".\\gradlew.bat" : "./gradlew";
    const child = spawn(cmd, [task], { cwd: root, shell: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => stdout += c);
    child.stderr.on("data", (c) => stderr += c);
    child.on("close", (exitCode) => resolve({
      command: `gradlew ${task}`, cwd: root, exitCode,
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      stdout: stdout.slice(-2000), stderr: stderr.slice(-2000)
    }));
  });
});

registry.register("knowledge.search", async (input) => {
  console.log(`  [knowledge.search] query="${input?.query}"`);
  return { added: 0, note: "not available in simulator" };
});

registry.register("knowledge.add", async (input) => {
  console.log(`  [knowledge.add] url="${input?.url}"`);
  return { id: "sim-" + Date.now() };
});

const gate = new ApprovalGate(config, async () => {}, () => {}, () => {});
const orig = gate.post.bind(gate);
gate.post = (msg) => {
  orig(msg);
  if (msg.type === "approvalRequest" && msg.payload?.requestId) {
    setImmediate(() => gate.resolve({ requestId: msg.payload.requestId, decision: "confirm-once" }));
  }
};

const dispatcher = new ToolDispatcher(registry, gate);
const providerRegistry = {
  get: async () => provider,
  providerStatuses: async () => [{ id: "cloudflare", hasKey: true }]
};

const orchestrator = new MineAgentOrchestrator(root, config, providerRegistry, undefined, dispatcher);

console.log(">>> Starting run...\n");

// Timeout — чтобы скрипт не висел вечно
const timeoutId = setTimeout(() => {
  console.error("\n=== TIMEOUT ===");
  console.error(`Script timed out after ${TIMEOUT_MS / 1000}s`);
  process.exit(1);
}, TIMEOUT_MS);

try {
  const report = await orchestrator.run({
    prompt: PROMPT,
    mode: MODE,
    onActivity: (event) => {
      const phase = event.phase ? `[${event.phase}] ` : "";
      const iter = event.toolLoopIteration ? ` (iter ${event.toolLoopIteration})` : "";
      console.log(`${phase}${event.status}: ${event.message}${iter}`);
    }
  });
  console.log("\n=== RESULT ===");
  console.log(report.summary);
  console.log(`\nTool calls: ${report.toolCalls?.length ?? 0}`);
  if (report.toolCalls) {
    for (const tc of report.toolCalls) {
      console.log(`  - ${tc.name} → ${tc.error ?? "ok"}`);
    }
  }
} catch (error) {
  console.error("\n=== FAILED ===");
  console.error(error.message ?? error);
}
clearTimeout(timeoutId);
