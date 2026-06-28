// Session persistence: сохраняет и загружает chat history в/из .mineagent/sessions/.
// Каждая сессия = отдельный JSON-файл. Это позволяет восстановить историю после
// перезапуска VS Code (главное требование пользователя — не терять контекст).

export interface SessionMessage {
  role: "user" | "assistant" | "activity";
  text: string;
  timestamp: string;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
  // Для auto-resume: модель и режим последнего запроса.
  lastMode?: "ask" | "plan" | "build" | "playtest";
}

// Создаёт короткий id сессии: timestamp + случайный суффикс.
export function generateSessionId(): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `session-${Date.now()}-${suffix}`;
}

// Авто-заголовок из первого user-сообщения: первые 5 слов.
export function deriveSessionTitle(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 5).join(" ");
  if (!words) {
    return "Без названия";
  }
  return words.length > 50 ? `${words.slice(0, 47)}...` : words;
}

// Красная зона перед сохранением: вычищаем похожее на секреты, чтобы не утекло
// в JSON на диске. Это базовый redaction — не гарантирует полной безопасности,
// но убирает самые частые утечки (sk-..., Bearer ...).
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9_.-]{20,}/gi, "Bearer [REDACTED]")
    .replace(/[A-Za-z0-9_-]{32,}/g, (match) => {
      // Длинные base64-подобные строки (вероятные токены/ключи).
      if (/^[A-Za-z0-9_-]+$/.test(match) && !/^\d+$/.test(match)) {
        return "[REDACTED]";
      }
      return match;
    });
}
