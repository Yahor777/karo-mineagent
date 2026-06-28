import type { ProjectMap } from "../repo/projectMap";
import type { CommandEvidence } from "./gradleTools";
import type { BuildDiagnosis } from "./buildDiagnostics";
import type { ParsedLogSummary } from "./logParser";

export type ToolRisk = "read" | "write" | "command" | "network" | "game-control";

export interface ToolContract<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  risk: ToolRisk;
  requiresApproval: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  sampleInput?: Input;
  sampleOutput?: Output;
}

export const toolContracts: ToolContract[] = [
  contract<{}, ProjectMap>("repo.index", "Build a Minecraft-aware project map.", "read", false),
  contract<{ query: string }, { files: string[] }>("repo.search", "Search workspace files.", "read", false),
  contract<{ path: string }, { text: string }>("repo.read", "Read a workspace file.", "read", false),
  contract<{ patch: string }, { accepted: boolean }>("repo.patch", "Apply a reviewed patch.", "write", true),
  contract<{}, { diff: string }>("git.diff", "Return current workspace diff.", "read", false),
  contract<{}, { tasks: string[] }>("gradle.tasks", "List available Gradle tasks.", "command", true),
  contract<{ task: string }, CommandEvidence>("gradle.run", "Run a Gradle task and store evidence.", "command", true),
  contract<{ task?: string }, BuildDiagnosis>("build.diagnose", "Run a Gradle build/compile task and return STRUCTURED diagnostics (parsed compile errors with file:line) instead of raw logs.", "command", true),
  // Этап 6: Knowledge Base инструменты для tool-loop.
  contract<{ query: string; category?: string }, { added: number }>("knowledge.search", "Search web for Minecraft modding resources and add to Knowledge Base.", "network", true),
  contract<{ url: string; summary: string; title?: string; category?: string; tags?: string[] }, { id: string }>("knowledge.add", "Add a knowledge entry manually.", "write", true),
  contract<{ task?: string }, CommandEvidence>("minecraft.runClient", "Launch the Minecraft dev client.", "game-control", true),
  contract<{}, { stopped: boolean }>("minecraft.stopClient", "Stop a launched dev client.", "game-control", true),
  contract<{ lines?: number }, ParsedLogSummary>("minecraft.tailLogs", "Read and summarize Minecraft logs.", "read", false),
  contract<{ path?: string }, ParsedLogSummary>("minecraft.parseCrash", "Parse a crash report or latest crash.", "read", false),
  contract<{}, { path: string }>("minecraft.screenshot", "Capture a screenshot from a dev run.", "game-control", true),
  contract<{}, { focused: boolean }>("minecraft.focusWindow", "Focus the Minecraft client window.", "game-control", true),
  contract<{ input: string }, { sent: boolean }>("minecraft.input", "Send keyboard/mouse input to Minecraft.", "game-control", true),
  contract<{ command: string }, { output: string }>("minecraft.command", "Execute a safe dev-only Minecraft command.", "game-control", true),
  contract<{ action: string; payload?: unknown }, { state: unknown }>("minecraft.devBridge", "Use the optional dev-only helper bridge.", "game-control", true),
  contract<{ query: string }, { sources: unknown[] }>("docs.search", "Search official docs/source references.", "network", true),
  contract<{ query: string }, { ledgerPath: string }>("web.research", "Run cited web research and produce a Source Ledger.", "network", true),
  contract<{ pack: unknown }, { path: string }>("reference.savePack", "Save a cited Reference Pack.", "write", true),
  contract<{ scenario: string }, { reportPath: string }>("playtest.run", "Run a playtest flow and store evidence.", "game-control", true),
  // Фаза 3 (P3): Git / GitHub. Опасное (commit/push/pull/checkout/clone/PR) — approval.
  contract<{}, CommandEvidence>("git.status", "Show git working tree status.", "read", false),
  contract<{ message: string }, CommandEvidence>("git.commit", "Commit tracked changes with a message.", "command", true),
  contract<{ name?: string }, CommandEvidence>("git.branch", "List branches or create a new branch.", "command", true),
  contract<{ ref: string }, CommandEvidence>("git.checkout", "Checkout a branch or ref.", "command", true),
  contract<{ remote?: string; branch?: string }, CommandEvidence>("git.push", "Push commits to a remote.", "command", true),
  contract<{ remote?: string; branch?: string }, CommandEvidence>("git.pull", "Pull from a remote.", "command", true),
  contract<{ url: string; targetDir?: string }, CommandEvidence>("github.clone", "Clone a GitHub repository.", "command", true),
  contract<{ owner: string; repo: string; title: string; head: string; base: string; body?: string }, { number: number; url: string; state: string }>("github.pr", "Open a GitHub pull request.", "network", true),
  // Фаза 2 (P2.3): агент пишет находки/решения в живую память проекта.
  contract<{ text: string; section?: string }, { written: boolean }>("memory.note", "Append a durable note/decision to project memory (project.md).", "write", false)
];

function contract<Input, Output>(
  name: string,
  description: string,
  risk: ToolRisk,
  requiresApproval: boolean
): ToolContract<Input, Output> {
  return {
    name,
    description,
    risk,
    requiresApproval,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" }
  };
}
