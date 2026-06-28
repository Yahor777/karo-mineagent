import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { defaultMineAgentConfig } from "../src/config/defaultConfig";
import type { MineAgentConfig } from "../src/config/types";
import { MineAgentOrchestrator } from "../src/orchestrator/orchestrator";
import { ApprovalGate } from "../src/approval/approvalGate";
import { ToolRegistry } from "../src/tools/toolRegistry";
import { ToolDispatcher, setRequestIdGenerator } from "../src/tools/toolDispatcher";
import { BlockbenchBridge } from "../src/mcp/blockbenchBridge";
import { clearDynamicSchemas, TOOL_LOOP_TOOLS } from "../src/tools/toolSchemas";
import type { McpTool } from "../src/mcp/types";
import type { ChatRequest, ChatResponse, ProviderAdapter, ProviderModel, StreamChunk, ToolCall } from "../src/providers/ProviderAdapter";

setRequestIdGenerator(() => "req-loop-bb-fixed");

// Fake MCP-сервер с одним render-tool и image-контентом в ответе.
interface FakeServerState {
  tools: McpTool[];
  callResults: Record<string, { content: unknown[]; isError?: boolean }>;
}

function makeFetch(state: FakeServerState): typeof fetch {
  return (async (input: any, init?: any) => {
    const body: Record<string, unknown> = init?.body ? JSON.parse(String(init.body)) : {};
    const id = body.id as number | string;
    const method = String(body.method ?? "");
    let result: unknown;
    let expectBody = true;
    if (method === "initialize") {
      result = { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "blockbench-mcp" } };
    } else if (method === "notifications/initialized") {
      expectBody = false;
    } else if (method === "tools/list") {
      result = { tools: state.tools };
    } else if (method === "tools/call") {
      const params = body.params as { name: string };
      const resp = state.callResults[params.name] ?? { content: [{ type: "text", text: "ok" }] };
      result = { content: resp.content, isError: resp.isError };
    } else {
      result = {};
    }
    if (!expectBody) {
      return new Response("", { status: 202, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;
}

class ScriptedProvider implements ProviderAdapter {
  public readonly id = "fireworks";
  public readonly displayName = "Fireworks AI";
  public queue: Array<{ content?: string; toolCalls?: ToolCall[] }> = [];
  public requests: ChatRequest[] = [];
  public models = ["@cf/moonshotai/kimi-k2.7-code"];

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    const next = this.queue.shift();
    if (!next) {
      throw new Error("ScriptedProvider: очередь ответов исчерпана");
    }
    return { model: request.model, content: next.content ?? "", toolCalls: next.toolCalls };
  }

  public async *streamChat(request: ChatRequest): AsyncIterable<StreamChunk> {
    yield { contentDelta: (await this.chat(request)).content };
  }

  public async listModels(): Promise<ProviderModel[]> {
    return this.models.map((id) => ({
      id,
      label: id,
      provider: "fireworks",
      capabilities: { vision: false, tools: true, jsonMode: true, speed: "fast" }
    }));
  }

  public async validateKey(): Promise<boolean> {
    return true;
  }
}

function makeAutoApproveGate(config: MineAgentConfig): ApprovalGate {
  const gate = new ApprovalGate(config, async () => {}, () => {}, () => {});
  const originalPost = (gate as unknown as { post: (msg: { type: string; payload?: unknown }) => void }).post;
  (gate as unknown as { post: (msg: { type: string; payload?: unknown }) => void }).post = (msg) => {
    originalPost.call(gate, msg);
    if (msg.type === "approvalRequest" && msg.payload && typeof msg.payload === "object" && "requestId" in msg.payload) {
      const req = msg.payload as { requestId: string };
      setImmediate(() => gate.resolve({ requestId: req.requestId, decision: "confirm-once" }));
    }
  };
  return gate;
}

function configWithoutTiering(): MineAgentConfig {
  return {
    ...defaultMineAgentConfig,
    providers: {
      ...defaultMineAgentConfig.providers,
      defaultProvider: "fireworks",
      defaultModel: "@cf/moonshotai/kimi-k2.7-code",
      routineModel: "",
      complexModel: ""
    }
  };
}

async function write(root: string, relativePath: string, text: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

async function makeProject(root: string): Promise<void> {
  await write(root, "gradle.properties", "minecraft_version=1.20.1\n");
  await write(root, "build.gradle", "plugins { id 'net.minecraftforge.gradle' version '6.0.+' }\n");
}

describe("MineAgentOrchestrator + Blockbench bridge (Этап 3)", () => {
  it("модель зовёт blockbench.render → результат (image base64) в role:tool", async () => {
    const root = join(tmpdir(), `mineagent-loop-bb-${Date.now()}`);
    const provider = new ScriptedProvider();
    const registry = new ToolRegistry();
    try {
      await makeProject(root);
      const state: FakeServerState = {
        tools: [{ name: "render", description: "Render model to PNG", inputSchema: { type: "object" } }],
        callResults: {
          render: { content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] }
        }
      };
      const bridge = new BlockbenchBridge(
        { registry },
        { url: "http://localhost:3000/bb-mcp", timeoutMs: 5_000, fetchImpl: makeFetch(state) }
      );
      await bridge.connect();
      const gate = makeAutoApproveGate(configWithoutTiering());
      const dispatcher = new ToolDispatcher(registry, gate);
      const orchestrator = new MineAgentOrchestrator(root, configWithoutTiering(), {
        get: async () => provider,
        providerStatuses: async () => [{ id: "fireworks", hasKey: true }]
      } as never, undefined, dispatcher, bridge);

      provider.queue = [
        { toolCalls: [{ id: "c1", name: "blockbench.render", arguments: "{}" }] },
        { content: "Готово, рендер получен." }
      ];

      const report = await orchestrator.run({ prompt: "покажи рендер модели", mode: "ask" });

      assert.equal(report.summary, "Готово, рендер получен.");
      assert.equal(report.toolCalls?.length, 1);
      assert.equal(report.toolCalls?.[0]?.name, "blockbench.render");
      // image-данные дошли до tool-результата (для будущей vision-передачи).
      const result = report.toolCalls?.[0]?.result as { images?: unknown[] } | undefined;
      assert.equal((result?.images as unknown[] | undefined)?.length, 1);
      // Второй запрос к модели содержит role:"tool" с результатом blockbench.render.
      const secondMessages = provider.requests[1]!.messages;
      const toolReply = secondMessages.find((m) => m.role === "tool" && m.name === "blockbench.render");
      assert.ok(toolReply, "результат blockbench.render должен попасть в диалог как role:tool");

      await bridge.disconnect();
    } finally {
      await rm(root, { recursive: true, force: true });
      clearDynamicSchemas();
    }
  });

  it("БЕЗ подключения Blockbench — его схемы НЕ шлются модели (токен-экономия)", async () => {
    const root = join(tmpdir(), `mineagent-loop-nobb-${Date.now()}`);
    const provider = new ScriptedProvider();
    const registry = new ToolRegistry();
    registry.register("repo.read", async () => ({ text: "x" }));
    try {
      await makeProject(root);
      const state: FakeServerState = { tools: [{ name: "render", description: "Render", inputSchema: { type: "object" } }], callResults: {} };
      const bridge = new BlockbenchBridge(
        { registry },
        { url: "http://localhost:3000/bb-mcp", timeoutMs: 5_000, fetchImpl: makeFetch(state) }
      );
      // НЕ подключаем bridge → isConnected() === false.
      const gate = makeAutoApproveGate(configWithoutTiering());
      const dispatcher = new ToolDispatcher(registry, gate);
      const orchestrator = new MineAgentOrchestrator(root, configWithoutTiering(), {
        get: async () => provider,
        providerStatuses: async () => [{ id: "fireworks", hasKey: true }]
      } as never, undefined, dispatcher, bridge);

      provider.queue = [{ content: "Обычный ответ без blockbench-инструментов." }];
      await orchestrator.run({ prompt: "ответь", mode: "ask" });

      // В запросе к модели — статичный набор Этапов 2-5, БЕЗ динамических blockbench.*.
      const tools = provider.requests[0]?.tools ?? [];
      const names = tools.map((t) => t.function.name);
      assert.deepEqual(names.slice().sort(), [...TOOL_LOOP_TOOLS].sort());
      assert.ok(!names.some((n) => n.startsWith("blockbench.")), "blockbench-схемы не должны слаться без подключения");
    } finally {
      await rm(root, { recursive: true, force: true });
      clearDynamicSchemas();
    }
  });

  it("после подключения blockbench.*-схемы добавляются к базовому набору", async () => {
    const root = join(tmpdir(), `mineagent-loop-bbschema-${Date.now()}`);
    const provider = new ScriptedProvider();
    const registry = new ToolRegistry();
    registry.register("repo.read", async () => ({ text: "x" }));
    try {
      await makeProject(root);
      const state: FakeServerState = { tools: [{ name: "render", description: "Render", inputSchema: { type: "object" } }], callResults: {} };
      const bridge = new BlockbenchBridge(
        { registry },
        { url: "http://localhost:3000/bb-mcp", timeoutMs: 5_000, fetchImpl: makeFetch(state) }
      );
      await bridge.connect();
      const gate = makeAutoApproveGate(configWithoutTiering());
      const dispatcher = new ToolDispatcher(registry, gate);
      const orchestrator = new MineAgentOrchestrator(root, configWithoutTiering(), {
        get: async () => provider,
        providerStatuses: async () => [{ id: "fireworks", hasKey: true }]
      } as never, undefined, dispatcher, bridge);

      provider.queue = [{ content: "Финальный ответ." }];
      await orchestrator.run({ prompt: "ответь", mode: "ask" });

      const tools = provider.requests[0]?.tools ?? [];
      const names = tools.map((t) => t.function.name);
      assert.ok(names.includes("blockbench.render"), "blockbench.render должен быть в схемах при подключении");
      assert.ok(names.includes("repo.read"), "базовый набор остаётся");
      await bridge.disconnect();
    } finally {
      await rm(root, { recursive: true, force: true });
      clearDynamicSchemas();
    }
  });
});
