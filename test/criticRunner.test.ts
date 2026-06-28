import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CriticRunner, resolveConsensus } from "../src/orchestrator/criticRunner";
import type { CriticArtifact, CriticVerdict } from "../src/orchestrator/criticRunner";
import type { ProjectMap } from "../src/repo/projectMap";
import type { ChatRequest, ChatResponse, ProviderAdapter, ProviderModel, StreamChunk } from "../src/providers/ProviderAdapter";

// Этап 5: тесты CriticRunner — critic оценивает артефакт БЕЗ хода мыслей main.
// (e) critic консенсус/разногласие/uncertain
// (g) critic НЕ получает ход мыслей main (assert на содержимое critic-запроса)

function makeProjectMap(): ProjectMap {
  return {
    indexedAt: new Date().toISOString(),
    root: ".",
    loader: "forge",
    minecraftVersion: "1.20.1",
    javaVersion: "17",
    mainModId: "testmod",
    gradleTasks: ["build"],
    registries: [],
    eventHandlers: [],
    networkPackets: [],
    clientOnlyClasses: [],
    resources: { lang: [], models: [], textures: [], recipes: [], lootTables: [], tags: [], sounds: [] },
    mixins: [],
    accessWideners: [],
    datagen: [],
    architectureHints: []
  };
}

class ScriptedProvider implements ProviderAdapter {
  public readonly id = "cloudflare";
  public readonly displayName = "Cloudflare";
  public lastRequest: ChatRequest | undefined;
  public queue: string[] = [];

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    this.lastRequest = request;
    const next = this.queue.shift();
    return { model: request.model, content: next ?? '{"verdict":"approve","reasoning":"Хороший код"}' };
  }

  public async *streamChat(request: ChatRequest): AsyncIterable<StreamChunk> {
    yield { contentDelta: (await this.chat(request)).content };
  }

  public async listModels(): Promise<ProviderModel[]> {
    return [
      {
        id: "@cf/moonshotai/kimi-k2.7-code",
        label: "Kimi K2.7",
        provider: "cloudflare",
        capabilities: { vision: false, tools: true, jsonMode: true, speed: "fast" }
      },
      {
        id: "@cf/zai-org/glm-4.7-flash",
        label: "GLM Flash",
        provider: "cloudflare",
        capabilities: { vision: false, tools: true, jsonMode: true, speed: "fast" }
      }
    ];
  }

  public async validateKey(): Promise<boolean> {
    return true;
  }
}

describe("CriticRunner (Этап 5)", () => {
  it("строит critic-запрос с компактным артефактом", async () => {
    const provider = new ScriptedProvider();
    const runner = new CriticRunner({
      provider,
      models: await provider.listModels(),
      mainModel: "@cf/moonshotai/kimi-k2.7-code",
      criticModel: "@cf/zai-org/glm-4.7-flash"
    });
    const artifact: CriticArtifact = {
      projectMap: makeProjectMap(),
      taskDescription: "Оцени patch класса Mod.java",
      artifact: "diff --git a/Mod.java b/Mod.java\n+public class Mod {}",
      mode: "code"
    };
    await runner.evaluate(artifact);
    const request = provider.lastRequest!;
    assert.ok(request);
    // System prompt описывает роль critic
    const systemMsg = request.messages.find((m) => m.role === "system")!;
    assert.match(systemMsg.content as string, /critic/);
    // User message содержит задачу и артефакт, но НЕ ход мыслей main
    const userMsg = request.messages.find((m) => m.role === "user")!;
    const userText = typeof userMsg.content === "string" ? userMsg.content : "";
    assert.match(userText, /Оцени patch класса Mod\.java/);
    assert.match(userText, /public class Mod/);
  });

  it("critic НЕ получает ход мыслей main (anti-anchoring)", async () => {
    const provider = new ScriptedProvider();
    const runner = new CriticRunner({
      provider,
      models: await provider.listModels(),
      mainModel: "@cf/moonshotai/kimi-k2.7-code",
      criticModel: "@cf/zai-org/glm-4.7-flash"
    });
    await runner.evaluate({
      projectMap: makeProjectMap(),
      taskDescription: "Оцени patch",
      artifact: "+code",
      mode: "code"
    });
    const request = provider.lastRequest!;
    // В запросе ровно 2 сообщения: system + user. Никаких assistant-сообщений
    // с ходом мыслей main. Это ключевое условие anti-anchoring.
    assert.equal(request.messages.length, 2, "critic получает только system + user, без chain-of-thought main");
    assert.equal(request.messages[0].role, "system");
    assert.equal(request.messages[1].role, "user");
  });

  it("выбирает модель, отличную от main (не self-critique)", async () => {
    const provider = new ScriptedProvider();
    const runner = new CriticRunner({
      provider,
      models: await provider.listModels(),
      mainModel: "@cf/moonshotai/kimi-k2.7-code",
      criticModel: ""
    });
    await runner.evaluate({
      projectMap: makeProjectMap(),
      taskDescription: "Оцени",
      artifact: "code",
      mode: "code"
    });
    assert.notEqual(provider.lastRequest!.model, "@cf/moonshotai/kimi-k2.7-code");
    assert.equal(provider.lastRequest!.model, "@cf/zai-org/glm-4.7-flash");
  });

  it("self-critique когда criticModel = mainModel", async () => {
    const provider = new ScriptedProvider();
    const runner = new CriticRunner({
      provider,
      models: await provider.listModels(),
      mainModel: "@cf/moonshotai/kimi-k2.7-code",
      criticModel: "@cf/moonshotai/kimi-k2.7-code"
    });
    const verdict = await runner.evaluate({
      projectMap: makeProjectMap(),
      taskDescription: "Оцени",
      artifact: "code",
      mode: "code"
    });
    assert.equal(verdict.isSelfCritique, true, "должен обнаружить self-critique");
    assert.equal(verdict.model, "@cf/moonshotai/kimi-k2.7-code");
  });

  it("парсит approve-вердикт", async () => {
    const provider = new ScriptedProvider();
    provider.queue = ['{"verdict":"approve","reasoning":"Код корректный"}'];
    const runner = new CriticRunner({
      provider,
      models: await provider.listModels(),
      mainModel: "@cf/moonshotai/kimi-k2.7-code"
    });
    const verdict = await runner.evaluate({
      projectMap: makeProjectMap(),
      taskDescription: "Оцени",
      artifact: "code",
      mode: "code"
    });
    assert.equal(verdict.verdict, "approve");
    assert.equal(verdict.reasoning, "Код корректный");
  });

  it("парсит reject-вердикт", async () => {
    const provider = new ScriptedProvider();
    provider.queue = ['{"verdict":"reject","reasoning":"NPE в строке 42"}'];
    const runner = new CriticRunner({
      provider,
      models: await provider.listModels(),
      mainModel: "@cf/moonshotai/kimi-k2.7-code"
    });
    const verdict = await runner.evaluate({
      projectMap: makeProjectMap(),
      taskDescription: "Оцени",
      artifact: "code",
      mode: "code"
    });
    assert.equal(verdict.verdict, "reject");
    assert.equal(verdict.reasoning, "NPE в строке 42");
  });

  it("парсит uncertain-вердикт", async () => {
    const provider = new ScriptedProvider();
    provider.queue = ['{"verdict":"uncertain","reasoning":"Нужен контекст"}'];
    const runner = new CriticRunner({
      provider,
      models: await provider.listModels(),
      mainModel: "@cf/moonshotai/kimi-k2.7-code"
    });
    const verdict = await runner.evaluate({
      projectMap: makeProjectMap(),
      taskDescription: "Оцени",
      artifact: "code",
      mode: "code"
    });
    assert.equal(verdict.verdict, "uncertain");
  });

  it("fallback uncertain при невалидном JSON", async () => {
    const provider = new ScriptedProvider();
    provider.queue = ["Не смог оценить"];
    const runner = new CriticRunner({
      provider,
      models: await provider.listModels(),
      mainModel: "@cf/moonshotai/kimi-k2.7-code"
    });
    const verdict = await runner.evaluate({
      projectMap: makeProjectMap(),
      taskDescription: "Оцени",
      artifact: "code",
      mode: "code"
    });
    assert.equal(verdict.verdict, "uncertain");
  });
});

describe("resolveConsensus (Этап 5)", () => {
  it("оба approve → apply", () => {
    const critic: CriticVerdict = {
      verdict: "approve",
      reasoning: "ok",
      model: "x",
      isSelfCritique: false
    };
    assert.equal(resolveConsensus(true, critic), "apply");
  });

  it("main approve + critic reject → ask-user", () => {
    const critic: CriticVerdict = {
      verdict: "reject",
      reasoning: "bad",
      model: "x",
      isSelfCritique: false
    };
    assert.equal(resolveConsensus(true, critic), "ask-user");
  });

  it("main reject + critic approve → ask-user", () => {
    const critic: CriticVerdict = {
      verdict: "approve",
      reasoning: "ok",
      model: "x",
      isSelfCritique: false
    };
    assert.equal(resolveConsensus(false, critic), "ask-user");
  });

  it("main approve + critic uncertain → ask-user", () => {
    const critic: CriticVerdict = {
      verdict: "uncertain",
      reasoning: "не уверен",
      model: "x",
      isSelfCritique: false
    };
    assert.equal(resolveConsensus(true, critic), "ask-user");
  });

  it("оба reject → ask-user (нет консенсуса на apply)", () => {
    const critic: CriticVerdict = {
      verdict: "reject",
      reasoning: "bad",
      model: "x",
      isSelfCritique: false
    };
    assert.equal(resolveConsensus(false, critic), "ask-user");
  });
});
