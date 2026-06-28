import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  MemoryRenderOptions,
  MemorySectionId,
  ProjectIdentityFacts,
  RunLogEntry
} from "./types";

// Фаза 1: ProjectMemoryService — живая память проекта в .mineagent/project.md.
//
// Цель пользователя: «продолжать проект, ничего не забывая». Память здесь —
// долговременная и провайдеро-независимая (никаких embeddings): один markdown-файл,
// который агент сам ведёт и подмешивает в начало контекста при каждом запросе.
//
// Файл размечен HTML-комментариями-маркерами на разделы. Это даёт три свойства:
//   1. Человекочитаемость — пользователь открывает project.md и всё понимает/правит.
//   2. Машинная адресуемость — сервис меняет один раздел, не трогая остальные
//      (в т.ч. ручные правки пользователя сохраняются).
//   3. Идемпотентность — повторный sync identity не плодит дубликатов.
//
// Разделы:
//   auto:identity   — факты из ProjectMap (loader/MC/Java/modId). Пишет агент.
//   conventions     — конвенции регистрации/архитектуры. Агент + пользователь.
//   content         — добавленный в мод контент (предметы/блоки/...). Агент + пользователь.
//   decisions       — принятые решения и их причины. Агент + пользователь.
//   open            — открытые вопросы / TODO. Агент + пользователь.
//   auto:log        — журнал задач (последние N). Пишет агент.

const SECTION_TITLES: Record<MemorySectionId, string> = {
  conventions: "Конвенции регистрации и архитектуры",
  content: "Добавленный контент",
  decisions: "Принятые решения",
  open: "Открытые вопросы / TODO"
};

const EMPTY_PLACEHOLDER = "_(пока пусто — агент дополнит по мере работы)_";

export class ProjectMemoryService {
  public constructor(private readonly root: string) {}

  public get filePath(): string {
    return join(this.root, ".mineagent", "project.md");
  }

  // Гарантирует существование файла памяти. Если файла нет — создаёт шаблон.
  public async ensure(): Promise<void> {
    const existing = await this.readRaw();
    if (existing === undefined) {
      await this.writeRaw(this.template());
    }
  }

  // Сырое содержимое файла (markdown). undefined — файла ещё нет.
  public async readRaw(): Promise<string | undefined> {
    try {
      return await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  // Обновляет auto-раздел identity фактами из ProjectMap. Идемпотентно:
  // повторный вызов перезаписывает блок целиком, дубликатов не возникает.
  // Пустые значения пропускаются (не затираем известное «unknown»-ом).
  public async syncIdentity(facts: ProjectIdentityFacts): Promise<void> {
    await this.ensure();
    const lines: string[] = [];
    const push = (label: string, value: string | number | undefined) => {
      if (value !== undefined && value !== null && String(value).trim() !== "" && value !== "unknown") {
        lines.push(`- ${label}: ${value}`);
      }
    };
    push("Загрузчик", facts.loader);
    push("Версия Minecraft", facts.minecraftVersion);
    push("Версия Java", facts.javaVersion);
    push("Mod ID", facts.mainModId);
    push("Записей в реестрах (registry)", facts.registriesCount);
    push("Обработчиков событий", facts.eventHandlersCount);
    lines.push(`- Индекс обновлён: ${facts.updatedAt ?? new Date().toISOString()}`);
    const body = lines.length ? lines.join("\n") : "_(индексатор пока не определил параметры мода)_";
    await this.replaceBlock("auto:identity", body);
  }

  // Добавляет строку в раздел (conventions/content/decisions/open).
  // Дедупликация по тексту: повторная одинаковая запись игнорируется, поэтому
  // агент может безопасно вызывать это после каждой задачи.
  public async appendToSection(
    section: MemorySectionId,
    text: string,
    source: "user" | "agent" = "agent"
  ): Promise<boolean> {
    const clean = text.trim().replace(/\s+/g, " ");
    if (!clean) {
      return false;
    }
    await this.ensure();
    const current = this.readBlock(await this.readRaw() ?? "", `section:${section}`);
    const existingLines = parseBullets(current);
    if (existingLines.some((line) => line.toLowerCase().includes(clean.toLowerCase()))) {
      return false; // уже записано — не дублируем
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const mark = source === "user" ? " (правка пользователя)" : "";
    existingLines.push(`${clean} — ${stamp}${mark}`);
    await this.replaceBlock(`section:${section}`, existingLines.map((l) => `- ${l}`).join("\n"));
    return true;
  }

  // Добавляет запись в журнал задач (auto:log). Хранит только последние keepLast,
  // чтобы файл не разрастался, но факт «делали X, получили Y» сохранялся надолго.
  public async appendRunLog(entry: RunLogEntry, keepLast = 20): Promise<void> {
    await this.ensure();
    const current = this.readBlock(await this.readRaw() ?? "", "auto:log");
    const blocks = current
      .split(/\n(?=- \d{4}-\d{2}-\d{2})/)
      .map((b) => b.trim())
      .filter((b) => b && !b.startsWith("_(")); // выбрасываем стартовый плейсхолдер
    const task = truncate(entry.task, 200);
    const summary = truncate(entry.summary, 400);
    const line = `- ${entry.at} [${entry.mode}] ${task}\n  Итог: ${summary}`;
    blocks.unshift(line); // свежие — первыми
    const kept = blocks.slice(0, keepLast);
    await this.replaceBlock("auto:log", kept.join("\n"));
  }

  // Рендерит компактный блок памяти для подмешивания в промпт. Это текст,
  // который делает агента «помнящим»: identity + конвенции + контент + решения +
  // открытые вопросы + последние записи журнала. Маркеры-комментарии убираются,
  // журнал ограничивается, всё обрезается по maxChars (защита от пожара токенов).
  public async renderForPrompt(options: MemoryRenderOptions = {}): Promise<string> {
    const raw = await this.readRaw();
    if (raw === undefined) {
      return "";
    }
    const maxLogEntries = options.maxLogEntries ?? 8;
    const maxChars = options.maxChars ?? 6000;

    const identity = this.readBlock(raw, "auto:identity").trim();
    const conventions = this.readBlock(raw, "section:conventions").trim();
    const content = this.readBlock(raw, "section:content").trim();
    const decisions = this.readBlock(raw, "section:decisions").trim();
    const open = this.readBlock(raw, "section:open").trim();
    const logRaw = this.readBlock(raw, "auto:log").trim();

    const logEntries = logRaw
      .split(/\n(?=- \d{4})/)
      .map((b) => b.trim())
      .filter(Boolean)
      .slice(0, maxLogEntries)
      .join("\n");

    const parts: string[] = ["Память проекта (.mineagent/project.md) — это твоя долговременная память. Опирайся на неё и не противоречь принятым решениям."];
    const addSection = (title: string, body: string) => {
      if (body && body !== EMPTY_PLACEHOLDER) {
        parts.push(`\n${title}:\n${body}`);
      }
    };
    addSection("Идентичность проекта", identity);
    addSection(SECTION_TITLES.conventions, conventions);
    addSection(SECTION_TITLES.content, content);
    addSection(SECTION_TITLES.decisions, decisions);
    addSection(SECTION_TITLES.open, open);
    addSection("Журнал последних задач", logEntries);

    const result = parts.join("\n");
    return result.length > maxChars ? `${result.slice(0, maxChars)}\n…(память обрезана)` : result;
  }

  // --- внутреннее ---

  // Читает содержимое блока по id маркера. Возвращает "" если блока нет.
  private readBlock(raw: string, id: string): string {
    const { open, close } = markers(id);
    const start = raw.indexOf(open);
    const end = raw.indexOf(close);
    if (start < 0 || end < 0 || end < start) {
      return "";
    }
    return raw.slice(start + open.length, end).replace(/^\n+|\n+$/g, "");
  }

  // Заменяет содержимое блока по id. Если блока нет — дописывает новый раздел в конец.
  private async replaceBlock(id: string, body: string): Promise<void> {
    const raw = (await this.readRaw()) ?? this.template();
    const { open, close } = markers(id);
    const start = raw.indexOf(open);
    const end = raw.indexOf(close);
    let next: string;
    if (start < 0 || end < 0 || end < start) {
      next = `${raw.trimEnd()}\n\n${open}\n${body}\n${close}\n`;
    } else {
      next = `${raw.slice(0, start + open.length)}\n${body}\n${raw.slice(end)}`;
    }
    await this.writeRaw(next);
  }

  private async writeRaw(content: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  }

  // Стартовый шаблон файла памяти.
  private template(): string {
    const block = (id: string, title: string, body: string) =>
      `## ${title}\n\n${markers(id).open}\n${body}\n${markers(id).close}\n`;
    return [
      "# MineAgent — Память проекта",
      "",
      "<!-- Этот файл — долговременная память проекта. Агент ведёт его автоматически.",
      "     Разделы «Конвенции», «Добавленный контент», «Решения», «Открытые вопросы»",
      "     можно править вручную — агент сохраняет ваши правки. Разделы с пометкой auto",
      "     (Идентичность, Журнал задач) перезаписываются агентом. -->",
      "",
      block("auto:identity", "Идентичность проекта", "_(заполнится при первом запуске индексатора)_"),
      block("section:conventions", SECTION_TITLES.conventions, EMPTY_PLACEHOLDER),
      block("section:content", SECTION_TITLES.content, EMPTY_PLACEHOLDER),
      block("section:decisions", SECTION_TITLES.decisions, EMPTY_PLACEHOLDER),
      block("section:open", SECTION_TITLES.open, EMPTY_PLACEHOLDER),
      block("auto:log", "Журнал задач", "_(история задач появится здесь)_")
    ].join("\n");
  }
}

function markers(id: string): { open: string; close: string } {
  return {
    open: `<!-- mineagent:${id} -->`,
    close: `<!-- /mineagent:${id} -->`
  };
}

// Разбирает строки-буллеты раздела, отбрасывая плейсхолдер и пустые строки.
function parseBullets(block: string): string[] {
  return block
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter((line) => line && line !== EMPTY_PLACEHOLDER && !line.startsWith("_("));
}

function truncate(text: string, max: number): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
