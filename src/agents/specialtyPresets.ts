import type { Specialty } from "./types";

// Этап 5: specialty-пресеты — надстройки промта + дефолтный toolset для каждой
// специализации sub-агента (docs/agent-architecture.md раздел 2).
// Пресет = { promptOverlay, defaultTools }. Юзер может отвязать пресет и
// настроить sub-агента с нуля (allowedTools в SubAgentConfig перекрывают default).

export interface SpecialtyPreset {
  promptOverlay: string;
  defaultTools: string[];
}

const presets: Record<Specialty, SpecialtyPreset> = {
  reviewer: {
    promptOverlay: [
      "Ты sub-агент-ревизор MineAgent. Оцениваешь код и дизайн мода Minecraft.",
      "Тебе доступны только read-инструменты — ты НЕ модифицируешь файлы.",
      "Формат ответа: вердикт (approve/reject/uncertain) + краткое обоснование.",
      "Не выдумывай Minecraft API. Если не уверен — отмечай как uncertain."
    ].join("\n"),
    defaultTools: ["repo.read", "repo.search", "git.diff"]
  },
  researcher: {
    promptOverlay: [
      "Ты sub-агент-исследователь MineAgent. Ищешь web-источники и заполняешь Source Ledger.",
      "Используешь web-поиск и инструменты reference.* для сбора источников.",
      "Не копируй защищённые имена, лор, ассеты, текстуры, звуки или логотипы.",
      "Формат ответа: краткая выжимка найденного + предложенные записи для Source Ledger."
    ].join("\n"),
    defaultTools: ["web.research", "docs.search"]
  },
  vision: {
    promptOverlay: [
      "Ты sub-агент vision-оценщик MineAgent. Оцениваешь скриншоты из игры и рендеры Blockbench.",
      "Тебе передаются image-блоки (base64 PNG) — ты видишь изображение и оцениваешь его.",
      "Вопросы: модель видна? эффект выглядит как задумано? анимация проигрывается?",
      "Формат ответа: { matches: boolean, confidence: number, notes: string }.",
      "confidence от 0 до 1. notes — что именно видно на скриншоте/рендере."
    ].join("\n"),
    defaultTools: ["minecraft.screenshot", "blockbench.render"]
  },
  custom: {
    promptOverlay: "",
    defaultTools: []
  }
};

export function getSpecialtyPreset(specialty: Specialty): SpecialtyPreset {
  return presets[specialty] ?? presets.custom;
}

// Строит системный промт sub-агента: базовый + надстройка specialty + promptOverride.
// promptOverride (из SubAgentConfig) перекрывает надстройку пресета — юзер
// может полностью заменить специализацию. Базовый промт MineAgent остаётся.
export function buildSubAgentSystemPrompt(basePrompt: string, specialty: Specialty, promptOverride?: string): string {
  const overlay = promptOverride?.trim() || getSpecialtyPreset(specialty).promptOverlay;
  if (!overlay) {
    return basePrompt;
  }
  return `${basePrompt}\n\n${overlay}`;
}

// Возвращает дефолтный toolset для specialty. Юзер может перекрыть через
// SubAgentConfig.allowedTools — тогда используется его список.
export function getSpecialtyDefaultTools(specialty: Specialty): string[] {
  return [...getSpecialtyPreset(specialty).defaultTools];
}
