import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { EmbeddingService } from "../providers/embeddingService";
import type { Skill, SkillManifest, SkillMatchResult } from "./types";

// Этап 6: SkillService — каталог .mineagent/skills/*.md + matching.
//
// Загрузка: читает все .md из skills-директории, парсит YAML frontmatter.
// Matching: embedding задачи → embedding skill descriptions → top-K.
// Создание через ИИ: generateSkill(topic, projectContext) → модель пишет .md.
//
// Авто + ручной override:
//   - retrieval выбирает top-K релевантных скиллов
//   - юзер видит выбор, может pinned (всегда) или excluded (никогда)
//   - pinned добавляются к retrieval-выбору

const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

export class SkillService {
  public constructor(
    private readonly skillsDir: string,
    private readonly embeddingService?: EmbeddingService
  ) {}

  // Загружает все скиллы из директории.
  public async list(): Promise<Skill[]> {
    try {
      const files = await readdir(this.skillsDir);
      const skills: Skill[] = [];
      for (const file of files) {
        if (!file.endsWith(".md")) {
          continue;
        }
        const path = join(this.skillsDir, file);
        const skill = await this.loadSkill(path, file);
        if (skill) {
          skills.push(skill);
        }
      }
      return skills;
    } catch {
      return [];
    }
  }

  // Загружает один скилл по имени.
  public async get(name: string): Promise<Skill | undefined> {
    const path = join(this.skillsDir, `${name}.md`);
    return this.loadSkill(path, `${name}.md`);
  }

  // Создаёт новый скилл (markdown + frontmatter). Используется для AI-генерации.
  public async create(manifest: SkillManifest, content: string): Promise<Skill> {
    const path = join(this.skillsDir, `${manifest.name}.md`);
    const fileContent = this.serializeSkill(manifest, content);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, fileContent, "utf8");
    return {
      ...manifest,
      content,
      path,
      embedding: this.embeddingService
        ? await this.embeddingService.embed(`${manifest.name} ${manifest.description} ${manifest.triggers.join(" ")}`)
        : undefined
    };
  }

  // Удаляет скилл по имени. readOnly скиллы нельзя удалить.
  public async remove(name: string): Promise<void> {
    const skill = await this.get(name);
    if (!skill) {
      throw new Error(`Скилл «${name}» не найден.`);
    }
    if (skill.readOnly) {
      throw new Error(`Скилл «${name}» защищён от удаления (readOnly).`);
    }
    const { unlink } = await import("node:fs/promises");
    await unlink(join(this.skillsDir, `${name}.md`));
  }

  // Matching: возвращает top-K релевантных скиллов для задачи.
  // pinnedSkills — имена скиллов, выбранных пользователем явно (всегда включаются).
  // excludedSkills — имена скиллов, отклонённых пользователем (исключаются).
  public async match(
    query: string,
    topK: number = 3,
    pinnedSkills: string[] = [],
    excludedSkills: string[] = []
  ): Promise<SkillMatchResult[]> {
    const skills = await this.list();
    if (!skills.length || topK <= 0) {
      return this.applyPinned([], pinnedSkills, excludedSkills);
    }

    // Исключаем отклонённые.
    const candidates = skills.filter((s) => !excludedSkills.includes(s.name));

    // Keyword pre-filter: оставляем скиллы где хотя бы одно слово из query
    // встречается в name/description/triggers.
    const queryWords = extractKeywords(query);
    let filtered = candidates.filter((skill) => {
      const haystack = `${skill.name} ${skill.description} ${skill.triggers.join(" ")}`.toLowerCase();
      return queryWords.some((word) => haystack.includes(word));
    });
    if (!filtered.length) {
      filtered = [...candidates];
    }

    // Embedding ranking если есть сервис.
    let ranked: SkillMatchResult[];
    if (this.embeddingService) {
      const queryEmbedding = await this.embeddingService.embed(query);
      const embeddings: number[][] = [];
      const skillsWithEmbedding: Skill[] = [];
      for (const skill of filtered) {
        if (!skill.embedding) {
          skill.embedding = await this.embeddingService!.embed(
            `${skill.name} ${skill.description} ${skill.triggers.join(" ")}`
          );
        }
        embeddings.push(skill.embedding!);
        skillsWithEmbedding.push(skill);
      }
      const scores = EmbeddingService.rankBySimilarity(queryEmbedding, embeddings, topK);
      ranked = scores.map(({ index, score }) => ({
        skill: skillsWithEmbedding[index]!,
        score,
        pinned: false
      }));
    } else {
      // Без embedding — возвращаем topK без ranking.
      ranked = filtered.slice(0, topK).map((skill) => ({ skill, score: 0, pinned: false }));
    }

    return this.applyPinned(ranked, pinnedSkills, excludedSkills);
  }

  // Применяет pinned (явно выбранные) и excluded (отклонённые) к результатам.
  private async applyPinned(
    ranked: SkillMatchResult[],
    pinnedSkills: string[],
    excludedSkills: string[]
  ): Promise<SkillMatchResult[]> {
    if (!pinnedSkills.length) {
      return ranked;
    }
    const skills = await this.list();
    const pinned = pinnedSkills
      .filter((name) => !excludedSkills.includes(name))
      .map((name) => skills.find((s) => s.name === name))
      .filter((s): s is Skill => Boolean(s))
      .map((skill) => ({ skill, score: 1, pinned: true }));
    // Объединяем, убираем дубликаты (pinned побеждает).
    const byName = new Map<string, SkillMatchResult>();
    for (const r of ranked) {
      byName.set(r.skill.name, r);
    }
    for (const p of pinned) {
      byName.set(p.skill.name, p);
    }
    return Array.from(byName.values()).sort((a, b) => {
      // pinned всегда наверху.
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.score - a.score;
    });
  }

  // Загружает и парсит .md с frontmatter.
  private async loadSkill(path: string, fileName: string): Promise<Skill | undefined> {
    try {
      const content = await readFile(path, "utf8");
      const parsed = this.parseSkill(content, fileName);
      if (!parsed) {
        return undefined;
      }
      return { ...parsed, path };
    } catch {
      return undefined;
    }
  }

  // Парсит markdown с YAML frontmatter.
  private parseSkill(content: string, fileName: string): Skill | undefined {
    const match = content.match(FRONTMATTER_REGEX);
    if (!match) {
      // Без frontmatter — используем имя файла как name, без description/triggers.
      return {
        name: fileName.replace(/\.md$/, ""),
        description: "",
        triggers: [],
        content: content.trim(),
        path: ""
      };
    }
    const frontmatter = match[1]!;
    const body = match[2]!.trim();
    const manifest = this.parseFrontmatter(frontmatter);
    return {
      name: manifest.name || fileName.replace(/\.md$/, ""),
      description: manifest.description || "",
      triggers: manifest.triggers || [],
      readOnly: manifest.readOnly,
      content: body,
      path: ""
    };
  }

  // Простой YAML-парсер для плоских key:value и key:[list] (без вложенностей).
  private parseFrontmatter(yaml: string): SkillManifest & { readOnly?: boolean } {
    const result: Record<string, unknown> = {};
    for (const line of yaml.split("\n")) {
      const match = line.match(/^(\w+):\s*(.*)$/);
      if (!match) {
        continue;
      }
      const key = match[1]!;
      let value = match[2]!.trim();
      // List: [a, b, c]
      if (value.startsWith("[") && value.endsWith("]")) {
        value = value.slice(1, -1);
        result[key] = value.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      } else {
        result[key] = value.replace(/^["']|["']$/g, "");
      }
    }
    return {
      name: String(result.name ?? ""),
      description: String(result.description ?? ""),
      triggers: Array.isArray(result.triggers) ? result.triggers as string[] : [],
      readOnly: Boolean(result.readOnly)
    };
  }

  // Сериализует Skill в markdown с frontmatter.
  private serializeSkill(manifest: SkillManifest, content: string): string {
    const triggers = `[${manifest.triggers.join(", ")}]`;
    const readOnly = manifest.readOnly ? `\nreadOnly: true` : "";
    return `---\nname: ${manifest.name}\ndescription: ${manifest.description}\ntriggers: ${triggers}${readOnly}\n---\n\n${content}\n`;
  }
}

function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "and", "or", "in", "on", "at", "to", "for",
    "of", "with", "это", "для", "на", "в", "с", "как", "что", "и", "или", "не"
  ]);
  return text
    .toLowerCase()
    .split(/[\s,.;:!?()[]{}`"']+/)
    .filter((word) => word.length > 2 && !stopWords.has(word))
    .filter((word, index, arr) => arr.indexOf(word) === index);
}
