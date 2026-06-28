import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseBridgeReadyLine,
  isBridgeReadyLine,
  type BridgeReadyInfo
} from "../src/tools/logParser";

// Этап 4: парсинг marker-строки мода mineagent-bridge из лога dev-клиента.
// Маркер: [mineagent-bridge] MCP endpoint ready url=... token=...
// Это единственный канал передачи shared-token от мода к расширению.

describe("logParser — parseBridgeReadyLine", () => {
  it("извлекает url+token из однострочного маркера", () => {
    const log = "[12:34:56] [Render thread/INFO]: [mineagent-bridge] MCP endpoint ready url=http://127.0.0.1:3100/mc-mcp token=abcdef0123456789";
    const info = parseBridgeReadyLine(log);
    assert.deepEqual(info, {
      url: "http://127.0.0.1:3100/mc-mcp",
      token: "abcdef0123456789"
    } satisfies BridgeReadyInfo);
  });

  it("берёт ПОСЛЕДНЕЕ совпадение (перезапуск клиента в одном логе)", () => {
    const log = [
      "[mineagent-bridge] MCP endpoint ready url=http://127.0.0.1:3100/mc-mcp token=oldtoken1111",
      "некоторый шум между запусками",
      "[mineagent-bridge] MCP endpoint ready url=http://127.0.0.1:3100/mc-mcp token=newtoken2222"
    ].join("\n");
    const info = parseBridgeReadyLine(log);
    assert.equal(info?.token, "newtoken2222");
  });

  it("undefined если маркер отсутствует", () => {
    assert.equal(parseBridgeReadyLine("обычный лог без маркера моста"), undefined);
    assert.equal(parseBridgeReadyLine(""), undefined);
  });

  it("undefined если маркер есть, но данных нет (битая строка)", () => {
    const log = "[mineagent-bridge] MCP endpoint ready (без url/token)";
    assert.equal(parseBridgeReadyLine(log), undefined);
  });

  it("undefined если только url без token", () => {
    const log = "[mineagent-bridge] MCP endpoint ready url=http://127.0.0.1:3100/mc-mcp";
    assert.equal(parseBridgeReadyLine(log), undefined);
  });

  it("толерантен к строчным/прописным hex в token", () => {
    const log = "[mineagent-bridge] MCP endpoint ready url=http://127.0.0.1:3100/mc-mcp token=AbCdEf0123";
    const info = parseBridgeReadyLine(log);
    assert.equal(info?.token, "AbCdEf0123");
  });
});

describe("logParser — isBridgeReadyLine", () => {
  it("true для строки с маркером", () => {
    assert.equal(isBridgeReadyLine("[12:00:00] [mineagent-bridge] MCP endpoint ready url=x token=y"), true);
    assert.equal(isBridgeReadyLine("[mineagent-bridge] MCP endpoint ready"), true);
  });

  it("false для обычных строк лога", () => {
    assert.equal(isBridgeReadyLine("[12:00:00] [Render thread/INFO]: Reloading resources"), false);
    assert.equal(isBridgeReadyLine(""), false);
    assert.equal(isBridgeReadyLine("some unrelated [mineagent-bridge] text without marker"), false);
  });
});
