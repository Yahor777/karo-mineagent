import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { defaultMineAgentConfig } from "../src/config/defaultConfig";
import { MineAgentOrchestrator } from "../src/orchestrator/orchestrator";
import { ProviderRequestError } from "../src/providers/openaiCompatibleProvider";
import type { ChatRequest, ProviderAdapter, ProviderModel, StreamChunk } from "../src/providers/ProviderAdapter";
import { extractTextFromContent } from "../src/providers/ProviderAdapter";
import { TokenBudgetService } from "../src/providers/tokenBudget";

describe("MineAgentOrchestrator", () => {
  it("uses the configured provider model for chat runs", async () => {
    const root = join(tmpdir(), `mineagent-orchestrator-${Date.now()}`);
    const provider = new FakeProvider();
    try {
      await write(root, "gradle.properties", "minecraft_version=1.20.1\njava_version=17\n");
      await write(root, "build.gradle", "plugins { id 'net.minecraftforge.gradle' version '6.0.+' }\n");
      await write(root, "src/main/resources/META-INF/mods.toml", 'modId="karo_test"\n');
      await write(root, "src/main/java/com/example/KaroTest.java", `
@Mod("karo_test")
public class KaroTest {
  public static final DeferredRegister<Item> ITEMS = DeferredRegister.create(ForgeRegistries.ITEMS, "karo_test");
}
`);

      const orchestrator = new MineAgentOrchestrator(root, {
        ...defaultMineAgentConfig,
        providers: {
          ...defaultMineAgentConfig.providers,
          defaultProvider: "fireworks",
          defaultModel: "accounts/fireworks/models/kimi-k2p7-code",
          // Тестируем defaultModel напрямую — отключаем auto-tiering.
          routineModel: "",
          complexModel: ""
        }
      }, {
        get: async () => provider,
        providerStatuses: async () => [{ id: "fireworks", hasKey: true }]
      } as never);

      const report = await orchestrator.run({
        prompt: "Проверь проект",
        mode: "ask"
      });

      assert.equal(provider.lastRequest?.model, "accounts/fireworks/models/kimi-k2p7-code");
      assert.match(extractTextFromContent(provider.lastRequest?.messages[0]?.content ?? ""), /MineAgent/);
      assert.equal(report.summary, "Ответ fake provider");
      assert.equal(report.phases.find((phase) => phase.name === "Report")?.status, "complete");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("НЕ делает тихий фоллбэк когда явная модель недоступна (выбор модели священен)", async () => {
    const root = join(tmpdir(), `mineagent-orchestrator-fallback-${Date.now()}`);
    const provider = new FakeProvider();
    provider.failModel = "bad-fireworks-model";
    try {
      await write(root, "gradle.properties", "minecraft_version=1.20.1\njava_version=17\n");
      await write(root, "build.gradle", "plugins { id 'net.minecraftforge.gradle' version '6.0.+' }\n");
      await write(root, "src/main/resources/META-INF/mods.toml", 'modId="karo_test"\n');

      const orchestrator = new MineAgentOrchestrator(root, {
        ...defaultMineAgentConfig,
        providers: {
          ...defaultMineAgentConfig.providers,
          defaultProvider: "fireworks",
          defaultModel: "bad-fireworks-model",
          // Отключаем auto-tiering: тестируем явную модель.
          routineModel: "",
          complexModel: ""
        }
      }, {
        get: async () => provider,
        providerStatuses: async () => [{ id: "fireworks", hasKey: true }]
      } as never);

      // Фаза 1 (P1.1): выбор модели священен — при явной модели нет тихого
      // фоллбэка на чужую модель. model-not-found пробрасывается наверх.
      await assert.rejects(
        orchestrator.run({ prompt: "Проверь модель", mode: "ask" }),
        /не найдена|not found/i
      );
      // Запрошена ровно одна (явная) модель, без подмены.
      assert.deepEqual(provider.requestedModels, ["bad-fireworks-model"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats empty provider responses as failed runs", async () => {
    const root = join(tmpdir(), `mineagent-orchestrator-empty-${Date.now()}`);
    const provider = new FakeProvider();
    provider.responseContent = "   ";
    try {
      await write(root, "gradle.properties", "minecraft_version=1.20.1\njava_version=17\n");
      await write(root, "build.gradle", "plugins { id 'net.minecraftforge.gradle' version '6.0.+' }\n");
      await write(root, "src/main/resources/META-INF/mods.toml", 'modId="karo_test"\n');

      const orchestrator = new MineAgentOrchestrator(root, {
        ...defaultMineAgentConfig,
        providers: {
          ...defaultMineAgentConfig.providers,
          defaultProvider: "fireworks",
          defaultModel: "accounts/fireworks/models/kimi-k2p7-code",
          // Тестируем defaultModel напрямую — отключаем auto-tiering.
          routineModel: "",
          complexModel: ""
        }
      }, {
        get: async () => provider,
        providerStatuses: async () => [{ id: "fireworks", hasKey: true }]
      } as never);

      await assert.rejects(
        orchestrator.run({
          prompt: "empty response check",
          mode: "ask"
        }),
        /empty response/
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("НЕ делает тихий фоллбэк когда явная модель вернула пустой ответ", async () => {
    const root = join(tmpdir(), `mineagent-orchestrator-empty-fallback-${Date.now()}`);
    const provider = new FakeProvider();
    provider.models = [
      "accounts/fireworks/models/empty-code",
      "accounts/fireworks/models/kimi-k2p7-code"
    ];
    provider.responsesByModel.set("accounts/fireworks/models/empty-code", "   ");
    provider.responsesByModel.set("accounts/fireworks/models/kimi-k2p7-code", "fallback response");
    try {
      await write(root, "gradle.properties", "minecraft_version=1.20.1\njava_version=17\n");
      await write(root, "build.gradle", "plugins { id 'net.minecraftforge.gradle' version '6.0.+' }\n");
      await write(root, "src/main/resources/META-INF/mods.toml", 'modId="karo_test"\n');

      const orchestrator = new MineAgentOrchestrator(root, {
        ...defaultMineAgentConfig,
        providers: {
          ...defaultMineAgentConfig.providers,
          defaultProvider: "fireworks",
          defaultModel: "accounts/fireworks/models/empty-code",
          // Явная модель — отключаем tiering.
          routineModel: "",
          complexModel: ""
        }
      }, {
        get: async () => provider,
        providerStatuses: async () => [{ id: "fireworks", hasKey: true }]
      } as never);

      // Фаза 1 (P1.1): выбор модели священен — пустой ответ явной модели НЕ
      // приводит к тихой подмене на другую модель; ошибка пробрасывается.
      await assert.rejects(
        orchestrator.run({ prompt: "empty fallback check", mode: "ask" }),
        /empty response/
      );
      assert.deepEqual(provider.requestedModels, [
        "accounts/fireworks/models/empty-code"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not expose raw Fireworks billing account details in error messages", () => {
    const error = new ProviderRequestError(
      "Fireworks AI",
      412,
      "Account abc123 is suspended, possibly due to reaching the monthly spending limit or failure to pay past invoices."
    );

    assert.equal(error.isBillingBlocked(), true);
    assert.match(error.message, /биллинга или статуса аккаунта/);
    assert.doesNotMatch(error.message, /abc123|suspended|invoices/i);
  });

  it("uses Patch phase and patch instructions for build runs", async () => {
    const root = join(tmpdir(), `mineagent-orchestrator-build-${Date.now()}`);
    const provider = new FakeProvider();
    try {
      await write(root, "gradle.properties", "minecraft_version=1.20.1\njava_version=17\n");
      await write(root, "build.gradle", "plugins { id 'net.minecraftforge.gradle' version '6.0.+' }\n");
      await write(root, "src/main/resources/META-INF/mods.toml", 'modId="karo_test"\n');

      const orchestrator = new MineAgentOrchestrator(root, {
        ...defaultMineAgentConfig,
        providers: {
          ...defaultMineAgentConfig.providers,
          defaultProvider: "fireworks",
          defaultModel: "accounts/fireworks/models/kimi-k2p7-code",
          // Тестируем defaultModel напрямую — отключаем auto-tiering.
          routineModel: "",
          complexModel: ""
        }
      }, {
        get: async () => provider,
        providerStatuses: async () => [{ id: "fireworks", hasKey: true }]
      } as never);

      const report = await orchestrator.run({
        prompt: "Добавь первую боевую технику",
        mode: "build"
      });

      assert.equal(report.phases.find((phase) => phase.name === "Patch")?.status, "complete");
      assert.equal(report.phases.find((phase) => phase.name === "Report")?.status, "skipped");
      assert.match(extractTextFromContent(provider.lastRequest?.messages[0]?.content ?? ""), /UNIFIED DIFF/);
      assert.match(extractTextFromContent(provider.lastRequest?.messages[1]?.content ?? ""), /Режим MineAgent: build/);
      assert.equal(provider.lastRequest?.maxTokens, 6144);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes the reviewed research ledger to the configured model", async () => {
    const root = join(tmpdir(), `mineagent-orchestrator-research-${Date.now()}`);
    const provider = new FakeProvider();
    try {
      await write(root, "gradle.properties", "minecraft_version=1.20.1\njava_version=17\n");
      await write(root, "build.gradle", "plugins { id 'net.minecraftforge.gradle' version '6.0.+' }\n");
      await write(root, "src/main/resources/META-INF/mods.toml", 'modId="karo_test"\n');

      const orchestrator = new MineAgentOrchestrator(root, {
        ...defaultMineAgentConfig,
        providers: {
          ...defaultMineAgentConfig.providers,
          defaultProvider: "fireworks",
          defaultModel: "accounts/fireworks/models/kimi-k2p7-code",
          // Тестируем defaultModel напрямую — отключаем auto-tiering.
          routineModel: "",
          complexModel: ""
        }
      }, {
        get: async () => provider,
        providerStatuses: async () => [{ id: "fireworks", hasKey: true }]
      } as never);

      await orchestrator.run({
        prompt: "Сделай оригинальную технику",
        mode: "plan",
        researchLedger: {
          topic: "combat inspiration",
          status: "reviewed",
          userNotes: "Не использовать школьные названия и прямые техники; взять только идею риск/цена/контроль пространства.",
          lastUpdated: "2026-06-19T00:00:00.000Z",
          sources: [
            {
              url: "https://example.com/source",
              title: "Source",
              summary: "Short source summary.",
              learned: "Combat system uses visible tradeoffs.",
              usedFor: "Translate into original Veil mechanics.",
              status: "accepted"
            }
          ]
        }
      });

      const userMessage = extractTextFromContent(provider.lastRequest?.messages[1]?.content ?? "");
      assert.match(userMessage, /Research Ledger/);
      assert.match(userMessage, /https:\/\/example\.com\/source/);
      assert.match(userMessage, /риск\/цена\/контроль пространства/);
      assert.match(extractTextFromContent(provider.lastRequest?.messages[0]?.content ?? ""), /user-reviewed source memory/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits budgetExceeded via onActivity after the model finishes, without interrupting the run", async () => {
    const root = join(tmpdir(), `mineagent-orchestrator-budget-${Date.now()}`);
    const provider = new FakeProvider();
    provider.responseUsage = { inputTokens: 600_000, outputTokens: 500_000 }; // > 1M лимит
    try {
      await write(root, "gradle.properties", "minecraft_version=1.20.1\n");
      await write(root, "build.gradle", "plugins { id 'net.minecraftforge.gradle' version '6.0.+' }\n");

      const budget = new TokenBudgetService(1_000_000);
      const events: { budgetExceeded?: { sessionUsed: number } }[] = [];
      const orchestrator = new MineAgentOrchestrator(root, {
        ...defaultMineAgentConfig,
        providers: {
          ...defaultMineAgentConfig.providers,
          defaultProvider: "fireworks",
          defaultModel: "accounts/fireworks/models/kimi-k2p7-code",
          // Тестируем defaultModel напрямую — отключаем auto-tiering.
          routineModel: "",
          complexModel: ""
        }
      }, {
        get: async () => provider,
        providerStatuses: async () => [{ id: "fireworks", hasKey: true }]
      } as never, budget);

      // Run завершается успешно — ответ НЕ прерывается, несмотря на превышение.
      const report = await orchestrator.run({
        prompt: "Тест бюджета",
        mode: "ask",
        onActivity: (event) => {
          if (event.budgetExceeded) {
            events.push(event);
          }
        }
      });

      assert.equal(report.summary, "Ответ fake provider");
      assert.ok(events.length >= 1, "Должно появиться событие budgetExceeded после ответа модели");
      assert.ok(events[0]!.budgetExceeded!.sessionUsed > 1_000_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not emit budgetExceeded when usage stays under the limit", async () => {
    const root = join(tmpdir(), `mineagent-orchestrator-budget-ok-${Date.now()}`);
    const provider = new FakeProvider();
    provider.responseUsage = { inputTokens: 100, outputTokens: 100 };
    try {
      await write(root, "gradle.properties", "minecraft_version=1.20.1\n");
      await write(root, "build.gradle", "plugins { id 'net.minecraftforge.gradle' version '6.0.+' }\n");

      const budget = new TokenBudgetService(1_000_000);
      let exceededEvents = 0;
      const orchestrator = new MineAgentOrchestrator(root, defaultMineAgentConfig, {
        get: async () => provider,
        providerStatuses: async () => [{ id: "fireworks", hasKey: true }]
      } as never, budget);

      await orchestrator.run({
        prompt: "Тест",
        mode: "ask",
        onActivity: (event) => {
          if (event.budgetExceeded) {
            exceededEvents += 1;
          }
        }
      });

      assert.equal(exceededEvents, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("auto-tiering uses routineModel for ask mode and complexModel for build mode", async () => {
    const root = join(tmpdir(), `mineagent-tier-${Date.now()}`);
    const provider = new FakeProvider();
    provider.models = [
      "@cf/zai-org/glm-4.7-flash",
      "@cf/moonshotai/kimi-k2.7-code"
    ];
    try {
      await write(root, "gradle.properties", "minecraft_version=1.20.1\n");
      await write(root, "build.gradle", "plugins { id 'net.minecraftforge.gradle' version '6.0.+' }\n");

      const orchestrator = new MineAgentOrchestrator(root, {
        ...defaultMineAgentConfig,
        providers: {
          ...defaultMineAgentConfig.providers,
          defaultProvider: "cloudflare",
          defaultModel: "@cf/moonshotai/kimi-k2.7-code",
          routineModel: "@cf/zai-org/glm-4.7-flash",
          complexModel: "@cf/moonshotai/kimi-k2.7-code"
        }
      }, {
        get: async () => provider,
        providerStatuses: async () => [{ id: "cloudflare", hasKey: true }]
      } as never);

      provider.requestedModels = [];
      await orchestrator.run({ prompt: "прочитай файл", mode: "ask" });
      // ask → routineModel (GLM 4.7 Flash — дешёвая).
      assert.deepEqual(provider.requestedModels, ["@cf/zai-org/glm-4.7-flash"]);

      provider.requestedModels = [];
      await orchestrator.run({ prompt: "напиши патч", mode: "build" });
      // build → complexModel (Kimi K2.7 Code — дорогая).
      assert.deepEqual(provider.requestedModels, ["@cf/moonshotai/kimi-k2.7-code"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

class FakeProvider implements ProviderAdapter {
  public readonly id = "fireworks";
  public readonly displayName = "Fireworks AI";
  public lastRequest?: ChatRequest;
  public failModel?: string;
  public responseContent = "Ответ fake provider";
  public responsesByModel = new Map<string, string>();
  public models = ["accounts/fireworks/models/kimi-k2p7-code"];
  public requestedModels: string[] = [];
  // Опционально: имитация usage из ответа провайдера. undefined → оценка по chars/4.
  public responseUsage?: { inputTokens?: number; outputTokens?: number };

  public async chat(request: ChatRequest) {
    this.lastRequest = request;
    this.requestedModels.push(request.model);
    if (request.model === this.failModel) {
      throw new ProviderRequestError(this.displayName, 404, "Model not found", "NOT_FOUND", "model");
    }
    return {
      model: request.model,
      content: this.responsesByModel.get(request.model) ?? this.responseContent,
      usage: this.responseUsage
    };
  }

  public async *streamChat(request: ChatRequest): AsyncIterable<StreamChunk> {
    yield {
      contentDelta: (await this.chat(request)).content
    };
  }

  public async listModels(): Promise<ProviderModel[]> {
    return this.models.map((model) => ({
        id: model,
        label: "Kimi K2.7 Code",
        provider: "fireworks",
        capabilities: {
          vision: false,
          tools: true,
          jsonMode: true,
          speed: "fast"
        }
      }));
  }

  public async validateKey(): Promise<boolean> {
    return true;
  }
}

async function write(root: string, relativePath: string, text: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}
