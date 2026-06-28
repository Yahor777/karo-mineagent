// MCP-сервер MineAgent: инструмент-схемы и handler-функции.
//
// Каждый tool — это функция, вызываемая внешним MCP-клиентом через tools/call.
// Схема описывает inputSchema (JSON Schema) для спецификации MCP, handler
// выполняет логику и возвращает NormalizedToolResult (text + images + isError).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { McpTool, McpContentBlock, NormalizedToolResult } from "./types";
import type { MineAgentConfig } from "../config/types";
import type { ProviderRegistry } from "../providers/providerRegistry";
import type { ToolDispatcher } from "../tools/toolDispatcher";
import type { TokenBudgetService } from "../providers/tokenBudget";
import type { BudgetSnapshot } from "../providers/tokenBudget";

// --- Контекст сервера: зависимости, общие для всех handler'ов ---

export interface McpServerContext {
  /** Workspace root (fsPath). */
  readonly root: string;
  /** Функция для получения свежего конфига (читается при каждом tools/call). */
  readonly getConfig: () => Promise<MineAgentConfig>;
  /** Реестр провайдеров для списка статусов. */
  readonly providers: ProviderRegistry;
  /** Диспетчер инструментов для repo.read / repo.patch / gradle.run. */
  readonly dispatcher: ToolDispatcher | undefined;
  /** Токен-бюджет для mineagent.status. */
  readonly tokenBudget: TokenBudgetService;
  /** AbortController текущего run — для mineagent.cancel. */
  readonly currentRunAbort: AbortController | undefined;
  /** Функция запуска оркестратора (делегируется в webview-provider или extension). */
  readonly startRun: (prompt: string, mode: RunMode, onActivity?: (event: unknown) => void) => Promise<RunResult>;
}

export type RunMode = "ask" | "plan" | "build" | "playtest";

export interface RunResult {
  id: string;
  summary: string;
  toolCallCount: number;
}

// --- Схемы инструментов ---

const runModeEnum: string[] = ["ask", "plan", "build", "playtest"];

export const MINEAGENT_TOOLS: McpTool[] = [
  {
    name: "mineagent.run",
    description:
      "Start a MineAgent orchestrator run with a prompt and mode. Returns the run summary. Activity events are streamed via SSE during the run.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The task or question for MineAgent (e.g. 'Create a new item that summons lightning on right-click')."
        },
        mode: {
          type: "string",
          enum: runModeEnum,
          description: "Run mode: ask (quick question), plan (design only), build (implement + compile), playtest (interact with dev client)."
        }
      },
      required: ["prompt", "mode"]
    }
  },
  {
    name: "mineagent.cancel",
    description: "Abort the currently running MineAgent run, if any.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "mineagent.status",
    description: "Return current run state, token budget snapshot, and configured provider/model.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "mineagent.repo.read",
    description: "Read a workspace file as UTF-8 text.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path to the file."
        }
      },
      required: ["path"]
    }
  },
  {
    name: "mineagent.repo.patch",
    description: "Apply a unified diff patch to the workspace (through the approval gate).",
    inputSchema: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description: "A single unified diff with valid file headers (--- a/path, +++ b/path) and hunk ranges."
        }
      },
      required: ["patch"]
    }
  },
  {
    name: "mineagent.gradle.run",
    description: "Run a Gradle task and return exit code, stdout, and stderr.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Gradle task name (e.g. 'build', 'runClient'). Omit for default build."
        }
      },
      required: []
    }
  },
  {
    name: "mineagent.providers",
    description: "List all configured providers with their key availability status.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  }
];

// --- Handler'ы ---

export async function handleToolCall(
  toolName: string,
  args: Record<string, unknown> | undefined,
  ctx: McpServerContext
): Promise<NormalizedToolResult> {
  const a = args ?? {};
  switch (toolName) {
    case "mineagent.run":
      return handleRun(a, ctx);
    case "mineagent.cancel":
      return handleCancel(ctx);
    case "mineagent.status":
      return await handleStatus(ctx);
    case "mineagent.repo.read":
      return handleRepoRead(a, ctx);
    case "mineagent.repo.patch":
      return handleRepoPatch(a, ctx);
    case "mineagent.gradle.run":
      return handleGradleRun(a, ctx);
    case "mineagent.providers":
      return handleProviders(ctx);
    default:
      return { text: `Unknown tool: ${toolName}`, isError: true };
  }
}

async function handleRun(
  args: Record<string, unknown>,
  ctx: McpServerContext
): Promise<NormalizedToolResult> {
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) {
    return { text: "mineagent.run: 'prompt' is required and must not be empty.", isError: true };
  }
  const mode = String(args.mode ?? "ask") as RunMode;
  if (!runModeEnum.includes(mode)) {
    return { text: `mineagent.run: 'mode' must be one of ${runModeEnum.join(", ")}.`, isError: true };
  }
  try {
    const result = await ctx.startRun(prompt, mode);
    const lines = [
      `Run ${result.id} completed.`,
      `Summary: ${result.summary}`,
      `Tool calls: ${result.toolCallCount}`
    ];
    return { text: lines.join("\n"), isError: false };
  } catch (error) {
    return { text: `Run failed: ${describeError(error)}`, isError: true };
  }
}

function handleCancel(ctx: McpServerContext): NormalizedToolResult {
  if (ctx.currentRunAbort) {
    ctx.currentRunAbort.abort();
    return { text: "Run cancellation requested.", isError: false };
  }
  return { text: "No run is currently active.", isError: false };
}

async function handleStatus(ctx: McpServerContext): Promise<NormalizedToolResult> {
  const snapshot: BudgetSnapshot = ctx.tokenBudget.snapshot();
  const isRunning = Boolean(ctx.currentRunAbort);
  const config = await ctx.getConfig();
  const provider = config.providers.defaultProvider;
  const model = config.providers.defaultModel;
  const lines = [
    `Running: ${isRunning}`,
    `Provider: ${provider}`,
    `Model: ${model}`,
    `Tokens used: ${snapshot.sessionUsed}`,
    `Token limit: ${snapshot.sessionLimit}`,
    `Budget exceeded: ${snapshot.exceeded}`
  ];
  return { text: lines.join("\n"), isError: false };
}

async function handleRepoRead(
  args: Record<string, unknown>,
  ctx: McpServerContext
): Promise<NormalizedToolResult> {
  const relPath = String(args.path ?? "").trim();
  if (!relPath) {
    return { text: "mineagent.repo.read: 'path' is required.", isError: true };
  }
  try {
    const abs = path.resolve(ctx.root, relPath);
    if (!abs.startsWith(ctx.root)) {
      return { text: "mineagent.repo.read: path escapes workspace root.", isError: true };
    }
    const content = await fs.readFile(abs, "utf8");
    return { text: content, isError: false };
  } catch (error) {
    return { text: `repo.read failed: ${describeError(error)}`, isError: true };
  }
}

async function handleRepoPatch(
  args: Record<string, unknown>,
  ctx: McpServerContext
): Promise<NormalizedToolResult> {
  const diff = String(args.patch ?? "").trim();
  if (!diff) {
    return { text: "mineagent.repo.patch: 'patch' is required.", isError: true };
  }
  if (!ctx.dispatcher) {
    return { text: "repo.patch: tool dispatcher is not initialized.", isError: true };
  }
  try {
    const result = await ctx.dispatcher.dispatch("repo.patch", { patch: diff }, "MCP: apply patch");
    return { text: JSON.stringify(result, null, 2), isError: false };
  } catch (error) {
    return { text: `repo.patch failed: ${describeError(error)}`, isError: true };
  }
}

async function handleGradleRun(
  args: Record<string, unknown>,
  ctx: McpServerContext
): Promise<NormalizedToolResult> {
  const task = String(args.task ?? "build").trim();
  if (!ctx.dispatcher) {
    return { text: "gradle.run: tool dispatcher is not initialized.", isError: true };
  }
  try {
    const result = await ctx.dispatcher.dispatch("gradle.run", { task }, `MCP: gradle ${task}`);
    return { text: JSON.stringify(result, null, 2), isError: false };
  } catch (error) {
    return { text: `gradle.run failed: ${describeError(error)}`, isError: true };
  }
}

async function handleProviders(ctx: McpServerContext): Promise<NormalizedToolResult> {
  try {
    const statuses = await ctx.providers.providerStatuses();
    const lines = statuses.map((s) => `${s.id}: ${s.hasKey ? "key set" : "no key"}`);
    return { text: lines.join("\n"), isError: false };
  } catch (error) {
    return { text: `providers failed: ${describeError(error)}`, isError: true };
  }
}

// --- Утилиты ---

export function normalizedToContentBlocks(result: NormalizedToolResult): McpContentBlock[] {
  const blocks: McpContentBlock[] = [];
  if (result.images) {
    for (const img of result.images) {
      blocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
  }
  blocks.push({ type: "text", text: result.text });
  return blocks;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
