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
import { VisionEvaluator } from "../src/orchestrator/visionEvaluator";
import { clearDynamicSchemas } from "../src/tools/toolSchemas";
import { hasImageBlocks } from "../src/providers/ProviderAdapter";
import type { McpTool } from "../src/mcp/types";
import type { ChatRequest, ChatResponse, ProviderAdapter, ProviderModel, StreamChunk, ToolCall } from "../src/providers/ProviderAdapter";

setRequestIdGenerator(() => "req-vision-loop-fixed");

// Этап 5: интеграционный тест — images из blockbench.render доходят до
// vision-модели через orchestrator tool-loop.
// (c) images из tool-результата доходят до vision-модели (не теряются)
// (b) visionCalls инкрементится

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

// Провайдер, который "видит" image-блоки и возвращает вердикт.
class VisionScriptedProvider implements ProviderAdapter {
  public readonly id = "cloudflare";
  public readonly displayName = "Cloudflare";
  public queue: Array<{ content?: string; toolCalls?: ToolCall[] }> = [];
  public requests: ChatRequest[] = [];
  public models = ["@cf/meta/llama-4-scout-17b-16e-instruct"];

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    const next = this.queue.shift();
    if (!next) {
      throw new Error("VisionScriptedProvider: очередь ответов исчерпана");
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
      provider: "cloudflare",
      capabilities: { vision: true, tools: true, jsonMode: true, speed: "medium" }
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

function configWithVision(): MineAgentConfig {
  return {
    ...defaultMineAgentConfig,
    providers: {
      ...defaultMineAgentConfig.providers,
      defaultProvider: "cloudflare",
      defaultModel: "@cf/meta/llama-4-scout-17b-16e-instruct",
      routineModel: "",
      complexModel: ""
    },
    agent: {
      ...defaultMineAgentConfig.agent,
      visionModel: "@cf/meta/llama-4-scout-17b-16e-instruct",
      visionTriggers: ["blockbench.render"]
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

describe("MineAgentOrchestrator + Vision (Этап 5 интеграция)", () => {
  it("images из blockbench.render доходят до VisionEvaluator (не теряются)", async () => {
    const root = join(tmpdir(), `mineagent-vision-${Date.now()}`);
    const provider = new VisionScriptedProvider();
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
      const gate = makeAutoApproveGate(configWithVision());
      const dispatcher = new ToolDispatcher(registry, gate);
      const visionEvaluator = new VisionEvaluator({
        provider,
        models: await provider.listModels(),
        visionModel: "@cf/meta/llama-4-scout-17b-16e-instruct"
      });
      const orchestrator = new MineAgentOrchestrator(
        root, configWithVision(),
        { get: async () => provider, providerStatuses: async () => [{ id: "cloudflare", hasKey: true }] } as never,
        undefined, dispatcher, bridge, undefined, visionEvaluator
      );

      provider.queue = [
        { toolCalls: [{ id: "c1", name: "blockbench.render", arguments: "{}" }] },
        { content: '{"matches":true,"confidence":0.9,"notes":"Модель видна"}' },
        { content: "Готово, рендер оценён." }
      ];

      const report = await orchestrator.run({ prompt: "покажи рендер модели", mode: "ask" });

      assert.equal(report.summary, "Готово, рендер оценён.");
      assert.equal(report.toolCalls?.length, 1);
      assert.equal(report.toolCalls?.[0]?.name, "blockbench.render");
      // images сохранены в trace (не потеряны через JSON.stringify)
      const result = report.toolCalls?.[0]?.result as { images?: unknown[] } | undefined;
      assert.equal((result?.images as unknown[] | undefined)?.length, 1);
      // images сохранены в trace.images
      assert.equal(report.toolCalls?.[0]?.images?.length, 1);

      // Второй запрос к модели (после blockbench.render) содержит role:"tool"
      // БЕЗ base64 images (они подняты в trace, а не в JSON.stringify).
      // requests[0] = initial, requests[1] = vision eval, requests[2] = final с tool result
      const finalMessages = provider.requests[2]!.messages;
      const toolReply = finalMessages.find((m) => m.role === "tool" && m.name === "blockbench.render");
      assert.ok(toolReply, "результат blockbench.render должен попасть в диалог как role:tool");
      const toolText = typeof toolReply.content === "string" ? toolReply.content : "";
      assert.ok(!toolText.includes("iVBORw0KGgo="), "base64 не должен попасть в role:tool (раздувает контекст)");

      // Vision-запрос отправлен с image-блоками
      const visionRequest = provider.requests.find(
        (req) => req.messages.some((m) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "image_url"))
      );
      assert.ok(visionRequest, "должен быть vision-запрос с image_url-блоками");
      assert.ok(hasImageBlocks(visionRequest!.messages), "vision-запрос содержит image-блоки");

      await bridge.disconnect();
    } finally {
      await rm(root, { recursive: true, force: true });
      clearDynamicSchemas();
    }
  });

  it("БЕЗ visionTriggers — vision-оценка НЕ запускается", async () => {
    const root = join(tmpdir(), `mineagent-no-vision-${Date.now()}`);
    const provider = new VisionScriptedProvider();
    const registry = new ToolRegistry();
    try {
      await makeProject(root);
      const state: FakeServerState = {
        tools: [{ name: "render", description: "Render", inputSchema: { type: "object" } }],
        callResults: {
          render: { content: [{ type: "image", data: "iVBOR", mimeType: "image/png" }] }
        }
      };
      const bridge = new BlockbenchBridge(
        { registry },
        { url: "http://localhost:3000/bb-mcp", timeoutMs: 5_000, fetchImpl: makeFetch(state) }
      );
      await bridge.connect();
      const configNoVision = {
        ...configWithVision(),
        agent: { ...configWithVision().agent, visionTriggers: [] }
      };
      const gate = makeAutoApproveGate(configNoVision);
      const dispatcher = new ToolDispatcher(registry, gate);
      const visionEvaluator = new VisionEvaluator({
        provider,
        models: await provider.listModels(),
        visionModel: "@cf/meta/llama-4-scout-17b-16e-instruct"
      });
      const orchestrator = new MineAgentOrchestrator(
        root, configNoVision,
        { get: async () => provider, providerStatuses: async () => [{ id: "cloudflare", hasKey: true }] } as never,
        undefined, dispatcher, bridge, undefined, visionEvaluator
      );

      provider.queue = [
        { toolCalls: [{ id: "c1", name: "blockbench.render", arguments: "{}" }] },
        { content: "Готово." }
      ];

      await orchestrator.run({ prompt: "покажи", mode: "ask" });

      // Не должно быть vision-запроса (только 2 запроса в tool-loop)
      const visionRequest = provider.requests.find(
        (req) => req.messages.some((m) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "image_url"))
      );
      assert.equal(visionRequest, undefined, "vision-оценка не должна запускаться без visionTriggers");

      await bridge.disconnect();
    } finally {
      await rm(root, { recursive: true, force: true });
      clearDynamicSchemas();
    }
  });
});
