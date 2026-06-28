import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ToolContract } from "../src/tools/ToolContracts";
import { ToolRegistry } from "../src/tools/toolRegistry";

function makeContract(name: string, risk: ToolContract["risk"], requiresApproval: boolean): ToolContract {
  return {
    name,
    description: `dynamic ${name}`,
    risk,
    requiresApproval,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" }
  };
}

describe("ToolRegistry динамические контракты (Этап 3)", () => {
  it("registerDynamic/findContract: динамический контракт выигрывает над статикой", () => {
    const registry = new ToolRegistry();
    const contract = makeContract("blockbench.render", "read", false);
    const handler = async () => ({ text: "render" });
    registry.registerDynamic(contract, handler);

    const found = registry.findContract("blockbench.render");
    assert.equal(found?.risk, "read");
    assert.equal(found?.requiresApproval, false);
    assert.equal(registry.has("blockbench.render"), true);
    assert.equal(registry.hasDynamic("blockbench.render"), true);
    assert.equal(registry.get("blockbench.render"), handler);
  });

  it("contracts(): статичные сначала, затем динамические (prefix-cache-friendly)", () => {
    const registry = new ToolRegistry();
    // Регистрируем один статичный (с handler) + два динамических.
    registry.register("repo.read", async () => ({ text: "x" }));
    registry.registerDynamic(makeContract("blockbench.render", "read", false), async () => ({}));
    registry.registerDynamic(makeContract("blockbench.add_cube", "write", true), async () => ({}));

    const names = registry.contracts().map((c) => c.name);
    // repo.read из статичного toolContracts должен идти ПЕРВЫМ.
    assert.deepEqual(names, ["repo.read", "blockbench.render", "blockbench.add_cube"]);
  });

  it("allContracts(): включает динамические + статичные без дублей", () => {
    const registry = new ToolRegistry();
    registry.registerDynamic(makeContract("blockbench.foo", "write", true), async () => ({}));
    const all = registry.allContracts();
    // Статичный repo.read присутствует (он не переопределён динамикой).
    assert.ok(all.some((c) => c.name === "repo.read"));
    // Динамический тоже.
    assert.ok(all.some((c) => c.name === "blockbench.foo"));
    // Без дублей.
    const dup = all.filter((c) => c.name === "repo.read");
    assert.equal(dup.length, 1);
  });

  it("unregisterDynamic снимает контракт и handler", () => {
    const registry = new ToolRegistry();
    registry.registerDynamic(makeContract("blockbench.temp", "write", true), async () => ({}));
    assert.equal(registry.hasDynamic("blockbench.temp"), true);
    registry.unregisterDynamic("blockbench.temp");
    assert.equal(registry.hasDynamic("blockbench.temp"), false);
    assert.equal(registry.has("blockbench.temp"), false);
    assert.equal(registry.findContract("blockbench.temp"), undefined);
  });

  it("clearDynamic снимает все динамические и возвращает их имена", () => {
    const registry = new ToolRegistry();
    registry.registerDynamic(makeContract("blockbench.a", "write", true), async () => ({}));
    registry.registerDynamic(makeContract("blockbench.b", "read", false), async () => ({}));
    // Статичный repo.read НЕ должен сняться.
    registry.register("repo.read", async () => ({}));

    const removed = registry.clearDynamic();
    assert.deepEqual(removed.sort(), ["blockbench.a", "blockbench.b"]);
    assert.equal(registry.has("repo.read"), true, "статичные handlers не трогаются clearDynamic");
    assert.equal(registry.dynamicNames().length, 0);
  });

  it("динамический контракт НЕ ломает статичный findContract для обычных tools", () => {
    const registry = new ToolRegistry();
    // gradle.run — из статичного toolContracts.
    const found = registry.findContract("gradle.run");
    assert.equal(found?.risk, "command");
    assert.equal(found?.requiresApproval, true);
    assert.equal(registry.hasDynamic("gradle.run"), false);
  });
});
