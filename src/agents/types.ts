// Конфиг sub-агента. Соответствует docs/agent-architecture.md.
// Sub-агенты — специализированные ассистенты внутри run: reviewer, researcher и т.д.
// Запуск через модель — это Этап 2; здесь только конфиг и CRUD.

// Сколько контекста sub-агент держит между своими вызовами.
export type MemoryMode = "none" | "task" | "session" | "ask";

// Специализация sub-агента. Определяет дефолтный промт и предлагаемый toolset.
export type Specialty = "reviewer" | "researcher" | "vision" | "custom";

export interface SubAgentConfig {
  // Уникальный идентификатор. Используется как scopeId в ApprovalGate.
  id: string;
  displayName: string;
  // Идентификатор модели провайдера (например "@cf/moonshotai/kimi-k2.7-code").
  model: string;
  specialty: Specialty;
  // Переопределение системного промта. Пусто = использовать дефолт по specialty.
  promptOverride?: string;
  // Whitelist инструментов, которые sub-агенту разрешено вызывать.
  allowedTools: string[];
  memoryMode: MemoryMode;
  enabled: boolean;
}
