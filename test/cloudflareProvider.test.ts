import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CloudflareProvider } from "../src/providers/cloudflareProvider";

describe("CloudflareProvider", () => {
  it("uses the Cloudflare OpenAI-compatible chat completions URL", async () => {
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input, init) => {
        assert.equal(String(input), "https://api.cloudflare.com/client/v4/accounts/test-account/ai/v1/chat/completions");
        assert.equal(init?.method, "POST");
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, "@cf/moonshotai/kimi-k2.7-code");
        return new Response(JSON.stringify({
          id: "chatcmpl-test",
          model: body.model,
          choices: [
            {
              message: {
                content: "ok"
              }
            }
          ]
        }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      };

      const provider = new CloudflareProvider("token", "test-account");
      const response = await provider.chat({
        model: "@cf/moonshotai/kimi-k2.7-code",
        messages: [
          {
            role: "user",
            content: "test"
          }
        ]
      });

      assert.equal(response.content, "ok");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("loads models from the Cloudflare model search endpoint", async () => {
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input) => {
        const url = String(input);
        assert.match(url, /\/accounts\/test-account\/ai\/models\/search$/);
        return new Response(JSON.stringify({
          result: [
            {
              id: "@cf/moonshotai/kimi-k2.7-code",
              label: "Kimi K2.7 Code",
              context_window: 262144,
              capabilities: ["function calling", "reasoning", "vision"]
            }
          ]
        }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      };

      const provider = new CloudflareProvider("token", "test-account");
      const models = await provider.listModels();

      assert.equal(models[0]?.id, "@cf/moonshotai/kimi-k2.7-code");
      assert.equal(models[0]?.provider, "cloudflare");
      assert.equal(models[0]?.capabilities.contextWindow, 262144);
      assert.equal(models[0]?.capabilities.tools, true);
      assert.equal(models[0]?.capabilities.reasoning, true);
      assert.equal(models[0]?.capabilities.vision, true);
      assert.ok(models.some((model) => model.id === "@cf/qwen/qwen2.5-coder-32b-instruct"));
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("reads OpenAI-compatible content arrays returned by Cloudflare", async () => {
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response(JSON.stringify({
        model: "@cf/moonshotai/kimi-k2.7-code",
        choices: [
          {
            message: {
              content: [
                { type: "text", text: "array " },
                { type: "text", text: "content" }
              ]
            }
          }
        ]
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      });

      const provider = new CloudflareProvider("token", "test-account");
      const response = await provider.chat({
        model: "@cf/moonshotai/kimi-k2.7-code",
        messages: [{ role: "user", content: "test" }]
      });

      assert.equal(response.content, "array content");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("reads Cloudflare native result response bodies", async () => {
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response(JSON.stringify({
        success: true,
        result: {
          response: "native response"
        }
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      });

      const provider = new CloudflareProvider("token", "test-account");
      const response = await provider.chat({
        model: "@cf/moonshotai/kimi-k2.7-code",
        messages: [{ role: "user", content: "test" }]
      });

      assert.equal(response.content, "native response");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("normalizes nested Cloudflare model search results", async () => {
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response(JSON.stringify({
        result: {
          data: [
            {
              models: [
                {
                  model_id: "@cf/test/nested-coder",
                  displayName: "Nested Coder",
                  contextLength: 64000,
                  tags: ["tools", "reasoning"]
                }
              ]
            }
          ]
        }
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      });

      const provider = new CloudflareProvider("token", "test-account");
      const models = await provider.listModels();

      const nested = models.find((model) => model.id === "@cf/test/nested-coder");
      assert.equal(nested?.label, "Nested Coder");
      assert.equal(nested?.capabilities.contextWindow, 64000);
      assert.ok(models.some((model) => model.id === "@cf/moonshotai/kimi-k2.7-code"));
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("parses real Cloudflare API response (id in `name`, task field, filters non-text)", async () => {
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        assert.match(url, /\/ai\/models\/search$/);
        // Реальный формат Cloudflare: GET, идентификатор модели в `name`,
        // тип задачи в `task`. Разные пути ответа: result.models или result[].
        assert.equal(init?.method, "GET");
        return new Response(JSON.stringify({
          result: {
            models: [
              {
                name: "@cf/qwen/qwen2.5-coder-32b-instruct",
                description: "Qwen coder",
                task: "Text Generation"
              },
              {
                name: "@cf/stabilityai/stable-diffusion-xl-base-1.0",
                description: "Image gen",
                task: "text-to-image"
              },
              {
                name: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
                description: "Llama",
                task: "text-generation"
              }
            ]
          }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      };

      const provider = new CloudflareProvider("token", "test-account");
      const models = await provider.listModels();

      const ids = models.map((m) => m.id);
      // Текстовые модели включены.
      assert.ok(ids.includes("@cf/qwen/qwen2.5-coder-32b-instruct"), "Qwen coder должен быть в списке");
      assert.ok(ids.includes("@cf/meta/llama-3.3-70b-instruct-fp8-fast"), "Llama должен быть в списке");
      // Image generation НЕ отсеивается, а помечается apiType=image (для раздела «Изображения»).
      const sd = models.find((m) => m.id === "@cf/stabilityai/stable-diffusion-xl-base-1.0");
      assert.ok(sd, "Stable Diffusion должен попасть в каталог как image-модель");
      assert.equal(sd?.apiType, "image", "Stable Diffusion должен иметь apiType=image");
      // Текстовые модели помечаются apiType=text.
      const qwen = models.find((m) => m.id === "@cf/qwen/qwen2.5-coder-32b-instruct");
      assert.equal(qwen?.apiType, "text", "Qwen coder должен иметь apiType=text");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("falls back to the bundled catalog when Cloudflare model search returns an empty body", async () => {
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response("", {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      });

      const provider = new CloudflareProvider("token", "test-account");
      const models = await provider.listModels();

      assert.ok(models.some((model) => model.id === "@cf/moonshotai/kimi-k2.7-code"));
      assert.ok(models.some((model) => model.id === "@cf/qwen/qwen2.5-coder-32b-instruct"));
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
