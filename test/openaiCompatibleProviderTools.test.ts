import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider, ProviderRequestError } from "../src/providers/openaiCompatibleProvider";

// Провайдер с голым OpenAI-compat URL (без обёртки Cloudflare) — тестируем
// парсер tool_calls напрямую. Это Этап 2: провайдер должен уметь разбирать
// оба варианта shape (OpenAI и Cloudflare-native), см. docs/source-ledger.md.
function makeProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: "custom",
    displayName: "Test Provider",
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
    defaultModels: [],
    chatEndpoint: "/chat/completions",
    modelsEndpoint: "/models"
  });
}

function mockFetchOnce(body: unknown): {
  restore: () => void;
  receivedBody: () => unknown;
} {
  const previous = globalThis.fetch;
  let received: unknown;
  globalThis.fetch = (async (_input, init) => {
    received = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = previous;
    },
    receivedBody: () => received
  };
}

describe("OpenAICompatibleProvider — tool_calls парсинг", () => {
  it("treats Kimchi 410 deprecated model responses as model-unavailable with replacement", () => {
    const error = new ProviderRequestError(
      "Custom OpenAI-Compatible",
      410,
      'Model "kimi-k2.5" is no longer available. Use "kimi-k2.6" instead.'
    );

    assert.equal(error.isModelNotFound(), true);
    assert.equal(error.suggestedReplacementModel(), "kimi-k2.6");
  });

  it("парсит OpenAI-shape tool_calls (arguments = JSON-строка)", async () => {
    const mock = mockFetchOnce({
      id: "chatcmpl-1",
      model: "m",
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: {
                  name: "repo.read",
                  arguments: "{\"path\":\"README.md\"}"
                }
              }
            ]
          }
        }
      ]
    });
    try {
      const provider = makeProvider();
      const response = await provider.chat({
        model: "m",
        messages: [{ role: "user", content: "x" }]
      });
      assert.equal(response.toolCalls?.length, 1);
      assert.equal(response.toolCalls?.[0]?.id, "call_abc");
      assert.equal(response.toolCalls?.[0]?.name, "repo.read");
      // arguments остаётся строкой — нормализация к объекту на стороне orchestrator.
      assert.deepEqual(JSON.parse(response.toolCalls![0]!.arguments), { path: "README.md" });
    } finally {
      mock.restore();
    }
  });

  it("парсит Cloudflare-native tool_calls (arguments = объект, плоский массив)", async () => {
    // Native REST-формат Cloudflare: response.tool_calls на верхнем уровне,
    // arguments приходит объектом. См. docs/source-ledger.md entry-1.
    const mock = mockFetchOnce({
      success: true,
      tool_calls: [
        {
          name: "gradle.run",
          arguments: { task: "build" }
        }
      ]
    });
    try {
      const provider = makeProvider();
      const response = await provider.chat({
        model: "m",
        messages: [{ role: "user", content: "x" }]
      });
      assert.equal(response.toolCalls?.length, 1);
      assert.equal(response.toolCalls?.[0]?.name, "gradle.run");
      // arguments-объект нормализован в JSON-строку.
      assert.deepEqual(JSON.parse(response.toolCalls![0]!.arguments), { task: "build" });
      // id синтезируется, если провайдер не вернул (Cloudflare native не шлёт id).
      assert.match(response.toolCalls![0]!.id, /^call_/);
    } finally {
      mock.restore();
    }
  });

  it("tool_call ответ с пустым content НЕ считается пустым ответом", async () => {
    const mock = mockFetchOnce({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              { id: "c1", type: "function", function: { name: "repo.read", arguments: "{\"path\":\"a\"}" } }
            ]
          }
        }
      ]
    });
    try {
      const provider = makeProvider();
      const response = await provider.chat({
        model: "m",
        messages: [{ role: "user", content: "x" }]
      });
      // content пустой, но toolCalls есть — orchestrator трактует как валидный
      // tool-call шаг, а НЕ как empty-response fallback.
      assert.equal(response.content, "");
      assert.equal(response.toolCalls?.length, 1);
    } finally {
      mock.restore();
    }
  });

  it("ответ без tool_calls → toolCalls undefined (обратная совместимость)", async () => {
    const mock = mockFetchOnce({
      choices: [{ message: { content: "просто текст" } }]
    });
    try {
      const provider = makeProvider();
      const response = await provider.chat({
        model: "m",
        messages: [{ role: "user", content: "x" }]
      });
      assert.equal(response.content, "просто текст");
      assert.equal(response.toolCalls, undefined);
    } finally {
      mock.restore();
    }
  });

  it("wire-формат запроса: tools и tool_choice передаются в body", async () => {
    const mock = mockFetchOnce({ choices: [{ message: { content: "ok" } }] });
    try {
      const provider = makeProvider();
      await provider.chat({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        tools: [
          {
            type: "function",
            function: {
              name: "repo.read",
              description: "read",
              parameters: { type: "object", properties: { path: { type: "string" } } }
            }
          }
        ],
        tool_choice: "auto"
      });
      const body = mock.receivedBody() as { tools?: unknown[]; tool_choice?: string };
      assert.equal(body.tools?.length, 1);
      assert.equal(body.tool_choice, "auto");
    } finally {
      mock.restore();
    }
  });
});
