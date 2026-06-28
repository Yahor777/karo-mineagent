import * as crypto from "node:crypto";
import type { ApprovalRequest } from "../approval/types";
import type { ApprovalGate } from "../approval/approvalGate";
import type { ToolContract } from "./ToolContracts";
import { ToolRegistry } from "./toolRegistry";

// Утилита генерации requestId. Вынесена для мока в тестах при необходимости.
let nextRequestId = (): string => `approval-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

export function setRequestIdGenerator(fn: () => string): void {
  nextRequestId = fn;
}

/**
 * ToolDispatcher — единая точка вызова tool'ов через ApprovalGate.
 *
 * Read-only tools (requiresApproval === false) вызываются напрямую, без модалки.
 * Опасные tools (requiresApproval === true) идут через gate.request() — показ
 * модалки, ожидание ответа. Это заменяет разбросанные прямые вызовы GradleTools
 * в orchestrator и webview-provider, подготавливая почву для tool-calling Этапа 2.
 */
export class ToolDispatcher {
  public constructor(
    private readonly registry: ToolRegistry,
    private readonly gate: ApprovalGate
  ) {}

  /**
   * Выполняет tool по имени.
   * @param name — имя tool (например "gradle.run")
   * @param input — параметры вызова (проверяются handler'ом)
   * @param description — человекочитаемое описание для модалки
   * @throws если tool не зарегистрирован, не одобрен или handler упал
   */
  public async dispatch(name: string, input: unknown, description: string): Promise<unknown> {
    const handler = this.registry.get(name);
    if (!handler) {
      throw new Error(`Tool "${name}" не зарегистрирован в ToolRegistry.`);
    }
    const contract = this.registry.findContract(name);
    if (!contract) {
      throw new Error(`Tool "${name}" не имеет контракта.`);
    }

    // Read-only path: без approval вообще.
    if (!contract.requiresApproval) {
      return handler(input);
    }

    // Write/command/network/game-control: через gate.
    const req: ApprovalRequest = {
      requestId: nextRequestId(),
      toolName: name,
      scope: "tool",
      scopeId: name,
      description,
      risk: contract.risk,
      input
    };

    const approved = await this.gate.request(req);
    if (!approved) {
      throw new Error(`Действие "${name}" не одобрено пользователем.`);
    }
    return handler(input);
  }

  // Сахар для мест, где нужен контракт напрямую (UI, подсказки).
  public contractFor(name: string): ToolContract | undefined {
    return this.registry.findContract(name);
  }
}
