import * as vscode from "vscode";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { AGENTS_FILE, CONFIG_DIR, CONFIG_FILE, RESEARCH_LEDGER_FILE, SECRET_PREFIX } from "../constants";
import { defaultMineAgentConfig } from "./defaultConfig";
import type { MineAgentConfig, ProviderId, ResearchLedger, ResearchSource } from "./types";

const defaultAgentsTemplate = `# MineAgent Workspace Rules

You are MineAgent, an AI assistant specialized for Minecraft Java mod development.

- Prefer repository evidence, loader docs, mappings/source, and cited references.
- Do not guess Minecraft APIs, mod-loader behavior, or universe lore.
- Show patches before writes and ask before destructive commands.
- Never expose provider keys or secrets in prompts, logs, or config.
- Store evidence for every run: command, exit code, file set, log summary, and screenshots when available.
`;

export class ConfigService {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceFolder: vscode.WorkspaceFolder
  ) {}

  public get workspaceRoot(): vscode.Uri {
    return this.workspaceFolder.uri;
  }

  public async ensureWorkspaceFiles(): Promise<MineAgentConfig> {
    await this.ensureDirectory(CONFIG_DIR);
    await Promise.all([
      this.ensureDirectory(defaultMineAgentConfig.paths.skills),
      this.ensureDirectory(defaultMineAgentConfig.paths.referencePacks),
      this.ensureDirectory(defaultMineAgentConfig.paths.playtests),
      this.ensureDirectory(defaultMineAgentConfig.paths.runs),
      this.ensureResearchLedger(),
      this.ensureAgentsFile()
    ]);

    const config = await this.readConfig();
    if (!config) {
      const mergedDefault = mergeConfig(defaultMineAgentConfig);
      await this.writeConfig(mergedDefault);
      return mergedDefault;
    }

    const merged = mergeConfig(config);
    await this.writeConfig(merged);
    return merged;
  }

  public async readConfig(): Promise<MineAgentConfig | undefined> {
    try {
      const text = await readFile(this.toFsPath(CONFIG_FILE), "utf8");
      return JSON.parse(stripBom(text)) as MineAgentConfig;
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  public async writeConfig(config: MineAgentConfig): Promise<void> {
    await this.ensureDirectory(dirname(CONFIG_FILE));
    await writeFile(this.toFsPath(CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  public async readAgentsRules(): Promise<string> {
    await this.ensureAgentsFile();
    return readFile(this.toFsPath(AGENTS_FILE), "utf8");
  }

  public async saveAgentsRules(text: string): Promise<void> {
    await writeFile(this.toFsPath(AGENTS_FILE), text, "utf8");
  }

  public async readResearchLedger(): Promise<ResearchLedger> {
    await this.ensureResearchLedger();
    const text = await readFile(this.toFsPath(RESEARCH_LEDGER_FILE), "utf8");
    return normalizeResearchLedger(JSON.parse(stripBom(text)) as Partial<ResearchLedger>);
  }

  public async saveResearchLedger(ledger: ResearchLedger): Promise<ResearchLedger> {
    const normalized = normalizeResearchLedger({
      ...ledger,
      lastUpdated: new Date().toISOString()
    });
    await this.ensureDirectory(dirname(RESEARCH_LEDGER_FILE));
    await writeFile(this.toFsPath(RESEARCH_LEDGER_FILE), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    return normalized;
  }

  public async setProviderKey(providerId: ProviderId, key: string): Promise<void> {
    await this.context.secrets.store(this.secretKey(providerId), key);
    await this.context.secrets.store(this.globalSecretKey(providerId), key);
  }

  public async getProviderKey(providerId: ProviderId): Promise<string | undefined> {
    const workspaceKey = await this.context.secrets.get(this.secretKey(providerId));
    if (workspaceKey) {
      await this.context.secrets.store(this.globalSecretKey(providerId), workspaceKey);
      return workspaceKey;
    }
    return await this.context.secrets.get(this.globalSecretKey(providerId))
      ?? this.getProviderKeyFromEnv(providerId);
  }

  public async hasProviderKey(providerId: ProviderId): Promise<boolean> {
    return Boolean(await this.getProviderKey(providerId));
  }

  public toFsPath(relativePath: string): string {
    return join(this.workspaceRoot.fsPath, relativePath);
  }

  private async ensureDirectory(relativePath: string): Promise<void> {
    await mkdir(this.toFsPath(relativePath), { recursive: true });
  }

  private async ensureAgentsFile(): Promise<void> {
    try {
      await readFile(this.toFsPath(AGENTS_FILE), "utf8");
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
      await writeFile(this.toFsPath(AGENTS_FILE), defaultAgentsTemplate, "utf8");
    }
  }

  private async ensureResearchLedger(): Promise<void> {
    try {
      await readFile(this.toFsPath(RESEARCH_LEDGER_FILE), "utf8");
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
      await writeFile(this.toFsPath(RESEARCH_LEDGER_FILE), `${JSON.stringify(defaultResearchLedger(), null, 2)}\n`, "utf8");
    }
  }

  private secretKey(providerId: ProviderId): string {
    return `${SECRET_PREFIX}.${this.workspaceFolder.uri.toString()}.${providerId}`;
  }

  private globalSecretKey(providerId: ProviderId): string {
    return `${SECRET_PREFIX}.global.${providerId}`;
  }

  private getProviderKeyFromEnv(providerId: ProviderId): string | undefined {
    const names = providerEnvNames(providerId);
    for (const name of names) {
      const value = process.env[name]?.trim();
      if (value) {
        return value;
      }
    }
    return undefined;
  }
}

function defaultResearchLedger(): ResearchLedger {
  return {
    topic: "Original dark supernatural combat Minecraft mod inspired by JJK-style combat structure",
    status: "draft",
    sources: [],
    userNotes: "",
    lastUpdated: null
  };
}

function normalizeResearchLedger(partial: Partial<ResearchLedger>): ResearchLedger {
  return {
    ...defaultResearchLedger(),
    ...partial,
    sources: Array.isArray(partial.sources)
      ? partial.sources.map((source): ResearchSource => ({
          url: String(source.url ?? ""),
          title: source.title ? String(source.title) : undefined,
          summary: String(source.summary ?? ""),
          learned: String(source.learned ?? ""),
          usedFor: String(source.usedFor ?? ""),
          status: source.status === "accepted" || source.status === "rejected" || source.status === "candidate"
            ? source.status
            : "candidate"
        })).filter((source) => source.url || source.summary || source.learned || source.usedFor)
      : [],
    userNotes: String(partial.userNotes ?? ""),
    lastUpdated: partial.lastUpdated ?? null,
    status: partial.status === "reviewed" ? "reviewed" : "draft"
  };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function providerEnvNames(providerId: ProviderId): string[] {
  switch (providerId) {
    case "fireworks":
      return ["MINEAGENT_FIREWORKS_API_KEY", "FIREWORKS_API_KEY"];
    case "cloudflare":
      return ["MINEAGENT_CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_AUTH_TOKEN"];
    case "openai":
      return ["MINEAGENT_OPENAI_API_KEY", "OPENAI_API_KEY"];
    case "anthropic":
      return ["MINEAGENT_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"];
    case "wavespeed":
      return ["MINEAGENT_WAVESPEED_API_KEY", "WAVESPEED_API_KEY"];
    case "kimchi":
      return ["MINEAGENT_KIMCHI_API_KEY", "KIMCHI_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY"];
    case "custom":
      return ["MINEAGENT_CUSTOM_API_KEY"];
  }
}

function mergeConfig(partial: Partial<MineAgentConfig>): MineAgentConfig {
  const minecraftBridgeEnabled = typeof partial.mcp?.minecraft?.enabled === "boolean"
    ? partial.mcp.minecraft.enabled
    : typeof partial.minecraft?.devBridgeEnabled === "boolean"
      ? partial.minecraft.devBridgeEnabled
      : defaultMineAgentConfig.mcp.minecraft.enabled;
  return {
    ...defaultMineAgentConfig,
    ...partial,
    providers: {
      ...defaultMineAgentConfig.providers,
      ...partial.providers,
      custom: {
        ...defaultMineAgentConfig.providers.custom,
        ...partial.providers?.custom
      },
      cloudflare: {
        ...defaultMineAgentConfig.providers.cloudflare,
        ...partial.providers?.cloudflare,
        accountId: partial.providers?.cloudflare?.accountId
          || process.env.MINEAGENT_CLOUDFLARE_ACCOUNT_ID?.trim()
          || process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
          || defaultMineAgentConfig.providers.cloudflare.accountId
      }
    },
    agent: {
      ...defaultMineAgentConfig.agent,
      ...partial.agent,
      // Этап 5: backward-compat для vision/critic полей. Старые config.json
      // без этих полей получают дефолтные значения автоматически.
      visionModel: typeof partial.agent?.visionModel === "string"
        ? partial.agent.visionModel
        : defaultMineAgentConfig.agent.visionModel,
      criticModel: typeof partial.agent?.criticModel === "string"
        ? partial.agent.criticModel
        : defaultMineAgentConfig.agent.criticModel,
      criticMode: partial.agent?.criticMode === "other-model"
        || partial.agent?.criticMode === "self"
        || partial.agent?.criticMode === "off"
        ? partial.agent.criticMode
        : defaultMineAgentConfig.agent.criticMode,
      visionTriggers: Array.isArray(partial.agent?.visionTriggers)
        ? partial.agent!.visionTriggers as string[]
        : defaultMineAgentConfig.agent.visionTriggers,
      // Этап 6: backward-compat для embedding/knowledge/skills полей.
      embeddingModel: typeof partial.agent?.embeddingModel === "string"
        ? partial.agent!.embeddingModel
        : defaultMineAgentConfig.agent.embeddingModel,
      knowledgeTopK: typeof partial.agent?.knowledgeTopK === "number"
        ? partial.agent!.knowledgeTopK
        : defaultMineAgentConfig.agent.knowledgeTopK,
      skillsTopK: typeof partial.agent?.skillsTopK === "number"
        ? partial.agent!.skillsTopK
        : defaultMineAgentConfig.agent.skillsTopK
    },
    // Top-level массив sub-агентов. Если в partial нет — берём дефолт (пустой).
    subAgents: Array.isArray(partial.subAgents) ? partial.subAgents : defaultMineAgentConfig.subAgents,
    minecraft: {
      ...defaultMineAgentConfig.minecraft,
      ...partial.minecraft,
      devBridgeEnabled: minecraftBridgeEnabled
    },
    // Этап 3/4: backward-compat мерж для секции mcp. Старые config.json без этих
    // полей (blockbench — Этап 3, minecraft — Этап 4) получают дефолтные значения
    // автоматически.
    mcp: {
      blockbench: {
        ...defaultMineAgentConfig.mcp.blockbench,
        ...partial.mcp?.blockbench
      },
      server: {
        ...defaultMineAgentConfig.mcp.server,
        ...partial.mcp?.server
      },
      minecraft: {
        ...defaultMineAgentConfig.mcp.minecraft,
        ...partial.mcp?.minecraft,
        enabled: minecraftBridgeEnabled
      }
    },
    paths: {
      ...defaultMineAgentConfig.paths,
      ...partial.paths
    }
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
