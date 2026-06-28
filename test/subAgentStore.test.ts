import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MineAgentConfig } from "../src/config/types";
import { defaultMineAgentConfig } from "../src/config/defaultConfig";
import { SubAgentStore, validateSubAgent } from "../src/agents/subAgentStore";
import type { SubAgentConfig } from "../src/agents/types";

// In-memory mock config (DI паттерн, без реальной ФС).
function makeFixture(): { store: SubAgentStore; state: MineAgentConfig } {
  const state: MineAgentConfig = JSON.parse(JSON.stringify(defaultMineAgentConfig));
  const store = new SubAgentStore({
    readConfig: async () => JSON.parse(JSON.stringify(state)),
    writeConfig: async (cfg) => {
      state.subAgents = cfg.subAgents;
    }
  });
  return { store, state };
}

function sampleAgent(id: string): SubAgentConfig {
  return {
    id,
    displayName: `Агент ${id}`,
    model: "@cf/moonshotai/kimi-k2.7-code",
    specialty: "reviewer",
    promptOverride: "",
    allowedTools: ["repo.read", "repo.search"],
    memoryMode: "task",
    enabled: true
  };
}

describe("SubAgentStore CRUD", () => {
  it("list возвращает пустой массив по умолчанию", async () => {
    const { store } = makeFixture();
    assert.deepEqual(await store.list(), []);
  });

  it("add добавляет sub-агента", async () => {
    const { store, state } = makeFixture();
    await store.add(sampleAgent("reviewer-1"));
    assert.equal(state.subAgents.length, 1);
    assert.equal(state.subAgents[0].id, "reviewer-1");
  });

  it("add с дубликатом id → throw", async () => {
    const { store } = makeFixture();
    await store.add(sampleAgent("reviewer-1"));
    await assert.rejects(
      () => store.add(sampleAgent("reviewer-1")),
      /уже существует/
    );
  });

  it("update меняет поля кроме id", async () => {
    const { store } = makeFixture();
    await store.add(sampleAgent("reviewer-1"));
    const updated = await store.update("reviewer-1", { displayName: "Изменён", enabled: false });
    assert.equal(updated.displayName, "Изменён");
    assert.equal(updated.enabled, false);
    assert.equal(updated.id, "reviewer-1", "id неизменен");
  });

  it("update игнорирует id в patch", async () => {
    const { store } = makeFixture();
    await store.add(sampleAgent("reviewer-1"));
    // Пытаемся сменить id — должен остаться прежним.
    const updated = await store.update("reviewer-1", { id: "hacker", displayName: "x" });
    assert.equal(updated.id, "reviewer-1");
  });

  it("update несуществующего → throw", async () => {
    const { store } = makeFixture();
    await assert.rejects(
      () => store.update("nope", { displayName: "x" }),
      /не найден/
    );
  });

  it("remove удаляет sub-агента", async () => {
    const { store, state } = makeFixture();
    await store.add(sampleAgent("a"));
    await store.add(sampleAgent("b"));
    await store.remove("a");
    assert.equal(state.subAgents.length, 1);
    assert.equal(state.subAgents[0].id, "b");
  });

  it("remove несуществующего → throw", async () => {
    const { store } = makeFixture();
    await assert.rejects(() => store.remove("nope"), /не найден/);
  });

  it("toggle инвертирует enabled", async () => {
    const { store } = makeFixture();
    await store.add(sampleAgent("reviewer-1"));
    assert.equal((await store.toggle("reviewer-1")).enabled, false);
    assert.equal((await store.toggle("reviewer-1")).enabled, true);
  });

  it("add без config (readConfig=undefined) → throw", async () => {
    const store = new SubAgentStore({
      readConfig: async () => undefined,
      writeConfig: async () => {}
    });
    await assert.rejects(() => store.add(sampleAgent("x")), /не инициализирован/);
  });
});

describe("validateSubAgent", () => {
  it("пустой id → throw", () => {
    const agent = sampleAgent("x");
    assert.throws(() => validateSubAgent({ ...agent, id: "" }), /id .* обязателен/);
  });

  it("пустой displayName → throw", () => {
    const agent = sampleAgent("x");
    assert.throws(() => validateSubAgent({ ...agent, displayName: "" }), /displayName .* обязателен/);
  });

  it("allowedTools не массив → throw", () => {
    const agent = sampleAgent("x");
    assert.throws(
      () => validateSubAgent({ ...agent, allowedTools: "repo.read" as unknown as string[] }),
      /allowedTools .* массив/
    );
  });

  it("валидный агент → проходит", () => {
    assert.doesNotThrow(() => validateSubAgent(sampleAgent("ok")));
  });
});
