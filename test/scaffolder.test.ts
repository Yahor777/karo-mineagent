import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Scaffolder } from "../src/scaffolder/scaffolder";
import { GradleDownloader } from "../src/utils/gradleDownloader";

describe("Scaffolder & GradleDownloader", () => {
  async function freshRoot(): Promise<string> {
    return mkdtemp(join(tmpdir(), "mineagent-scaffold-"));
  }

  it("успешно скаффолдит NeoForge проект", async () => {
    const root = await freshRoot();
    try {
      // Подменим скачивание jar-файла заглушкой для тестов, чтобы не дергать сеть
      const originalDownload = (GradleDownloader as any).downloadFile;
      (GradleDownloader as any).downloadFile = async (url: string, dest: string) => {
        const fs = require("node:fs");
        fs.writeFileSync(dest, "mock-jar-content");
      };

      await Scaffolder.scaffold({
        rootDir: root,
        loader: "neoforge",
        minecraftVersion: "1.21.1",
        modId: "testneoforge",
        groupId: "com.test.neoforge",
        version: "1.2.3",
        javaVersion: "21"
      });

      assert.ok(existsSync(join(root, "build.gradle")));
      assert.ok(existsSync(join(root, "settings.gradle")));
      assert.ok(existsSync(join(root, "gradle.properties")));
      assert.ok(existsSync(join(root, "gradlew")));
      assert.ok(existsSync(join(root, "gradlew.bat")));
      assert.ok(existsSync(join(root, "gradle/wrapper/gradle-wrapper.properties")));
      assert.ok(existsSync(join(root, "gradle/wrapper/gradle-wrapper.jar")));
      assert.ok(existsSync(join(root, "src/main/resources/pack.mcmeta")));
      assert.ok(existsSync(join(root, "src/main/resources/META-INF/neoforge.mods.toml")));
      assert.ok(existsSync(join(root, "src/main/java/com/test/neoforge/ExampleMod.java")));

      const buildContent = await readFile(join(root, "build.gradle"), "utf8");
      assert.ok(buildContent.includes("net.neoforged.moddev"));
      assert.ok(buildContent.includes("1.2.3"));

      const propertiesContent = await readFile(join(root, "gradle.properties"), "utf8");
      assert.ok(propertiesContent.includes("minecraft_version=1.21.1"));

      // Восстанавливаем оригинальный метод
      (GradleDownloader as any).downloadFile = originalDownload;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("успешно скаффолдит Fabric проект", async () => {
    const root = await freshRoot();
    try {
      const originalDownload = (GradleDownloader as any).downloadFile;
      (GradleDownloader as any).downloadFile = async (url: string, dest: string) => {
        const fs = require("node:fs");
        fs.writeFileSync(dest, "mock-jar-content");
      };

      await Scaffolder.scaffold({
        rootDir: root,
        loader: "fabric",
        minecraftVersion: "1.21.1",
        modId: "testfabric",
        groupId: "com.test.fabric",
        version: "1.0.0"
      });

      assert.ok(existsSync(join(root, "build.gradle")));
      assert.ok(existsSync(join(root, "src/main/resources/fabric.mod.json")));
      assert.ok(existsSync(join(root, "src/main/java/com/test/fabric/ExampleMod.java")));

      const fabricJson = await readFile(join(root, "src/main/resources/fabric.mod.json"), "utf8");
      assert.ok(fabricJson.includes("testfabric"));
      assert.ok(fabricJson.includes("com.test.fabric.ExampleMod"));

      (GradleDownloader as any).downloadFile = originalDownload;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
