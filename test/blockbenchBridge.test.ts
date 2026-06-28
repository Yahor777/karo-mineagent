import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultMineAgentConfig } from "../src/config/defaultConfig";
import type { MineAgentConfig } from "../src/config/types";
import { ApprovalGate } from "../src/approval/approvalGate";
import { ToolRegistry } from "../src/tools/toolRegistry";
import { ToolDispatcher, setRequestIdGenerator } from "../src/tools/toolDispatcher";
import { BlockbenchBridge, classifyRisk, normalizeCallResult } from "../src/mcp/blockbenchBridge";
import { clearDynamicSchemas } from "../src/tools/toolSchemas";
import type { McpTool } from "../src/mcp/types";

setRequestIdGenerator(() => "req-bridge-fixed");

// Fake MCP-сервер: отвечает на initialize/notifications/tools-list/tools-call.
// Возвращает фиксированный набор tools и эмулирует ответ на tools/call.
interface FakeServerState {
  tools: McpTool[];
  // Карта serverToolName → возвращаемый McpToolCallResult.
  callResults: Record<string, { content: unknown[]; isError?: boolean }>;
}

function makeFetch(state: FakeServerState): typeof fetch {
  let nextId = 0;
  return (async (input: any, init?: any) => {
    const body: Record<string, unknown> = init?.body ? JSON.parse(String(init.body)) : {};
    const id = (body.id as number | string | undefined) ?? ++nextId;
    const method = String(body.method ?? "");
    let result: unknown;
    let expectBody = true;
    if (method === "initialize") {
      result = { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "blockbench-mcp", version: "1.6.0" } };
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
          status: 200,
          headers: { "Content-Type": "application/json" }
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
      status: 200,
      headers: { "Content-Type": "application/json", "MCP-Session-Id": "sess-test" }
    });
  }) as typeof fetch;
}

function makeBridge(state: FakeServerState): { bridge: BlockbenchBridge; registry: ToolRegistry } {
  const registry = new ToolRegistry();
  const bridge = new BlockbenchBridge(
    { registry },
    { url: "http://localhost:3000/bb-mcp", timeoutMs: 5_000, fetchImpl: makeFetch(state) }
  );
  return { bridge, registry };
}

describe("BlockbenchBridge — risk-классификатор (classifyRisk)", () => {
  it("render/screenshot/preview/get_/list_ → read", () => {
    assert.equal(classifyRisk("blockbench.render_model"), "read");
    assert.equal(classifyRisk("blockbench.screenshot"), "read");
    assert.equal(classifyRisk("blockbench.preview"), "read");
    assert.equal(classifyRisk("blockbench.get_model"), "read");
    assert.equal(classifyRisk("blockbench.list_animations"), "read");
  });

  it("мутирующие операции (add_cube, set_bone, add_keyframe) → write", () => {
    assert.equal(classifyRisk("blockbench.add_cube"), "write");
    assert.equal(classifyRisk("blockbench.set_bone_rotation"), "write");
    assert.equal(classifyRisk("blockbench.add_keyframe"), "write");
    assert.equal(classifyRisk("blockbench.import_texture"), "write");
  });

  it("описание влияет на классификацию (render в description)", () => {
    assert.equal(classifyRisk("blockbench.do_something", "Render the model"), "read");
    assert.equal(classifyRisk("blockbench.do_something", "Move cube by offset"), "write");
  });
});

describe("BlockbenchBridge — normalizeCallResult", () => {
  it("text-блоки склеиваются, image-блоки сохраняются в images[]", () => {
    const result = normalizeCallResult({
      content: [
        { type: "text", text: "line1" },
        { type: "image", data: "base64data", mimeType: "image/png" },
        { type: "text", text: "line2" }
      ]
    }, "render");
    assert.equal(result.text, "line1\nline2");
    assert.equal(result.images?.length, 1);
    assert.equal(result.images?.[0]?.mimeType, "image/png");
    assert.equal(result.isError, false);
  });

  it("isError=true без слова error → text помечается как ошибка", () => {
    const result = normalizeCallResult({ content: [{ type: "text", text: "bone not found" }], isError: true }, "select_bone");
    assert.equal(result.isError, true);
    assert.match(result.text, /вернул ошибку/);
  });

  it("пустой content → запасной текст", () => {
    const result = normalizeCallResult({ content: [] }, "noop");
    assert.match(result.text, /пустой ответ/);
    assert.equal(result.images, undefined);
  });
});

describe("BlockbenchBridge — connect/disconnect + регистрация", () => {
  it("connect: tools/list → регистрирует blockbench.* с правильным risk", async () => {
    const state: FakeServerState = {
      tools: [
        { name: "render", description: "Render model", inputSchema: { type: "object" } },
        { name: "add_cube", description: "Add a cube", inputSchema: { type: "object" } }
      ],
      callResults: {}
    };
    const { bridge, registry } = makeBridge(state);
    try {
      const snapshot = await bridge.connect();
      assert.equal(snapshot.status, "connected");
      assert.equal(snapshot.serverName, "blockbench-mcp");
      assert.equal(snapshot.toolCount, 2);
      assert.deepEqual(bridge.listRegisteredToolNames(), ["blockbench.render", "blockbench.add_cube"]);
      // risk-классификация дошла до контрактов.
      assert.equal(registry.findContract("blockbench.render")?.risk, "read");
      assert.equal(registry.findContract("blockbench.render")?.requiresApproval, false);
      assert.equal(registry.findContract("blockbench.add_cube")?.risk, "write");
      assert.equal(registry.findContract("blockbench.add_cube")?.requiresApproval, true);
      // handlers зарегистрированы.
      assert.equal(registry.has("blockbench.render"), true);
      assert.equal(registry.has("blockbench.add_cube"), true);
    } finally {
      await bridge.disconnect();
    }
  });

  it("disconnect: снимает все динамические контракты и схемы", async () => {
    const state: FakeServerState = {
      tools: [{ name: "render", description: "render", inputSchema: { type: "object" } }],
      callResults: {}
    };
    const { bridge, registry } = makeBridge(state);
    await bridge.connect();
    assert.equal(registry.hasDynamic("blockbench.render"), true);
    await bridge.disconnect();
    assert.equal(bridge.isConnected(), false);
    assert.equal(registry.hasDynamic("blockbench.render"), false);
    assert.equal(registry.has("blockbench.render"), false);
  });

  it("onChange: уведомляет подписчиков при смене статуса", async () => {
    const state: FakeServerState = { tools: [], callResults: {} };
    const { bridge } = makeBridge(state);
    const statuses: string[] = [];
    bridge.onChange((s) => statuses.push(s.status));
    try {
      await bridge.connect();
      await bridge.disconnect();
      // connecting → connected → (disconnect) disconnected.
      assert.ok(statuses.includes("connecting"));
      assert.ok(statuses.includes("connected"));
      assert.ok(statuses.includes("disconnected"));
    } finally {
      await bridge.disconnect();
    }
  });
});

describe("BlockbenchBridge — прокси tool-call через dispatcher", () => {
  // Gate, авто-одобряющий всё (для read) и требующий ручной confirm/deny для write.
  function makeGate(config: MineAgentConfig, decision: "confirm-once" | "deny"): { gate: ApprovalGate; posts: { type: string; payload?: unknown }[] } {
    const posts: { type: string; payload?: unknown }[] = [];
    const gate = new ApprovalGate(config, async () => {}, (msg) => posts.push(msg), () => {});
    // Сначала зовём оригинальный post (чтобы gate.pending заполнился), затем
    // авто-resolve по requestId — как в test/toolDispatcher.test.ts.
    const originalPost = (gate as unknown as { post: (msg: { type: string; payload?: unknown }) => void }).post;
    (gate as unknown as { post: (msg: { type: string; payload?: unknown }) => void }).post = (msg) => {
      originalPost.call(gate, msg);
      if (msg.type === "approvalRequest" && msg.payload && typeof msg.payload === "object" && "requestId" in msg.payload) {
        const req = msg.payload as { requestId: string };
        setImmediate(() => gate.resolve({ requestId: req.requestId, decision }));
      }
    };
    return { gate, posts };
  }

  it("read-tool (blockbench.render) — БЕЗ approval модалки", async () => {
    const state: FakeServerState = {
      tools: [{ name: "render", description: "Render", inputSchema: { type: "object" } }],
      callResults: {
        render: { content: [{ type: "text", text: "rendered ok" }] }
      }
    };
    const { bridge, registry } = makeBridge(state);
    const { gate, posts } = makeGate(defaultMineAgentConfig, "confirm-once");
    const dispatcher = new ToolDispatcher(registry, gate);
    try {
      await bridge.connect();
      const result = await dispatcher.dispatch("blockbench.render", {}, "Render model") as { text: string };
      assert.equal(result.text, "rendered ok");
      // read-tools не должны слать approvalRequest.
      assert.equal(posts.filter((p) => p.type === "approvalRequest").length, 0);
    } finally {
      await bridge.disconnect();
    }
  });

  it("write-tool (blockbench.add_cube) — ЧЕРЕЗ approval (confirm-once → успех)", async () => {
    const state: FakeServerState = {
      tools: [{ name: "add_cube", description: "Add cube", inputSchema: { type: "object" } }],
      callResults: {
        add_cube: { content: [{ type: "text", text: "cube added" }] }
      }
    };
    const { bridge, registry } = makeBridge(state);
    const { gate, posts } = makeGate(defaultMineAgentConfig, "confirm-once");
    const dispatcher = new ToolDispatcher(registry, gate);
    try {
      await bridge.connect();
      const result = await dispatcher.dispatch("blockbench.add_cube", { size: 1 }, "Add cube") as { text: string };
      assert.equal(result.text, "cube added");
      // Был один запрос approval.
      assert.equal(posts.filter((p) => p.type === "approvalRequest").length, 1);
    } finally {
      await bridge.disconnect();
    }
  });

  it("write-tool deny → throw, MCP tools/call НЕ вызывается", async () => {
    const state: FakeServerState = {
      tools: [{ name: "add_cube", description: "Add cube", inputSchema: { type: "object" } }],
      callResults: {
        add_cube: { content: [{ type: "text", text: "cube added" }] }
      }
    };
    const { bridge, registry } = makeBridge(state);
    const { gate } = makeGate(defaultMineAgentConfig, "deny");
    const dispatcher = new ToolDispatcher(registry, gate);
    try {
      await bridge.connect();
      await assert.rejects(() => dispatcher.dispatch("blockbench.add_cube", {}, "Add cube"), /не одобрено/);
    } finally {
      await bridge.disconnect();
    }
  });

  it("image-контент из tools/call сохраняется в результате для vision (Этап 5)", async () => {
    const state: FakeServerState = {
      tools: [{ name: "render", description: "Render", inputSchema: { type: "object" } }],
      callResults: {
        render: { content: [{ type: "image", data: "iVBOR...", mimeType: "image/png" }] }
      }
    };
    const { bridge, registry } = makeBridge(state);
    const gate = new ApprovalGate(defaultMineAgentConfig, async () => {}, () => {}, () => {});
    const dispatcher = new ToolDispatcher(registry, gate);
    try {
      await bridge.connect();
      const result = await dispatcher.dispatch("blockbench.render", {}, "Render") as { images?: Array<{ data: string }> };
      assert.equal(result.images?.length, 1);
      assert.equal(result.images?.[0]?.data, "iVBOR...");
    } finally {
      await bridge.disconnect();
    }
  });
});

describe("BlockbenchBridge — findRenderTool (пункт 6 задачи)", () => {
  it("находит render-tool среди зарегистрированных", async () => {
    const state: FakeServerState = {
      tools: [
        { name: "add_cube", description: "Add", inputSchema: { type: "object" } },
        { name: "render", description: "Render model", inputSchema: { type: "object" } }
      ],
      callResults: {}
    };
    const { bridge } = makeBridge(state);
    try {
      assert.equal(bridge.findRenderTool(), undefined, "до connect — undefined");
      await bridge.connect();
      assert.equal(bridge.findRenderTool(), "blockbench.render");
    } finally {
      await bridge.disconnect();
      clearDynamicSchemas();
    }
  });
});
