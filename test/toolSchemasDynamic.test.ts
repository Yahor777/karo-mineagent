import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildToolSchemas,
  registerToolSchema,
  unregisterToolSchema,
  clearDynamicSchemas,
  hasDynamicSchema,
  TOOL_LOOP_TOOLS
} from "../src/tools/toolSchemas";
import type { ToolDefinition } from "../src/providers/ProviderAdapter";

function makeSchema(name: string): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: `dynamic ${name}`,
      parameters: { type: "object", properties: {} }
    }
  };
}

describe("toolSchemas динамические (Этап 3)", () => {
  it("buildToolSchemas: статичные + динамические, порядок стабилен", () => {
    registerToolSchema("blockbench.render", makeSchema("blockbench.render"));
    registerToolSchema("blockbench.add_cube", makeSchema("blockbench.add_cube"));
    try {
      const schemas = buildToolSchemas([...TOOL_LOOP_TOOLS, "blockbench.render", "blockbench.add_cube"]);
      const names = schemas.map((s) => s.function.name);
      // Сначала статичный набор (в порядке TOOL_LOOP_TOOLS), затем динамические blockbench.*.
      assert.deepEqual(names, [...TOOL_LOOP_TOOLS, "blockbench.render", "blockbench.add_cube"]);
    } finally {
      clearDynamicSchemas();
    }
  });

  it("без подключения (нет динамики) buildToolSchemas = базовый набор", () => {
    clearDynamicSchemas();
    const schemas = buildToolSchemas(TOOL_LOOP_TOOLS);
    // Без подключённых мостов модели уходит ровно статичный набор Этапов 2-5.
    assert.deepEqual(schemas.map((s) => s.function.name), [...TOOL_LOOP_TOOLS]);
    // Динамических (bridge) схем в наборе нет.
    assert.equal(schemas.some((s) => s.function.name.startsWith("blockbench.")), false);
  });

  it("register/unregister/hasDynamicSchema", () => {
    registerToolSchema("blockbench.x", makeSchema("blockbench.x"));
    assert.equal(hasDynamicSchema("blockbench.x"), true);
    unregisterToolSchema("blockbench.x");
    assert.equal(hasDynamicSchema("blockbench.x"), false);
    // unregister несуществующего — не throw.
    unregisterToolSchema("blockbench.never");
  });

  it("clearDynamicSchemas возвращает снятые имена", () => {
    registerToolSchema("blockbench.a", makeSchema("blockbench.a"));
    registerToolSchema("blockbench.b", makeSchema("blockbench.b"));
    const removed = clearDynamicSchemas();
    assert.deepEqual(removed.sort(), ["blockbench.a", "blockbench.b"]);
    assert.equal(hasDynamicSchema("blockbench.a"), false);
  });

  it("buildToolSchemas: динамическое имя без зарегистрированной схемы молча пропускается", () => {
    const schemas = buildToolSchemas(["repo.read", "blockbench.unknown", "gradle.run"]);
    assert.deepEqual(schemas.map((s) => s.function.name), ["repo.read", "gradle.run"]);
  });
});
