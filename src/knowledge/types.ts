// Этап 6: Knowledge Base — база знаний проекта с RAG-retrieval.
// Заменяет Source Ledger v1 (research-ledger.json) на масштабируемую базу:
//   - мультикатегорийная (api/gameplay/rendering/tools/assets/misc + кастомные)
//   - embedding-retrieval (keyword pre-filter → cosine similarity top-K)
//   - два входа: через чат (модель ищет) + через UI-панель (запрос к модели)
//   - fullNotes отдельно от summary (модель пишет при поиске)
//
// Хранилище: .mineagent/knowledge-base.json (отдельный файл, НЕ config.json).
// Embedding хранится рядом с записью (in-memory Map при работе, persist в JSON).

// Универсальные категории под моддинг (не JJK-зашивка).
export type KnowledgeCategory =
  | "api"        // Forge/Fabric/NeoForge docs, mappings, исходники
  | "gameplay"   // механики, эффекты, combat
  | "rendering"  // модели, текстуры, шейдеры, рендер
  | "tools"      // Gradle, mappings, dev-bridge, Blockbench
  | "assets"     // звуки, текстуры, локализация
  | "misc";      // прочее

export const KNOWLEDGE_CATEGORIES: KnowledgeCategory[] = [
  "api", "gameplay", "rendering", "tools", "assets", "misc"
];

export interface KnowledgeEntry {
  id: string;
  url: string;
  title?: string;
  category: KnowledgeCategory;
  tags: string[];
  summary: string;
  // Полные заметки — модель пишет при поиске, пользователь редактирует.
  fullNotes?: string;
  // Embedding вектора для retrieval. Может отсутствовать если embedding
  // ещё не вычислен (lazy-compute при первом search).
  embedding?: number[];
  // source: user всегда побеждает над model при retrieval (правило roadmap.md).
  source: "user" | "model";
  status: "candidate" | "accepted" | "rejected";
  addedAt: string;
}

export interface KnowledgeBase {
  entries: KnowledgeEntry[];
  lastUpdated: string | null;
}

export interface KnowledgeSearchResult {
  entry: KnowledgeEntry;
  score: number;
}

export interface KnowledgeBaseDeps {
  readBase: () => Promise<KnowledgeBase | undefined>;
  writeBase: (base: KnowledgeBase) => Promise<void>;
}
