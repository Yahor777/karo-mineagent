import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultMineAgentConfig } from "../src/config/defaultConfig";
import { ApprovalGate } from "../src/approval/approvalGate";
import { ToolRegistry } from "../src/tools/toolRegistry";
import { ToolDispatcher, setRequestIdGenerator } from "../src/tools/toolDispatcher";

// Детерминированный requestId для тестов.
setRequestIdGenerator(() => "req-test-fixed");

function makeRegistry(): { registry: ToolRegistry; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const registry = new ToolRegistry();
  // Read-only tool (без approval).
  registry.register("repo.read", async (input) => {
    calls["repo.read"] = (calls["repo.read"] ?? 0) + 1;
    return { text: `read ${(input as { path: string }).path}` };
  });
  // Write tool (требует approval).
  registry.register("repo.patch", async (input) => {
    calls["repo.patch"] = (calls["repo.patch"] ?? 0) + 1;
    return { accepted: Boolean((input as { patch: string }).patch) };
  });
  // Command tool.
  registry.register("gradle.run", async (input) => {
    calls["gradle.run"] = (calls["gradle.run"] ?? 0) + 1;
    return { exitCode: 0, task: (input as { task: string }).task };
  });
  return { registry, calls };
}

function makeGate(approve: boolean): { gate: ApprovalGate; posts: { type: string; payload?: unknown }[] } {
  const posts: { type: string; payload?: unknown }[] = [];
  const gate = new ApprovalGate(
    defaultMineAgentConfig,
    async () => {},
    (msg) => posts.push(msg),
    () => {}
  );
  // Обрабатываем все pending запросы синхронно — эмулируем мгновенный ответ UI.
  if (approve) {
    const originalPost = gate["post"] as (msg: { type: string; payload?: unknown }) => void;
    (gate as unknown as { post: (msg: { type: string; payload?: unknown }) => void }).post = (msg) => {
      originalPost(msg);
      posts.push(msg);
      // auto-resolve сразу.
      const req = msg.payload as { requestId: string };
      setImmediate(() => gate.resolve({ requestId: req.requestId, decision: "confirm-once" }));
    };
  }
  return { gate, posts };
}

describe("ToolDispatcher", () => {
  it("read-only tool вызывается напрямую, без approval", async () => {
    const { registry, calls } = makeRegistry();
    const gate = new ApprovalGate(defaultMineAgentConfig, async () => {}, () => {}, () => {});
    const dispatcher = new ToolDispatcher(registry, gate);
    const result = await dispatcher.dispatch("repo.read", { path: "README.md" }, "Чтение файла");
    assert.deepEqual(result, { text: "read README.md" });
    assert.equal(calls["repo.read"], 1);
  });

  it("write tool при approve → вызывает handler", async () => {
    const { registry, calls } = makeRegistry();
    const posts: { type: string; payload?: unknown }[] = [];
    const gate = new ApprovalGate(defaultMineAgentConfig, async () => {}, (msg) => posts.push(msg), () => {});
    const dispatcher = new ToolDispatcher(registry, gate);

    const promise = dispatcher.dispatch("repo.patch", { patch: "diff" }, "Применить патч");
    // Утверждаем запрос после его появления.
    await new Promise((r) => setImmediate(r));
    const req = posts.find((p) => p.type === "approvalRequest")?.payload as { requestId: string };
    gate.resolve({ requestId: req.requestId, decision: "confirm-once" });
    const result = await promise;
    assert.deepEqual(result, { accepted: true });
    assert.equal(calls["repo.patch"], 1);
  });

  it("write tool при deny → throw, handler не вызывается", async () => {
    const { registry, calls } = makeRegistry();
    const posts: { type: string; payload?: unknown }[] = [];
    const gate = new ApprovalGate(defaultMineAgentConfig, async () => {}, (msg) => posts.push(msg), () => {});
    const dispatcher = new ToolDispatcher(registry, gate);

    const promise = dispatcher.dispatch("gradle.run", { task: "build" }, "Gradle build");
    await new Promise((r) => setImmediate(r));
    const req = posts.find((p) => p.type === "approvalRequest")?.payload as { requestId: string };
    gate.resolve({ requestId: req.requestId, decision: "deny" });

    await assert.rejects(promise, /не одобрено/);
    assert.equal(calls["gradle.run"], undefined, "handler не должен вызваться при deny");
  });

  it("dispatch несуществующего tool → throw", async () => {
    const { registry } = makeRegistry();
    const gate = new ApprovalGate(defaultMineAgentConfig, async () => {}, () => {}, () => {});
    const dispatcher = new ToolDispatcher(registry, gate);
    await assert.rejects(
      () => dispatcher.dispatch("no.such.tool", {}, "Несуществующий"),
      /не зарегистрирован/
    );
  });

  it("contractFor возвращает контракт по имени", () => {
    const { registry } = makeRegistry();
    const gate = new ApprovalGate(defaultMineAgentConfig, async () => {}, () => {}, () => {});
    const dispatcher = new ToolDispatcher(registry, gate);
    const contract = dispatcher.contractFor("gradle.run");
    assert.equal(contract?.risk, "command");
    assert.equal(contract?.requiresApproval, true);
  });

  it("autoApproveTools обходит модалку для write tool", async () => {
    const { registry, calls } = makeRegistry();
    const config = {
      ...defaultMineAgentConfig,
      agent: { ...defaultMineAgentConfig.agent, autoApproveTools: ["repo.patch"] }
    };
    const posts: { type: string; payload?: unknown }[] = [];
    const gate = new ApprovalGate(config, async () => {}, (msg) => posts.push(msg), () => {});
    const dispatcher = new ToolDispatcher(registry, gate);

    const result = await dispatcher.dispatch("repo.patch", { patch: "x" }, "Патч");
    assert.deepEqual(result, { accepted: true });
    assert.equal(posts.length, 0, "модалка не показывается");
    assert.equal(calls["repo.patch"], 1);
  });
});
