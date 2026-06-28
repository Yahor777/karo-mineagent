import type { ToolRisk } from "../tools/ToolContracts";

// Что одобряем: конкретный tool-call или запуск sub-агента.
export type ApprovalScope = "tool" | "subagent";

// Решение пользователя в модалке. Порядок соответствует кнопкам слева направо.
// confirm-once — только этот вызов.
// always-in-session — этот scopeId до конца сессии VS Code (in-memory Set, без persist).
// always-all-in-session — ЛЮБОЙ инструмент до конца сессии (in-memory флаг, без persist).
//   Решает кейс «жму Всегда, а оно всё равно спрашивает у каждого инструмента»:
//   у Blockbench каждый tool (add_group/create_texture/…) имеет свой scopeId, поэтому
//   per-scope approval не покрывает следующий инструмент. Этот режим доверяет всей сессии.
// always — persist scopeId в config.agent.autoApproveTools (синхронизируется с диском).
// deny — отказ, выполнение прерывается.
export type ApprovalDecision = "confirm-once" | "always-in-session" | "always-all-in-session" | "always" | "deny";

// Запрос approval от backend к UI. requestId — correlation id для round-trip.
export interface ApprovalRequest {
  requestId: string;
  toolName: string;
  scope: ApprovalScope;
  // Имя tool (например "gradle.run") ИЛИ id sub-агента, в зависимости от scope.
  scopeId: string;
  description: string;
  risk: ToolRisk;
  // Параметры вызова — для предпросмотра в модалке (что именно выполнится).
  input?: unknown;
}

// Ответ UI на запрос. Приходит из webview при клике по кнопке модалки.
export interface ApprovalResponse {
  requestId: string;
  decision: ApprovalDecision;
}

// Внутренний тип для ApprovalGate: pending Promise round-trip.
export interface PendingApproval {
  resolve: (approved: boolean) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  scopeId: string;
}
