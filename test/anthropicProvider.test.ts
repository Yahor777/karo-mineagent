import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { 
  AnthropicProvider, 
  toAnthropicMessages, 
  toImageSource, 
  extractSystemPrompt 
} from "../src/providers/anthropicProvider";

describe("AnthropicProvider", () => {
  it("корректно инициализирует capabilities", () => {
    const provider = new AnthropicProvider("test-key");
    const model = (provider as any).describeModel("claude-3-5-sonnet-latest");
    
    assert.equal(model.provider, "anthropic");
    assert.equal(model.capabilities.vision, true);
    assert.equal(model.capabilities.tools, true);
    assert.equal(model.capabilities.jsonMode, false); // Anthropic не json-native
  });

  it("вычленяет system prompt из сообщений и форматирует сообщения", () => {
    const messages = [
      { role: "system" as const, content: "You are Claude" },
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi there" }
    ];

    const system = extractSystemPrompt(messages);
    assert.equal(system, "You are Claude");
  });

  it("сливает последовательные tool_result в один user-turn", () => {
    const messages = [
      { role: "user" as const, content: "Call tools" },
      { 
        role: "assistant" as const, 
        content: "", 
        tool_calls: [
          { id: "call_1", name: "tool_a", arguments: "{}" },
          { id: "call_2", name: "tool_b", arguments: "{}" }
        ] 
      },
      { role: "tool" as const, tool_call_id: "call_1", content: "result a" },
      { role: "tool" as const, tool_call_id: "call_2", content: "result b" }
    ];

    const anthropicMessages = toAnthropicMessages(messages);
    
    // Ожидаем:
    // 0: user "Call tools"
    // 1: assistant with tool_use blocks
    // 2: user with two tool_result blocks
    assert.equal(anthropicMessages.length, 3);
    assert.equal(anthropicMessages[0].role, "user");
    assert.equal(anthropicMessages[1].role, "assistant");
    assert.equal(anthropicMessages[2].role, "user");
    
    const toolResults = anthropicMessages[2].content as any[];
    assert.ok(Array.isArray(toolResults));
    assert.equal(toolResults.length, 2);
    assert.equal(toolResults[0].type, "tool_result");
    assert.equal(toolResults[0].tool_use_id, "call_1");
    assert.equal(toolResults[0].content, "result a");
    assert.equal(toolResults[1].tool_use_id, "call_2");
    assert.equal(toolResults[1].content, "result b");
  });

  it("конвертирует data URL картинки в base64 image block", () => {
    const url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    
    const source = toImageSource(url);
    assert.equal(source.type, "base64");
    assert.equal(source.media_type, "image/png");
    assert.equal(source.data, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
  });
});
