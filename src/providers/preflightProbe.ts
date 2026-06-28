import type { ProviderAdapter, ProviderModel, ModelCapabilities } from "./ProviderAdapter";

// Фаза 1 (P1.4): Preflight-проба.
// Каталог /models у провайдеров «врёт»: qwen3-coder-next-fp8 есть в списке, но
// при вызове даёт 400 "no registered providers"; glm-5.2-fp8 на vision молча
// отдаёт пустой content. Проба делает крошечный реальный запрос к модели и
// кэширует РЕАЛЬНЫЕ возможности (жива ли вообще; отвечает ли непустым текстом).
// Результат используется как фильтр поверх listModels().

export interface ProbeResult {
  modelId: string;
  // Ответила ли модель вообще (без сетевой/билинг-ошибки).
  alive: boolean;
  // Вернула ли непустой content на тривиальный запрос (ловит «молчунов» вроде
  // glm на vision / qwen без backend-провайдера).
  respondsText: boolean;
  // Сообщение об ошибке, если alive=false (для UI/диагностики).
  error?: string;
  checkedAt: string;
}

// TTL кэша пробы. Возможности модели у провайдера меняются редко — час разумно.
const PROBE_TTL_MS = 60 * 60 * 1000;

export class PreflightProbe {
  private readonly cache = new Map<string, ProbeResult>();

  public constructor(private readonly ttlMs: number = PROBE_TTL_MS) {}

  // Возвращает кэш, если он свежий; иначе undefined.
  public cached(modelId: string): ProbeResult | undefined {
    const hit = this.cache.get(modelId);
    if (!hit) {
      return undefined;
    }
    const age = Date.now() - new Date(hit.checkedAt).getTime();
    return age <= this.ttlMs ? hit : undefined;
  }

  // Делает крошечный запрос к модели и кэширует результат. Никогда не бросает —
  // ошибки превращаются в alive:false (проба не должна валить основной flow).
  public async probe(
    provider: ProviderAdapter,
    modelId: string,
    signal?: AbortSignal
  ): Promise<ProbeResult> {
    const fresh = this.cached(modelId);
    if (fresh) {
      return fresh;
    }
    let result: ProbeResult;
    try {
      const response = await provider.chat({
        model: modelId,
        // Минимальный запрос: одно слово ответа. maxTokens крошечный — дёшево.
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 8,
        temperature: 0,
        signal
      });
      result = {
        modelId,
        alive: true,
        respondsText: Boolean(response.content && response.content.trim()),
        checkedAt: new Date().toISOString()
      };
    } catch (error) {
      result = {
        modelId,
        alive: false,
        respondsText: false,
        error: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString()
      };
    }
    this.cache.set(modelId, result);
    return result;
  }

  // Помечает модель как «битую» в её capabilities (deprecated:true) — UI может
  // показать это и не предлагать модель по умолчанию. Не мутирует исходный
  // массив, возвращает копию.
  public annotate(models: ProviderModel[]): ProviderModel[] {
    return models.map((model) => {
      const probe = this.cached(model.id);
      if (!probe || (probe.alive && probe.respondsText)) {
        return model;
      }
      const caps: ModelCapabilities = { ...model.capabilities, deprecated: true };
      return { ...model, capabilities: caps };
    });
  }

  public invalidate(modelId?: string): void {
    if (modelId) {
      this.cache.delete(modelId);
    } else {
      this.cache.clear();
    }
  }
}