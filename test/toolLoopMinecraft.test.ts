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
import { MinecraftBridge } from "../src/mcp/minecraftBridge";
import { clearDynamicSchemas } from "../src/tools/toolSchemas";
import type { McpTool } from "../src/mcp/types";
import type { ChatRequest, ChatResponse, ProviderAdapter, ProviderModel, StreamChunk, ToolCall } from "../src/providers/ProviderAdapter";

setRequestIdGenerator(() => "req-loop-mc-fixed");

// Fake MCP-сервер мода (с token-check, как в minecraftBridge.test.ts).
interface FakeServerState {
  tools: McpTool[];
  callResults: Record<string, { content: unknown[]; isError?: boolean }>;
  expectedToken: string;
}

function makeFetch(state: FakeServerState): typeof fetch {
  let nextId = 0;
  return (async (input: any, init?: any) => {
    const auth = init?.headers?.Authorization ?? init?.headers?.authorization;
    if (auth !== `Bearer ${state.expectedToken}`) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }), {
        status: 401, headers: { "Content-Type": "application/json" }
      });
    }
    const body: Record<string, unknown> = init?.body ? JSON.parse(String(init.body)) : {};
    const id = (body.id as number | string | undefined) ?? ++nextId;
    const method = String(body.method ?? "");
    let result: unknown;
    let expectBody = true;
    if (method === "initialize") {
      result = { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "mineagent-bridge" } };
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
      status: 200, headers: { "Content-Type": "application/json" }
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
      id, label: id, provider: "fireworks",
      capabilities: { vision: false, tools: true, jsonMode: true, speed: "fast" }
    }));
  }

  public async validateKey(): Promise<boolean> { return true; }
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

describe("MineAgentOrchestrator + Minecraft bridge (Этап 4)", () => {
  it("модель зовёт minecraft.summon → результат в role:tool (game-control, через approval)", async () => {
    const root = join(tmpdir(), `mineagent-loop-mc-${Date.now()}`);
    const provider = new ScriptedProvider();
    const registry = new ToolRegistry();
    try {
      await makeProject(root);
      const state: FakeServerState = {
        tools: [{ name: "summon", description: "Summon entity", inputSchema: { type: "object" } }],
        callResults: { summon: { content: [{ type: "text", text: "summoned minecraft:zombie" }] } },
        expectedToken: "tok123"
      };
      const bridge = new MinecraftBridge(
        { registry },
        { url: "http://127.0.0.1:3100/mc-mcp", timeoutMs: 5_000, fetchImpl: makeFetch(state), token: "tok123" }
      );
      await bridge.connect();

      const gate = makeAutoApproveGate(configWithoutTiering());
      const dispatcher = new ToolDispatcher(registry, gate);
      const orchestrator = new MineAgentOrchestrator(root, configWithoutTiering(), {
        get: async () => provider,
        providerStatuses: async () => [{ id: "fireworks", hasKey: true }]
      } as never, undefined, dispatcher, undefined, bridge);

      provider.queue = [
        { toolCalls: [{ id: "c1", name: "minecraft.summon", arguments: "{\"entity\":\"minecraft:zombie\"}" }] },
        { content: "Готово, моб призван." }
      ];

      const report = await orchestrator.run({ prompt: "призови зомби", mode: "ask" });
      assert.equal(report.summary, "Готово, моб призван.");
      assert.equal(report.toolCalls?.length, 1);
      assert.equal(report.toolCalls?.[0]?.name, "minecraft.summon");
      const result = report.toolCalls?.[0]?.result as { text?: string };
      assert.equal(result.text, "summoned minecraft:zombie");
      // tools-схема в запросе к модели содержала minecraft.summon.
      const lastReq = provider.requests[provider.requests.length - 1];
      assert.ok(lastReq.tools?.some((t) => t.function.name === "minecraft.summon"), "minecraft.summon должен быть в tools-схеме");

      await bridge.disconnect();
    } finally {
      await rm(root, { recursive: true, force: true });
      clearDynamicSchemas();
    }
  });

  it("без подключения minecraft-bridge: minecraft.* НЕ попадают в tools-схему (токен-экономия)", async () => {
    const root = join(tmpdir(), `mineagent-loop-mc-off-${Date.now()}`);
    const provider = new ScriptedProvider();
    const registry = new ToolRegistry();
    try {
      await makeProject(root);
      // Bridge создан, но НЕ подключён.
      const bridge = new MinecraftBridge(
        { registry },
        { url: "http://127.0.0.1:3100/mc-mcp", timeoutMs: 1_000, token: "x" }
      );
      const gate = makeAutoApproveGate(configWithoutTiering());
      const dispatcher = new ToolDispatcher(registry, gate);
      const orchestrator = new MineAgentOrchestrator(root, configWithoutTiering(), {
        get: async () => provider,
        providerStatuses: async () => [{ id: "fireworks", hasKey: true }]
      } as never, undefined, dispatcher, undefined, bridge);

      provider.queue = [{ content: "ответ без tool-call" }];
      await orchestrator.run({ prompt: "привет", mode: "ask" });

      // В запросе только статичный набор. Динамические инструменты dev-bridge
      // (minecraft.summon и т.п.) НЕ шлются без подключения. Статичные
      // лог-инструменты (minecraft.tailLogs/parseCrash) читают локальные файлы
      // и доступны всегда — они НЕ зависят от моста.
      const req = provider.requests[0];
      assert.ok(req.tools);
      const names = req.tools?.map((t) => t.function.name) ?? [];
      assert.equal(names.includes("minecraft.summon"), false);
      assert.equal(names.some((n) => n.startsWith("blockbench.")), false);
      assert.equal(names.includes("repo.read"), true);
    } finally {
      await rm(root, { recursive: true, force: true });
      clearDynamicSchemas();
    }
  });
});

describe("MineAgentOrchestrator + оба bridge'а одновременно (multi-bridge)", () => {
  it("blockbench.* И minecraft.* оба попадают в tools-схему без коллизий", async () => {
    const root = join(tmpdir(), `mineagent-loop-multi-${Date.now()}`);
    const provider = new ScriptedProvider();
    const registry = new ToolRegistry();
    try {
      await makeProject(root);

      // Blockbench bridge (Этап 3) — render tool.
      const bbState: {
        tools: McpTool[];
        callResults: Record<string, { content: unknown[]; isError?: boolean }>;
      } = {
        tools: [{ name: "render", description: "Render", inputSchema: { type: "object" } }],
        callResults: { render: { content: [{ type: "text", text: "rendered" }] } }
      };
      const bbFetch = ((async (input: any, init?: any) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const id = body.id ?? 1;
        const method = String(body.method ?? "");
        let result: unknown = {};
        if (method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "bb" } };
        else if (method === "notifications/initialized") {
          return new Response("", { status: 202 });
        } else if (method === "tools/list") {
          result = { tools: bbState.tools };
        } else if (method === "tools/call") {
          result = { content: bbState.callResults[(body.params as { name: string }).name]?.content ?? [{ type: "text", text: "ok" }] };
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch);
      const bbBridge = new BlockbenchBridge(
        { registry },
        { url: "http://localhost:3000/bb-mcp", timeoutMs: 5_000, fetchImpl: bbFetch }
      );
      await bbBridge.connect();

      // Minecraft bridge (Этап 4) — summon tool.
      const mcState: FakeServerState = {
        tools: [{ name: "summon", description: "Summon", inputSchema: { type: "object" } }],
        callResults: { summon: { content: [{ type: "text", text: "summoned" }] } },
        expectedToken: "mtok"
      };
      const mcBridge = new MinecraftBridge(
        { registry },
        { url: "http://127.0.0.1:3100/mc-mcp", timeoutMs: 5_000, fetchImpl: makeFetch(mcState), token: "mtok" }
      );
      await mcBridge.connect();

      // Явная проверка, что оба bridge'а подключились и зарегистрировали инструменты.
      assert.equal(bbBridge.isConnected(), true, "bbBridge должен быть подключён");
      assert.equal(mcBridge.isConnected(), true, "mcBridge должен быть подключён");
      assert.ok(bbBridge.listRegisteredToolNames().includes("blockbench.render"),
        `bbBridge tools: ${JSON.stringify(bbBridge.listRegisteredToolNames())}`);
      assert.ok(mcBridge.listRegisteredToolNames().includes("minecraft.summon"),
        `mcBridge tools: ${JSON.stringify(mcBridge.listRegisteredToolNames())}`);

      const gate = makeAutoApproveGate(configWithoutTiering());
      const dispatcher = new ToolDispatcher(registry, gate);
      // Передаём ОБА bridge'а.
      const orchestrator = new MineAgentOrchestrator(root, configWithoutTiering(), {
        get: async () => provider,
        providerStatuses: async () => [{ id: "fireworks", hasKey: true }]
      } as never, undefined, dispatcher, bbBridge, mcBridge);

      provider.queue = [{ content: "ответ" }];
      await orchestrator.run({ prompt: "работай", mode: "ask" });

      // Диагностика: если tools пуст — это значит, что toolsAvailable=false
      // (loop не запустился), а не коллизия префиксов.
      const req = provider.requests[0];
      const toolNames = (req.tools ?? []).map((t) => t.function.name);
      assert.ok(req.tools && req.tools.length > 0, `tools-схема пуста: loop не включился. requests=${provider.requests.length}`);
      assert.ok(toolNames.includes("blockbench.render"), `blockbench.render отсутствует. tools=${JSON.stringify(toolNames)}`);
      assert.ok(toolNames.includes("minecraft.summon"), `minecraft.summon отсутствует. tools=${JSON.stringify(toolNames)}`);

      await bbBridge.disconnect();
      await mcBridge.disconnect();
    } finally {
      await rm(root, { recursive: true, force: true });
      clearDynamicSchemas();
    }
  });
});
