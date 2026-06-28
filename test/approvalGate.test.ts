import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MineAgentConfig } from "../src/config/types";
import { defaultMineAgentConfig } from "../src/config/defaultConfig";
import { ApprovalGate } from "../src/approval/approvalGate";
import type { ApprovalRequest, ApprovalResponse } from "../src/approval/types";

// Базовый запрос с разными scopeId/risk. requestId контролируем вручную.
function makeRequest(overrides: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    requestId: `req-${overrides.scopeId ?? "test"}-${Math.random().toString(36).slice(2, 6)}`,
    toolName: overrides.toolName ?? "gradle.run",
    scope: "tool",
    scopeId: "gradle.run",
    description: "Запуск Gradle",
    risk: "command",
    ...overrides
  };
}

// Фабрика gate с записью всех постов и notify-сообщений.
function makeGate(config: MineAgentConfig): {
  gate: ApprovalGate;
  posts: { type: string; payload?: unknown }[];
  notifies: string[];
  persistCalls: MineAgentConfig[];
} {
  const posts: { type: string; payload?: unknown }[] = [];
  const notifies: string[] = [];
  const persistCalls: MineAgentConfig[] = [];
  const gate = new ApprovalGate(
    config,
    async (cfg) => {
      persistCalls.push(cfg);
    },
    (msg) => {
      posts.push(msg);
    },
    (msg) => {
      notifies.push(msg);
    }
  );
  return { gate, posts, notifies, persistCalls };
}

describe("ApprovalGate — auto-approve пути", () => {
  it("autoApproveTools содержит scopeId → true без post в view", async () => {
    const config: MineAgentConfig = {
      ...defaultMineAgentConfig,
      agent: { ...defaultMineAgentConfig.agent, autoApproveTools: ["gradle.run"] }
    };
    const { gate, posts } = makeGate(config);
    const result = await gate.request(makeRequest({ scopeId: "gradle.run", risk: "command" }));
    assert.equal(result, true);
    assert.equal(posts.length, 0, "не должно постить в view при autoApprove");
  });

  it("approvalMode=auto-readonly И risk=read → true без модалки", async () => {
    const config: MineAgentConfig = {
      ...defaultMineAgentConfig,
      agent: { ...defaultMineAgentConfig.agent, approvalMode: "auto-readonly" }
    };
    const { gate, posts } = makeGate(config);
    const result = await gate.request(makeRequest({ scopeId: "repo.read", toolName: "repo.read", risk: "read" }));
    assert.equal(result, true);
    assert.equal(posts.length, 0);
  });

  it("approvalMode=auto-readonly НЕ авто-approve для command risk", async () => {
    const config: MineAgentConfig = {
      ...defaultMineAgentConfig,
      agent: { ...defaultMineAgentConfig.agent, approvalMode: "auto-readonly" }
    };
    const { gate, posts } = makeGate(config);
    // Возвращаем false через deny — без resolve запрос повиснет, используем короткий таймаут.
    const promise = gate.request(makeRequest({ scopeId: "gradle.run", risk: "command" }));
    assert.equal(posts.length, 1, "должен показать модалку для command");
    // Respond deny.
    const req = posts[0].payload as ApprovalRequest;
    gate.resolve({ requestId: req.requestId, decision: "deny" });
    const result = await promise;
    assert.equal(result, false);
  });

  it("approvalMode=workspace И risk=read → true без модалки", async () => {
    const config: MineAgentConfig = {
      ...defaultMineAgentConfig,
      agent: { ...defaultMineAgentConfig.agent, approvalMode: "workspace" }
    };
    const { gate, posts } = makeGate(config);
    const result = await gate.request(makeRequest({ scopeId: "repo.read", toolName: "repo.read", risk: "read" }));
    assert.equal(result, true);
    assert.equal(posts.length, 0);
  });
});

describe("ApprovalGate — round-trip решения", () => {
  it("confirm-once → true, не persist, не session", async () => {
    const { gate, posts, persistCalls } = makeGate(defaultMineAgentConfig);
    const promise = gate.request(makeRequest({ scopeId: "gradle.run" }));
    const req = posts[0].payload as ApprovalRequest;
    gate.resolve({ requestId: req.requestId, decision: "confirm-once" });
    assert.equal(await promise, true);
    assert.equal(persistCalls.length, 0, "confirm-once не persist");

    // Повторный запрос того же scopeId снова покажет модалку (session не добавлен).
    const promise2 = gate.request(makeRequest({ scopeId: "gradle.run" }));
    assert.equal(posts.length, 2, "модалка должна появиться снова");
    const req2 = posts[1].payload as ApprovalRequest;
    gate.resolve({ requestId: req2.requestId, decision: "deny" });
    assert.equal(await promise2, false);
  });

  it("always-in-session → true, последующий без модалки", async () => {
    const { gate, posts } = makeGate(defaultMineAgentConfig);
    const promise1 = gate.request(makeRequest({ scopeId: "repo.patch", toolName: "repo.patch", risk: "write" }));
    const req1 = posts[0].payload as ApprovalRequest;
    gate.resolve({ requestId: req1.requestId, decision: "always-in-session" });
    assert.equal(await promise1, true);

    // Второй запрос того же scopeId — без модалки.
    const result2 = await gate.request(makeRequest({ scopeId: "repo.patch", toolName: "repo.patch", risk: "write" }));
    assert.equal(result2, true);
    assert.equal(posts.length, 1, "модалка не должна повторяться");
  });

  it("always-all-in-session → ДРУГОЙ scopeId авто-approve, resetSession сбрасывает", async () => {
    const { gate, posts, persistCalls } = makeGate(defaultMineAgentConfig);
    // Одобряем один MCP-инструмент с «всё в этой сессии».
    const promise1 = gate.request(makeRequest({ scopeId: "blockbench.add_group", toolName: "blockbench.add_group", risk: "write" }));
    const req1 = posts[0].payload as ApprovalRequest;
    gate.resolve({ requestId: req1.requestId, decision: "always-all-in-session" });
    assert.equal(await promise1, true);
    assert.equal(persistCalls.length, 0, "session-wide trust не persist'ится");

    // Совершенно другой scopeId следующего инструмента — без модалки.
    const result2 = await gate.request(makeRequest({ scopeId: "blockbench.create_texture", toolName: "blockbench.create_texture", risk: "write" }));
    assert.equal(result2, true);
    const result3 = await gate.request(makeRequest({ scopeId: "minecraft.summon", toolName: "minecraft.summon", risk: "game-control" }));
    assert.equal(result3, true);
    assert.equal(posts.length, 1, "после session-wide trust модалка больше не появляется");

    // resetSession снимает доверие — снова модалка.
    gate.resetSession();
    const promise4 = gate.request(makeRequest({ scopeId: "blockbench.create_texture", toolName: "blockbench.create_texture", risk: "write" }));
    assert.equal(posts.length, 2, "после reset session-wide trust снят");
    const req4 = posts[1].payload as ApprovalRequest;
    gate.resolve({ requestId: req4.requestId, decision: "deny" });
    assert.equal(await promise4, false);
  });

  it("always → true, persist в config.agent.autoApproveTools", async () => {
    const { gate, posts, persistCalls } = makeGate(defaultMineAgentConfig);
    const promise = gate.request(makeRequest({ scopeId: "minecraft.runClient", toolName: "minecraft.runClient", risk: "game-control" }));
    const req = posts[0].payload as ApprovalRequest;
    gate.resolve({ requestId: req.requestId, decision: "always" });
    assert.equal(await promise, true);

    // persist вызывается асинхронно (void this.persistAlways).
    await new Promise((r) => setImmediate(r));
    assert.equal(persistCalls.length, 1);
    assert.ok(persistCalls[0].agent.autoApproveTools.includes("minecraft.runClient"));
  });

  it("deny → false", async () => {
    const { gate, posts } = makeGate(defaultMineAgentConfig);
    const promise = gate.request(makeRequest({ scopeId: "gradle.run" }));
    const req = posts[0].payload as ApprovalRequest;
    gate.resolve({ requestId: req.requestId, decision: "deny" });
    assert.equal(await promise, false);
  });

  it("resolve для неизвестного requestId → false (no-op)", () => {
    const { gate } = makeGate(defaultMineAgentConfig);
    const handled = gate.resolve({ requestId: "no-such-id", decision: "confirm-once" });
    assert.equal(handled, false);
  });
});

describe("ApprovalGate — misc", () => {
  it("resetSession сбрасывает session-approved", async () => {
    const { gate, posts } = makeGate(defaultMineAgentConfig);
    const promise = gate.request(makeRequest({ scopeId: "repo.patch", toolName: "repo.patch", risk: "write" }));
    const req = posts[0].payload as ApprovalRequest;
    gate.resolve({ requestId: req.requestId, decision: "always-in-session" });
    await promise;

    gate.resetSession();

    // После reset — снова модалка.
    const promise2 = gate.request(makeRequest({ scopeId: "repo.patch", toolName: "repo.patch", risk: "write" }));
    assert.equal(posts.length, 2);
    const req2 = posts[1].payload as ApprovalRequest;
    gate.resolve({ requestId: req2.requestId, decision: "deny" });
    assert.equal(await promise2, false);
  });

  it("pendingCount отражает ждущие запросы", async () => {
    const { gate } = makeGate(defaultMineAgentConfig);
    assert.equal(gate.pendingCount(), 0);
    void gate.request(makeRequest({ scopeId: "gradle.run" }));
    assert.equal(gate.pendingCount(), 1);
  });

  it("updateConfig подхватывает новый whitelist", async () => {
    const { gate, posts } = makeGate(defaultMineAgentConfig);
    const config2: MineAgentConfig = {
      ...defaultMineAgentConfig,
      agent: { ...defaultMineAgentConfig.agent, autoApproveTools: ["gradle.run"] }
    };
    gate.updateConfig(config2);
    const result = await gate.request(makeRequest({ scopeId: "gradle.run" }));
    assert.equal(result, true);
    assert.equal(posts.length, 0);
  });
});
