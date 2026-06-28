import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BlockbenchMcpClient, McpRequestError } from "../src/mcp/mcpClient";

// Минимальный fake Response (обход типов DOM). Удобнее, чем тянуть node:undici.
interface FakeResp {
  status: number;
  statusText: string;
  body: string;
  contentType: string;
  sessionId?: string;
}

function makeFetch(responder: (body: Record<string, unknown>) => FakeResp, capture?: (headers: Record<string, string>, body: Record<string, unknown>) => void): typeof fetch {
  return (async (input: any, init?: any) => {
    const bodyRaw: Record<string, unknown> = init?.body ? JSON.parse(String(init.body)) : {};
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers)) {
        headers[k.toLowerCase()] = String(v);
      }
    }
    capture?.(headers, bodyRaw);
    const resp = responder(bodyRaw);
    const headerMap = new Map<string, string>([
      ["content-type", resp.contentType]
    ]);
    if (resp.sessionId) {
      headerMap.set("mcp-session-id", resp.sessionId);
    }
    // Эмуляция Response.headers.get (case-insensitive).
    const responseHeaders = {
      get(name: string) {
        return headerMap.get(name.toLowerCase()) ?? null;
      }
    };
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      statusText: resp.statusText,
      headers: responseHeaders,
      text: async () => resp.body
    } as unknown as Response;
  }) as typeof fetch;
}

function makeClient(fetchImpl: typeof fetch, opts?: { timeoutMs?: number }) {
  return new BlockbenchMcpClient({
    url: "http://localhost:3000/bb-mcp",
    timeoutMs: opts?.timeoutMs ?? 5_000,
    fetchImpl
  });
}

describe("BlockbenchMcpClient", () => {
  it("connect: initialize → notifications/initialized, фиксирует protocolVersion и sessionId", async () => {
    const requests: Array<{ headers: Record<string, string>; body: unknown }> = [];
    let call = 0;
    const fetch = makeFetch((body) => {
      call += 1;
      if (call === 1) {
        // initialize → ответ с sessionId в заголовке.
        assert.equal(body.method, "initialize");
        return {
          status: 200,
          statusText: "OK",
          contentType: "application/json",
          sessionId: "sess-123",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              serverInfo: { name: "blockbench-mcp", version: "1.6.0" }
            }
          })
        };
      }
      // Второй запрос — notifications/initialized (notification, без id).
      assert.equal(body.method, "notifications/initialized");
      return { status: 202, statusText: "Accepted", contentType: "application/json", body: "" };
    }, (headers, body) => requests.push({ headers, body }));

    const client = makeClient(fetch);
    const result = await client.connect();

    assert.equal(result.serverInfo.name, "blockbench-mcp");
    assert.equal(client.getStatus(), "connected");
    assert.equal(client.isConnected(), true);
    // SessionId должен прийти из заголовка первого ответа.
    assert.deepEqual(requests[1]?.headers["mcp-session-id"], "sess-123");
    assert.deepEqual(requests[1]?.headers["mcp-protocol-version"], "2025-11-25");
  });

  it("listTools: возвращает инструменты и кэширует (повторный вызов без запроса)", async () => {
    let calls = 0;
    const fetch = makeFetch((body) => {
      calls += 1;
      if (body.method === "initialize") {
        return {
          status: 200,
          statusText: "OK",
          contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "bb" } } })
        };
      }
      if (body.method === "notifications/initialized") {
        return { status: 202, statusText: "OK", contentType: "application/json", body: "" };
      }
      // tools/list
      return {
        status: 200,
        statusText: "OK",
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [{ name: "add_cube", description: "Add a cube", inputSchema: { type: "object" } }] }
        })
      };
    });
    const client = makeClient(fetch);
    await client.connect();
    calls = 0;
    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, "add_cube");
    // Второй вызов из кэша — новый запрос не нужен.
    const cached = await client.listTools();
    assert.equal(cached.length, 1);
    assert.equal(calls, 1, "повторный listTools должен идти из кэша");
    // refresh=true — новый запрос.
    calls = 0;
    await client.listTools(true);
    assert.equal(calls, 1, "refresh должен сделать новый запрос");
  });

  it("принимает SSE-ответ (text/event-stream) с одним data-событием", async () => {
    let call = 0;
    const fetch = makeFetch((body) => {
      call += 1;
      if (call === 1) {
        return {
          status: 200,
          statusText: "OK",
          contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "bb" } } })
        };
      }
      if (call === 2) {
        return { status: 202, statusText: "OK", contentType: "application/json", body: "" };
      }
      // tools/list → сервер отдаёт SSE-стрим.
      const payload = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "render", inputSchema: { type: "object" } }] } });
      return {
        status: 200,
        statusText: "OK",
        contentType: "text/event-stream",
        body: `event: message\ndata: ${payload}\n\n`
      };
    });
    const client = makeClient(fetch);
    await client.connect();
    const tools = await client.listTools();
    assert.equal(tools[0]?.name, "render");
  });

  it("callTool: isError=true → McpToolCallResult с isError (НЕ throw)", async () => {
    let call = 0;
    const fetch = makeFetch((body) => {
      call += 1;
      if (call === 1) {
        return { status: 200, statusText: "OK", contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "bb" } } }) };
      }
      if (call === 2) {
        return { status: 202, statusText: "OK", contentType: "application/json", body: "" };
      }
      return {
        status: 200,
        statusText: "OK",
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "bone not found" }], isError: true } })
      };
    });
    const client = makeClient(fetch);
    await client.connect();
    const result = await client.callTool({ name: "select_bone", arguments: { name: "nope" } });
    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.type, "text");
    const first = result.content[0];
    assert.equal(first && first.type === "text" ? first.text : "", "bone not found");
  });

  it("JSON-RPC ошибка (response.error) → McpRequestError", async () => {
    let call = 0;
    const fetch = makeFetch((body) => {
      call += 1;
      if (call === 1) {
        return { status: 200, statusText: "OK", contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "bb" } } }) };
      }
      if (call === 2) {
        return { status: 202, statusText: "OK", contentType: "application/json", body: "" };
      }
      return {
        status: 200,
        statusText: "OK",
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "Invalid params" } })
      };
    });
    const client = makeClient(fetch);
    await client.connect();
    await assert.rejects(() => client.callTool({ name: "x" }), (err: unknown) => {
      assert.ok(err instanceof McpRequestError, "должен быть McpRequestError");
      assert.equal((err as McpRequestError).rpcError.code, -32602);
      return true;
    });
  });

  it("таймаут: AbortController срабатывает по timeoutMs", async () => {
    // fetchImpl, который уважает signal: имитируем abort по таймауту клиента.
    const hanging: typeof fetch = (async (_input: any, init?: any) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("The operation was aborted");
          (e as Error & { name: string }).name = "AbortError";
          reject(e);
        });
      });
    }) as typeof fetch;
    const client = makeClient(hanging, { timeoutMs: 50 });
    await assert.rejects(() => client.connect(), /таймаут\/abort/);
    assert.equal(client.getStatus(), "error");
  });

  it("disconnect: best-effort DELETE, статус → disconnected", async () => {
    let deleted = false;
    const fetch = makeFetch((body) => {
      if (body.method === "initialize") {
        return { status: 200, statusText: "OK", contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "bb" } } }) };
      }
      if (body.method === "notifications/initialized") {
        return { status: 202, statusText: "OK", contentType: "application/json", body: "" };
      }
      return { status: 200, statusText: "OK", contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }) };
    });
    const deleteFetch: typeof fetch = (async (input: any, init?: any) => {
      if (init?.method === "DELETE") {
        deleted = true;
      }
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const client = new BlockbenchMcpClient({
      url: "http://localhost:3000/bb-mcp",
      timeoutMs: 5_000,
      fetchImpl: async (input: any, init?: any) => {
        return init?.method === "DELETE" ? deleteFetch(input, init) : fetch(input, init);
      }
    });
    await client.connect();
    await client.disconnect();
    assert.equal(deleted, true, "disconnect должен послать DELETE");
    assert.equal(client.getStatus(), "disconnected");
    assert.equal(client.isConnected(), false);
  });
});
