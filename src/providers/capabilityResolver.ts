import type { ProviderModel, ModelCapabilities } from "./ProviderAdapter";

// Фаза 1 (P1.3): Capability-резолвер.
// «Выбор модели священен»: мы НЕ подменяем модель за пользователя. Резолвер
// лишь ОТВЕЧАЕТ на вопрос «тянет ли выбранная модель эту задачу?» и, если нет,
// формирует структурированный отказ с альтернативами — решение остаётся за
// пользователем (UI показывает «повторить / выбрать другую / отменить»).

// Что требует задача от модели.
export interface CapabilityNeed {
  tools?: boolean;        // нужен tool-loop
  vision?: boolean;       // в запросе есть image-блоки
  jsonMode?: boolean;     // нужен строгий JSON
  minContext?: number;    // оценка нужного контекста (в токенах)
}

export interface CapabilityVerdict {
  ok: boolean;
  // Чего именно не хватает выбранной модели (человекочитаемо, для UI).
  missing: string[];
  // Модели того же провайдера, которые удовлетворяют need (id) — для подсказки
  // «выбрать другую». Пусто — если подходящих нет.
  alternatives: string[];
}

// Проверяет, удовлетворяет ли модель потребностям задачи.
export function resolveCapability(
  modelId: string,
  models: ProviderModel[],
  need: CapabilityNeed
): CapabilityVerdict {
  const model = models.find((m) => m.id === modelId);
  const caps = model?.capabilities;
  const missing: string[] = [];

  if (!caps) {
    // Модели нет в каталоге провайдера — это hard-ошибка уровня «нет модели».
    return {
      ok: false,
      missing: [`модель "${modelId}" не найдена в каталоге провайдера`],
      alternatives: models.filter((m) => satisfies(m.capabilities, need)).map((m) => m.id)
    };
  }

  if (need.tools && !caps.tools) {
    missing.push("инструменты (tools)");
  }
  if (need.vision && !caps.vision) {
    missing.push("зрение (vision)");
  }
  if (need.jsonMode && !caps.jsonMode) {
    missing.push("строгий JSON (json mode)");
  }
  if (need.minContext && caps.contextWindow && caps.contextWindow < need.minContext) {
    missing.push(`контекст ${caps.contextWindow} < требуемых ${need.minContext}`);
  }

  if (!missing.length) {
    return { ok: true, missing: [], alternatives: [] };
  }

  return {
    ok: false,
    missing,
    alternatives: models
      .filter((m) => m.id !== modelId && satisfies(m.capabilities, need))
      .map((m) => m.id)
  };
}

function satisfies(caps: ModelCapabilities | undefined, need: CapabilityNeed): boolean {
  if (!caps) {
    return false;
  }
  if (need.tools && !caps.tools) return false;
  if (need.vision && !caps.vision) return false;
  if (need.jsonMode && !caps.jsonMode) return false;
  if (need.minContext && caps.contextWindow && caps.contextWindow < need.minContext) return false;
  return true;
}

// Поддерживает ли модель reasoning_effort (P1.5). Гейтит передачу effort —
// шлём только моделям, у которых это есть, чтобы не ловить 400 на остальных.
export function supportsEffort(modelId: string, models: ProviderModel[]): boolean {
  const caps = models.find((m) => m.id === modelId)?.capabilities;
  return Boolean(caps?.effortLevels);
}