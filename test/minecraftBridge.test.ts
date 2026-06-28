import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultMineAgentConfig } from "../src/config/defaultConfig";
import type { MineAgentConfig } from "../src/config/types";
import { ApprovalGate } from "../src/approval/approvalGate";
import { ToolRegistry } from "../src/tools/toolRegistry";
import { ToolDispatcher, setRequestIdGenerator } from "../src/tools/toolDispatcher";
import {
  MinecraftBridge,
  classifyMinecraftRisk,
  normalizeCallResult
} from "../src/mcp/minecraftBridge";
import { clearDynamicSchemas } from "../src/tools/toolSchemas";
import type { McpTool } from "../src/mcp/types";

setRequestIdGenerator(() => "req-mc-bridge-fixed");

// Fake MCP-сервер мода mineagent-bridge: отвечает initialize/notifications/
// tools-list/tools-call. token передаётся в Authorization; если не совпадает —
// 401 (имитация McpHttpServer.checkToken).
interface FakeServerState {
  tools: McpTool[];
  callResults: Record<string, { content: unknown[]; isError?: boolean }>;
  expectedToken?: string;
}

function makeFetch(state: FakeServerState): typeof fetch {
  let nextId = 0;
  return (async (input: any, init?: any) => {
    // Token-check: имитация сервера мода. Если expectedToken задан и не совпал — 401.
    if (state.expectedToken) {
      const auth = init?.headers?.Authorization ?? init?.headers?.authorization;
      if (auth !== `Bearer ${state.expectedToken}`) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }), {
          status: 401, headers: { "Content-Type": "application/json" }
        });
      }
    }
    const body: Record<string, unknown> = init?.body ? JSON.parse(String(init.body)) : {};
    const id = (body.id as number | string | undefined) ?? ++nextId;
    const method = String(body.method ?? "");
    let result: unknown;
    let expectBody = true;
    if (method === "initialize") {
      result = { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "mineagent-bridge", version: "0.1.0" } };
    } else if (method === "notifications/initialized") {
      expectBody = false;
      result = undefined;
    } else if (method === "tools/list") {
      result = { tools: state.tools };
    } else if (method === "tools/call") {
      const params = body.params as { name: string; arguments?: Record<string, unknown> };
      const resp = state.callResults[params.name];
      if (!resp) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool ${params.name}` } }), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      }
      result = { content: resp.content, isError: resp.isError };
    } else {
      result = {};
    }
    if (!expectBody) {
      return new Response("", { status: 202, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      status: 200, headers: { "Content-Type": "application/json", "MCP-Session-Id": "sess-mc-test" }
    });
  }) as typeof fetch;
}

function makeBridge(state: FakeServerState, token = "deadbeef"): { bridge: MinecraftBridge; registry: ToolRegistry } {
  const registry = new ToolRegistry();
  const bridge = new MinecraftBridge(
    { registry },
    {
      url: "http://127.0.0.1:3100/mc-mcp",
      timeoutMs: 5_000,
      fetchImpl: makeFetch(state),
      token
    }
  );
  return { bridge, registry };
}

describe("MinecraftBridge — classifyMinecraftRisk (ВСЕ game-control)", () => {
  it("summon/apply_effect/set_camera → game-control (меняют мир)", () => {
    assert.equal(classifyMinecraftRisk("minecraft.summon"), "game-control");
    assert.equal(classifyMinecraftRisk("minecraft.apply_effect"), "game-control");
    assert.equal(classifyMinecraftRisk("minecraft.set_camera"), "game-control");
  });

  it("read-операции (screenshot/get_state) ТОЖЕ game-control (захват состояния)", () => {
    assert.equal(classifyMinecraftRisk("minecraft.screenshot"), "game-control");
    assert.equal(classifyMinecraftRisk("minecraft.get_state"), "game-control");
    assert.equal(classifyMinecraftRisk("minecraft.reload_resources"), "game-control");
  });

  it("не зависит от описания — всегда game-control", () => {
    assert.equal(classifyMinecraftRisk("minecraft.whatever", "Read-only registry inspection"), "game-control");
  });
});

describe("MinecraftBridge — normalizeCallResult", () => {
  it("text-блоки склеиваются, image (screenshot) сохраняется в images[]", () => {
    const result = normalizeCallResult({
      content: [
        { type: "text", text: "ok" },
        { type: "image", data: "iVBOR", mimeType: "image/png" }
      ]
    }, "screenshot");
    assert.equal(result.text, "ok");
    assert.equal(result.images?.length, 1);
    assert.equal(result.images?.[0]?.mimeType, "image/png");
    assert.equal(result.isError, false);
  });

  it("isError=true помечает текст ошибки", () => {
    const result = normalizeCallResult({ content: [{ type: "text", text: "client not ready" }], isError: true }, "summon");
    assert.equal(result.isError, true);
    assert.match(result.text, /ошибку/);
  });

  it("пустой content → запасной текст с именем инструмента", () => {
    const result = normalizeCallResult({ content: [] }, "summon");
    assert.match(result.text, /Minecraft summon/);
    assert.equal(result.images, undefined);
  });
});

describe("MinecraftBridge — connect/disconnect + регистрация", () => {
  it("connect: tools/list → регистрирует minecraft.* с game-control risk + approval", async () => {
    const state: FakeServerState = {
      tools: [
        { name: "summon", description: "Summon entity", inputSchema: { type: "object" } },
        { name: "screenshot", description: "Capture frame", inputSchema: { type: "object" } }
      ],
      callResults: {},
      expectedToken: "deadbeef"
    };
    const { bridge, registry } = makeBridge(state);
    try {
      const snapshot = await bridge.connect();
      assert.equal(snapshot.status, "connected");
      assert.equal(snapshot.serverName, "mineagent-bridge");
      assert.equal(snapshot.toolCount, 2);
      assert.deepEqual(bridge.listRegisteredToolNames(), ["minecraft.summon", "minecraft.screenshot"]);
      // ВСЕ инструменты — game-control (требуют approval).
      assert.equal(registry.findContract("minecraft.summon")?.risk, "game-control");
      assert.equal(registry.findContract("minecraft.summon")?.requiresApproval, true);
      assert.equal(registry.findContract("minecraft.screenshot")?.risk, "game-control");
      assert.equal(registry.findContract("minecraft.screenshot")?.requiresApproval, true);
      // handlers зарегистрированы.
      assert.equal(registry.has("minecraft.summon"), true);
    } finally {
      await bridge.disconnect();
    }
  });

  it("connect без токена → throw (мод отклонит)", async () => {
    const state: FakeServerState = { tools: [], callResults: {} };
    const registry = new ToolRegistry();
    const bridge = new MinecraftBridge(
      { registry },
      { url: "http://127.0.0.1:3100/mc-mcp", timeoutMs: 1_000, fetchImpl: makeFetch(state) }
      // token НЕ передан
    );
    await assert.rejects(() => bridge.connect(), /shared-token не задан/);
    assert.equal(bridge.isConnected(), false);
  });

  it("connect с неверным токеном → ошибка (сервер 401)", async () => {
    const state: FakeServerState = {
      tools: [{ name: "summon", description: "summon", inputSchema: { type: "object" } }],
      callResults: {},
      expectedToken: "correct-token"
    };
    const { bridge } = makeBridge(state, "wrong-token");
    try {
      await assert.rejects(() => bridge.connect(), /401|Unauthorized|HTTP 401/i);
      assert.equal(bridge.getStatus(), "error");
    } finally {
      await bridge.disconnect();
    }
  });

  it("disconnect: снимает все динамические контракты", async () => {
    const state: FakeServerState = {
      tools: [{ name: "summon", description: "summon", inputSchema: { type: "object" } }],
      callResults: {}
    };
    const { bridge, registry } = makeBridge(state);
    await bridge.connect();
    assert.equal(registry.hasDynamic("minecraft.summon"), true);
    await bridge.disconnect();
    assert.equal(bridge.isConnected(), false);
    assert.equal(registry.hasDynamic("minecraft.summon"), false);
    assert.equal(registry.has("minecraft.summon"), false);
  });

  it("onChange: уведомляет подписчиков при смене статуса", async () => {
    const state: FakeServerState = { tools: [], callResults: {} };
    const { bridge } = makeBridge(state);
    const statuses: string[] = [];
    bridge.onChange((s) => statuses.push(s.status));
    try {
      await bridge.connect();
      await bridge.disconnect();
      assert.ok(statuses.includes("connecting"));
      assert.ok(statuses.includes("connected"));
      assert.ok(statuses.includes("disconnected"));
    } finally {
      await bridge.disconnect();
      clearDynamicSchemas();
    }
  });
});

describe("MinecraftBridge — waitForEndpoint (health-poll)", () => {
  it("endpoint отвечает сразу → true", async () => {
    const state: FakeServerState = { tools: [], callResults: {} };
    const { bridge } = makeBridge(state);
    const ready = await bridge.waitForEndpoint(2_000);
    assert.equal(ready, true);
  });

  it("endpoint не отвечает (fetch бросает) → false по таймауту", async () => {
    const failingFetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const registry = new ToolRegistry();
    const bridge = new MinecraftBridge(
      { registry },
      { url: "http://127.0.0.1:3100/mc-mcp", timeoutMs: 200, fetchImpl: failingFetch, token: "t" }
    );
    // launchWaitMs маленький, чтобы тест не висел.
    const ready = await bridge.waitForEndpoint(300);
    assert.equal(ready, false);
  });
});

describe("MinecraftBridge — прокси tool-call через dispatcher", () => {
  function makeGate(config: MineAgentConfig, decision: "confirm-once" | "deny"): ApprovalGate {
    const gate = new ApprovalGate(config, async () => {}, (msg) => {
      if (msg.type === "approvalRequest" && msg.payload && typeof msg.payload === "object" && "requestId" in msg.payload) {
        const req = msg.payload as { requestId: string };
        setImmediate(() => gate.resolve({ requestId: req.requestId, decision }));
      }
    }, () => {});
    return gate;
  }

  it("summon (game-control) — ЧЕРЕЗ approval (confirm-once → успех)", async () => {
    const state: FakeServerState = {
      tools: [{ name: "summon", description: "Summon", inputSchema: { type: "object" } }],
      callResults: { summon: { content: [{ type: "text", text: "summoned zombie" }] } }
    };
    const { bridge, registry } = makeBridge(state);
    const gate = makeGate(defaultMineAgentConfig, "confirm-once");
    const dispatcher = new ToolDispatcher(registry, gate);
    try {
      await bridge.connect();
      const result = await dispatcher.dispatch("minecraft.summon", { entity: "minecraft:zombie" }, "Summon zombie") as { text: string };
      assert.equal(result.text, "summoned zombie");
    } finally {
      await bridge.disconnect();
    }
  });

  it("summon deny → throw, MCP tools/call НЕ вызывается", async () => {
    const state: FakeServerState = {
      tools: [{ name: "summon", description: "Summon", inputSchema: { type: "object" } }],
      callResults: { summon: { content: [{ type: "text", text: "should not happen" }] } }
    };
    const { bridge, registry } = makeBridge(state);
    const gate = makeGate(defaultMineAgentConfig, "deny");
    const dispatcher = new ToolDispatcher(registry, gate);
    try {
      await bridge.connect();
      await assert.rejects(() => dispatcher.dispatch("minecraft.summon", {}, "Summon"), /не одобрено/);
    } finally {
      await bridge.disconnect();
    }
  });

  it("screenshot → image-контент сохраняется в результате (для vision Этап 5)", async () => {
    const state: FakeServerState = {
      tools: [{ name: "screenshot", description: "Capture", inputSchema: { type: "object" } }],
      callResults: { screenshot: { content: [{ type: "image", data: "iVBORpng", mimeType: "image/png" }] } }
    };
    const { bridge, registry } = makeBridge(state);
    const gate = makeGate(defaultMineAgentConfig, "confirm-once");
    const dispatcher = new ToolDispatcher(registry, gate);
    try {
      await bridge.connect();
      const result = await dispatcher.dispatch("minecraft.screenshot", {}, "Screenshot") as { images?: Array<{ data: string }> };
      assert.equal(result.images?.length, 1);
      assert.equal(result.images?.[0]?.data, "iVBORpng");
    } finally {
      await bridge.disconnect();
    }
  });
});
