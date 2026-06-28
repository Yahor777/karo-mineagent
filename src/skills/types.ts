// Этап 6: Skills — markdown-файлы с инструкциями для модели.
// Скилл = .mineagent/skills/{name}.md с YAML frontmatter:
//   ---
//   name: forge-event-handler
//   description: Регистрация event handlers в Forge/NeoForge
//   triggers: [event, handler, forge, bus, subscribe]
//   ---
//   Тело markdown — инструкция для модели.
//
// Создание через ИИ: юзер даёт тему → модель (с контекстом проекта) пишет .md.
// Авто-matching: embedding задачи → embedding skill descriptions → top-K.
// Ручной override: UI показывает выбранные скиллы, юзер может закрепить/отклонить.

export interface SkillManifest {
  // Имя скилла (из frontmatter, совпадает с именем файла без .md).
  name: string;
  // Краткое описание для matching/UI.
  description: string;
  // Ключевые слова-триггеры — для keyword pre-filter при matching.
  triggers: string[];
  // true = скилл нельзя удалить/редактировать (стартовые скиллы).
  readOnly?: boolean;
}

export interface Skill extends SkillManifest {
  // Тело markdown — инструкция для модели (подмешивается в system prompt).
  content: string;
  // Путь к файлу (относительно workspace root).
  path: string;
  // Embedding для matching (lazy-compute при первом match).
  embedding?: number[];
}

// Результат matching скилла с задачей.
export interface SkillMatchResult {
  skill: Skill;
  score: number;
  // true = выбран пользователем явно (pinned), не через retrieval.
  pinned: boolean;
}
