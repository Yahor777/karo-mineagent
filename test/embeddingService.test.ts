import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EmbeddingService } from "../src/providers/embeddingService";
import type { ChatRequest, ChatResponse, EmbeddingRequest, EmbeddingResponse, ProviderAdapter, ProviderModel, StreamChunk } from "../src/providers/ProviderAdapter";

// Этап 6: тесты EmbeddingService — косинусное сходство, ranking, batch.

class ScriptedEmbeddingProvider implements ProviderAdapter {
  public readonly id = "cloudflare";
  public readonly displayName = "Cloudflare";
  public embeddingRequests: EmbeddingRequest[] = [];
  public queue: number[][] = [];

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    return { model: request.model, content: "ok" };
  }

  public async *streamChat(request: ChatRequest): AsyncIterable<StreamChunk> {
    yield { contentDelta: "ok" };
  }

  public async listModels(): Promise<ProviderModel[]> {
    return [{
      id: "@cf/baai/bge-m3",
      label: "bge-m3",
      provider: "cloudflare",
      capabilities: { vision: false, tools: false, jsonMode: false, speed: "fast" }
    }];
  }

  public async validateKey(): Promise<boolean> {
    return true;
  }

  public async embeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    this.embeddingRequests.push(request);
    const next = this.queue.shift() ?? [1, 0, 0];
    return {
      model: request.model,
      data: [{ embedding: next, index: 0 }]
    };
  }
}

describe("EmbeddingService (Этап 6)", () => {
  describe("cosineSimilarity", () => {
    it("1 для идентичных векторов", () => {
      const a = [1, 2, 3];
      assert.equal(EmbeddingService.cosineSimilarity(a, a), 1);
    });

    it("0 для ортогональных векторов", () => {
      assert.equal(EmbeddingService.cosineSimilarity([1, 0], [0, 1]), 0);
    });

    it("0 для разных размерностей", () => {
      assert.equal(EmbeddingService.cosineSimilarity([1, 2], [1, 2, 3]), 0);
    });

    it("0 для нулевых векторов", () => {
      assert.equal(EmbeddingService.cosineSimilarity([0, 0], [0, 0]), 0);
    });
  });

  describe("rankBySimilarity", () => {
    it("возвращает top-K по убыванию сходства", () => {
      const query = [1, 0];
      const candidates = [
        [0.9, 0.1], // ~0.99
        [0, 1],     // 0
        [0.5, 0.5]  // ~0.7
      ];
      const ranked = EmbeddingService.rankBySimilarity(query, candidates, 2);
      assert.equal(ranked.length, 2);
      assert.equal(ranked[0].index, 0); // самый похожий
      assert.equal(ranked[1].index, 2); // второй по сходству
      assert.ok(ranked[0].score > ranked[1].score);
    });

    it("возвращает меньше чем topK если candidates меньше", () => {
      const ranked = EmbeddingService.rankBySimilarity([1], [[1]], 5);
      assert.equal(ranked.length, 1);
    });
  });

  describe("embed", () => {
    it("вызывает провайдера с правильной моделью", async () => {
      const provider = new ScriptedEmbeddingProvider();
      provider.queue = [[1, 2, 3]];
      const service = new EmbeddingService({ provider });
      const embedding = await service.embed("текст");
      assert.deepEqual(embedding, [1, 2, 3]);
      assert.equal(provider.embeddingRequests[0]!.model, "@cf/baai/bge-m3");
      assert.equal(provider.embeddingRequests[0]!.input, "текст");
    });

    it("использует кастомную модель из options", async () => {
      const provider = new ScriptedEmbeddingProvider();
      provider.queue = [[1]];
      const service = new EmbeddingService({ provider, embeddingModel: "@cf/custom-embed" });
      await service.embed("x");
      assert.equal(provider.embeddingRequests[0]!.model, "@cf/custom-embed");
    });

    it("throw если провайдер вернул пустой embedding", async () => {
      const provider = new ScriptedEmbeddingProvider();
      provider.queue = [];
      // Подменяем ответ — пустой data
      provider.embeddings = async () => ({ model: "x", data: [] });
      const service = new EmbeddingService({ provider });
      await assert.rejects(() => service.embed("x"), /пустой embedding/);
    });
  });
});
