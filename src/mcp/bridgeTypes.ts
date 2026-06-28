// Общий интерфейс MCP-bridge'ей MineAgent. Введён на Этапе 4 для обобщения
// orchestrator'а с одного BlockbenchBridge (Этап 3) на массив произвольных
// мостов. Сейчас две реализации: BlockbenchBridge (blockbench.*) и
// MinecraftBridge (minecraft.*) — но интерфейс открыт для будущих мостоёв.
//
// Контракт минимальный: только то, что нужно orchestrator'у (добавить
// инструменты в tool-loop, если подключён). Bridge-специфичные lifecycle-методы
// (connect/disconnect/waitForEndpoint) лежат в самих классах — orchestrator их
// не зовёт (это ответственность webview-провайдера через ApprovalGate).

export interface McpBridge {
  /** true, если handshake завершён и инструменты зарегистрированы. */
  isConnected(): boolean;

  /**
   * Имена зарегистрированных tools (с префиксом, напр. "blockbench.render" или
   * "minecraft.summon"). Пусто, если не подключён.
   */
  listRegisteredToolNames(): string[];
}

/**
 * Проверка, что bridge содержит инструменты с заданным префиксом неймспейса.
 * Используется orchestrator'ом для отладки/диагностики (какой мост добавил tool).
 * Префикс — часть имени до первой точки ("blockbench", "minecraft").
 */
export function bridgeNamespace(name: string): string | undefined {
  const dot = name.indexOf(".");
  return dot > 0 ? name.slice(0, dot) : undefined;
}
