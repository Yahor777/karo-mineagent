import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { EmbeddingService } from "../providers/embeddingService";
import type {
  KnowledgeBase,
  KnowledgeEntry,
  KnowledgeCategory,
  KnowledgeSearchResult,
  KnowledgeBaseDeps
} from "./types";
import { KNOWLEDGE_CATEGORIES } from "./types";

// Этап 6: KnowledgeBaseService — CRUD + RAG-retrieval над .mineagent/knowledge-base.json.
//
// Retrieval pipeline (правило «не жечь токены»):
//   1. Keyword pre-filter: отсекаем записи без совпадения слов из задачи
//      (дёшево, грубо — убираем явно нерелевантное).
//   2. Embedding ranking: косинусное сходство query↔entry.embedding → top-K.
//      Точно, но требует embedding (вычисляется один раз, кэшируется).
//   3. source:user всегда побеждает над source:model при равенстве score.
//
// Embedding lazy-compute: при первом search если у записи нет embedding —
// вычисляем и persist. При последующих search — используем кэш.

export class KnowledgeBaseService {
  // Этап 6: директория для full notes файлов (отдельно от knowledge-base.json).
  // Каждый fullNotes хранится в .mineagent/knowledge-notes/{id}.md — редактируется
  // пользователем отдельно от UI-вкладки (roadmap.md:110).
  private readonly notesDir: string;

  public constructor(
    private readonly deps: KnowledgeBaseDeps,
    private readonly embeddingService?: EmbeddingService,
    notesDir?: string
  ) {
    this.notesDir = notesDir ?? ".mineagent/knowledge-notes";
  }

  public async list(): Promise<KnowledgeEntry[]> {
    const base = await this.deps.readBase();
    return base?.entries ?? [];
  }

  public async add(entry: Omit<KnowledgeEntry, "id" | "addedAt"> & { id?: string }): Promise<KnowledgeEntry> {
    const base = await this.requireBase();
    const id = entry.id ?? generateEntryId();
    if (base.entries.some((e) => e.id === id)) {
      throw new Error(`Запись с id "${id}" уже существует.`);
    }
    const full: KnowledgeEntry = {
      ...entry,
      id,
      addedAt: new Date().toISOString()
    };
    // Вычисляем embedding сразу при добавлении (если сервис есть).
    if (this.embeddingService && !full.embedding) {
      const text = this.entryToText(full);
      full.embedding = await this.embeddingService.embed(text);
    }
    await this.deps.writeBase({
      entries: [...base.entries, full],
      lastUpdated: new Date().toISOString()
    });
    return full;
  }

  public async update(id: string, patch: Partial<KnowledgeEntry>): Promise<KnowledgeEntry> {
    const base = await this.requireBase();
    const index = base.entries.findIndex((e) => e.id === id);
    if (index === -1) {
      throw new Error(`Запись с id "${id}" не найдена.`);
    }
    const { id: _ignored, ...rest } = patch;
    void _ignored;
    const updated: KnowledgeEntry = { ...base.entries[index]!, ...rest, id };
    // Если изменился текст — обновляем embedding.
    if (this.embeddingService && (patch.summary || patch.fullNotes || patch.title)) {
      const text = this.entryToText(updated);
      updated.embedding = await this.embeddingService.embed(text);
    }
    const nextEntries = [...base.entries];
    nextEntries[index] = updated;
    await this.deps.writeBase({
      entries: nextEntries,
      lastUpdated: new Date().toISOString()
    });
    return updated;
  }

  public async remove(id: string): Promise<void> {
    const base = await this.requireBase();
    if (!base.entries.some((e) => e.id === id)) {
      throw new Error(`Запись с id "${id}" не найдена.`);
    }
    await this.deps.writeBase({
      entries: base.entries.filter((e) => e.id !== id),
      lastUpdated: new Date().toISOString()
    });
  }

  // RAG-retrieval: возвращает top-K записей релевантных задаче.
  // Pipeline: keyword pre-filter → embedding ranking → user-priority.
  public async search(query: string, topK: number = 5): Promise<KnowledgeSearchResult[]> {
    const base = await this.requireBase();
    if (!base.entries.length || topK <= 0) {
      return [];
    }

    // 1. Keyword pre-filter: оставляем записи где хотя бы одно слово из query
    //    встречается в summary/tags/title. Дёшево, отсекает явно нерелевантное.
    const queryWords = extractKeywords(query);
    let candidates = base.entries.filter((entry) => {
      const haystack = `${entry.title ?? ""} ${entry.summary} ${entry.tags.join(" ")}`.toLowerCase();
      return queryWords.some((word) => haystack.includes(word));
    });

    // Если pre-filter отсеял всё — берём все записи (fallback).
    if (!candidates.length) {
      candidates = [...base.entries];
    }

    // 2. Embedding ranking: если есть embeddingService — вычисляем query embedding
    //    и ранжируем по cosine similarity. Иначе — возвращаем без ranking.
    if (this.embeddingService) {
      const queryEmbedding = await this.embeddingService.embed(query);
      // Lazy-compute embeddings для записей где их нет.
      const embeddings: number[][] = [];
      const entriesWithEmbedding: KnowledgeEntry[] = [];
      for (const entry of candidates) {
        if (!entry.embedding) {
          const text = this.entryToText(entry);
          const emb = await this.embeddingService!.embed(text);
          entry.embedding = emb;
        }
        embeddings.push(entry.embedding!);
        entriesWithEmbedding.push(entry);
      }
      // Persist обновлённых embeddings.
      await this.deps.writeBase({ entries: base.entries, lastUpdated: new Date().toISOString() });

      const ranked = EmbeddingService.rankBySimilarity(queryEmbedding, embeddings, topK);
      let results = ranked.map(({ index, score }) => ({
        entry: entriesWithEmbedding[index]!,
        score
      }));

      // 3. User-priority: при равенстве score source:user побеждает.
      results = results.sort((a, b) => {
        if (Math.abs(a.score - b.score) < 0.01) {
          if (a.entry.source === "user" && b.entry.source !== "user") return -1;
          if (a.entry.source !== "user" && b.entry.source === "user") return 1;
        }
        return b.score - a.score;
      });
      return results;
    }

    // Без embeddingService — возвращаем topK без ranking (по дате добавления).
    return candidates
      .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
      .slice(0, topK)
      .map((entry) => ({ entry, score: 0 }));
  }

  // Категоризация: модель предлагает категорию при добавлении.
  // Здесь — простая эвристика по ключевым словам (без вызова модели).
  public suggestCategory(text: string): KnowledgeCategory {
    const lower = text.toLowerCase();
    if (/forge|fabric|neoforge|mapping|mcp|yarn|api|registry|event/.test(lower)) return "api";
    if (/combat|effect|damage|mob|entity|mechanic|gameplay/.test(lower)) return "gameplay";
    if (/render|model|texture|shader|blockbench|obj/.test(lower)) return "rendering";
    if (/gradle|build|task|dev-bridge|tool/.test(lower)) return "tools";
    if (/sound|lang|texture|asset|resource/.test(lower)) return "assets";
    return "misc";
  }

  // Этап 6: full notes файл — отдельный .md для каждой записи (roadmap.md:110).
  // Пользователь редактирует файл напрямую; UI-вкладка показывает summary.
  public async writeFullNotesFile(id: string, content: string, basePath: string): Promise<string> {
    const path = join(basePath, this.notesDir, `${id}.md`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `# Knowledge Entry ${id}\n\n${content}\n`, "utf8");
    return path;
  }

  public async readFullNotesFile(id: string, basePath: string): Promise<string | undefined> {
    try {
      const path = join(basePath, this.notesDir, `${id}.md`);
      return await readFile(path, "utf8");
    } catch {
      return undefined;
    }
  }

  private async requireBase(): Promise<KnowledgeBase> {
    const base = await this.deps.readBase();
    if (!base) {
      return { entries: [], lastUpdated: null };
    }
    return base;
  }

  // Текст для embedding: title + summary + tags (fullNotes слишком длинный).
  private entryToText(entry: KnowledgeEntry): string {
    return [entry.title, entry.summary, entry.tags.join(" ")].filter(Boolean).join(" ");
  }
}

// Импортируем EmbeddingService в начале файла (для static метода rankBySimilarity).

function generateEntryId(): string {
  return `kb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Извлекает ключевые слова из запроса (для pre-filter).
// Убирает стоп-слова и короткие токены, приводит к нижнему регистру.
function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "and", "or",
    "but", "in", "on", "at", "to", "for", "of", "with", "by", "from", "as",
    "это", "эта", "этот", "эти", "для", "на", "в", "с", "от", "по", "как",
    "что", "какой", "какая", "и", "или", "но", "не", "да", "нет"
  ]);
  return text
    .toLowerCase()
    .split(/[\s,.;:!?()[]{}`"']+/)
    .filter((word) => word.length > 2 && !stopWords.has(word))
    .filter((word, index, arr) => arr.indexOf(word) === index);
}

// Валидация категории (для UI/API).
export function isValidCategory(value: string): value is KnowledgeCategory {
  return KNOWLEDGE_CATEGORIES.includes(value as KnowledgeCategory);
}
