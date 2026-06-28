import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import type { ProviderAdapter, ChatRequest } from "../providers/ProviderAdapter";

// Фаза 2 (P2.1): ИИ-индекс — третий слой памяти.
// Запускается ПО КНОПКЕ (выбор провайдера+модели индекса ≠ модель работы).
// Для каждого исходника строит конспект (что делает, что регистрирует,
// зависимости, точки расширения) + общую карту архитектуры. Хранит в
// .mineagent/workspace-index/. Инкрементально по хэшу файла (кэш не
// перестраивает неизменённое — правило «не жечь токены»).
//
// Конспекты служат и памятью, и кормом для RAG (их индексирует EmbeddingService).

export interface FileSummary {
  path: string;          // workspace-relative
  hash: string;          // sha1 содержимого — ключ инкрементальности
  summary: string;       // конспект от модели
  summarizedAt: string;
}

export interface WorkspaceIndexData {
  model: string;         // какой моделью построен индекс
  files: Record<string, FileSummary>; // path → summary
  architecture?: string; // общая карта архитектуры
  builtAt: string | null;
}

export interface WorkspaceIndexProgress {
  total: number;
  done: number;
  current?: string;
}

const INDEX_DIR = ".mineagent/workspace-index";
const INDEX_FILE = "index.json";

export class WorkspaceIndexer {
  public constructor(
    private readonly root: string,
    private readonly provider: ProviderAdapter,
    private readonly model: string
  ) {}

  public async load(): Promise<WorkspaceIndexData> {
    try {
      const raw = await readFile(join(this.root, INDEX_DIR, INDEX_FILE), "utf8");
      return JSON.parse(raw) as WorkspaceIndexData;
    } catch {
      return { model: this.model, files: {}, builtAt: null };
    }
  }

  private async save(data: WorkspaceIndexData): Promise<void> {
    const path = join(this.root, INDEX_DIR, INDEX_FILE);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2), "utf8");
  }

  // Инкрементальная переиндексация. files — абсолютные пути исходников
  // (вызывающий код собирает их через RepoIndexer/glob). onProgress — для UI.
  public async build(
    files: string[],
    onProgress?: (p: WorkspaceIndexProgress) => void,
    signal?: AbortSignal
  ): Promise<WorkspaceIndexData> {
    const existing = await this.load();
    // Сброс кэша, если индекс строился другой моделью.
    const data: WorkspaceIndexData =
      existing.model === this.model ? existing : { model: this.model, files: {}, builtAt: null };

    let done = 0;
    for (const abs of files) {
      if (signal?.aborted) {
        break;
      }
      const rel = relative(this.root, abs);
      onProgress?.({ total: files.length, done, current: rel });
      try {
        const content = await readFile(abs, "utf8");
        const hash = sha1(content);
        const cached = data.files[rel];
        // Инкрементальность: не трогаем неизменённые файлы.
        if (!cached || cached.hash !== hash) {
          const summary = await this.summarizeFile(rel, content, signal);
          data.files[rel] = { path: rel, hash, summary, summarizedAt: new Date().toISOString() };
        }
      } catch {
        // Нечитаемый/бинарный файл пропускаем.
      }
      done += 1;
    }

    // Общая карта архитектуры из конспектов файлов.
    if (!signal?.aborted) {
      data.architecture = await this.summarizeArchitecture(data, signal);
      data.builtAt = new Date().toISOString();
    }
    await this.save(data);
    onProgress?.({ total: files.length, done });
    return data;
  }

  private async summarizeFile(rel: string, content: string, signal?: AbortSignal): Promise<string> {
    // Ограничиваем размер входа — большие файлы режем (конспект не требует всего).
    const clipped = content.length > 12000 ? `${content.slice(0, 12000)}\n…(обрезано)` : content;
    const req: ChatRequest = {
      model: this.model,
      temperature: 0.1,
      maxTokens: 512,
      messages: [
        {
          role: "system",
          content:
            "Ты строишь индекс кодовой базы. Для файла дай КРАТКИЙ конспект на русском: " +
            "1) что делает, 2) что регистрирует/экспортирует, 3) ключевые зависимости, " +
            "4) точки расширения. Без воды, маркированным списком."
        },
        { role: "user", content: `Файл: ${rel}\n\n${clipped}` }
      ],
      signal
    };
    const response = await this.provider.chat(req);
    return response.content.trim();
  }

  private async summarizeArchitecture(data: WorkspaceIndexData, signal?: AbortSignal): Promise<string> {
    const digest = Object.values(data.files)
      .map((f) => `### ${f.path}\n${f.summary}`)
      .join("\n\n")
      .slice(0, 40000);
    const req: ChatRequest = {
      model: this.model,
      temperature: 0.1,
      maxTokens: 1024,
      messages: [
        {
          role: "system",
          content:
            "По конспектам файлов составь общую карту архитектуры проекта на русском: " +
            "слои, основные потоки данных, как модули связаны. Кратко, структурно."
        },
        { role: "user", content: digest }
      ],
      signal
    };
    const response = await this.provider.chat(req);
    return response.content.trim();
  }
}

function sha1(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

export async function indexAgeMs(root: string): Promise<number | undefined> {
  try {
    const s = await stat(join(root, INDEX_DIR, INDEX_FILE));
    return Date.now() - s.mtimeMs;
  } catch {
    return undefined;
  }
}