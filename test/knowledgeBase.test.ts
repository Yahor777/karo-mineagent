import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { KnowledgeBaseService, isValidCategory } from "../src/knowledge/knowledgeBase";
import type { KnowledgeBase, KnowledgeBaseDeps } from "../src/knowledge/types";

// Этап 6: тесты KnowledgeBaseService — CRUD, search (keyword pre-filter), категории.

function makeFixture(): { service: KnowledgeBaseService; state: KnowledgeBase } {
  const state: KnowledgeBase = { entries: [], lastUpdated: null };
  const deps: KnowledgeBaseDeps = {
    readBase: async () => JSON.parse(JSON.stringify(state)),
    writeBase: async (base) => {
      state.entries = base.entries;
      state.lastUpdated = base.lastUpdated;
    }
  };
  return { service: new KnowledgeBaseService(deps), state };
}

describe("KnowledgeBaseService (Этап 6)", () => {
  it("list возвращает пустой массив по умолчанию", async () => {
    const { service } = makeFixture();
    assert.deepEqual(await service.list(), []);
  });

  it("add добавляет запись с auto-generated id", async () => {
    const { service, state } = makeFixture();
    const entry = await service.add({
      url: "https://docs.minecraftforge.net/events",
      title: "Forge Events",
      category: "api",
      tags: ["forge", "event"],
      summary: "Документация по event handlers в Forge",
      source: "model",
      status: "candidate"
    });
    assert.ok(entry.id.startsWith("kb-"));
    assert.ok(entry.addedAt);
    assert.equal(state.entries.length, 1);
    assert.equal(state.entries[0]!.url, "https://docs.minecraftforge.net/events");
  });

  it("add с дубликатом id → throw", async () => {
    const { service } = makeFixture();
    await service.add({ id: "fixed-1", url: "x", category: "misc", tags: [], summary: "x", source: "model", status: "candidate" });
    await assert.rejects(
      () => service.add({ id: "fixed-1", url: "y", category: "misc", tags: [], summary: "y", source: "model", status: "candidate" }),
      /уже существует/
    );
  });

  it("remove удаляет запись", async () => {
    const { service, state } = makeFixture();
    await service.add({ id: "r1", url: "x", category: "misc", tags: [], summary: "x", source: "model", status: "candidate" });
    await service.remove("r1");
    assert.equal(state.entries.length, 0);
  });

  it("remove несуществующего → throw", async () => {
    const { service } = makeFixture();
    await assert.rejects(() => service.remove("nope"), /не найден/);
  });

  it("update меняет поля кроме id", async () => {
    const { service } = makeFixture();
    await service.add({ id: "u1", url: "x", category: "misc", tags: [], summary: "x", source: "model", status: "candidate" });
    const updated = await service.update("u1", { summary: "новая", status: "accepted" });
    assert.equal(updated.summary, "новая");
    assert.equal(updated.status, "accepted");
    assert.equal(updated.id, "u1");
  });

  it("update несуществующего → throw", async () => {
    const { service } = makeFixture();
    await assert.rejects(() => service.update("nope", { summary: "x" }), /не найден/);
  });

  it("search без embeddingService — возвращает по дате", async () => {
    const { service } = makeFixture();
    await service.add({ url: "a", category: "api", tags: ["forge"], summary: "Forge event", source: "model", status: "candidate" });
    await service.add({ url: "b", category: "misc", tags: [], summary: "other", source: "model", status: "candidate" });
    const results = await service.search("forge event", 5);
    assert.ok(results.length > 0);
  });

  it("search с keyword pre-filter — отсекает нерелевантное", async () => {
    const { service } = makeFixture();
    await service.add({ url: "a", category: "api", tags: ["forge"], summary: "Forge event handler", source: "model", status: "candidate" });
    await service.add({ url: "b", category: "misc", tags: ["cooking"], summary: "Recipe for cake", source: "model", status: "candidate" });
    const results = await service.search("forge event", 5);
    // "cooking" запись не должна попасть (keyword pre-filter)
    const urls = results.map((r) => r.entry.url);
    assert.ok(urls.includes("a"));
    assert.ok(!urls.includes("b"));
  });

  it("search fallback — все записи если pre-filter отсеял всё", async () => {
    const { service } = makeFixture();
    await service.add({ url: "a", category: "misc", tags: ["xyz"], summary: "abc", source: "model", status: "candidate" });
    const results = await service.search("несовпадающий запрос", 5);
    assert.ok(results.length > 0, "fallback должен вернуть все записи");
  });

  it("suggestCategory — api для forge/fabric", () => {
    const { service } = makeFixture();
    assert.equal(service.suggestCategory("forge event handler registry"), "api");
    assert.equal(service.suggestCategory("fabric mixin"), "api");
  });

  it("suggestCategory — gameplay для combat", () => {
    const { service } = makeFixture();
    assert.equal(service.suggestCategory("combat damage mob effect"), "gameplay");
  });

  it("suggestCategory — rendering для model/texture", () => {
    const { service } = makeFixture();
    assert.equal(service.suggestCategory("blockbench model texture render"), "rendering");
  });

  it("suggestCategory — misc для несовпадений", () => {
    const { service } = makeFixture();
    assert.equal(service.suggestCategory("random text about nothing"), "misc");
  });

  it("isValidCategory — принимает валидные категории", () => {
    assert.ok(isValidCategory("api"));
    assert.ok(isValidCategory("gameplay"));
    assert.ok(isValidCategory("rendering"));
    assert.ok(isValidCategory("tools"));
    assert.ok(isValidCategory("assets"));
    assert.ok(isValidCategory("misc"));
  });

  it("isValidCategory — отвергает невалидные", () => {
    assert.ok(!isValidCategory("characters"));
    assert.ok(!isValidCategory("lore"));
    assert.ok(!isValidCategory(""));
  });
});
