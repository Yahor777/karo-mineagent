import type { ToolContract } from "./ToolContracts";
import { toolContracts } from "./ToolContracts";

// Универсальный обработчик tool-вызова. Input/Output — unknown, чтобы реестр
// не зависел от конкретных типов каждого tool (контракты типизируются отдельно).
export type ToolHandler = (input: unknown) => Promise<unknown>;

// Единый реестр всех доступных tools. Источник правды для:
//  - UI (какие tools показывать/выбирать в sub-agent форме)
//  - Dispatcher (где искать handler для вызова)
//  - Документации (контракты для LLM на Этапе 2)
export class ToolRegistry {
  private readonly handlers = new Map<string, ToolHandler>();
  // Этап 3: динамические контракты (blockbench.*). Регистрируются в рантайме
  // при подключении к MCP-серверу из tools/list, без изменения статичного
  // toolContracts. findContract проверяет динамику ПЕРВЕЕ статики, чтобы
  // переопределённый контракт выигрывал.
  private readonly dynamicContracts = new Map<string, ToolContract>();

  public register(name: string, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }

  public get(name: string): ToolHandler | undefined {
    return this.handlers.get(name);
  }

  public has(name: string): boolean {
    return this.handlers.has(name);
  }

  // Все зарегистрированные контракты (handler есть + контракт описан).
  // Порядок: статичные как в toolContracts, затем динамические (для
  // предсказуемости в UI и prefix-cache-friendly выдачи схем модели).
  public contracts(): ToolContract[] {
    const staticContracts = toolContracts.filter((contract) => this.handlers.has(contract.name));
    const dynamicContracts: ToolContract[] = [];
    for (const [name, contract] of this.dynamicContracts) {
      if (this.handlers.has(name)) {
        dynamicContracts.push(contract);
      }
    }
    return [...staticContracts, ...dynamicContracts];
  }

  // Все контракты, независимо от наличия handler (для подсказок/документации).
  public allContracts(): ToolContract[] {
    const dynamicNames = new Set(this.dynamicContracts.keys());
    const staticOnly = toolContracts.filter((contract) => !dynamicNames.has(contract.name));
    return [...staticOnly, ...this.dynamicContracts.values()];
  }

  public findContract(name: string): ToolContract | undefined {
    const dynamic = this.dynamicContracts.get(name);
    if (dynamic) {
      return dynamic;
    }
    return toolContracts.find((contract) => contract.name === name);
  }

  // --- Этап 3: динамические контракты (blockbench.*) ---

  public registerDynamic(contract: ToolContract, handler: ToolHandler): void {
    this.dynamicContracts.set(contract.name, contract);
    this.handlers.set(contract.name, handler);
  }

  public unregisterDynamic(name: string): void {
    this.dynamicContracts.delete(name);
    this.handlers.delete(name);
  }

  // Снимает ВСЕ динамические контракты (например, при отключении Blockbench).
  public clearDynamic(): string[] {
    const names = Array.from(this.dynamicContracts.keys());
    for (const name of names) {
      this.dynamicContracts.delete(name);
      this.handlers.delete(name);
    }
    return names;
  }

  public hasDynamic(name: string): boolean {
    return this.dynamicContracts.has(name);
  }

  public dynamicNames(): string[] {
    return Array.from(this.dynamicContracts.keys());
  }
}
