import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateSessionId, deriveSessionTitle, redactSecrets, type ChatSession, type SessionMessage } from "./types";

// SessionService: CRUD над chat-сессиями в .mineagent/sessions/.
// Каждая сессия = файл {id}.json. Метаданные (title, timestamps) внутри файла.
// Redaction: секреты (sk-..., Bearer ...) вычищаются перед записью.
export class SessionService {
  public constructor(private readonly root: string) {}

  public get sessionsDir(): string {
    return join(this.root, ".mineagent", "sessions");
  }

  // Создаёт новую пустую сессию и возвращает её id.
  public async createSession(firstPrompt?: string): Promise<ChatSession> {
    const session: ChatSession = {
      id: generateSessionId(),
      title: deriveSessionTitle(firstPrompt ?? ""),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: []
    };
    await this.ensureDir();
    await this.write(session);
    return session;
  }

  // Добавляет сообщение в сессию и сохраняет. title обновляется по первому user.
  public async appendMessage(sessionId: string, message: SessionMessage): Promise<ChatSession> {
    const session = await this.loadSession(sessionId);
    session.messages.push({
      ...message,
      text: redactSecrets(message.text)
    });
    // Обновляем title по первому user-сообщению, если оно ещё дефолтное.
    if (message.role === "user" && (session.title === "Без названия" || !session.title)) {
      session.title = deriveSessionTitle(message.text);
    }
    if (message.role === "user" || message.role === "assistant") {
      session.lastMode = message.role === "user" ? session.lastMode : session.lastMode;
    }
    session.updatedAt = new Date().toISOString();
    await this.write(session);
    return session;
  }

  public async loadSession(sessionId: string): Promise<ChatSession> {
    try {
      const text = await readFile(this.path(sessionId), "utf8");
      return normalizeSession(JSON.parse(text));
    } catch (error) {
      if (isNotFound(error)) {
        // Возвращаем пустую сессию, если файла нет — это безопасный fallback.
        return {
          id: sessionId,
          title: "Без названия",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: []
        };
      }
      throw error;
    }
  }

  // Список сессий (только метаданные, без messages — для UI-списка).
  public async listSessions(): Promise<Array<{ id: string; title: string; updatedAt: string; messageCount: number }>> {
    await this.ensureDir();
    const files = await readdir(this.sessionsDir);
    const sessions: Array<{ id: string; title: string; updatedAt: string; messageCount: number }> = [];
    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }
      try {
        const text = await readFile(join(this.sessionsDir, file), "utf8");
        const session = normalizeSession(JSON.parse(text));
        sessions.push({
          id: session.id,
          title: session.title,
          updatedAt: session.updatedAt,
          messageCount: session.messages.length
        });
      } catch {
        // Пропускаем повреждённые файлы — не валим весь список.
      }
    }
    // Свежие первыми.
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public async deleteSession(sessionId: string): Promise<void> {
    try {
      await rm(this.path(sessionId), { force: true });
    } catch {
      // ignore
    }
  }

  // Возвращает самую свежую сессию для auto-resume, или undefined.
  public async latestSession(): Promise<ChatSession | undefined> {
    const sessions = await this.listSessions();
    if (!sessions.length) {
      return undefined;
    }
    return this.loadSession(sessions[0].id);
  }

  private path(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
  }

  private async write(session: ChatSession): Promise<void> {
    await this.ensureDir();
    await writeFile(this.path(session.id), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  }
}

function normalizeSession(raw: Partial<ChatSession>): ChatSession {
  const now = new Date().toISOString();
  return {
    id: String(raw.id ?? generateSessionId()),
    title: raw.title ?? "Без названия",
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? now,
    messages: Array.isArray(raw.messages) ? raw.messages.map(normalizeMessage) : [],
    lastMode: raw.lastMode
  };
}

function normalizeMessage(raw: Partial<SessionMessage>): SessionMessage {
  const role = raw.role === "user" || raw.role === "assistant" || raw.role === "activity" ? raw.role : "activity";
  return {
    role,
    text: String(raw.text ?? ""),
    timestamp: raw.timestamp ?? new Date().toISOString()
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
