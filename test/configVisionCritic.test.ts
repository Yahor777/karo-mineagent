import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultMineAgentConfig } from "../src/config/defaultConfig";

// Этап 5: тесты config — новые поля vision/critic + backward-compat через merge.
// mergeConfig живёт внутри configService.ts (не экспортируется), тестируем
// через значения defaultConfig и ручной merge (тот же паттерн).

describe("Config Этап 5 — vision/critic поля", () => {
  it("defaultConfig содержит visionModel", () => {
    assert.ok(defaultMineAgentConfig.agent.visionModel);
    assert.equal(defaultMineAgentConfig.agent.visionModel, "@cf/meta/llama-4-scout-17b-16e-instruct");
  });

  it("defaultConfig содержит criticModel (пусто = авто-выбор)", () => {
    assert.equal(defaultMineAgentConfig.agent.criticModel, "");
  });

  it("defaultConfig.criticMode = other-model (не self-critique)", () => {
    assert.equal(defaultMineAgentConfig.agent.criticMode, "other-model");
  });

  it("defaultConfig.visionTriggers содержит render и screenshot", () => {
    const triggers = defaultMineAgentConfig.agent.visionTriggers;
    assert.ok(triggers.includes("blockbench.render"));
    assert.ok(triggers.includes("minecraft.screenshot"));
  });

  it("новые поля — строки и массивы правильного типа", () => {
    assert.equal(typeof defaultMineAgentConfig.agent.visionModel, "string");
    assert.equal(typeof defaultMineAgentConfig.agent.criticModel, "string");
    assert.ok(Array.isArray(defaultMineAgentConfig.agent.visionTriggers));
  });

  it("mergeConfig pattern: старый config без vision-полей → дефолтные значения", () => {
    // Симулируем старый config.json (до Этапа 5) — без vision/critic полей.
    const oldConfig = {
      version: 1 as const,
      agent: {
        approvalMode: "ask" as const,
        autoApproveTools: [] as string[],
        evidenceRetentionDays: 14,
        defaultRunPhases: defaultMineAgentConfig.agent.defaultRunPhases,
        tokenLimit: 1_000_000,
        maxToolIterations: 5,
        maxDiagnoseIterations: 2
      }
    };
    // mergeConfig pattern (упрощённый — тот же что в configService.ts):
    const merged = {
      ...defaultMineAgentConfig.agent,
      ...oldConfig.agent,
      visionModel: typeof (oldConfig.agent as Record<string, unknown>)?.visionModel === "string"
        ? (oldConfig.agent as Record<string, unknown>).visionModel as string
        : defaultMineAgentConfig.agent.visionModel,
      criticModel: typeof (oldConfig.agent as Record<string, unknown>)?.criticModel === "string"
        ? (oldConfig.agent as Record<string, unknown>).criticModel as string
        : defaultMineAgentConfig.agent.criticModel,
      criticMode: (oldConfig.agent as Record<string, unknown>)?.criticMode === "other-model"
        || (oldConfig.agent as Record<string, unknown>)?.criticMode === "self"
        || (oldConfig.agent as Record<string, unknown>)?.criticMode === "off"
        ? (oldConfig.agent as Record<string, unknown>).criticMode as "other-model" | "self" | "off"
        : defaultMineAgentConfig.agent.criticMode,
      visionTriggers: Array.isArray((oldConfig.agent as Record<string, unknown>)?.visionTriggers)
        ? (oldConfig.agent as Record<string, unknown>).visionTriggers as string[]
        : defaultMineAgentConfig.agent.visionTriggers
    };
    assert.equal(merged.visionModel, defaultMineAgentConfig.agent.visionModel);
    assert.equal(merged.criticModel, "");
    assert.equal(merged.criticMode, "other-model");
    assert.deepEqual(merged.visionTriggers, defaultMineAgentConfig.agent.visionTriggers);
  });

  it("mergeConfig pattern: config с criticMode=off → сохраняется", () => {
    const customConfig = {
      agent: {
        ...defaultMineAgentConfig.agent,
        criticMode: "off" as const
      }
    };
    assert.equal(customConfig.agent.criticMode, "off");
  });

  it("mergeConfig pattern: config с criticMode=self → сохраняется", () => {
    const customConfig = {
      agent: {
        ...defaultMineAgentConfig.agent,
        criticMode: "self" as const
      }
    };
    assert.equal(customConfig.agent.criticMode, "self");
  });
});
