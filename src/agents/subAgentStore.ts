import type { MineAgentConfig } from "../config/types";
import type { SubAgentConfig } from "./types";

// Инжектируемые колбэхи для тестируемости. В проде — обёртки над ConfigService.
export interface SubAgentStoreDeps {
  readConfig: () => Promise<MineAgentConfig | undefined>;
  writeConfig: (config: MineAgentConfig) => Promise<void>;
}

/**
 * SubAgentStore — CRUD над config.subAgents.
 *
 * Sub-агенты живут в config.json (не в отдельном файле), чтобы использовать
 * существующую инфраструктуру persist + mergeConfig. Каждый метод перечитывает
 * актуальный конфиг с диска — на случай если config менялся вне UI.
 */
export class SubAgentStore {
  public constructor(private readonly deps: SubAgentStoreDeps) {}

  public async list(): Promise<SubAgentConfig[]> {
    const config = await this.deps.readConfig();
    return config?.subAgents ?? [];
  }

  public async add(agent: SubAgentConfig): Promise<void> {
    validateSubAgent(agent);
    const config = await this.requireConfig();
    if (config.subAgents.some((existing) => existing.id === agent.id)) {
      throw new Error(`Sub-агент с id "${agent.id}" уже существует.`);
    }
    await this.deps.writeConfig({
      ...config,
      subAgents: [...config.subAgents, agent]
    });
  }

  public async update(id: string, patch: Partial<SubAgentConfig>): Promise<SubAgentConfig> {
    const config = await this.requireConfig();
    const index = config.subAgents.findIndex((existing) => existing.id === id);
    if (index === -1) {
      throw new Error(`Sub-агент с id "${id}" не найден.`);
    }
    // id нельзя менять — он же correlation scopeId для approval и сессий.
    const { id: _ignored, ...rest } = patch;
    void _ignored;
    const updated: SubAgentConfig = { ...config.subAgents[index], ...rest, id };
    validateSubAgent(updated);
    const nextList = [...config.subAgents];
    nextList[index] = updated;
    await this.deps.writeConfig({ ...config, subAgents: nextList });
    return updated;
  }

  public async remove(id: string): Promise<void> {
    const config = await this.requireConfig();
    if (!config.subAgents.some((existing) => existing.id === id)) {
      throw new Error(`Sub-агент с id "${id}" не найден.`);
    }
    await this.deps.writeConfig({
      ...config,
      subAgents: config.subAgents.filter((existing) => existing.id !== id)
    });
  }

  // Сахар для UI-тумблера enabled/disabled.
  public async toggle(id: string): Promise<SubAgentConfig> {
    const config = await this.requireConfig();
    const existing = config.subAgents.find((agent) => agent.id === id);
    if (!existing) {
      throw new Error(`Sub-агент с id "${id}" не найден.`);
    }
    return this.update(id, { enabled: !existing.enabled });
  }

  private async requireConfig(): Promise<MineAgentConfig> {
    const config = await this.deps.readConfig();
    if (!config) {
      throw new Error("Конфиг MineAgent не инициализирован. Запустите initializeWorkspace.");
    }
    return config;
  }
}

// Минимальная валидация перед persist. id и displayName обязательны.
export function validateSubAgent(agent: SubAgentConfig): void {
  if (!agent.id || !agent.id.trim()) {
    throw new Error("id sub-агента обязателен.");
  }
  if (!agent.displayName || !agent.displayName.trim()) {
    throw new Error("displayName sub-агента обязателен.");
  }
  if (!Array.isArray(agent.allowedTools)) {
    throw new Error("allowedTools должен быть массивом.");
  }
}
