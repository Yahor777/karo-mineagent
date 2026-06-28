import type { EmbeddingRequest, EmbeddingResponse } from "./ProviderAdapter";

// Фаза 2 (P2.2): Локальные оффлайн-embeddings.
// Снимает зависимость RAG от провайдера (у kimchi embeddings НЕТ — semantic
// ranking в KnowledgeBaseService без них отключается и падает до top-K по дате).
// Модель bge-m3 (multilingual — важно для русского) гоняется локально через
// @xenova/transformers (transformers.js, ONNX-бэкенд, без сети после первой
// загрузки весов). Лёгкая зависимость, lazy-load модели при первом вызове.
//
// ВАЖНО: @xenova/transformers — runtime-зависимость расширения (добавить в
// package.json dependencies). Импорт динамический, чтобы не платить за загрузку
// модуля, если локальные embeddings не используются.

const DEFAULT_LOCAL_MODEL = "Xenova/bge-m3";

export interface LocalEmbeddingOptions {
  // HF-id модели для transformers.js. Дефолт — bge-m3 (multilingual).
  model?: string;
  // Кэш-директория весов (по умолчанию — кэш transformers.js).
  cacheDir?: string;
}

export class LocalEmbeddingProvider {
  public readonly id = "local-embedding" as const;
  public readonly displayName = "Local embeddings (bge-m3)";

  // Ленивая инициализация пайплайна (загружается один раз).
  private extractor: unknown;
  private readonly model: string;

  public constructor(private readonly options: LocalEmbeddingOptions = {}) {
    this.model = options.model?.trim() || DEFAULT_LOCAL_MODEL;
  }

  // Реализует тот же контракт, что ProviderAdapter.embeddings — так
  // EmbeddingService может работать поверх локального провайдера без изменений.
  public async embeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const extractor = await this.ensureExtractor();
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    const data: Array<{ embedding: number[]; index: number }> = [];
    for (let i = 0; i < inputs.length; i += 1) {
      // mean-pooling + normalize — стандарт для bge-моделей (cosine-ready).
      const output = await (extractor as (
        text: string,
        opts: { pooling: string; normalize: boolean }
      ) => Promise<{ data: Float32Array | number[] }>)(inputs[i]!, {
        pooling: "mean",
        normalize: true
      });
      data.push({ embedding: Array.from(output.data as ArrayLike<number>), index: i });
    }
    return { model: this.model, data };
  }

  private async ensureExtractor(): Promise<unknown> {
    if (this.extractor) {
      return this.extractor;
    }
    // Динамический импорт: пакет грузится только когда реально нужен.
    // Спецификатор собирается косвенно, чтобы tsc не пытался резолвить
    // опциональную runtime-зависимость @xenova/transformers на этапе сборки
    // (она может быть не установлена, если локальные embeddings не нужны).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const specifier = ["@xenova", "transformers"].join("/");
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const dynamicImport = new Function("s", "return import(s);") as (
      s: string
    ) => Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transformers: any = await dynamicImport(specifier);
    if (this.options.cacheDir) {
      transformers.env.cacheDir = this.options.cacheDir;
    }
    // Полностью оффлайн после первой загрузки весов.
    transformers.env.allowRemoteModels = true;
    this.extractor = await transformers.pipeline("feature-extraction", this.model);
    return this.extractor;
  }
}