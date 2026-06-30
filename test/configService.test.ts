import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigService } from "../src/config/configService";

describe("ConfigService", () => {
  it("can read Fireworks API key from development environment", async () => {
    const previous = process.env.MINEAGENT_FIREWORKS_API_KEY;
    const root = await mkdtemp(join(tmpdir(), "mineagent-config-"));
    process.env.MINEAGENT_FIREWORKS_API_KEY = "test-fireworks-key";
    try {
      const service = new ConfigService(fakeContext(), {
        uri: { fsPath: root, toString: () => `file://${root}` }
      } as never);

      assert.equal(await service.getProviderKey("fireworks"), "test-fireworks-key");
      assert.equal(await service.hasProviderKey("fireworks"), true);
    } finally {
      if (previous === undefined) {
        delete process.env.MINEAGENT_FIREWORKS_API_KEY;
      } else {
        process.env.MINEAGENT_FIREWORKS_API_KEY = previous;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("can read Cloudflare token from development environment and merge Account ID", async () => {
    const previousToken = process.env.CLOUDFLARE_API_TOKEN;
    const previousAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    const root = await mkdtemp(join(tmpdir(), "mineagent-cloudflare-config-"));
    process.env.CLOUDFLARE_API_TOKEN = "test-cloudflare-token";
    process.env.CLOUDFLARE_ACCOUNT_ID = "test-account-id";
    try {
      const service = new ConfigService(fakeContext(), {
        uri: { fsPath: root, toString: () => `file://${root}` }
      } as never);

      const config = await service.ensureWorkspaceFiles();

      assert.equal(await service.getProviderKey("cloudflare"), "test-cloudflare-token");
      assert.equal(await service.hasProviderKey("cloudflare"), true);
      assert.equal(config.providers.cloudflare.accountId, "test-account-id");
    } finally {
      if (previousToken === undefined) {
        delete process.env.CLOUDFLARE_API_TOKEN;
      } else {
        process.env.CLOUDFLARE_API_TOKEN = previousToken;
      }
      if (previousAccount === undefined) {
        delete process.env.CLOUDFLARE_ACCOUNT_ID;
      } else {
        process.env.CLOUDFLARE_ACCOUNT_ID = previousAccount;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to a global provider key for new workspaces", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "mineagent-key-first-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "mineagent-key-second-"));
    const context = fakeContext();
    try {
      const firstService = new ConfigService(context, {
        uri: { fsPath: firstRoot, toString: () => `file://${firstRoot}` }
      } as never);
      const secondService = new ConfigService(context, {
        uri: { fsPath: secondRoot, toString: () => `file://${secondRoot}` }
      } as never);

      await firstService.setProviderKey("cloudflare", "shared-cloudflare-token");

      assert.equal(await secondService.getProviderKey("cloudflare"), "shared-cloudflare-token");
      assert.equal(await secondService.hasProviderKey("cloudflare"), true);
    } finally {
      await rm(firstRoot, { recursive: true, force: true });
      await rm(secondRoot, { recursive: true, force: true });
    }
  });

  it("reads workspace config files with UTF-8 BOM", async () => {
    const root = await mkdtemp(join(tmpdir(), "mineagent-config-bom-"));
    try {
      await mkdir(join(root, ".mineagent"), { recursive: true });
      await writeFile(join(root, ".mineagent", "config.json"), `\uFEFF${JSON.stringify({
        version: 1,
        providers: {
          defaultProvider: "fireworks",
          defaultModel: "accounts/fireworks/models/kimi-k2p7-code",
          custom: {
            baseUrl: "",
            modelsEndpoint: "/v1/models",
            chatEndpoint: "/v1/chat/completions"
          }
        },
        agent: {
          approvalMode: "ask",
          evidenceRetentionDays: 14,
          defaultRunPhases: ["Understand", "Research", "Patch", "Build", "Launch", "Playtest", "Diagnose", "Report"]
        },
        minecraft: {
          gradleBuildTask: "build",
          runClientTask: "runClient",
          devBridgeEnabled: false
        },
        paths: {
          skills: ".mineagent/skills",
          referencePacks: ".mineagent/reference-packs",
          playtests: ".mineagent/playtests",
          runs: ".mineagent/runs"
        }
      })}\n`, "utf8");

      const service = new ConfigService(fakeContext(), {
        uri: { fsPath: root, toString: () => `file://${root}` }
      } as never);

      const config = await service.readConfig();
      assert.equal(config?.providers.defaultProvider, "fireworks");
      assert.equal(config?.providers.defaultModel, "accounts/fireworks/models/kimi-k2p7-code");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Этап 3: mergeConfig подставляет дефолтные mcp.blockbench в старый config.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "mineagent-config-mcp-"));
    try {
      await mkdir(join(root, ".mineagent"), { recursive: true });
      // Старый config БЕЗ секции mcp (как до Этапа 3).
      await writeFile(join(root, ".mineagent", "config.json"), `${JSON.stringify({
        version: 1,
        providers: {
          defaultProvider: "cloudflare",
          defaultModel: "@cf/moonshotai/kimi-k2.7-code",
          custom: { baseUrl: "", modelsEndpoint: "/v1/models", chatEndpoint: "/v1/chat/completions" }
        },
        agent: { approvalMode: "ask", autoApproveTools: [] },
        minecraft: { gradleBuildTask: "build", runClientTask: "runClient", devBridgeEnabled: false },
        paths: {}
      })}\n`, "utf8");

      const service = new ConfigService(fakeContext(), {
        uri: { fsPath: root, toString: () => `file://${root}` }
      } as never);

      const config = await service.ensureWorkspaceFiles();
      // mcp.blockbench подставился из дефолта (backward-compat).
      assert.equal(config.mcp.blockbench.enabled, false);
      assert.equal(config.mcp.blockbench.url, "http://localhost:3000/bb-mcp");
      assert.equal(config.mcp.blockbench.timeoutMs, 60_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Этап 3: пользовательский mcp.blockbench.url сохраняется при merge", async () => {
    const root = await mkdtemp(join(tmpdir(), "mineagent-config-mcp-custom-"));
    try {
      await mkdir(join(root, ".mineagent"), { recursive: true });
      await writeFile(join(root, ".mineagent", "config.json"), `${JSON.stringify({
        version: 1,
        providers: { defaultProvider: "cloudflare", defaultModel: "m", custom: { baseUrl: "", modelsEndpoint: "/v1/models", chatEndpoint: "/v1/chat/completions" } },
        agent: { approvalMode: "ask", autoApproveTools: [] },
        minecraft: { gradleBuildTask: "build", runClientTask: "runClient", devBridgeEnabled: false },
        paths: {},
        mcp: { blockbench: { enabled: true, url: "http://localhost:8080/mcp", timeoutMs: 30_000 } }
      })}\n`, "utf8");

      const service = new ConfigService(fakeContext(), {
        uri: { fsPath: root, toString: () => `file://${root}` }
      } as never);

      const config = await service.ensureWorkspaceFiles();
      assert.equal(config.mcp.blockbench.enabled, true);
      assert.equal(config.mcp.blockbench.url, "http://localhost:8080/mcp");
      assert.equal(config.mcp.blockbench.timeoutMs, 30_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Этап 4: mergeConfig подставляет дефолтные mcp.minecraft в старый config.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "mineagent-config-mc-mcp-"));
    try {
      await mkdir(join(root, ".mineagent"), { recursive: true });
      // Старый config БЕЗ секции mcp.minecraft (как до Этапа 4).
      await writeFile(join(root, ".mineagent", "config.json"), `${JSON.stringify({
        version: 1,
        providers: { defaultProvider: "cloudflare", defaultModel: "m", custom: { baseUrl: "", modelsEndpoint: "/v1/models", chatEndpoint: "/v1/chat/completions" } },
        agent: { approvalMode: "ask", autoApproveTools: [] },
        minecraft: { gradleBuildTask: "build", runClientTask: "runClient", devBridgeEnabled: false },
        paths: {}
      })}\n`, "utf8");

      const service = new ConfigService(fakeContext(), {
        uri: { fsPath: root, toString: () => `file://${root}` }
      } as never);

      const config = await service.ensureWorkspaceFiles();
      // mcp.minecraft подставился из дефолта (backward-compat через mergeConfig).
      assert.equal(config.mcp.minecraft.enabled, false);
      assert.equal(config.mcp.minecraft.url, "http://127.0.0.1:3100/mc-mcp");
      assert.equal(config.mcp.minecraft.timeoutMs, 60_000);
      assert.equal(config.mcp.minecraft.launchWaitMs, 90_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Этап 4: legacy minecraft.devBridgeEnabled включает mcp.minecraft.enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "mineagent-config-mc-legacy-bridge-"));
    try {
      await mkdir(join(root, ".mineagent"), { recursive: true });
      await writeFile(join(root, ".mineagent", "config.json"), `${JSON.stringify({
        version: 1,
        providers: { defaultProvider: "cloudflare", defaultModel: "m", custom: { baseUrl: "", modelsEndpoint: "/v1/models", chatEndpoint: "/v1/chat/completions" } },
        agent: { approvalMode: "ask", autoApproveTools: [] },
        minecraft: { gradleBuildTask: "build", runClientTask: "runClient", devBridgeEnabled: true },
        paths: {}
      })}\n`, "utf8");

      const service = new ConfigService(fakeContext(), {
        uri: { fsPath: root, toString: () => `file://${root}` }
      } as never);

      const config = await service.ensureWorkspaceFiles();
      assert.equal(config.minecraft.devBridgeEnabled, true);
      assert.equal(config.mcp.minecraft.enabled, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Этап 4: пользовательский mcp.minecraft сохраняется при merge", async () => {
    const root = await mkdtemp(join(tmpdir(), "mineagent-config-mc-mcp-custom-"));
    try {
      await mkdir(join(root, ".mineagent"), { recursive: true });
      await writeFile(join(root, ".mineagent", "config.json"), `${JSON.stringify({
        version: 1,
        providers: { defaultProvider: "cloudflare", defaultModel: "m", custom: { baseUrl: "", modelsEndpoint: "/v1/models", chatEndpoint: "/v1/chat/completions" } },
        agent: { approvalMode: "ask", autoApproveTools: [] },
        minecraft: { gradleBuildTask: "build", runClientTask: "runClient", devBridgeEnabled: false },
        paths: {},
        mcp: {
          blockbench: { enabled: false, url: "http://localhost:3000/bb-mcp", timeoutMs: 60_000 },
          minecraft: { enabled: true, url: "http://127.0.0.1:3199/mc", timeoutMs: 45_000, launchWaitMs: 120_000 }
        }
      })}\n`, "utf8");

      const service = new ConfigService(fakeContext(), {
        uri: { fsPath: root, toString: () => `file://${root}` }
      } as never);

      const config = await service.ensureWorkspaceFiles();
      assert.equal(config.mcp.minecraft.enabled, true);
      assert.equal(config.mcp.minecraft.url, "http://127.0.0.1:3199/mc");
      assert.equal(config.mcp.minecraft.timeoutMs, 45_000);
      assert.equal(config.mcp.minecraft.launchWaitMs, 120_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates and saves an editable research ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "mineagent-research-ledger-"));
    try {
      const service = new ConfigService(fakeContext(), {
        uri: { fsPath: root, toString: () => `file://${root}` }
      } as never);

      await service.ensureWorkspaceFiles();
      const initial = await service.readResearchLedger();
      assert.equal(initial.status, "draft");
      assert.deepEqual(initial.sources, []);

      const saved = await service.saveResearchLedger({
        topic: "combat references",
        status: "reviewed",
        userNotes: "Use tradeoffs, not copied names.",
        lastUpdated: null,
        sources: [
          {
            url: "https://example.com/reference",
            summary: "Summary",
            learned: "Learned",
            usedFor: "Original mechanics",
            status: "accepted"
          }
        ]
      });

      assert.equal(saved.status, "reviewed");
      assert.equal(saved.sources[0]?.status, "accepted");
      assert.match(saved.lastUpdated ?? "", /^\d{4}-\d{2}-\d{2}T/);

      const fileText = await readFile(join(root, ".mineagent", "research-ledger.json"), "utf8");
      assert.match(fileText, /https:\/\/example\.com\/reference/);
      assert.match(fileText, /Use tradeoffs/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function fakeContext(): never {
  const secrets = new Map<string, string>();
  return {
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value);
      }
    }
  } as never;
}
