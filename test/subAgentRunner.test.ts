import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SubAgentRunner, clearSubAgentMemory, clearTaskMemory } from "../src/agents/subAgentRunner";
import { getSpecialtyPreset, buildSubAgentSystemPrompt, getSpecialtyDefaultTools } from "../src/agents/specialtyPresets";
import { ApprovalGate } from "../src/approval/approvalGate";
import type { SubAgentConfig } from "../src/agents/types";
import type { ProjectMap } from "../src/repo/projectMap";
import type { ChatRequest, ChatResponse, ProviderAdapter, ProviderModel, StreamChunk } from "../src/providers/ProviderAdapter";
import { defaultMineAgentConfig } from "../src/config/defaultConfig";

// Этап 5: тесты SubAgentRunner — запуск sub-агента через approval gate.
// (d) SubAgentRunner с mock-approval

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

function makeAgent(overrides: Partial<SubAgentConfig> = {}): SubAgentConfig {
  return {
    id: "reviewer-1",
    displayName: "Ревизор",
    model: "@cf/zai-org/glm-4.7-flash",
    specialty: "reviewer",
    allowedTools: ["repo.read"],
    memoryMode: "none",
    enabled: true,
    ...overrides
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
    return { model: request.model, content: next ?? "Ревизия: код выглядит хорошо" };
  }

  public async *streamChat(request: ChatRequest): AsyncIterable<StreamChunk> {
    yield { contentDelta: (await this.chat(request)).content };
  }

  public async listModels(): Promise<ProviderModel[]> {
    return [{
      id: "@cf/zai-org/glm-4.7-flash",
      label: "GLM Flash",
      provider: "cloudflare",
      capabilities: { vision: false, tools: true, jsonMode: true, speed: "fast" }
    }];
  }

  public async validateKey(): Promise<boolean> {
    return true;
  }
}

function makeAutoApproveGate(): ApprovalGate {
  const gate = new ApprovalGate(defaultMineAgentConfig, async () => {}, () => {}, () => {});
  const originalPost = (gate as unknown as { post: (msg: { type: string; payload?: unknown }) => void }).post;
  (gate as unknown as { post: (msg: { type: string; payload?: unknown }) => void }).post = (msg) => {
    originalPost.call(gate, msg);
    if (msg.type === "approvalRequest" && msg.payload && typeof msg.payload === "object" && "requestId" in msg.payload) {
      const req = msg.payload as { requestId: string };
      setImmediate(() => gate.resolve({ requestId: req.requestId, decision: "confirm-once" }));
    }
  };
  return gate;
}

describe("SubAgentRunner (Этап 5)", () => {
  beforeEach(() => clearSubAgentMemory());
  afterEach(() => clearSubAgentMemory());

  it("запускается через approval и возвращает ответ модели", async () => {
    const provider = new ScriptedProvider();
    const gate = makeAutoApproveGate();
    const runner = new SubAgentRunner(gate, () => "req-test-1");
    const result = await runner.run(makeAgent(), {
      baseSystemPrompt: "Ты MineAgent.",
      task: "Оцени класс Mod.java",
      projectMap: makeProjectMap(),
      provider
    });
    assert.equal(result.timedOut, false);
    assert.match(result.content, /Ревизия/);
  });

  it("approval scope = subagent, scopeId = agent.id", async () => {
    const provider = new ScriptedProvider();
    let capturedRequest: { scope?: string; scopeId?: string } | undefined;
    const gate = makeAutoApproveGate();
    const originalRequest = gate.request.bind(gate);
    gate.request = async (req) => {
      capturedRequest = req;
      return originalRequest(req);
    };
    const runner = new SubAgentRunner(gate, () => "req-test-2");
    await runner.run(makeAgent({ id: "vision-1" }), {
      baseSystemPrompt: "Базовый",
      task: "Оцени",
      projectMap: makeProjectMap(),
      provider
    });
    assert.equal(capturedRequest?.scope, "subagent");
    assert.equal(capturedRequest?.scopeId, "vision-1");
  });

  it("throw если agent.disabled", async () => {
    const provider = new ScriptedProvider();
    const gate = makeAutoApproveGate();
    const runner = new SubAgentRunner(gate);
    await assert.rejects(
      () => runner.run(makeAgent({ enabled: false }), {
        baseSystemPrompt: "Базовый",
        task: "Оцени",
        projectMap: makeProjectMap(),
        provider
      }),
      /выключен/
    );
  });

  it("system prompt = базовый + надстройка specialty", async () => {
    const provider = new ScriptedProvider();
    provider.queue = ["ok"];
    const gate = makeAutoApproveGate();
    const runner = new SubAgentRunner(gate, () => "req-test-3");
    await runner.run(makeAgent({ specialty: "reviewer" }), {
      baseSystemPrompt: "Ты MineAgent.",
      task: "Оцени",
      projectMap: makeProjectMap(),
      provider
    });
    const systemMsg = provider.lastRequest!.messages[0];
    const systemText = typeof systemMsg.content === "string" ? systemMsg.content : "";
    assert.match(systemText, /Ты MineAgent\./);
    assert.match(systemText, /sub-агент-ревизор/);
  });

  it("promptOverride перекрывает specialty-надстройку", async () => {
    const provider = new ScriptedProvider();
    const gate = makeAutoApproveGate();
    const runner = new SubAgentRunner(gate, () => "req-test-4");
    await runner.run(makeAgent({ specialty: "reviewer", promptOverride: "Ты эксперт по Mixins." }), {
      baseSystemPrompt: "Базовый",
      task: "Оцени",
      projectMap: makeProjectMap(),
      provider
    });
    const systemText = typeof provider.lastRequest!.messages[0].content === "string"
      ? provider.lastRequest!.messages[0].content as string
      : "";
    assert.match(systemText, /эксперт по Mixins/);
    assert.doesNotMatch(systemText, /ревизор/);
  });

  it("memoryMode=none → контекст не сохраняется между запусками", async () => {
    const provider = new ScriptedProvider();
    provider.queue = ["Первый ответ", "Второй ответ"];
    const gate = makeAutoApproveGate();
    const runner = new SubAgentRunner(gate, () => "req-test-5");
    await runner.run(makeAgent({ memoryMode: "none" }), {
      baseSystemPrompt: "Базовый",
      task: "Первый запуск",
      projectMap: makeProjectMap(),
      provider
    });
    const firstMsgCount = provider.lastRequest!.messages.length;
    await runner.run(makeAgent({ memoryMode: "none" }), {
      baseSystemPrompt: "Базовый",
      task: "Второй запуск",
      projectMap: makeProjectMap(),
      provider
    });
    // При memoryMode=none второй запуск не должен содержать контекст первого.
    assert.equal(provider.lastRequest!.messages.length, firstMsgCount);
  });

  it("memoryMode=session → контекст сохраняется между запусками", async () => {
    const provider = new ScriptedProvider();
    provider.queue = ["Первый ответ", "Второй ответ"];
    const gate = makeAutoApproveGate();
    const runner = new SubAgentRunner(gate, () => "req-test-6");
    await runner.run(makeAgent({ id: "mem-test", memoryMode: "session" }), {
      baseSystemPrompt: "Базовый",
      task: "Первый запуск",
      projectMap: makeProjectMap(),
      provider
    });
    const firstMsgCount = provider.lastRequest!.messages.length;
    await runner.run(makeAgent({ id: "mem-test", memoryMode: "session" }), {
      baseSystemPrompt: "Базовый",
      task: "Второй запуск",
      projectMap: makeProjectMap(),
      provider
    });
    // При memoryMode=session второй запуск должен содержать больше сообщений
    // (system + prior context + new user).
    assert.ok(provider.lastRequest!.messages.length > firstMsgCount,
      "session memory должна накапливать контекст");
  });

  it("memoryMode=task → контекст сохраняется в рамках одного runId", async () => {
    const provider = new ScriptedProvider();
    provider.queue = ["Ответ 1", "Ответ 2"];
    const gate = makeAutoApproveGate();
    const runner = new SubAgentRunner(gate, () => "req-test-7");
    const agent = makeAgent({ id: "task-mem", memoryMode: "task" });
    await runner.run(agent, {
      baseSystemPrompt: "Базовый",
      task: "Шаг 1",
      projectMap: makeProjectMap(),
      provider
    }, "task-123");
    const firstCount = provider.lastRequest!.messages.length;
    await runner.run(agent, {
      baseSystemPrompt: "Базовый",
      task: "Шаг 2",
      projectMap: makeProjectMap(),
      provider
    }, "task-123");
    assert.ok(provider.lastRequest!.messages.length > firstCount,
      "task memory должна накапливать контекст в рамках одного runId");
  });

  it("memoryMode=task → другой runId не видит чужой контекст", async () => {
    const provider = new ScriptedProvider();
    provider.queue = ["Ответ 1", "Ответ 2"];
    const gate = makeAutoApproveGate();
    const runner = new SubAgentRunner(gate, () => "req-test-8");
    const agent = makeAgent({ id: "task-mem2", memoryMode: "task" });
    await runner.run(agent, {
      baseSystemPrompt: "Базовый",
      task: "Задача A",
      projectMap: makeProjectMap(),
      provider
    }, "task-A");
    const firstCount = provider.lastRequest!.messages.length;
    await runner.run(agent, {
      baseSystemPrompt: "Базовый",
      task: "Задача B",
      projectMap: makeProjectMap(),
      provider
    }, "task-B");
    assert.equal(provider.lastRequest!.messages.length, firstCount,
      "task memory с другим runId не должна видеть чужой контекст");
  });

  it("clearTaskMemory очищает контекст конкретной задачи", async () => {
    const provider = new ScriptedProvider();
    provider.queue = ["Ответ 1", "Ответ 2"];
    const gate = makeAutoApproveGate();
    const runner = new SubAgentRunner(gate, () => "req-test-9");
    const agent = makeAgent({ id: "clear-test", memoryMode: "task" });
    await runner.run(agent, {
      baseSystemPrompt: "Базовый",
      task: "Шаг 1",
      projectMap: makeProjectMap(),
      provider
    }, "task-clear");
    const firstCount = provider.lastRequest!.messages.length;
    clearTaskMemory("task-clear");
    await runner.run(agent, {
      baseSystemPrompt: "Базовый",
      task: "Шаг 2",
      projectMap: makeProjectMap(),
      provider
    }, "task-clear");
    assert.equal(provider.lastRequest!.messages.length, firstCount,
      "после clearTaskMemory контекст должен быть пуст");
  });
});

describe("specialtyPresets (Этап 5)", () => {
  it("reviewer preset содержит промт и read-only tools", () => {
    const preset = getSpecialtyPreset("reviewer");
    assert.match(preset.promptOverlay, /ревизор/);
    assert.ok(preset.defaultTools.includes("repo.read"));
    assert.ok(!preset.defaultTools.includes("repo.patch"), "reviewer не должен иметь write-tools");
  });

  it("vision preset содержит промт и screenshot/render tools", () => {
    const preset = getSpecialtyPreset("vision");
    assert.match(preset.promptOverlay, /vision-оценщик/);
    assert.ok(preset.defaultTools.includes("minecraft.screenshot"));
    assert.ok(preset.defaultTools.includes("blockbench.render"));
  });

  it("custom preset — пустой промт и tools", () => {
    const preset = getSpecialtyPreset("custom");
    assert.equal(preset.promptOverlay, "");
    assert.equal(preset.defaultTools.length, 0);
  });

  it("buildSubAgentSystemPrompt склеивает базовый + надстройку", () => {
    const prompt = buildSubAgentSystemPrompt("Базовый", "reviewer");
    assert.match(prompt, /Базовый/);
    assert.match(prompt, /ревизор/);
  });

  it("buildSubAgentSystemPrompt с promptOverride заменяет надстройку", () => {
    const prompt = buildSubAgentSystemPrompt("Базовый", "reviewer", "Своя надстройка");
    assert.match(prompt, /Базовый/);
    assert.match(prompt, /Своя надстройка/);
    assert.doesNotMatch(prompt, /ревизор/);
  });

  it("getSpecialtyDefaultTools возвращает копию массива", () => {
    const tools1 = getSpecialtyDefaultTools("reviewer");
    const tools2 = getSpecialtyDefaultTools("reviewer");
    assert.deepEqual(tools1, tools2);
    tools1.push("custom-tool");
    assert.notDeepEqual(tools1, tools2, "изменение копии не должно влиять на оригинал");
  });
});
