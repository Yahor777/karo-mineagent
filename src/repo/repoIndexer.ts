import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import type { MinecraftLoader, ProjectMap, RegistrySymbol, ResourceSummary } from "./projectMap";

/**
 * Быстрая проверка: является ли директория Minecraft-модом?
 * Проверяет наличие маркеров мода (fabric.mod.json, mods.toml, neoforge.mods.toml)
 * или Gradle-файла с forge/fabric/neoforge зависимостями.
 * Не индексирует весь проект — только читает корневые файлы.
 */
export async function isMinecraftModDir(dir: string): Promise<boolean> {
  try {
    const entries = new Set((await readdir(dir)).map((e) => e.toLowerCase()));
    // Маркеры мода — наличие любого из этих файлов в корне
    if (entries.has("fabric.mod.json") ||
        entries.has("mods.toml") ||
        entries.has("neoforge.mods.toml") ||
        entries.has("quilt.mod.json")) {
      return true;
    }
    // Проверяем build.gradle на наличие forge/fabric/neoforge плагинов
    for (const gradleName of ["build.gradle", "build.gradle.kts"]) {
      if (entries.has(gradleName)) {
        try {
          const text = await readFile(join(dir, gradleName), "utf8");
          if (/fabric-loom|net\.fabricmc|net\.minecraftforge|minecraftforge|net\.neoforged|neoforge|net\.fabricmc|quilt/i.test(text)) {
            return true;
          }
        } catch {
          // ignore read errors
        }
      }
    }
    // Проверяем settings.gradle на наличие мод-проекта в multi-project build
    for (const settingsName of ["settings.gradle", "settings.gradle.kts"]) {
      if (entries.has(settingsName)) {
        try {
          const text = await readFile(join(dir, settingsName), "utf8");
          if (/fabric-loom|net\.fabricmc|minecraftforge|neoforge/i.test(text)) {
            return true;
          }
        } catch {
          // ignore
        }
      }
    }
    // Проверяем gradle.properties — там может быть minecraft_version
    if (entries.has("gradle.properties")) {
      try {
        const text = await readFile(join(dir, "gradle.properties"), "utf8");
        if (/minecraft_version\s*=/i.test(text) &&
            !/minecraft_version\s*=\s*(?:\"\"|'')/i.test(text)) {
          // Дополнительная проверка: это не просто любой Gradle-проект,
          // а именно Minecraft-мод (есть forge/fabric/neo плагин или маркер)
          if (/forge|fabric|neoforge|quilt/i.test(text)) {
            return true;
          }
        }
      } catch {
        // ignore
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Среди списка workspace folders находит первый, который является Minecraft-модом.
 * Возвращает null если ни один не подходит.
 * Принимает пути как строки, чтобы не зависеть от vscode API.
 */
export async function findModWorkspaceFolder(
  folderPaths: string[]
): Promise<string | null> {
  for (const path of folderPaths) {
    if (await isMinecraftModDir(path)) {
      return path;
    }
  }
  return null;
}

const ignoredDirectories = new Set([
  ".git",
  ".gradle",
  ".idea",
  ".mineagent/runs",
  "build",
  "node_modules",
  "out",
  "run"
]);

const sourceExtensions = new Set([".java", ".kt"]);

export class RepoIndexer {
  public constructor(private readonly root: string) {}

  public async buildProjectMap(): Promise<ProjectMap> {
    const files = await this.walk(this.root);
    const textFiles = await this.readInterestingFiles(files);
    const gradleText = textFiles.filter((file) => file.path.endsWith("build.gradle") || file.path.endsWith("build.gradle.kts"));
    const resources = summarizeResources(this.root, files);

    return {
      indexedAt: new Date().toISOString(),
      root: this.root,
      loader: detectLoader(files, textFiles),
      minecraftVersion: detectMinecraftVersion(textFiles),
      javaVersion: detectJavaVersion(gradleText),
      gradleTasks: detectGradleTasks(textFiles),
      mainModId: detectModId(textFiles),
      registries: detectRegistries(textFiles),
      eventHandlers: detectByPattern(textFiles, /@SubscribeEvent|EventBusSubscriber|UseBlockCallback|ServerTickEvents|ClientTickEvents/g),
      networkPackets: detectByPattern(textFiles, /SimpleChannel|ClientPlayNetworking|ServerPlayNetworking|CustomPacketPayload|PacketDistributor/g),
      clientOnlyClasses: detectByPattern(textFiles, /Dist\.CLIENT|EnvType\.CLIENT|OnlyIn\(Dist\.CLIENT\)|client\./gi),
      resources,
      mixins: files.filter((file) => basename(file).toLowerCase().includes("mixin") && file.endsWith(".json")).map((file) => toProjectPath(this.root, file)),
      accessWideners: files.filter((file) => file.endsWith(".accesswidener")).map((file) => toProjectPath(this.root, file)),
      datagen: detectByPattern(textFiles, /DataGenerator|GatherDataEvent|FabricDataGenerator|DataProvider/g),
      architectureHints: detectArchitectureHints(textFiles)
    };
  }

  private async walk(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const result: string[] = [];
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      const projectPath = relative(this.root, fullPath).split(sep).join("/");
      if (entry.isDirectory()) {
        if (isIgnored(projectPath)) {
          continue;
        }
        result.push(...await this.walk(fullPath));
      } else {
        result.push(fullPath);
      }
    }
    return result;
  }

  private async readInterestingFiles(files: string[]): Promise<Array<{ path: string; text: string }>> {
    const interesting = files.filter((file) => {
      const projectPath = toProjectPath(this.root, file);
      return sourceExtensions.has(extname(file)) ||
        projectPath.endsWith("build.gradle") ||
        projectPath.endsWith("build.gradle.kts") ||
        projectPath.endsWith("gradle.properties") ||
        projectPath.endsWith("settings.gradle") ||
        projectPath.endsWith("settings.gradle.kts") ||
        projectPath.endsWith("mods.toml") ||
        projectPath.endsWith("neoforge.mods.toml") ||
        projectPath.endsWith("fabric.mod.json");
    });

    const result: Array<{ path: string; text: string }> = [];
    for (const file of interesting) {
      const info = await stat(file);
      if (info.size > 512_000) {
        continue;
      }
      result.push({
        path: toProjectPath(this.root, file),
        text: await readFile(file, "utf8")
      });
    }
    return result;
  }
}

function detectLoader(files: string[], textFiles: Array<{ path: string; text: string }>): MinecraftLoader {
  if (files.some((file) => file.endsWith("fabric.mod.json")) || textFiles.some((file) => /fabric-loom|net\.fabricmc/i.test(file.text))) {
    return "fabric";
  }
  if (files.some((file) => file.endsWith("neoforge.mods.toml")) || textFiles.some((file) => /net\.neoforged|neoform|neoforge/i.test(file.text))) {
    return "neoforge";
  }
  if (files.some((file) => file.endsWith("mods.toml")) || textFiles.some((file) => /net\.minecraftforge|minecraftforge/i.test(file.text))) {
    return "forge";
  }
  return "unknown";
}

function detectMinecraftVersion(textFiles: Array<{ path: string; text: string }>): string | undefined {
  const patterns = [
    /minecraft_version\s*=\s*["']?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i,
    /minecraft\s*["']?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i,
    /minecraft_version\s*:\s*["']([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i
  ];
  return firstMatch(textFiles, patterns);
}

function detectJavaVersion(textFiles: Array<{ path: string; text: string }>): string | undefined {
  const patterns = [
    /JavaLanguageVersion\.of\((\d+)\)/,
    /sourceCompatibility\s*=\s*['"]?(\d+)/,
    /targetCompatibility\s*=\s*['"]?(\d+)/,
    /java_version\s*=\s*["']?(\d+)/
  ];
  return firstMatch(textFiles, patterns);
}

function detectGradleTasks(textFiles: Array<{ path: string; text: string }>): string[] {
  const tasks = new Set(["build"]);
  for (const file of textFiles) {
    if (!file.path.includes("build.gradle")) {
      continue;
    }
    if (/runClient/i.test(file.text)) {
      tasks.add("runClient");
    }
    for (const match of file.text.matchAll(/tasks\.(?:register|create)\(["']([^"']+)["']/g)) {
      tasks.add(match[1]);
    }
  }
  return [...tasks].sort();
}

function detectModId(textFiles: Array<{ path: string; text: string }>): string | undefined {
  const gradleModId = firstMatch(textFiles, [/^mod_id\s*=\s*([a-z0-9_\-.]+)\s*$/im]);
  for (const file of textFiles) {
    if (!file.path.endsWith("mods.toml") && !file.path.endsWith("neoforge.mods.toml")) {
      continue;
    }
    const modBlock = firstTomlArrayBlock(file.text, "mods");
    const modId = modBlock?.match(/modId\s*=\s*["']([a-z0-9_\-.]+)["']/i)?.[1];
    if (modId) {
      return modId;
    }
    if (modBlock?.match(/modId\s*=\s*["']\$\{mod_id\}["']/i) && gradleModId) {
      return gradleModId;
    }
  }
  return gradleModId ?? firstMatch(textFiles, [
    /modId\s*=\s*["']([a-z0-9_\-.]+)["']/i,
    /"id"\s*:\s*"([a-z0-9_\-.]+)"/i,
    /archivesBaseName\s*=\s*["']([a-z0-9_\-.]+)["']/i
  ]);
}

function firstTomlArrayBlock(text: string, name: string): string | undefined {
  const header = `[[${name}]]`;
  const start = text.indexOf(header);
  if (start < 0) {
    return undefined;
  }
  const bodyStart = start + header.length;
  const nextHeader = text.indexOf("[[", bodyStart);
  return nextHeader < 0 ? text.slice(bodyStart) : text.slice(bodyStart, nextHeader);
}

function detectRegistries(textFiles: Array<{ path: string; text: string }>): RegistrySymbol[] {
  const registries: RegistrySymbol[] = [];
  for (const file of textFiles) {
    const add = (type: RegistrySymbol["type"], pattern: RegExp) => {
      for (const match of file.text.matchAll(pattern)) {
        registries.push({
          type,
          name: match[1],
          file: file.path
        });
      }
    };
    add("item", /(?:ITEMS|Items|Registry\.ITEM|BuiltInRegistries\.ITEM)[\s\S]{0,120}?["']([a-z0-9_\-:.]+)["']/g);
    add("block", /(?:BLOCKS|Blocks|Registry\.BLOCK|BuiltInRegistries\.BLOCK)[\s\S]{0,120}?["']([a-z0-9_\-:.]+)["']/g);
    add("entity", /(?:ENTITY_TYPES|EntityType|BuiltInRegistries\.ENTITY_TYPE)[\s\S]{0,120}?["']([a-z0-9_\-:.]+)["']/g);
    add("effect", /(?:MOB_EFFECTS|MobEffect|StatusEffects|BuiltInRegistries\.MOB_EFFECT)[\s\S]{0,120}?["']([a-z0-9_\-:.]+)["']/g);
  }
  return uniqueBy(registries, (item) => `${item.type}:${item.name}:${item.file}`);
}

function summarizeResources(root: string, files: string[]): ResourceSummary {
  const projectFiles = files.map((file) => toProjectPath(root, file));
  return {
    lang: projectFiles.filter((file) => file.includes("/lang/") && file.endsWith(".json")),
    models: projectFiles.filter((file) => file.includes("/models/") && file.endsWith(".json")),
    textures: projectFiles.filter((file) => file.includes("/textures/") && /\.(png|mcmeta)$/i.test(file)),
    recipes: projectFiles.filter((file) => file.includes("/recipes/") && file.endsWith(".json")),
    lootTables: projectFiles.filter((file) => file.includes("/loot_tables/") && file.endsWith(".json")),
    tags: projectFiles.filter((file) => file.includes("/tags/") && file.endsWith(".json")),
    sounds: projectFiles.filter((file) => file.includes("/sounds/") || file.endsWith("sounds.json"))
  };
}

function detectArchitectureHints(textFiles: Array<{ path: string; text: string }>): string[] {
  const hints = new Set<string>();
  for (const file of textFiles) {
    if (/DeferredRegister|RegistryObject/.test(file.text)) hints.add("Forge-style deferred registration");
    if (/FabricLoader|ModInitializer|ClientModInitializer/.test(file.text)) hints.add("Fabric initializer pattern");
    if (/@Mod\(|IEventBus/.test(file.text)) hints.add("Forge/NeoForge mod entrypoint pattern");
    if (/Capability|AttachmentType/.test(file.text)) hints.add("Persistent ability/state capability pattern");
    if (/GeoModel|GeckoLib|AnimationController/.test(file.text)) hints.add("GeckoLib animation integration");
  }
  return [...hints].sort();
}

function detectByPattern(textFiles: Array<{ path: string; text: string }>, pattern: RegExp): string[] {
  return textFiles.filter((file) => pattern.test(file.text)).map((file) => file.path);
}

function firstMatch(textFiles: Array<{ path: string; text: string }>, patterns: RegExp[]): string | undefined {
  for (const file of textFiles) {
    for (const pattern of patterns) {
      const match = pattern.exec(file.text);
      if (match?.[1]) {
        return match[1];
      }
    }
  }
  return undefined;
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

function isIgnored(projectPath: string): boolean {
  return [...ignoredDirectories].some((ignored) => projectPath === ignored || projectPath.startsWith(`${ignored}/`));
}

function toProjectPath(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}
