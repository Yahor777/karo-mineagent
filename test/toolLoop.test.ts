import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { defaultMineAgentConfig } from "../src/config/defaultConfig";
import type { MineAgentConfig } from "../src/config/types";
import { MineAgentOrchestrator } from "../src/orchestrator/orchestrator";
import { ApprovalGate } from "../src/approval/approvalGate";
import { ToolRegistry } from "../src/tools/toolRegistry";
import { ToolDispatcher, setRequestIdGenerator } from "../src/tools/toolDispatcher";
import type { ChatRequest, ChatResponse, ProviderAdapter, ProviderModel, StreamChunk, ToolCall } from "../src/providers/ProviderAdapter";
import { extractTextFromContent } from "../src/providers/ProviderAdapter";

// Детерминированный requestId, чтобы auto-resolve в gate находил запрос.
setRequestIdGenerator(() => "req-loop-fixed");

// Очередной «ответ модели» в loop. content — текст, calls — tool_calls.
interface QueuedResponse {
  content?: string;
  toolCalls?: ToolCall[];
}

// FakeProvider отдаёт ответы по очереди (первый chat() → первый элемент),
// чтобы имитировать многошаговый tool-loop «модель зовёт tool → получает
// результат → отвечает финальным текстом».
class ScriptedProvider implements ProviderAdapter {
  public readonly id = "fireworks";
  public readonly displayName = "Fireworks AI";
  public queue: QueuedResponse[] = [];
  public requests: ChatRequest[] = [];
  public models = ["@cf/moonshotai/kimi-k2.7-code"];

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    const next = this.queue.shift();
    if (!next) {
      throw new Error("ScriptedProvider: очередь ответов исчерпана");
    }
    return {
      model: request.model,
      content: next.content ?? "",
      toolCalls: next.toolCalls
    };
  }

  public async *streamChat(request: ChatRequest): AsyncIterable<StreamChunk> {
    yield { contentDelta: (await this.chat(request)).content };
  }

  public async listModels(): Promise<ProviderModel[]> {
    return this.models.map((id) => ({
      id,
      label: id,
      provider: "fireworks",
      capabilities: { vision: false, tools: true, jsonMode: true, speed: "fast" }
    }));
  }

  public async validateKey(): Promise<boolean> {
    return true;
  }
}

// In-memory ToolRegistry + счётчик вызовов и настраиваемые результаты.
interface FakeTools {
  registry: ToolRegistry;
  calls: { name: string; input: unknown }[];
  // Что вернуть из repo.patch (accepted?).
  patchAccepted: boolean;
  // exitCode авто/manual gradle.run. 0 = успех.
  gradleExitCode: number;
  gradleStderr: string;
  gradleStdout: string;
}

function makeTools(): FakeTools {
  const tools: FakeTools = {
    registry: new ToolRegistry(),
    calls: [],
    patchAccepted: true,
    gradleExitCode: 0,
    gradleStderr: "",
    gradleStdout: "BUILD SUCCESSFUL"
  };
  tools.registry.register("repo.read", async (input) => {
    tools.calls.push({ name: "repo.read", input });
    return { text: `contents of ${(input as { path: string }).path}` };
  });
  tools.registry.register("repo.patch", async (input) => {
    tools.calls.push({ name: "repo.patch", input });
    return { accepted: tools.patchAccepted };
  });
  tools.registry.register("gradle.run", async (input) => {
    tools.calls.push({ name: "gradle.run", input });
    return {
      command: `gradlew ${(input as { task?: string }).task ?? "build"}`,
      cwd: ".",
      exitCode: tools.gradleExitCode,
      startedAt: "t0",
      completedAt: "t1",
      stdout: tools.gradleStdout,
      stderr: tools.gradleStderr
    };
  });
  return tools;
}

// Gate, одобряющий всё синхронно (через auto-resolve в post).
function makeAutoApproveGate(config: MineAgentConfig): ApprovalGate {
  const gate = new ApprovalGate(config, async () => {}, () => {}, () => {});
  // Подменяем post: после посылки запроса в view сразу resolve его.
  (gate as unknown as { post: (msg: { type: string; payload?: { requestId?: string } }) => void }).post = (msg) => {
    if (msg.type === "approvalRequest" && msg.payload?.requestId) {
      setImmediate(() => gate.resolve({ requestId: msg.payload!.requestId!, decision: "confirm-once" }));
    }
  };
  return gate;
}

function configWithoutTiering(): MineAgentConfig {
  return {
    ...defaultMineAgentConfig,
    providers: {
      ...defaultMineAgentConfig.providers,
      defaultProvider: "fireworks",
      defaultModel: "@cf/moonshotai/kimi-k2.7-code",
      // singleChat path не нужен — проверяем именно loop.
      routineModel: "",
      complexModel: ""
    }
  };
}

async function write(root: string, relativePath: string, text: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

async function makeProject(root: string): Promise<void> {
  await write(root, "gradle.properties", "minecraft_version=1.20.1\n");
  await write(root, "build.gradle", "plugins { id 'net.minecraftforge.gradle' version '6.0.+' }\n");
}

describe("MineAgentOrchestrator tool-loop (Этап 2)", () => {
  it("repo.read → финальный ответ: один tool-call, потом текст", async () => {
    const root = join(tmpdir(), `mineagent-loop-read-${Date.now()}`);
    const provider = new ScriptedProvider();
    const tools = makeTools();
    try {
      await makeProject(root);
      provider.queue = [
        {
          toolCalls: [{ id: "c1", name: "repo.read", arguments: "{\"path\":\"README.md\"}" }]
        },
        { content: "Прочитал файл, вот ответ." }
      ];
      const gate = makeAutoApproveGate(configWithoutTiering());
      const dispatcher = new ToolDispatcher(tools.registry, gate);
      const orchestrator = new MineAgentOrchestrator(root, configWithoutTiering(), {
        get: async () => provider,
        providerStatuses: async () => [{ id: "fireworks", hasKey: true }]
      } as never, undefined, dispatcher);

      const report = await orchestrator.run({ prompt: "прочитай README", mode: "ask" });

      assert.equal(report.summary, "Прочитал файл, вот ответ.");
      assert.equal(report.toolCalls?.length, 1);
      assert.equal(report.toolCalls?.[0]?.name, "repo.read");
      // Второй запрос к модели НЕ содержит tools-вызова, а拿到了 результат.
      assert.equal(provider.requests.length, 2);
      // Второе сообщение в диалоге второго запроса — role:"tool" с результатом repo.read.
      const secondMessages = provider.requests[1]!.messages;
      const toolReply = secondMessages.find((m) => m.role === "tool");
      assert.equal(toolReply?.name, "repo.read");
      assert.match(extractTextFromContent(toolReply?.content ?? ""), /contents of README\.md/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repo.patch accepted → авто gradle.run в той же итерации", async () => {
    const root = join(tmpdir(), `mineagent-loop-patch-${Date.now()}`);
    const provider = new ScriptedProvider();
    const tools = makeTools();
    tools.gradleExitCode = 0;
    try {
      await makeProject(root);
      provider.queue = [
        {
          toolCalls: [{ id: "c1", name: "repo.patch", arguments: "{\"patch\":\"diff\"}" }]
        },
        { content: "Готово, патч применён и собран." }
      ];
      const gate = makeAutoApproveGate(configWithoutTiering());
      const dispatcher = new ToolDispatcher(tools.registry, gate);
      const orchestrator = new MineAgentOrchestrator(root, configWithoutTiering(), {
        get: async () => provider,
        providerStatuses: async () => [{ id: "fireworks", hasKey: true }]
      } as never, undefined, dispatcher);

      const report = await orchestrator.run({ prompt: "добавь метод", mode: "build" });

      // patch и авто-build оба прошли через dispatcher.
      const names = tools.calls.map((c) => c.name);
      assert.deepEqual(names, ["repo.patch", "gradle.run"], "после accepted patch должен сработать авто-build");
      // Trace фиксирует авто-build.
      const patchTrace = report.toolCalls?.find((t) => t.name === "repo.patch");
      assert.equal(patchTrace?.autoBuildTriggered, true);
      assert.equal(patchTrace?.autoBuildExitCode, 0);
      // Второй запрос к модели содержит role:"tool" от gradle.run (авто).
      const secondMessages = provider.requests[1]!.messages;
      const buildReply = secondMessages.find((m) => m.role === "tool" && m.name === "gradle.run");
      assert.ok(buildReply, "авто-build результат должен быть в диалоге");
      assert.match(extractTextFromContent(buildReply?.content ?? ""), /BUILD SUCCESSFUL/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repo.patch deny → авто-build НЕ запускается, модель видит отказ", async () => {
    const root = join(tmpdir(), `mineagent-loop-deny-${Date.now()}`);
    const provider = new ScriptedProvider();
    const tools = makeTools();
    try {
      await makeProject(root);
      provider.queue = [
        { toolCalls: [{ id: "c1", name: "repo.patch", arguments: "{\"patch\":\"diff\"}" }] },
        { content: "Понял, патч отклонён." }
      ];
      // Gate, который ВСЁ deny.
      const config = configWithoutTiering();
      const gate = new ApprovalGate(config, async () => {}, () => {}, () => {});
      (gate as unknown as { post: (msg: { type: string; payload?: { requestId?: string } }) => void }).post = (msg) => {
        if (msg.type === "approvalRequest" && msg.payload?.requestId) {
          setImmediate(() => gate.resolve({ requestId: msg.payload!.requestId!, decision: "deny" }));
        }
      };
      const dispatcher = new ToolDispatcher(tools.registry, gate);
      const orchestrator = new MineAgentOrchestrator(root, config, {
        get: async () => provider,
        providerStatuses: async () => [{ id: "fireworks", hasKey: true }]
      } as never, undefined, dispatcher);

      const report = await orchestrator.run({ prompt: "добавь метод", mode: "build" });

      // repo.patch был вызван (до deny), но gradle.run — НЕТ (deny прервал patch).
      const names = tools.calls.map((c) => c.name);
      assert.deepEqual(names, [], "patch deny → ни patch handler, ни gradle не выполняются");
      // Trace фиксирует ошибку отказа.
      const patchTrace = report.toolCalls?.find((t) => t.name === "repo.patch");
      assert.ok(patchTrace?.error, "trace должен содержать ошибку отказа");
      assert.equal(patchTrace?.autoBuildTriggered, undefined, "авто-build не должен триггериться");
      // Модель во втором запросе видит отказ через role:"tool".
      const secondMessages = provider.requests[1]!.messages;
      const toolReply = secondMessages.find((m) => m.role === "tool");
      assert.match(extractTextFromContent(toolReply?.content ?? ""), /не одобрено|error/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gradle.run exitCode !== 0 → parseMinecraftLog кормит ошибку в модель", async () => {
    const root = join(tmpdir(), `mineagent-loop-diagnose-${Date.now()}`);
    const provider = new ScriptedProvider();
    const tools = makeTools();
    tools.gradleExitCode = 1;
    tools.gradleStderr = "java.lang.NullPointerException at com.example.Mod.init(Mod.java:42)";
    try {
      await makeProject(root);
      provider.queue = [
        {
          toolCalls: [
            { id: "c1", name: "repo.patch", arguments: "{\"patch\":\"diff\"}" }
            // авто-build упадёт (exitCode=1) → diagnose сообщение
          ]
        },
        { content: "Понял ошибку сборки, поправил." }
      ];
      const gate = makeAutoApproveGate(configWithoutTiering());
      const dispatcher = new ToolDispatcher(tools.registry, gate);
      const orchestrator = new MineAgentOrchestrator(root, configWithoutTiering(), {
        get: async () => provider,
        providerStatuses: async () => [{ id: "fireworks", hasKey: true }]
      } as never, undefined, dispatcher);

      const report = await orchestrator.run({ prompt: "добавь метод", mode: "build" });

      // patch + авто gradle выполнены.
      const names = tools.calls.map((c) => c.name);
      assert.deepEqual(names, ["repo.patch", "gradle.run"]);
      // Во втором запросе должно появиться role:"tool" name:"diagnose" с parsed summary.
      const secondMessages = provider.requests[1]!.messages;
      const diagnose = secondMessages.find((m) => m.role === "tool" && m.name === "diagnose");
      assert.ok(diagnose, "после упавшего build должно появиться diagnose-сообщение");
      const parsed = JSON.parse(extractTextFromContent(diagnose!.content));
      // parseMinecraftLog извлекает NullPointerException.
      assert.ok(parsed.exceptions.some((e: string) => /NullPointerException/.test(e))
        || /Null access/.test(parsed.likelyCause ?? ""),
      "diagnose должен содержать извлечённое исключение/likelyCause");
      void report;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maxToolIterations cap: модель зациклилась на tool_calls → выход по лимиту", async () => {
    const root = join(tmpdir(), `mineagent-loop-cap-${Date.now()}`);
    const provider = new ScriptedProvider();
    const tools = makeTools();
    try {
      await makeProject(root);
      // Модель вечно зовёт repo.read и никогда не даёт финальный текст.
      const looping: QueuedResponse = {
        toolCalls: [{ id: "c", name: "repo.read", arguments: "{\"path\":\"a\"}" }]
      };
      provider.queue = Array.from({ length: 20 }, () => looping);
      const config = configWithoutTiering();
      // Лимит итераций = 2 для скорости теста.
      config.agent = { ...config.agent, maxToolIterations: 2, maxDiagnoseIterations: 0 };
      const gate = makeAutoApproveGate(config);
      const dispatcher = new ToolDispatcher(tools.registry, gate);
      const orchestrator = new MineAgentOrchestrator(root, config, {
        get: async () => provider,
        providerStatuses: async () => [{ id: "fireworks", hasKey: true }]
      } as never, undefined, dispatcher);

      const report = await orchestrator.run({ prompt: "читай бесконечно", mode: "ask" });

      // maxIterations tool-итераций + 1 принудительная финализация (tool_choice:none),
      // которая заставляет модель ответить вместо бесконечных tool_calls.
      assert.equal(provider.requests.length, 3);
      // Последний запрос — финализация: tools отключены через tool_choice:none.
      assert.equal(provider.requests[provider.requests.length - 1]?.tool_choice, "none");
      assert.match(report.summary, /лимит tool-loop итераций|tool-loop limit/);
      // repo.read вызывался ровно на каждой tool-итерации (не больше лимита).
      assert.equal(tools.calls.filter((c) => c.name === "repo.read").length, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("anti-loop: при ВЫСОКОМ потолке повтор одинаковых вызовов останавливает цикл рано", async () => {
    const root = join(tmpdir(), `mineagent-loop-detect-${Date.now()}`);
    const provider = new ScriptedProvider();
    const tools = makeTools();
    try {
      await makeProject(root);
      // Модель повторяет ОДИН И ТОТ ЖЕ вызов с теми же аргументами — это «тупление».
      const looping: QueuedResponse = {
        toolCalls: [{ id: "c", name: "repo.read", arguments: "{\"path\":\"same\"}" }]
      };
      provider.queue = Array.from({ length: 50 }, () => looping);
      const config = configWithoutTiering();
      // Потолок высокий (100) — но детектор зацикливания обязан остановить раньше.
      config.agent = { ...config.agent, maxToolIterations: 100, maxDiagnoseIterations: 0 };
      const gate = makeAutoApproveGate(config);
      const dispatcher = new ToolDispatcher(tools.registry, gate);
      const orchestrator = new MineAgentOrchestrator(root, config, {
        get: async () => provider,
        providerStatuses: async () => [{ id: "fireworks", hasKey: true }]
      } as never, undefined, dispatcher);

      await orchestrator.run({ prompt: "читай одно и то же", mode: "ask" });

      // Детектор ловит повтор после 2-го одинакового шага: 2 tool-шага + 1 финализация.
      // Главное — НЕ дошли до потолка 100 (иначе цикл «тупил» бы и жёг токены).
      assert.ok(provider.requests.length <= 4, `ожидали раннюю остановку, получили ${provider.requests.length} запросов`);
      assert.ok(tools.calls.filter((c) => c.name === "repo.read").length <= 3);
      assert.equal(provider.requests[provider.requests.length - 1]?.tool_choice, "none");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("без dispatcher → одноразовый chat (legacy путь), toolCalls в report нет", async () => {
    const root = join(tmpdir(), `mineagent-loop-legacy-${Date.now()}`);
    const provider = new ScriptedProvider();
    try {
      await makeProject(root);
      provider.queue = [{ content: "Обычный ответ без tools." }];
      // dispatcher НЕ передаём (5-й аргумент конструктора опущен).
      const orchestrator = new MineAgentOrchestrator(root, configWithoutTiering(), {
        get: async () => provider,
        providerStatuses: async () => [{ id: "fireworks", hasKey: true }]
      } as never);

      const report = await orchestrator.run({ prompt: "ответь", mode: "ask" });

      assert.equal(report.summary, "Обычный ответ без tools.");
      assert.equal(report.toolCalls, undefined);
      assert.equal(provider.requests.length, 1);
      // Запрос не содержал tools-схем.
      assert.equal(provider.requests[0]?.tools, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
