import type { EmbeddingRequest, EmbeddingResponse } from "./ProviderAdapter";

// Фаза 2 (P2.2): минимальный структурный контракт источника embeddings.
// Ему удовлетворяет и полноценный ProviderAdapter (embeddings опционально),
// и LocalEmbeddingProvider — без реализации chat/listModels/validateKey.
export interface EmbeddingCapableProvider {
  embeddings?(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}

// Этап 6: EmbeddingService — обёртка над провайдером для embeddings.
// Используется Knowledge Base (retrieval) и Skills (matching).
//
// Cloudflare Workers AI: /v1/embeddings endpoint (entry-16 source-ledger).
// Модель по умолчанию — @cf/baai/bge-m3 (multilingual — важно для русского
// проекта). Пользователь может переключить через config.agent.embeddingModel.
//
// Косинусное сходство (cosine similarity) для ranking top-K записей/скиллов.

export interface EmbeddingServiceOptions {
  provider: EmbeddingCapableProvider;
  // Модель embeddings (из config.agent.embeddingModel). Пусто = дефолт bge-m3.
  embeddingModel?: string;
}

const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-m3";

export class EmbeddingService {
  public constructor(private readonly options: EmbeddingServiceOptions) {}

  // Возвращает embedding для одного текста.
  public async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const model = this.resolveModel();
    const request: EmbeddingRequest = { model, input: text, signal };
    const response = await this.options.provider.embeddings!(request);
    if (!response.data.length) {
      throw new Error(`EmbeddingService: провайдер вернул пустой embedding для модели ${model}.`);
    }
    return response.data[0]!.embedding;
  }

  // Возвращает embeddings для массива текстов (batch).
  public async embedBatch(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (!texts.length) {
      return [];
    }
    const model = this.resolveModel();
    const request: EmbeddingRequest = { model, input: texts, signal };
    const response = await this.options.provider.embeddings!(request);
    return response.data
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((item) => item.embedding);
  }

  // Косинусное сходство двух векторов. 1 = идентичны, 0 = ортогональны.
  public static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      return 0;
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  // Ranking: возвращает top-K индексов из candidates по убыванию сходства.
  public static rankBySimilarity(query: number[], candidates: number[][], topK: number): Array<{ index: number; score: number }> {
    const scored = candidates.map((candidate, index) => ({
      index,
      score: EmbeddingService.cosineSimilarity(query, candidate)
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  private resolveModel(): string {
    return this.options.embeddingModel?.trim() || DEFAULT_EMBEDDING_MODEL;
  }
}
