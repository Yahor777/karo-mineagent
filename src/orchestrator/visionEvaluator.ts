import type { ProviderAdapter, ProviderModel, ChatRequest, ContentBlock, ChatMessage } from "../providers/ProviderAdapter";
import { hasImageBlocks } from "../providers/ProviderAdapter";
import type { TokenBudgetService, ModelPricing } from "../providers/tokenBudget";

// Этап 5: VisionEvaluator — оценивает артефакты (скрины из игры, рендеры
// Blockbench) через vision-capable модель.
//
// Wire-формат (docs/source-ledger.md entry-13/14):
//   content: [{ type:"text", text:"Вопрос модели" },
//             { type:"image_url", image_url:{ url:"data:image/png;base64,...", detail:"low" } }]
//
// Vision-блоки шлются ТОЛЬКО vision-capable модели (иначе провайдер упадёт).
// Проверка: ModelCapabilities.vision === true.
//
// Триггеры: на чекпойнтах дизайна (после blockbench.render, minecraft.screenshot,
// patch'а визуала) — НЕ на каждой итерации. Решение об авто/явном триггере —
// в orchestrator (config.agent.visionTriggers).

export interface VisionArtifact {
  // Image-блоки (base64 PNG) — источник: NormalizedToolResult.images из
  // blockbench.render / minecraft.screenshot.
  images: Array<{ data: string; mimeType: string }>;
  // Описание задачи: что именно оцениваем (например «модель меча видна в руке
  // игрока? эффект домена выглядит как задумано?»).
  taskDescription: string;
  // Опционально: имя tool'а, который сгенерировал артефакт (для логирования).
  sourceTool?: string;
}

export interface VisionVerdict {
  // true = артефакт соответствует ожиданию (модель видна, эффект выглядит).
  matches: boolean;
  // Уверенность 0..1 (1 = высокая). Модель может быть не уверена.
  confidence: number;
  // Текстовые заметки модели: что именно видно на скриншоте/рендере.
  notes: string;
  // Модель, которая оценивала (для UI/логирования).
  model: string;
}

export interface VisionEvaluatorOptions {
  // Модель для vision-оценки (из config.agent.visionModel). Если пусто —
  // fallback на первую vision-capable модель из списка провайдера.
  visionModel?: string;
  // Провайдер для вызова модели.
  provider: ProviderAdapter;
  // Список моделей провайдера (для поиска vision-capable + pricing).
  models: ProviderModel[];
  // Опционально: token-budget для учёта vision-вызовов.
  tokenBudget?: TokenBudgetService;
  // Опционально: signal для отмены.
  signal?: AbortSignal;
}

const DEFAULT_VISION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

export class VisionEvaluator {
  public constructor(private readonly options: VisionEvaluatorOptions) {}

  public async evaluate(artifact: VisionArtifact): Promise<VisionVerdict> {
    if (!artifact.images.length) {
      throw new Error("VisionEvaluator: artifact.images пуст — нечего оценивать.");
    }

    const model = this.resolveVisionModel();
    const pricing = this.lookupPricing(model);

    // Строим multimodal ChatRequest: system + user (text + image_url блоки).
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          "Ты vision-оценщик MineAgent. Тебе передаётся изображение (скриншот из игры",
          "или рендер Blockbench) и задача. Оцени, соответствует ли изображение ожиданию.",
          "",
          "Формат ответа — JSON:",
          '{ "matches": boolean, "confidence": number, "notes": string }',
          "matches: true если артефакт соответствует ожиданию, false если нет.",
          "confidence: от 0 до 1, насколько ты уверен в оценке.",
          "notes: что именно видно на изображении, кратко (1-3 предложения).",
          "Отвечай ТОЛЬКО валидным JSON, без markdown-обёртки."
        ].join("\n")
      },
      {
        role: "user",
        content: this.buildVisionContent(artifact)
      }
    ];

    const chatRequest: ChatRequest = {
      model,
      temperature: 0.1,
      maxTokens: 500,
      messages,
      jsonMode: true,
      signal: this.options.signal
    };

    const response = await this.options.provider.chat(chatRequest);

    // Учитываем vision-вызов в token-budget.
    if (this.options.tokenBudget) {
      const visionCalls = hasImageBlocks(chatRequest.messages) ? 1 : 0;
      if (response.usage) {
        this.options.tokenBudget.record({
          inputTokens: response.usage.inputTokens ?? 0,
          outputTokens: response.usage.outputTokens ?? 0,
          visionCalls
        }, undefined, pricing);
      } else {
        this.options.tokenBudget.record(undefined, {
          inputTokens: 0,
          outputTokens: 0,
          visionCalls
        }, pricing);
      }
    }

    return this.parseVerdict(response.content, model);
  }

  // Строит multimodal content: text-блок с вопросом + image_url-блоки.
  private buildVisionContent(artifact: VisionArtifact): ContentBlock[] {
    const blocks: ContentBlock[] = [
      {
        type: "text",
        text: artifact.taskDescription
      }
    ];
    for (const img of artifact.images) {
      blocks.push({
        type: "image_url",
        image_url: {
          url: `data:${img.mimeType};base64,${img.data}`,
          // low = экономия токенов на оценочных вызовах (правило «не жечь токены»).
          detail: "low"
        }
      });
    }
    return blocks;
  }

  // Выбирает vision-capable модель: явный config ИЛИ fallback на дефолт.
  private resolveVisionModel(): string {
    const configured = this.options.visionModel?.trim();
    if (configured) {
      return configured;
    }
    // Ищем vision-capable модель в каталоге провайдера.
    const visionModel = this.options.models.find(
      (m) => m.capabilities.vision && m.id !== DEFAULT_VISION_MODEL
    );
    if (visionModel) {
      return visionModel.id;
    }
    // Fallback на дефолтную vision-модель (может отсутствовать у провайдера —
    // тогда провайдер вернёт model-not-found, и вызывающий код обработает).
    return DEFAULT_VISION_MODEL;
  }

  private lookupPricing(modelId: string): ModelPricing | undefined {
    const model = this.options.models.find((m) => m.id === modelId);
    return model ? {
      neuronsPerMInput: model.capabilities.neuronsPerMInput,
      neuronsPerMOutput: model.capabilities.neuronsPerMOutput
    } : undefined;
  }

  // Парсит JSON-ответ модели в VisionVerdict. Дефензивно — модель может
  // вернуть JSON с лишним текстом или невалидные поля.
  private parseVerdict(content: string, model: string): VisionVerdict {
    const fallback: VisionVerdict = {
      matches: false,
      confidence: 0,
      notes: content.slice(0, 300),
      model
    };
    try {
      const parsed = JSON.parse(extractJson(content));
      return {
        matches: Boolean(parsed.matches),
        confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
        notes: typeof parsed.notes === "string" ? parsed.notes : String(parsed.notes ?? ""),
        model
      };
    } catch {
      return fallback;
    }
  }
}

// Извлекает JSON из ответа модели (может быть обёрнут в markdown ```json ... ```).
function extractJson(text: string): string {
  const trimmed = text.trim();
  // Пытаемся найти JSON в markdown code block.
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\r?\n([\s\S]*?)```/i);
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim();
  }
  // Пытаемся найти первый { ... } блок.
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return jsonMatch[0];
  }
  return trimmed;
}
