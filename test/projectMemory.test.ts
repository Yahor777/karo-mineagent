import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectMemoryService } from "../src/memory/projectMemory";

// Фаза 1: тесты живой памяти проекта (.mineagent/project.md).
describe("ProjectMemoryService", () => {
  async function freshRoot(): Promise<string> {
    return mkdtemp(join(tmpdir(), "mineagent-mem-"));
  }

  it("создаёт файл памяти из шаблона", async () => {
    const m = new ProjectMemoryService(await freshRoot());
    await m.ensure();
    const raw = await m.readRaw();
    assert.ok(raw && raw.includes("# MineAgent"));
    assert.ok(raw.includes("mineagent:auto:identity"));
  });

  it("синхронизирует идентичность идемпотентно (без дублей)", async () => {
    const m = new ProjectMemoryService(await freshRoot());
    await m.syncIdentity({ loader: "neoforge", minecraftVersion: "1.21.1", mainModId: "kimijjk" });
    await m.syncIdentity({ loader: "neoforge", minecraftVersion: "1.21.1", mainModId: "kimijjk", registriesCount: 14 });
    const raw = (await m.readRaw()) ?? "";
    assert.equal((raw.match(/Загрузчик: neoforge/g) ?? []).length, 1);
    assert.ok(raw.includes("registry): 14"));
  });

  it("пропускает пустые и unknown значения в идентичности", async () => {
    const m = new ProjectMemoryService(await freshRoot());
    await m.syncIdentity({ loader: "unknown", minecraftVersion: "", mainModId: "kimijjk" });
    const raw = (await m.readRaw()) ?? "";
    assert.ok(!raw.includes("Загрузчик: unknown"));
    assert.ok(raw.includes("Mod ID: kimijjk"));
  });

  it("дедуплицирует записи разделов", async () => {
    const m = new ProjectMemoryService(await freshRoot());
    const first = await m.appendToSection("content", "Добавлен предмет cursed_charm");
    const second = await m.appendToSection("content", "Добавлен предмет cursed_charm");
    assert.equal(first, true);
    assert.equal(second, false);
    const raw = (await m.readRaw()) ?? "";
    assert.equal((raw.match(/cursed_charm/g) ?? []).length, 1);
  });

  it("ведёт журнал свежими записями сверху и ограничивает длину", async () => {
    const m = new ProjectMemoryService(await freshRoot());
    for (let i = 0; i < 25; i += 1) {
      await m.appendRunLog({ at: `2026-06-26T00:00:${String(i).padStart(2, "0")}Z`, mode: "build", task: `задача ${i}`, summary: `итог ${i}` }, 20);
    }
    const raw = (await m.readRaw()) ?? "";
    assert.ok(raw.includes("задача 24"));
    assert.ok(!raw.includes("задача 0\n")); // старейшие вытеснены
    assert.ok(!raw.includes("_(история задач")); // плейсхолдер убран
    const entries = (raw.match(/\[build\]/g) ?? []).length;
    assert.equal(entries, 20);
  });

  it("рендерит компактный блок памяти для промпта", async () => {
    const root = await freshRoot();
    const m = new ProjectMemoryService(root);
    await m.syncIdentity({ loader: "neoforge", mainModId: "kimijjk" });
    await m.appendToSection("decisions", "Версии берём из gradle.properties");
    const rendered = await m.renderForPrompt();
    assert.ok(rendered.includes("Идентичность проекта"));
    assert.ok(rendered.includes("kimijjk"));
    assert.ok(rendered.includes("gradle.properties"));
    assert.ok(!rendered.includes("<!--")); // маркеры-комментарии вычищены
  });
});
