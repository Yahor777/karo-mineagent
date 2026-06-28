export interface ParsedLogSummary {
  fatalLines: string[];
  warnings: string[];
  exceptions: string[];
  crashReportPath?: string;
  likelyCause?: string;
}

const fatalPattern = /\b(FATAL|ERROR)\b|\bException\b|\bCrash\b|[A-Za-z0-9_.]+Error\b/i;
const warnPattern = /\bWARN(?:ING)?\b/i;
const exceptionPattern = /(?:Caused by: |Exception in thread |^\s*at\s+|[A-Za-z0-9_.]+Exception|[A-Za-z0-9_.]+Error)/;

export function parseMinecraftLog(text: string): ParsedLogSummary {
  const lines = text.split(/\r?\n/);
  const fatalLines = lines.filter((line) => fatalPattern.test(line)).slice(-30);
  const warnings = lines.filter((line) => warnPattern.test(line)).slice(-30);
  const exceptions = lines.filter((line) => exceptionPattern.test(line)).slice(-80);
  const crashReportPath = lines.map((line) => /Crash report saved to:\s*(.+)$/i.exec(line)?.[1]).find(Boolean);

  return {
    fatalLines,
    warnings,
    exceptions,
    crashReportPath,
    likelyCause: inferLikelyCause(exceptions, fatalLines)
  };
}

function inferLikelyCause(exceptions: string[], fatalLines: string[]): string | undefined {
  const joined = [...exceptions, ...fatalLines].join("\n");
  if (/NoClassDefFoundError|ClassNotFoundException/.test(joined)) {
    return "Missing class or dependency mismatch.";
  }
  if (/MixinApplyError|InvalidMixinException/.test(joined)) {
    return "Mixin configuration or target signature mismatch.";
  }
  if (/NullPointerException/.test(joined)) {
    return "Null access; inspect the first mod-owned stack frame.";
  }
  if (/Registry Object not present|Unknown registry|Duplicate registration/i.test(joined)) {
    return "Registry setup, id, or lifecycle ordering issue.";
  }
  return fatalLines[0];
}

// --- Этап 4: парсинг marker-строки Minecraft Dev Bridge ---
//
// Мод mineagent-bridge печатает при старте endpoint'а:
//   [mineagent-bridge] MCP endpoint ready url=http://127.0.0.1:3100/mc-mcp token=<hex>
// Эта строка — единственный канал передачи shared-token от мода к расширению
// (токен НЕ хранится в config — мод генерирует его каждый старт). Расширение
// tail'ит лог dev-клиента, находит эту строку и использует url+token для
// подключения McpClient.
//
// Формат устойчив к таймстемпам/префиксам логгера: ищем подстроку-маркер и
// ключи url=/token= в любой части строки.

export interface BridgeReadyInfo {
  url: string;
  token: string;
}

const BRIDGE_READY_MARKER = "[mineagent-bridge] MCP endpoint ready";
const BRIDGE_URL_RE = /\burl=(\S+)/;
// token: любые непробельные символы (мод генерирует hex, но парсер не завязан на
// формат — устойчив к будущим изменениям схемы генерации токена).
const BRIDGE_TOKEN_RE = /\btoken=(\S+)/;

/**
 * Ищет в тексте лога marker-строку готовности моста и извлекает url + token.
 * Возвращает undefined, если маркер не найден или данные неполные.
 *
 * Берёт ПОСЛЕДНЕЕ совпадение (если клиент перезапускался в одном логе —
// актуальный endpoint от последнего старта).
 */
export function parseBridgeReadyLine(logText: string): BridgeReadyInfo | undefined {
  const lines = logText.split(/\r?\n/);
  let lastMatch: BridgeReadyInfo | undefined;
  for (const line of lines) {
    if (!line.includes(BRIDGE_READY_MARKER)) {
      continue;
    }
    const url = BRIDGE_URL_RE.exec(line)?.[1];
    const token = BRIDGE_TOKEN_RE.exec(line)?.[1];
    if (url && token) {
      lastMatch = { url, token };
    }
  }
  return lastMatch;
}

/**
 * Проверяет, что строка содержит маркер готовности моста (быстрая проверка
 * для streaming-tail без полного разбора). Используется MinecraftBridge при
 * ожидании поднятия endpoint'а после runClient.
 */
export function isBridgeReadyLine(line: string): boolean {
  return line.includes(BRIDGE_READY_MARKER);
}
