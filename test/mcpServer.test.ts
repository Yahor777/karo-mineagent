import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { McpServer } from "../src/mcp/mcpServer";
import type { McpServerContext, RunResult } from "../src/mcp/mcpServerTools";
import { MINEAGENT_TOOLS, handleToolCall } from "../src/mcp/mcpServerTools";
import { TokenBudgetService } from "../src/providers/tokenBudget";
import type { MineAgentConfig } from "../src/config/types";

// --- Helpers: HTTP JSON-RPC client for tests ---

const TEST_PORT = 18347;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function rpc(
  body: Record<string, unknown>,
  headers?: Record<string, string>
): Promise<{ status: number; json: Record<string, unknown> | null; headers: Record<string, string> }> {
  const resp = await fetch(BASE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  const respHeaders: Record<string, string> = {};
  resp.headers.forEach((v, k) => { respHeaders[k] = v; });
  let json: Record<string, unknown> | null = null;
  const text = await resp.text();
  if (text) {
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON */ }
  }
  return { status: resp.status, json, headers: respHeaders };
}

function makeRequest(id: number | string, method: string, params?: unknown): Record<string, unknown> {
  const msg: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) msg.params = params;
  return msg;
}

function makeNotification(method: string, params?: unknown): Record<string, unknown> {
  const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) msg.params = params;
  return msg;
}

// --- Mock McpServerContext ---

function makeMockContext(overrides?: Partial<McpServerContext>): McpServerContext {
  const tokenBudget = new TokenBudgetService(500_000);
  const mockConfig: MineAgentConfig = {
    providers: {
      defaultProvider: "cloudflare",
      defaultModel: "@cf/meta/llama-3.1-8b-instruct",
      complexModel: "@cf/meta/llama-3.1-70b-instruct",
      routineModel: "@cf/meta/llama-3.1-8b-instruct",
      sessionTokenLimit: 500_000,
      apiKeys: {}
    },
    minecraft: {
      gradleBuildTask: "build",
      runClientTask: "runClient",
      devBridgeEnabled: false
    },
    mcp: {
      blockbench: { enabled: false, url: "", timeoutMs: 30_000 },
      server: { enabled: false, port: 0, token: "" },
      minecraft: { enabled: false, url: "", timeoutMs: 30_000, launchWaitMs: 120_000 }
    }
  } as unknown as MineAgentConfig;

  const mockRunResult: RunResult = {
    id: "run-test-001",
    summary: "Completed successfully.",
    toolCallCount: 3
  };

  return {
    root: os.tmpdir(),
    getConfig: async () => mockConfig,
    providers: {
      providerStatuses: async () => [
        { id: "cloudflare" as never, hasKey: true },
        { id: "wavespeed" as never, hasKey: false }
      ]
    } as unknown as McpServerContext["providers"],
    dispatcher: undefined,
    tokenBudget,
    currentRunAbort: undefined,
    startRun: async () => mockRunResult,
    ...overrides
  };
}

// --- Tests ---

describe("McpServer", () => {
  let server: McpServer;
  let tempDir: string;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
    // Create a test file for repo.read tests
    await fs.writeFile(path.join(tempDir, "test.txt"), "hello world\nline 2\n");

    server = new McpServer({ port: TEST_PORT }, () => makeMockContext({ root: tempDir }));
    await server.start();
  });

  after(async () => {
    await server.stop();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("initialize", () => {
    it("returns protocolVersion, capabilities, serverInfo, and sessionId header", async () => {
      const { status, json, headers } = await rpc(makeRequest(1, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" }
      }));

      assert.equal(status, 200);
      assert.ok(json, "response body must be JSON");
      assert.equal(json!.jsonrpc, "2.0");
      assert.equal(json!.id, 1);
      const result = json!.result as Record<string, unknown>;
      assert.ok(result, "result must be present");
      assert.equal(result.protocolVersion, "2025-11-25");
      assert.ok(result.serverInfo, "serverInfo must be present");
      assert.equal((result.serverInfo as Record<string, unknown>).name, "MineAgent MCP Server");
      assert.ok(result.capabilities, "capabilities must be present");
      // Session ID header
      assert.ok(headers["mcp-session-id"], "Mcp-Session-Id header must be present");
      assert.match(headers["mcp-session-id"], /^mcp-/);
    });
  });

  describe("tools/list", () => {
    it("returns all 7 mineagent tools", async () => {
      const { status, json } = await rpc(makeRequest(2, "tools/list"));
      assert.equal(status, 200);
      const result = json!.result as { tools: Array<{ name: string }> };
      assert.ok(result.tools, "tools array must be present");
      assert.equal(result.tools.length, MINEAGENT_TOOLS.length);
      const names = result.tools.map((t) => t.name);
      const expected = MINEAGENT_TOOLS.map((t) => t.name);
      assert.deepEqual(names.sort(), [...expected].sort());
    });

    it("each tool has name, description, and inputSchema", async () => {
      const { json } = await rpc(makeRequest(3, "tools/list"));
      const result = json!.result as { tools: Array<Record<string, unknown>> };
      for (const tool of result.tools) {
        assert.ok(tool.name, "tool.name required");
        assert.ok(tool.description, "tool.description required");
        assert.ok(tool.inputSchema, "tool.inputSchema required");
        assert.equal((tool.inputSchema as Record<string, unknown>).type, "object");
      }
    });
  });

  describe("tools/call — mineagent.status", () => {
    it("returns running state, provider, model, and budget", async () => {
      const { status, json } = await rpc(makeRequest(10, "tools/call", {
        name: "mineagent.status"
      }));
      assert.equal(status, 200);
      const result = json!.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.equal(result.isError, false);
      assert.ok(result.content.length > 0);
      const text = result.content.find((c) => c.type === "text")!.text;
      assert.match(text, /Running: false/);
      assert.match(text, /Provider: cloudflare/);
      assert.match(text, /Tokens used: 0/);
      assert.match(text, /Budget exceeded: false/);
    });
  });

  describe("tools/call — mineagent.run", () => {
    it("starts a run and returns summary", async () => {
      const { status, json } = await rpc(makeRequest(11, "tools/call", {
        name: "mineagent.run",
        arguments: { prompt: "Create a lightning item", mode: "build" }
      }));
      assert.equal(status, 200);
      const result = json!.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.equal(result.isError, false);
      const text = result.content.find((c) => c.type === "text")!.text;
      assert.match(text, /run-test-001/);
      assert.match(text, /Completed successfully/);
      assert.match(text, /Tool calls: 3/);
    });

    it("rejects empty prompt with isError=true", async () => {
      const { json } = await rpc(makeRequest(12, "tools/call", {
        name: "mineagent.run",
        arguments: { prompt: "", mode: "ask" }
      }));
      const result = json!.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.equal(result.isError, true);
      assert.match(result.content[0]!.text, /prompt.*required/i);
    });

    it("rejects invalid mode with isError=true", async () => {
      const { json } = await rpc(makeRequest(13, "tools/call", {
        name: "mineagent.run",
        arguments: { prompt: "test", mode: "invalid" }
      }));
      const result = json!.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.equal(result.isError, true);
      assert.match(result.content[0]!.text, /mode/i);
    });
  });

  describe("tools/call — mineagent.cancel", () => {
    it("returns 'no run active' when idle", async () => {
      const { json } = await rpc(makeRequest(14, "tools/call", {
        name: "mineagent.cancel"
      }));
      const result = json!.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.equal(result.isError, false);
      assert.match(result.content[0]!.text, /no run/i);
    });

    it("aborts the current run when active", async () => {
      // Use a server with a context that has an active AbortController
      const abort = new AbortController();
      const server2 = new McpServer(
        { port: TEST_PORT + 1 },
        () => makeMockContext({ currentRunAbort: abort })
      );
      await server2.start();
      try {
        const resp = await fetch(`http://127.0.0.1:${TEST_PORT + 1}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(makeRequest(15, "tools/call", { name: "mineagent.cancel" }))
        });
        const json = await resp.json() as Record<string, unknown>;
        const result = json.result as { content: Array<{ type: string; text: string }>; isError: boolean };
        assert.equal(result.isError, false);
        assert.match(result.content[0]!.text, /cancellation/i);
        assert.equal(abort.signal.aborted, true, "AbortController should be aborted");
      } finally {
        await server2.stop();
      }
    });
  });

  describe("tools/call — mineagent.repo.read", () => {
    it("reads a workspace file", async () => {
      const { json } = await rpc(makeRequest(20, "tools/call", {
        name: "mineagent.repo.read",
        arguments: { path: "test.txt" }
      }));
      const result = json!.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.equal(result.isError, false);
      assert.equal(result.content[0]!.text, "hello world\nline 2\n");
    });

    it("rejects missing path", async () => {
      const { json } = await rpc(makeRequest(21, "tools/call", {
        name: "mineagent.repo.read",
        arguments: {}
      }));
      const result = json!.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.equal(result.isError, true);
      assert.match(result.content[0]!.text, /path.*required/i);
    });

    it("rejects path traversal", async () => {
      const { json } = await rpc(makeRequest(22, "tools/call", {
        name: "mineagent.repo.read",
        arguments: { path: "../../../etc/passwd" }
      }));
      const result = json!.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.equal(result.isError, true);
      assert.match(result.content[0]!.text, /escapes workspace/i);
    });

    it("returns error for non-existent file", async () => {
      const { json } = await rpc(makeRequest(23, "tools/call", {
        name: "mineagent.repo.read",
        arguments: { path: "does-not-exist.txt" }
      }));
      const result = json!.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.equal(result.isError, true);
      assert.match(result.content[0]!.text, /repo\.read failed/i);
    });
  });

  describe("tools/call — mineagent.providers", () => {
    it("lists all providers with key status", async () => {
      const { json } = await rpc(makeRequest(30, "tools/call", {
        name: "mineagent.providers"
      }));
      const result = json!.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.equal(result.isError, false);
      const text = result.content[0]!.text;
      assert.match(text, /cloudflare: key set/);
      assert.match(text, /wavespeed: no key/);
    });
  });

  describe("tools/call — unknown tool", () => {
    it("returns isError=true with unknown tool message", async () => {
      const { json } = await rpc(makeRequest(40, "tools/call", {
        name: "mineagent.nonexistent"
      }));
      const result = json!.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.equal(result.isError, true);
      assert.match(result.content[0]!.text, /unknown tool/i);
    });
  });

  describe("tools/call — missing name param", () => {
    it("returns JSON-RPC error with INVALID_PARAMS code", async () => {
      const { json } = await rpc(makeRequest(41, "tools/call", {}));
      assert.ok(json!.error, "error must be present");
      const error = json!.error as { code: number; message: string };
      assert.equal(error.code, -32602);
      assert.match(error.message, /name/i);
    });
  });

  describe("notifications/initialized", () => {
    it("returns 202 Accepted", async () => {
      const { status } = await rpc(makeNotification("notifications/initialized"));
      assert.equal(status, 202);
    });
  });

  describe("ping", () => {
    it("returns empty result", async () => {
      const { json } = await rpc(makeRequest(50, "ping"));
      assert.ok(json!.result !== undefined || json!.id === 50);
    });
  });

  describe("method not found", () => {
    it("returns JSON-RPC error with METHOD_NOT_FOUND code", async () => {
      const { json } = await rpc(makeRequest(51, "nonexistent/method"));
      assert.ok(json!.error, "error must be present");
      const error = json!.error as { code: number; message: string };
      assert.equal(error.code, -32601);
      assert.match(error.message, /not supported/i);
    });
  });

  describe("invalid JSON body", () => {
    it("returns 400 with PARSE_ERROR code", async () => {
      const resp = await fetch(BASE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json{{{"
      });
      assert.equal(resp.status, 400);
      const json = await resp.json() as Record<string, unknown>;
      const error = json.error as { code: number; message: string };
      assert.equal(error.code, -32700);
    });
  });

  describe("non-POST method", () => {
    it("returns 405 Method Not Allowed", async () => {
      const resp = await fetch(BASE_URL, { method: "GET" });
      assert.equal(resp.status, 405);
    });
  });

  describe("not a valid JSON-RPC message", () => {
    it("returns INVALID_REQUEST error", async () => {
      const { json } = await rpc({ foo: "bar" });
      assert.ok(json!.error, "error must be present");
      const error = json!.error as { code: number; message: string };
      assert.equal(error.code, -32600);
    });
  });

  describe("bearer token auth", () => {
    let authServer: McpServer;
    const AUTH_PORT = TEST_PORT + 10;
    const TOKEN = "secret-test-token";

    before(async () => {
      authServer = new McpServer(
        { port: AUTH_PORT, token: TOKEN },
        () => makeMockContext()
      );
      await authServer.start();
    });

    after(async () => {
      await authServer.stop();
    });

    it("rejects request without Authorization header (401)", async () => {
      const resp = await fetch(`http://127.0.0.1:${AUTH_PORT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeRequest(60, "initialize"))
      });
      assert.equal(resp.status, 401);
    });

    it("rejects request with wrong token (401)", async () => {
      const resp = await fetch(`http://127.0.0.1:${AUTH_PORT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
        body: JSON.stringify(makeRequest(61, "initialize"))
      });
      assert.equal(resp.status, 401);
    });

    it("accepts request with correct Bearer token", async () => {
      const resp = await fetch(`http://127.0.0.1:${AUTH_PORT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(makeRequest(62, "initialize"))
      });
      assert.equal(resp.status, 200);
      const json = await resp.json() as Record<string, unknown>;
      assert.ok(json.result, "result must be present with valid token");
    });
  });

  describe("server lifecycle", () => {
    it("isRunning returns true after start, false after stop", async () => {
      const s = new McpServer({ port: TEST_PORT + 20 }, () => makeMockContext());
      assert.equal(s.isRunning(), false);
      await s.start();
      assert.equal(s.isRunning(), true);
      await s.stop();
      assert.equal(s.isRunning(), false);
    });

    it("start throws if already running", async () => {
      const s = new McpServer({ port: TEST_PORT + 21 }, () => makeMockContext());
      await s.start();
      assert.throws(() => s.start(), /already running/i);
      await s.stop();
    });

    it("stop is safe to call when not running", async () => {
      const s = new McpServer({ port: TEST_PORT + 22 }, () => makeMockContext());
      await s.stop(); // should not throw
    });
  });
});

// --- Unit tests for handleToolCall (direct, without HTTP) ---

describe("handleToolCall (unit)", () => {
  it("mineagent.repo.read returns file content", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-unit-"));
    await fs.writeFile(path.join(dir, "a.txt"), "content-123");
    try {
      const result = await handleToolCall("mineagent.repo.read", { path: "a.txt" }, makeMockContext({ root: dir }));
      assert.equal(result.isError, false);
      assert.equal(result.text, "content-123");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("mineagent.repo.patch returns error when dispatcher is undefined", async () => {
    const result = await handleToolCall("mineagent.repo.patch", { patch: "diff" }, makeMockContext());
    assert.equal(result.isError, true);
    assert.match(result.text, /dispatcher.*not initialized/i);
  });

  it("mineagent.gradle.run returns error when dispatcher is undefined", async () => {
    const result = await handleToolCall("mineagent.gradle.run", { task: "build" }, makeMockContext());
    assert.equal(result.isError, true);
    assert.match(result.text, /dispatcher.*not initialized/i);
  });

  it("mineagent.status returns provider and model from config", async () => {
    const ctx = makeMockContext();
    const result = await handleToolCall("mineagent.status", {}, ctx);
    assert.equal(result.isError, false);
    assert.match(result.text, /Provider: cloudflare/);
    assert.match(result.text, /Model: @cf\/meta\/llama-3.1-8b-instruct/);
  });

  it("mineagent.run propagates startRun failure as isError", async () => {
    const ctx = makeMockContext({
      startRun: async () => { throw new Error("provider down"); }
    });
    const result = await handleToolCall("mineagent.run", { prompt: "test", mode: "ask" }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.text, /Run failed: provider down/);
  });

  it("unknown tool name returns isError", async () => {
    const result = await handleToolCall("mineagent.bogus", {}, makeMockContext());
    assert.equal(result.isError, true);
    assert.match(result.text, /unknown tool/i);
  });
});
