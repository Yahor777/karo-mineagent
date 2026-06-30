import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PreflightProbe } from "../src/providers/preflightProbe";
import type { ProviderAdapter, ChatResponse, ChatRequest, ProviderModel, TokenCount } from "../src/providers/ProviderAdapter";

class MockProvider implements ProviderAdapter {
  public readonly id = "custom" as const;
  public readonly displayName = "Mock Provider";
  public shouldFail = false;
  public emptyResponse = false;
  public chatCalls = 0;

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    this.chatCalls++;
    if (this.shouldFail) {
      throw new Error("API Connection Failed");
    }
    return {
      id: "msg-123",
      model: request.model,
      content: this.emptyResponse ? "   " : "pong",
      raw: {}
    };
  }

  public async *streamChat(request: ChatRequest) {
    yield { contentDelta: "pong", raw: {} };
  }

  public async listModels() {
    return [];
  }

  public async countTokens(request: ChatRequest): Promise<TokenCount> {
    return { inputTokens: 1, estimated: true };
  }

  public async validateKey() {
    return true;
  }
}

describe("PreflightProbe", () => {
  it("успешно выполняет пробу и кэширует результат", async () => {
    const probe = new PreflightProbe(1000);
    const provider = new MockProvider();

    const result = await probe.probe(provider, "test-model");
    assert.equal(result.modelId, "test-model");
    assert.equal(result.alive, true);
    assert.equal(result.respondsText, true);
    assert.equal(provider.chatCalls, 1);

    // Повторный вызов должен идти из кэша
    const cachedResult = await probe.probe(provider, "test-model");
    assert.equal(cachedResult.alive, true);
    assert.equal(provider.chatCalls, 1); // счетчик вызовов не изменился
  });

  it("обрабатывает сбойные вызовы и сохраняет ошибку", async () => {
    const probe = new PreflightProbe(1000);
    const provider = new MockProvider();
    provider.shouldFail = true;

    const result = await probe.probe(provider, "failing-model");
    assert.equal(result.alive, false);
    assert.equal(result.respondsText, false);
    assert.ok(result.error?.includes("API Connection Failed"));
  });

  it("помечает пустые текстовые ответы как respondsText: false", async () => {
    const probe = new PreflightProbe(1000);
    const provider = new MockProvider();
    provider.emptyResponse = true;

    const result = await probe.probe(provider, "empty-model");
    assert.equal(result.alive, true);
    assert.equal(result.respondsText, false);
  });

  it("кэш сбрасывается по TTL", async () => {
    const probe = new PreflightProbe(10); // TTL 10ms
    const provider = new MockProvider();

    await probe.probe(provider, "temp-model");
    assert.equal(provider.chatCalls, 1);

    await new Promise((resolve) => setTimeout(resolve, 20));

    await probe.probe(provider, "temp-model");
    assert.equal(provider.chatCalls, 2); // запрос ушел заново
  });

  it("размечает битые модели как deprecated", async () => {
    const probe = new PreflightProbe(1000);
    const provider = new MockProvider();
    provider.shouldFail = true;

    // Сначала пробиваем модель
    await probe.probe(provider, "broken-model");

    const models: ProviderModel[] = [
      {
        id: "broken-model",
        label: "Broken Model",
        provider: "custom",
        capabilities: { contextWindow: 100, vision: false, tools: false, jsonMode: false }
      },
      {
        id: "healthy-model",
        label: "Healthy Model",
        provider: "custom",
        capabilities: { contextWindow: 100, vision: false, tools: false, jsonMode: false }
      }
    ];

    const annotated = probe.annotate(models);
    assert.equal(annotated[0].capabilities.deprecated, true);
    assert.equal(annotated[1].capabilities.deprecated, undefined);
  });
});
