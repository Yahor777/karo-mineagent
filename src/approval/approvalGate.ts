import type { MineAgentConfig } from "../config/types";
import type { ApprovalRequest, ApprovalResponse, PendingApproval } from "./types";

// Таймаут ожидания ответа пользователя в модалке. Если юзер не ответил —
// действие считается отклонённым, чтобы не блокировать run навсегда.
const APPROVAL_TIMEOUT_MS = 60_000;

// Колбэк отправки сообщения в webview. Инжектируется webview-provider'ом.
// Gate намеренно не зависит от vscode-типов, чтобы быть тестируемым в чистом node.
export type PostToView = (message: { type: string; payload?: unknown }) => void;

// Колбэк persist обновлённого конфига (для «always» — записи в config.json).
export type PersistConfig = (config: MineAgentConfig) => Promise<void>;

// Оповещение о non-fatal событиях (таймаут, отсутствие view и т.д.).
export type Notify = (message: string) => void;

/**
 * ApprovalGate — блокирующий round-trip approval между backend и webview.
 *
 * Логика приоритетов в request() (токен-экономия: п.1-4 НЕ шлют post в webview):
 *   1. config.agent.autoApproveTools содержит scopeId → true (persist)
 *   2. sessionApproved содержит scopeId → true (in-memory, до конца сессии)
 *   3. approvalMode === "auto-readonly" И risk === "read" → true
 *   4. approvalMode === "workspace" И risk === "read" → true
 *   5. иначе — шлём approvalRequest в webview, ждём Promise round-trip
 *
 * «always-in-session» добавляет scopeId в sessionApproved (in-memory).
 * «always» добавляет scopeId в config.agent.autoApproveTools и persist'ит.
 */
export class ApprovalGate {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly sessionApproved = new Set<string>();
  // «Всегда (всё в этой сессии)» — доверие ВСЕМ инструментам до конца сессии.
  // Нужно потому, что у MCP-инструментов (Blockbench add_group/create_texture/…)
  // каждый scopeId свой, и per-scope approval не покрывает следующий инструмент.
  private sessionApproveAll = false;
  private config: MineAgentConfig;

  public constructor(
    config: MineAgentConfig,
    private readonly persist: PersistConfig,
    private readonly post: PostToView,
    private readonly notify: Notify
  ) {
    this.config = config;
  }

  // Provider обновляет ссылку на актуальный конфиг после refresh().
  public updateConfig(config: MineAgentConfig): void {
    this.config = config;
  }

  /**
   * Запрашивает approval перед действием. Возвращает true — одобрено, false — нет.
   * Никогда не throws в нормальном flow; ошибки → false + notify.
   */
  public async request(req: ApprovalRequest): Promise<boolean> {
    // 0. Session-wide trust («Всегда (всё в этой сессии)» ранее).
    if (this.sessionApproveAll) {
      return true;
    }
    // 1. Persist whitelist (кнопка «Всегда» ранее).
    if (this.config.agent.autoApproveTools.includes(req.scopeId)) {
      return true;
    }
    // 2. Session whitelist (кнопка «Всегда в сессии» ранее в этой сессии).
    if (this.sessionApproved.has(req.scopeId)) {
      return true;
    }
    // 3-4. Mode-based auto-approve для read-only.
    const isRead = req.risk === "read";
    if (isRead && (this.config.agent.approvalMode === "auto-readonly" || this.config.agent.approvalMode === "workspace")) {
      return true;
    }

    // 5. Round-trip к webview.
    return this.requestFromView(req);
  }

  // Шлёт запрос в webview и ждёт Promise. Таймаут → false.
  private requestFromView(req: ApprovalRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(req.requestId);
        if (!entry) {
          return;
        }
        this.pending.delete(req.requestId);
        this.notify(`Approval timeout для ${req.scopeId} (${APPROVAL_TIMEOUT_MS / 1000}с). Действие отклонено.`);
        resolve(false);
      }, APPROVAL_TIMEOUT_MS);

      this.pending.set(req.requestId, {
        resolve: (approved) => resolve(approved),
        reject: (error) => {
          clearTimeout(timer);
          this.notify(`Approval error для ${req.scopeId}: ${error.message}`);
          resolve(false);
        },
        timer,
        scopeId: req.scopeId
      });

      this.post({ type: "approvalRequest", payload: req });
    });
  }

  /**
   * Обрабатывает ответ UI. Вызывается из webview-provider handleMessage
   * при сообщении "approvalResponse". Возвращает true если requestId найден.
   */
  public resolve(response: ApprovalResponse): boolean {
    const entry = this.pending.get(response.requestId);
    if (!entry) {
      return false;
    }
    clearTimeout(entry.timer);
    this.pending.delete(response.requestId);

    switch (response.decision) {
      case "confirm-once":
        entry.resolve(true);
        return true;
      case "deny":
        entry.resolve(false);
        return true;
      case "always-in-session":
        this.sessionApproved.add(entry.scopeId);
        entry.resolve(true);
        return true;
      case "always-all-in-session":
        this.sessionApproveAll = true;
        entry.resolve(true);
        return true;
      case "always":
        void this.persistAlways(entry.scopeId);
        entry.resolve(true);
        return true;
      default:
        return false;
    }
  }

  // Persist в config.agent.autoApproveTools. Fire-and-forget, ошибка → notify.
  private async persistAlways(scopeId: string): Promise<void> {
    if (this.config.agent.autoApproveTools.includes(scopeId)) {
      return;
    }
    try {
      const updated: MineAgentConfig = {
        ...this.config,
        agent: {
          ...this.config.agent,
          autoApproveTools: [...this.config.agent.autoApproveTools, scopeId]
        }
      };
      await this.persist(updated);
      this.config = updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.notify(`Не удалось сохранить always-approval для ${scopeId}: ${message}`);
    }
  }

  // Сброс session-approval (UI-кнопка «reset approvals» позже).
  public resetSession(): void {
    this.sessionApproved.clear();
    this.sessionApproveAll = false;
  }

  // Для тестов и интроспекции: сколько запросов ждут ответа.
  public pendingCount(): number {
    return this.pending.size;
  }
}
