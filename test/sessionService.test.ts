import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionService } from "../src/session/sessionService";
import { deriveSessionTitle, redactSecrets } from "../src/session/types";

describe("SessionService", () => {
  let root: string;

  beforeEach(async () => {
    root = join(tmpdir(), `mineagent-session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a session with derived title and returns id", async () => {
    const svc = new SessionService(root);
    const session = await svc.createSession("Добавь новый меч и щит в мод");
    assert.match(session.id, /^session-\d+-[a-z0-9]+$/);
    assert.equal(session.title, "Добавь новый меч и щит");
    assert.equal(session.messages.length, 0);
  });

  it("appends messages and persists them", async () => {
    const svc = new SessionService(root);
    const session = await svc.createSession("прочитай проект");
    await svc.appendMessage(session.id, { role: "user", text: "прочитай проект", timestamp: new Date().toISOString() });
    await svc.appendMessage(session.id, { role: "assistant", text: "Готово, проект Forge 1.20.1", timestamp: new Date().toISOString() });

    const reloaded = await svc.loadSession(session.id);
    assert.equal(reloaded.messages.length, 2);
    assert.equal(reloaded.messages[0]?.role, "user");
    assert.equal(reloaded.messages[1]?.text, "Готово, проект Forge 1.20.1");
  });

  it("updates title from first user message when title was default", async () => {
    const svc = new SessionService(root);
    const session = await svc.createSession(); // без промпта → title "Без названия"
    await svc.appendMessage(session.id, { role: "user", text: "сделай моба-приведение", timestamp: new Date().toISOString() });
    const reloaded = await svc.loadSession(session.id);
    assert.equal(reloaded.title, "сделай моба-приведение");
  });

  it("lists sessions ordered by updatedAt desc", async () => {
    const svc = new SessionService(root);
    const a = await svc.createSession("первый");
    const b = await svc.createSession("второй");
    // b создаётся позже, но мы «потрогаем» a чтобы обновить его timestamp.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await svc.appendMessage(a.id, { role: "user", text: "обновляю", timestamp: new Date().toISOString() });

    const list = await svc.listSessions();
    assert.equal(list.length, 2);
    assert.equal(list[0]?.id, a.id, "свежая сессия (a) должна быть первой");
    assert.equal(list[0]?.messageCount, 1);
  });

  it("deletes a session", async () => {
    const svc = new SessionService(root);
    const session = await svc.createSession("temp");
    await svc.deleteSession(session.id);
    const list = await svc.listSessions();
    assert.equal(list.length, 0);
  });

  it("latestSession returns the most recently updated", async () => {
    const svc = new SessionService(root);
    await svc.createSession("старая");
    const fresh = await svc.createSession("новая");
    const latest = await svc.latestSession();
    assert.equal(latest?.id, fresh.id);
  });

  it("latestSession returns undefined when no sessions exist", async () => {
    const svc = new SessionService(root);
    const latest = await svc.latestSession();
    assert.equal(latest, undefined);
  });
});

describe("session redaction", () => {
  it("redacts sk- prefixed api keys", () => {
    const out = redactSecrets("my key is sk-proj-AbCdEf1234567890XYZabc not for you");
    assert.ok(!out.includes("sk-proj-AbCdEf1234567890XYZabc"), "API ключ должен быть замаскирован");
    assert.match(out, /sk-\[REDACTED\]/);
  });

  it("redacts Bearer tokens", () => {
    const out = redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    assert.ok(!out.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));
    assert.match(out, /Bearer \[REDACTED\]/);
  });

  it("does not redact normal short text", () => {
    const out = redactSecrets("Привет, это обычное сообщение без секретов");
    assert.equal(out, "Привет, это обычное сообщение без секретов");
  });
});

describe("deriveSessionTitle", () => {
  it("takes first ~6 words", () => {
    assert.equal(deriveSessionTitle("Добавь новый предмет меч карамельный в мод"), "Добавь новый предмет меч карамельный");
  });

  it("truncates very long titles", () => {
    const long = "а".repeat(80);
    const title = deriveSessionTitle(long);
    assert.ok(title.length <= 50);
    assert.match(title, /\.\.\.$/);
  });

  it("returns default for empty prompt", () => {
    assert.equal(deriveSessionTitle(""), "Без названия");
  });
});
