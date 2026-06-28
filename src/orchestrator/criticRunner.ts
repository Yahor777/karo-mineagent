import type { ProviderAdapter, ProviderModel, ChatRequest, ChatMessage } from "../providers/ProviderAdapter";
import type { TokenBudgetService, ModelPricing } from "../providers/tokenBudget";
import type { ProjectMap } from "../repo/projectMap";

// Этап 5: CriticRunner — вторая модель оценивает артефакт БЕЗ хода мыслей
// main (убирает anchoring bias, docs/agent-architecture.md раздел 3).
//
// Critic получает компактный артефакт: projectMap + taskDescription + artifact.
// НЕ получает chain-of-thought main (предыдущие assistant-сообщения с
// рассуждениями). Это заставляет critic формировать независимое мнение.
//
// Консенсус: main-результат + critic-verdict →
//   оба approve → применить автоматически
//   разногласие (один approve, другой reject) → спросить пользователя
//   uncertain → спросить пользователя
//
// По умолчанию critic = ДРУГАЯ модель (не та же, что main). Self-critique
// (та же модель) возможен, но с UI-предупреждением «объективность ниже».

export interface CriticArtifact {
  // Компактная карта проекта (compact JSON) — НЕ весь контекст.
  projectMap: ProjectMap;
  // Что оцениваем (одно предложение).
  taskDescription: string;
  // Сам объект оценки: код / скрин base64 / geo.json / patch diff.
  artifact: string;
  // Режим оценки: code (patch/класс), design (модель/текстура), vision (скрин).
  mode: "code" | "design" | "vision";
}

export interface CriticVerdict {
  // approve = артефакт хорош, можно применять.
  // reject = артефакт плох, нужно переделать.
  // uncertain = critic не уверен, спросить пользователя.
  verdict: "approve" | "reject" | "uncertain";
  // Обоснование критика (кратко, 1-3 предложения).
  reasoning: string;
  // Модель, которая оценивала (для UI/логирования).
  model: string;
  // true = critic работает на той же модели, что main (self-critique).
  // UI показывает предупреждение «объективность ниже».
  isSelfCritique: boolean;
}

export interface CriticRunnerOptions {
  // Модель для critic (из config.agent.criticModel). Если пусто — fallback
  // на complexModel (если != defaultModel) или первую доступную.
  criticModel?: string;
  // Модель main-агента — для обнаружения self-critique.
  mainModel: string;
  // Провайдер для вызова модели.
  provider: ProviderAdapter;
  // Список моделей провайдера (для выбора + pricing).
  models: ProviderModel[];
  // Опционально: token-budget для учёта critic-вызовов.
  tokenBudget?: TokenBudgetService;
  // Опционально: signal для отмены.
  signal?: AbortSignal;
}

export class CriticRunner {
  public constructor(private readonly options: CriticRunnerOptions) {}

  public async evaluate(artifact: CriticArtifact): Promise<CriticVerdict> {
    const model = this.resolveCriticModel();
    const isSelfCritique = model === this.options.mainModel;
    const pricing = this.lookupPricing(model);

    // Строим messages: system (роль critic) + user (компактный артефакт).
    // НЕТ chain-of-thought main — critic не видит предыдущие рассуждения.
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: this.buildCriticSystemPrompt(artifact.mode)
      },
      {
        role: "user",
        content: this.buildCriticUserMessage(artifact)
      }
    ];

    const chatRequest: ChatRequest = {
      model,
      temperature: 0.1,
      maxTokens: 600,
      messages,
      jsonMode: true,
      signal: this.options.signal
    };

    const response = await this.options.provider.chat(chatRequest);

    // Учитываем critic-вызов в token-budget (как обычный chat, не vision).
    if (this.options.tokenBudget && response.usage) {
      this.options.tokenBudget.record({
        inputTokens: response.usage.inputTokens ?? 0,
        outputTokens: response.usage.outputTokens ?? 0,
        visionCalls: 0
      }, undefined, pricing);
    }

    return this.parseVerdict(response.content, model, isSelfCritique);
  }

  private buildCriticSystemPrompt(mode: CriticArtifact["mode"]): string {
    const modeDescription = mode === "code"
      ? "оцениваешь код (patch/класс/метод) мода Minecraft"
      : mode === "design"
        ? "оцениваешь дизайн (3D-модель/текстуру/анимацию) мода Minecraft"
        : "оцениваешь визуальный артефакт (скриншот/рендер) мода Minecraft";
    return [
      `Ты critic MineAgent — независимый оценщик. ${modeDescription}.`,
      "Ты получаешь компактный артефакт: карту проекта + задачу + объект оценки.",
      "Ты НЕ видишь ход мыслей основного агента — формируй независимое мнение.",
      "",
      "Формат ответа — JSON:",
      '{ "verdict": "approve" | "reject" | "uncertain", "reasoning": string }',
      "approve: артефакт хорош, можно применять.",
      "reject: артефакт плох, нужно переделать (объясни почему в reasoning).",
      "uncertain: недостаточно информации для оценки.",
      "reasoning: краткое обоснование (1-3 предложения), БЕЗ цитирования кода.",
      "Не выдумывай Minecraft API. Если не уверен — verdict: uncertain.",
      "Отвечай ТОЛЬКО валидным JSON, без markdown-обёртки."
    ].join("\n");
  }

  private buildCriticUserMessage(artifact: CriticArtifact): string {
    const compactMap = {
      loader: artifact.projectMap.loader,
      minecraftVersion: artifact.projectMap.minecraftVersion,
      javaVersion: artifact.projectMap.javaVersion,
      mainModId: artifact.projectMap.mainModId,
      registries: artifact.projectMap.registries.slice(0, 10),
      eventHandlers: artifact.projectMap.eventHandlers.slice(0, 10)
    };
    return [
      `Задача: ${artifact.taskDescription}`,
      "",
      "Карта проекта:",
      JSON.stringify(compactMap, null, 2),
      "",
      `Режим оценки: ${artifact.mode}`,
      "",
      "Артефакт для оценки:",
      artifact.artifact
    ].join("\n");
  }

  // Выбирает critic-модель: явный config ИЛИ первая модель != mainModel.
  private resolveCriticModel(): string {
    const configured = this.options.criticModel?.trim();
    if (configured) {
      return configured;
    }
    // Пытаемся найти модель, ОТЛИЧНУЮ от main (избегаем self-critique).
    const otherModel = this.options.models.find(
      (m) => m.id !== this.options.mainModel && m.capabilities.tools
    );
    if (otherModel) {
      return otherModel.id;
    }
    // Fallback: та же модель (self-critique) — UI покажет предупреждение.
    return this.options.mainModel;
  }

  private lookupPricing(modelId: string): ModelPricing | undefined {
    const model = this.options.models.find((m) => m.id === modelId);
    return model ? {
      neuronsPerMInput: model.capabilities.neuronsPerMInput,
      neuronsPerMOutput: model.capabilities.neuronsPerMOutput
    } : undefined;
  }

  private parseVerdict(content: string, model: string, isSelfCritique: boolean): CriticVerdict {
    const fallback: CriticVerdict = {
      verdict: "uncertain",
      reasoning: content.slice(0, 300),
      model,
      isSelfCritique
    };
    try {
      const parsed = JSON.parse(extractJson(content));
      const verdict = parsed.verdict === "approve" || parsed.verdict === "reject"
        ? parsed.verdict
        : "uncertain";
      return {
        verdict,
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : String(parsed.reasoning ?? ""),
        model,
        isSelfCritique
      };
    } catch {
      return fallback;
    }
  }
}

// Консенсус main + critic → действие.
// docs/agent-architecture.md раздел 3: консенсус = применить, разногласие = спросить.
export type ConsensusAction = "apply" | "ask-user";

export function resolveConsensus(
  mainApproved: boolean,
  critic: CriticVerdict
): ConsensusAction {
  // Консенсус: main approve + critic approve → применить.
  if (mainApproved && critic.verdict === "approve") {
    return "apply";
  }
  // Разногласие: один approve, другой reject → спросить.
  // Uncertain → спросить.
  return "ask-user";
}

// Извлекает JSON из ответа модели (может быть обёрнут в markdown).
function extractJson(text: string): string {
  const trimmed = text.trim();
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\r?\n([\s\S]*?)```/i);
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim();
  }
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return jsonMatch[0];
  }
  return trimmed;
}
