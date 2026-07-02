import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GradleDownloader } from "../utils/gradleDownloader";

export interface ScaffoldOptions {
  rootDir: string;
  loader: "forge" | "fabric" | "neoforge";
  minecraftVersion: string;
  modId: string;
  groupId?: string;
  version?: string;
  javaVersion?: string;
  // Явная версия загрузчика (Forge/NeoForge). Если не задана — берётся из
  // KNOWN_*_VERSIONS по minecraftVersion; для неизвестной версии scaffold
  // бросает понятную ошибку вместо генерации заведомо битого build.gradle.
  loaderVersion?: string;
}

// Известные (проверенные) версии загрузчиков по версии Minecraft. Раньше эти
// значения были захардкожены в build.gradle (NeoForge 21.1.77, Forge 47.3.0) и
// игнорировали options.minecraftVersion — скаффолд под любую другую версию MC
// давал нерабочую/неразрешимую зависимость. Теперь версия резолвится по
// карте проверенных значений либо по явному override.
const KNOWN_NEOFORGE_VERSIONS: Record<string, string> = {
  "1.21.1": "21.1.77"
};

const KNOWN_FORGE_VERSIONS: Record<string, string> = {
  "1.20.1": "47.3.0"
};

// pack_format ресурс-пака зависит от версии Minecraft (раньше был захардкожен
// 15 = MC 1.20.1, из-за чего ресурсы для 1.21.1 ловили предупреждение о
// неверном формате). Значения задокументированы Mojang и стабильны.
const RESOURCE_PACK_FORMATS: Record<string, number> = {
  "1.20.1": 15,
  "1.20.2": 18,
  "1.20.3": 22,
  "1.20.4": 22,
  "1.20.5": 32,
  "1.20.6": 32,
  "1.21": 34,
  "1.21.1": 34
};

// Резолвит версию загрузчика. Приоритет: явный override > карта проверенных
// версий. Для неизвестной версии MC без override — понятная ошибка (fail-fast),
// чтобы не сгенерировать build.gradle с неразрешимой зависимостью.
export function resolveLoaderVersion(
  loader: "forge" | "fabric" | "neoforge",
  minecraftVersion: string,
  override?: string
): string {
  if (override && override.trim()) {
    return override.trim();
  }
  const map = loader === "neoforge" ? KNOWN_NEOFORGE_VERSIONS : KNOWN_FORGE_VERSIONS;
  const known = map[minecraftVersion];
  if (known) {
    return known;
  }
  const loaderName = loader === "neoforge" ? "NeoForge" : "Forge";
  const supported = Object.keys(map).join(", ") || "(нет)";
  throw new Error(
    `Scaffolder: неизвестна версия ${loaderName} для Minecraft ${minecraftVersion}. ` +
    `Передай явный loaderVersion в опциях scaffold(). Известные версии MC: ${supported}.`
  );
}

// pack_format по версии MC: точное совпадение → карта; иначе фоллбэк по
// minor-ветке (1.21.x → 34, 1.20.x → 15 baseline). Неизвестная ветка → самый
// свежий известный формат (лучше, чем заведомо устаревший хардкод).
export function resolvePackFormat(minecraftVersion: string): number {
  const exact = RESOURCE_PACK_FORMATS[minecraftVersion];
  if (exact !== undefined) {
    return exact;
  }
  if (minecraftVersion.startsWith("1.21")) {
    return 34;
  }
  if (minecraftVersion.startsWith("1.20")) {
    return 15;
  }
  return 34;
}

export class Scaffolder {
  public static async scaffold(options: ScaffoldOptions): Promise<void> {
    const groupId = options.groupId || "com.example." + options.modId;
    const version = options.version || "1.0.0";
    const javaVersion = options.javaVersion || (options.minecraftVersion.startsWith("1.20") ? "17" : "21");

    // Резолвим версию загрузчика ДО создания файлов: для неизвестной версии MC
    // это бросит понятную ошибку без частичного scaffold (fail-fast).
    const loaderVersion = options.loader === "fabric"
      ? undefined
      : resolveLoaderVersion(options.loader, options.minecraftVersion, options.loaderVersion);
    const packFormat = resolvePackFormat(options.minecraftVersion);

    // Создаем базовые директории
    const packagePath = groupId.replace(/\./g, "/");
    const srcDir = join(options.rootDir, "src", "main", "java", packagePath);
    const resourcesDir = join(options.rootDir, "src", "main", "resources");
    await mkdir(srcDir, { recursive: true });
    await mkdir(resourcesDir, { recursive: true });

    // 1. Генерируем Gradle-файлы
    await this.generateGradleFiles(options.rootDir, options.loader, options.minecraftVersion, options.modId, groupId, version, javaVersion, loaderVersion);

    // 2. Генерируем метаданные мода в зависимости от загрузчика
    await this.generateModMetadata(options.rootDir, resourcesDir, options.loader, options.modId, version, groupId, packFormat);

    // 3. Генерируем базовый Java-класс
    await this.generateBaseClass(srcDir, options.loader, options.modId, groupId);

    // 4. Устанавливаем Gradle Wrapper
    await GradleDownloader.ensureWrapper(options.rootDir, "8.8");
  }

  private static async generateGradleFiles(
    rootDir: string,
    loader: "forge" | "fabric" | "neoforge",
    mcVersion: string,
    modId: string,
    groupId: string,
    version: string,
    javaVersion: string,
    loaderVersion?: string
  ): Promise<void> {
    const settingsGradle = `rootProject.name = "${modId}"\n`;
    await writeFile(join(rootDir, "settings.gradle"), settingsGradle, "utf8");

    let buildGradle = "";
    let gradleProperties = "";

    if (loader === "neoforge") {
      buildGradle = `plugins {
    id 'net.neoforged.moddev' version '1.0.21'
    id 'java'
}

version = "${version}"
group = "${groupId}"

neoForge {
    version = "${loaderVersion}" // NeoForge для MC ${mcVersion}

    runs {
        client {
            client()
        }
    }

    mods {
        ${modId} {
            sourceSet sourceSets.main
        }
    }
}

repositories {
    mavenCentral()
    maven { url = "https://maven.neoforged.net/releases" }
}

dependencies {
}

java {
    sourceCompatibility = JavaVersion.VERSION_${javaVersion}
    targetCompatibility = JavaVersion.VERSION_${javaVersion}
    toolchain {
        languageVersion = JavaLanguageVersion.of(${javaVersion})
    }
}

processResources {
    inputs.property "version", project.version
    filesMatching("META-INF/neoforge.mods.toml") {
        expand "version": project.version
    }
}
`;
      gradleProperties = `minecraft_version=${mcVersion}
java_version=${javaVersion}
`;
    } else if (loader === "forge") {
      buildGradle = `plugins {
    id 'net.minecraftforge.gradle' version '[6.0.16,6.2)'
    id 'java'
}

version = "${version}"
group = "${groupId}"

minecraft {
    mappings channel: 'official', version: '${mcVersion}'
    runs {
        client {
            workingDirectory project.file('run')
            property 'forge.logging.markers', 'REGISTRIES'
            property 'forge.logging.console.level', 'debug'
            mods {
                ${modId} {
                    source sourceSets.main
                }
            }
        }
    }
}

repositories {
    mavenCentral()
    maven { url = "https://maven.minecraftforge.net/" }
}

dependencies {
    minecraft 'net.minecraftforge:forge:${mcVersion}-${loaderVersion}'
}

java {
    sourceCompatibility = JavaVersion.VERSION_${javaVersion}
    targetCompatibility = JavaVersion.VERSION_${javaVersion}
    toolchain {
        languageVersion = JavaLanguageVersion.of(${javaVersion})
    }
}

processResources {
    inputs.property "version", project.version
    filesMatching("META-INF/mods.toml") {
        expand "version": project.version
    }
}
`;
      gradleProperties = `minecraft_version=${mcVersion}
java_version=${javaVersion}
`;
    } else if (loader === "fabric") {
      buildGradle = `plugins {
    id 'fabric-loom' version '1.7-SNAPSHOT'
    id 'java'
}

version = "${version}"
group = "${groupId}"

repositories {
    mavenCentral()
    maven { url = "https://maven.fabricmc.net/" }
}

dependencies {
    minecraft "com.mojang:minecraft:${mcVersion}"
    mappings "net.fabricmc:yarn:${mcVersion}+build.3:v2"
    modImplementation "net.fabricmc:fabric-loader:0.16.0"
    modImplementation "net.fabricmc.fabric-api:fabric-api:0.102.0+1.21.1"
}

java {
    sourceCompatibility = JavaVersion.VERSION_${javaVersion}
    targetCompatibility = JavaVersion.VERSION_${javaVersion}
    toolchain {
        languageVersion = JavaLanguageVersion.of(${javaVersion})
    }
}

processResources {
    inputs.property "version", project.version
    filesMatching("fabric.mod.json") {
        expand "version": project.version
    }
}
`;
      gradleProperties = `minecraft_version=${mcVersion}
java_version=${javaVersion}
`;
    }

    await writeFile(join(rootDir, "build.gradle"), buildGradle, "utf8");
    await writeFile(join(rootDir, "gradle.properties"), gradleProperties, "utf8");
  }

  private static async generateModMetadata(
    rootDir: string,
    resourcesDir: string,
    loader: "forge" | "fabric" | "neoforge",
    modId: string,
    version: string,
    groupId: string,
    packFormat: number
  ): Promise<void> {
    const metaDir = join(resourcesDir, "META-INF");
    await mkdir(metaDir, { recursive: true });

    // pack.mcmeta обязателен для ресурсов; pack_format зависит от версии MC.
    const packMcMeta = `{
    "pack": {
        "description": "${modId} resources",
        "pack_format": ${packFormat}
    }
}
`;
    await writeFile(join(resourcesDir, "pack.mcmeta"), packMcMeta, "utf8");

    if (loader === "neoforge") {
      const modsToml = `modLoader="javafml"
loaderVersion="[4,)"
license="MIT"

[[mods]]
modId="${modId}"
version="\${version}"
displayName="${modId}"
authors="MineAgent"
description="${modId} Minecraft Mod."
`;
      await writeFile(join(metaDir, "neoforge.mods.toml"), modsToml, "utf8");
    } else if (loader === "forge") {
      const modsToml = `modLoader="javafml"
loaderVersion="[47,)"
license="MIT"

[[mods]]
modId="${modId}"
version="\${version}"
displayName="${modId}"
authors="MineAgent"
description="${modId} Minecraft Mod."
`;
      await writeFile(join(metaDir, "mods.toml"), modsToml, "utf8");
    } else if (loader === "fabric") {
      const fabricModJson = `{
  "schemaVersion": 1,
  "id": "${modId}",
  "version": "\${version}",
  "name": "${modId}",
  "description": "${modId} Minecraft Mod.",
  "authors": [
    "MineAgent"
  ],
  "contact": {},
  "license": "MIT",
  "environment": "*",
  "entrypoints": {
    "main": [
      "${groupId}.ExampleMod"
    ]
  },
  "mixins": [],
  "depends": {
    "fabricloader": ">=0.16.0",
    "minecraft": ">=1.21.1",
    "fabric-api": "*"
  }
}
`;
      await writeFile(join(resourcesDir, "fabric.mod.json"), fabricModJson, "utf8");

      // Создаем assets папку
      const assetsDir = join(resourcesDir, "assets", modId, "lang");
      await mkdir(assetsDir, { recursive: true });
      const enUsJson = `{\n  "modmenu.summaryTranslation.${modId}": "${modId} Mod"\n}\n`;
      await writeFile(join(assetsDir, "en_us.json"), enUsJson, "utf8");
    }
  }

  private static async generateBaseClass(
    srcDir: string,
    loader: "forge" | "fabric" | "neoforge",
    modId: string,
    groupId: string
  ): Promise<void> {
    const classContent = loader === "fabric"
      ? `package ${groupId};

import net.fabricmc.api.ModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class ExampleMod implements ModInitializer {
    public static final String MOD_ID = "${modId}";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    @Override
    public void onInitialize() {
        LOGGER.info("Hello Fabric world from " + MOD_ID + "!");
    }
}
`
      : `package ${groupId};

${loader === "neoforge" ? "import net.neoforged.fml.common.Mod;" : "import net.minecraftforge.fml.common.Mod;"}
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

@Mod(ExampleMod.MOD_ID)
public class ExampleMod {
    public static final String MOD_ID = "${modId}";
    private static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    public ExampleMod() {
        LOGGER.info("Hello Minecraft world from " + MOD_ID + "!");
    }
}
`;

    await writeFile(join(srcDir, "ExampleMod.java"), classContent, "utf8");
  }
}