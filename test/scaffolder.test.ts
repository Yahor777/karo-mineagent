import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  Scaffolder,
  resolveLoaderVersion,
  resolvePackFormat
} from "../src/scaffolder/scaffolder";
import { GradleDownloader } from "../src/utils/gradleDownloader";

describe("Scaffolder & GradleDownloader", () => {
  async function freshRoot(): Promise<string> {
    return mkdtemp(join(tmpdir(), "mineagent-scaffold-"));
  }

  // Заглушка скачивания jar (чтобы не дёргать сеть в тестах).
  function stubDownload(): () => void {
    const original = (GradleDownloader as any).downloadFile;
    (GradleDownloader as any).downloadFile = async (_url: string, dest: string) => {
      const fs = require("node:fs");
      fs.writeFileSync(dest, "mock-jar-content");
    };
    return () => {
      (GradleDownloader as any).downloadFile = original;
    };
  }

  it("успешно скаффолдит NeoForge проект", async () => {
    const root = await freshRoot();
    const restore = stubDownload();
    try {
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
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("успешно скаффолдит Fabric проект", async () => {
    const root = await freshRoot();
    const restore = stubDownload();
    try {
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
      // fabric.mod.json не должен ссылаться на иконку, которую scaffolder не создаёт.
      assert.ok(!fabricJson.includes("icon.png"));
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  // --- Версионная корректность (регрессия захардкоженных версий) ---

  it("NeoForge build.gradle использует версию loader'а, соответствующую MC", async () => {
    const root = await freshRoot();
    const restore = stubDownload();
    try {
      await Scaffolder.scaffold({
        rootDir: root,
        loader: "neoforge",
        minecraftVersion: "1.21.1",
        modId: "neov",
        version: "1.0.0"
      });
      const build = await readFile(join(root, "build.gradle"), "utf8");
      // Версия NeoForge для 1.21.1 = 21.1.77, не должна быть пустой/undefined.
      assert.ok(build.includes('version = "21.1.77"'), "NeoForge version must resolve to 21.1.77 for MC 1.21.1");
      assert.ok(!build.includes("undefined"), "build.gradle must not contain 'undefined'");
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Forge build.gradle привязывает forge-версию к запрошенной версии MC", async () => {
    const root = await freshRoot();
    const restore = stubDownload();
    try {
      await Scaffolder.scaffold({
        rootDir: root,
        loader: "forge",
        minecraftVersion: "1.20.1",
        modId: "forgev",
        version: "1.0.0"
      });
      const build = await readFile(join(root, "build.gradle"), "utf8");
      // Forge build 47.3.0 соответствует MC 1.20.1.
      assert.ok(
        build.includes("net.minecraftforge:forge:1.20.1-47.3.0"),
        "Forge dependency must couple MC version with the matching forge build"
      );
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("явный loaderVersion переопределяет карту версий", async () => {
    const root = await freshRoot();
    const restore = stubDownload();
    try {
      await Scaffolder.scaffold({
        rootDir: root,
        loader: "neoforge",
        minecraftVersion: "1.21.1",
        modId: "ovr",
        version: "1.0.0",
        loaderVersion: "21.1.99"
      });
      const build = await readFile(join(root, "build.gradle"), "utf8");
      assert.ok(build.includes('version = "21.1.99"'), "explicit loaderVersion must win");
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scaffold падает с понятной ошибкой для неизвестной версии MC без override", async () => {
    const root = await freshRoot();
    const restore = stubDownload();
    try {
      await assert.rejects(
        () => Scaffolder.scaffold({
          rootDir: root,
          loader: "forge",
          minecraftVersion: "1.99.9",
          modId: "unknownmc",
          version: "1.0.0"
        }),
        /неизвестна версия Forge для Minecraft 1\.99\.9/
      );
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pack_format соответствует версии Minecraft", async () => {
    // unit-проверки резолвера pack_format.
    assert.equal(resolvePackFormat("1.20.1"), 15);
    assert.equal(resolvePackFormat("1.21.1"), 34);
    assert.equal(resolvePackFormat("1.21"), 34);
    // Фоллбэк по minor-ветке для неизвестной точечной версии.
    assert.equal(resolvePackFormat("1.21.5"), 34);
    assert.equal(resolvePackFormat("1.20.9"), 15);
  });

  it("pack.mcmeta пишет pack_format, соответствующий MC (1.21.1 → 34)", async () => {
    const root = await freshRoot();
    const restore = stubDownload();
    try {
      await Scaffolder.scaffold({
        rootDir: root,
        loader: "fabric",
        minecraftVersion: "1.21.1",
        modId: "packfmt",
        version: "1.0.0"
      });
      const mcmeta = await readFile(join(root, "src/main/resources/pack.mcmeta"), "utf8");
      assert.ok(mcmeta.includes('"pack_format": 34'), "pack_format for 1.21.1 must be 34, not the old hardcoded 15");
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolveLoaderVersion: карта и override", () => {
    assert.equal(resolveLoaderVersion("neoforge", "1.21.1"), "21.1.77");
    assert.equal(resolveLoaderVersion("forge", "1.20.1"), "47.3.0");
    assert.equal(resolveLoaderVersion("forge", "1.20.1", "47.9.9"), "47.9.9");
    assert.throws(() => resolveLoaderVersion("neoforge", "1.18.2"), /неизвестна версия NeoForge/);
  });
});