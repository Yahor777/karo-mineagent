import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultMineAgentConfig } from "../src/config/defaultConfig";
import { ProviderRegistry } from "../src/providers/providerRegistry";

describe("ProviderRegistry", () => {
  it("uses configured custom models as tool-capable fallback when /models is unavailable", async () => {
    const config = {
      ...defaultMineAgentConfig,
      providers: {
        ...defaultMineAgentConfig.providers,
        defaultProvider: "custom" as const,
        defaultModel: "kimi-k2.7",
        routineModel: "minimax-m2.7",
        complexModel: "kimi-k2.7"
      }
    };
    const registry = new ProviderRegistry({
      readConfig: async () => config,
      getProviderKey: async () => "test-key",
      hasProviderKey: async () => true
    } as never, config);

    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
    try {
      const provider = await registry.get("custom");
      const models = await provider.listModels();
      const ids = models.map((model) => model.id);

      assert.deepEqual(ids, ["kimi-k2.7", "minimax-m2.7"]);
      assert.equal(models[0]?.provider, "custom");
      assert.equal(models[0]?.capabilities.tools, true);
      assert.equal(models[0]?.capabilities.jsonMode, true);
      assert.equal(models[0]?.capabilities.reasoning, true);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
