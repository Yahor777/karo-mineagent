import type { ToolDefinition } from "../providers/ProviderAdapter";

// Полные JSON Schema для tools, которые модель может вызывать в tool-loop.
// Контракты в ToolContracts.ts хранят только заглушку inputSchema (для UI/
// документации), здесь — конкретные parameters для wire-формата провайдера.
//
// Этап 2 даёт модели ровно три инструмента (roadmap.md): repo.read, repo.patch,
// gradle.run. Остальные контракты НЕ передаются — это минимизирует токены в
// каждом запросе (правило «не жечь токены»).

const toolSchemas: Record<string, ToolDefinition> = {
  "repo.search": {
    type: "function",
    function: {
      name: "repo.search",
      description: "Search workspace source files by substring (or regex). Returns matching files and line hits. Use to locate code before reading or editing.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to search for (substring by default)." },
          regex: { type: "boolean", description: "Treat query as a case-insensitive regular expression." }
        },
        required: ["query"]
      }
    }
  },
  "repo.index": {
    type: "function",
    function: {
      name: "repo.index",
      description: "Build a Minecraft-aware project map (loader, MC version, registries, resources, gradle tasks). Call once at the start to understand the project.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  "gradle.tasks": {
    type: "function",
    function: {
      name: "gradle.tasks",
      description: "List available Gradle tasks detected in the project. Use to discover valid task names before calling gradle.run.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  "git.diff": {
    type: "function",
    function: {
      name: "git.diff",
      description: "Show uncommitted changes in the workspace as a unified diff. Optionally limit to a single path. Use to review your own edits before building.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional workspace-relative path to limit the diff." }
        },
        required: []
      }
    }
  },
  "build.diagnose": {
    type: "function",
    function: {
      name: "build.diagnose",
      description: "Run a Gradle build/compile task and return STRUCTURED diagnostics: parsed compile errors (file, line, message), build failures and a summary — instead of raw logs. Use this as the primary build tool to find and fix errors fast.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Gradle task to run. Default compileJava. Use 'build' for a full build." }
        },
        required: []
      }
    }
  },
  "minecraft.tailLogs": {
    type: "function",
    function: {
      name: "minecraft.tailLogs",
      description: "Read the tail of the latest client log (run/logs/latest.log) and return parsed fatal lines, warnings and exceptions. Use to diagnose runtime issues after launching.",
      parameters: {
        type: "object",
        properties: {
          lines: { type: "number", description: "How many trailing lines to analyze. Default 200." }
        },
        required: []
      }
    }
  },
  "minecraft.parseCrash": {
    type: "function",
    function: {
      name: "minecraft.parseCrash",
      description: "Parse a Minecraft crash report (given path, or the latest in run/crash-reports) and return fatal lines, exceptions and the likely cause.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional workspace-relative path to a crash report. If omitted, the latest crash report is used." }
        },
        required: []
      }
    }
  },
  "repo.read": {
    type: "function",
    function: {
      name: "repo.read",
      description: "Read a workspace file as UTF-8 text. Use to inspect existing code before editing.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative path to the file (e.g. src/main/java/.../Mod.java)."
          }
        },
        required: ["path"]
      }
    }
  },
  "repo.patch": {
    type: "function",
    function: {
      name: "repo.patch",
      description: "Apply a unified diff patch to the workspace. After a successful patch, MineAgent automatically runs the Gradle build — do not call gradle.run yourself after patching.",
      parameters: {
        type: "object",
        properties: {
          patch: {
            type: "string",
            description: "A single unified diff in one code block, with valid file headers (--- a/path, +++ b/path) and hunk ranges."
          }
        },
        required: ["patch"]
      }
    }
  },
  "gradle.run": {
    type: "function",
    function: {
      name: "gradle.run",
      description: "Run a Gradle task (e.g. build, runClient) and return exit code, stdout and stderr.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "Gradle task name. Omit or leave empty to run the default build task."
          }
        },
        required: []
      }
    }
  },
  "knowledge.search": {
    type: "function",
    function: {
      name: "knowledge.search",
      description: "Search the web for Minecraft modding resources and add them to the Knowledge Base. Use for finding Forge/Fabric/NeoForge docs, API references, mappings, and tutorials relevant to the current task.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (e.g. 'Forge 1.20 event handler registration')."
          },
          category: {
            type: "string",
            description: "Category: api, gameplay, rendering, tools, assets, misc.",
            enum: ["api", "gameplay", "rendering", "tools", "assets", "misc"]
          }
        },
        required: ["query"]
      }
    }
  },
  "knowledge.add": {
    type: "function",
    function: {
      name: "knowledge.add",
      description: "Add a knowledge entry to the Knowledge Base manually (e.g. from a source you already know). Use knowledge.search for web search instead.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Source URL" },
          title: { type: "string", description: "Short title" },
          summary: { type: "string", description: "Brief summary of what was learned" },
          category: {
            type: "string",
            description: "Category: api, gameplay, rendering, tools, assets, misc.",
            enum: ["api", "gameplay", "rendering", "tools", "assets", "misc"]
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags for retrieval (keywords)."
          }
        },
        required: ["url", "summary"]
      }
    }
  },
  "git.status": {
    type: "function",
    function: {
      name: "git.status",
      description: "Show the git working tree status (current branch, staged/unstaged changes). Read-only.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  "git.commit": {
    type: "function",
    function: {
      name: "git.commit",
      description: "Commit tracked changes with a message. Requires user approval.",
      parameters: { type: "object", properties: { message: { type: "string", description: "Commit message." } }, required: ["message"] }
    }
  },
  "memory.note": {
    type: "function",
    function: {
      name: "memory.note",
      description: "Append a durable note or decision to project memory (.mineagent/project.md). Use to record decisions, conventions, content facts or open questions while working.",
      parameters: { type: "object", properties: { text: { type: "string", description: "The note to remember." }, section: { type: "string", enum: ["conventions", "content", "decisions", "open"], description: "Memory section (default decisions)." } }, required: ["text"] }
    }
  }
};

// Собирает wire-схемы для заданных имён tools. Неизвестные имена молча
// пропускаются — вызывающий код (orchestrator) фильтрует по реестру.
// Порядок вывода стабилен (сначала статичные как в toolSchemas, затем
// динамические), что дружественно к prefix-cache.
export function buildToolSchemas(toolNames: string[]): ToolDefinition[] {
  const result: ToolDefinition[] = [];
  for (const name of toolNames) {
    const schema = toolSchemas[name];
    if (schema) {
      result.push(schema);
    }
  }
  // Динамические схемы (Этап 3: blockbench.*) — после статичных, чтобы сохранить
  // prefix-cache-friendliness базового набора Этапа 2.
  for (const name of toolNames) {
    if (toolSchemas[name]) {
      continue;
    }
    const dynamic = dynamicToolSchemas.get(name);
    if (dynamic) {
      result.push(dynamic);
    }
  }
  return result;
}

// Имена tools, которые Этап 2 открывает модели. Единый источник правды для
// orchestrator: buildToolSchemas(TOOL_LOOP_TOOLS).
export const TOOL_LOOP_TOOLS = ["repo.index", "repo.read", "repo.search", "git.diff", "repo.patch", "build.diagnose", "gradle.tasks", "gradle.run", "minecraft.tailLogs", "minecraft.parseCrash", "knowledge.search", "knowledge.add", "git.status", "memory.note"];

// --- Этап 3: динамические tool-схемы (blockbench.*) ---
//
// Появляются в рантайме при подключении к Blockbench MCP-серверу. Конвертируются
// из MCP inputSchema сервера (tools/list). Без подключения — пусто → модели
// схемы НЕ шлются (правило «не жечь токены»).

const dynamicToolSchemas = new Map<string, ToolDefinition>();

export function registerToolSchema(name: string, schema: ToolDefinition): void {
  dynamicToolSchemas.set(name, schema);
}

export function unregisterToolSchema(name: string): void {
  dynamicToolSchemas.delete(name);
}

export function clearDynamicSchemas(): string[] {
  const names = Array.from(dynamicToolSchemas.keys());
  dynamicToolSchemas.clear();
  return names;
}

export function hasDynamicSchema(name: string): boolean {
  return dynamicToolSchemas.has(name);
}
