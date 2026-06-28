import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasImageBlocks, extractTextFromContent } from "../src/providers/ProviderAdapter";
import type { ChatMessage, ContentBlock } from "../src/providers/ProviderAdapter";

// Этап 5: тесты multimodal wire-формата — ContentBlock union в ChatMessage.
// (a) content-блоковый формат в ChatRequest (text+image)
// (b) hasImageBlocks — корректное определение vision-запроса
// (c) extractTextFromContent — извлечение текста из string и array content

describe("Multimodal content (Этап 5)", () => {
  describe("hasImageBlocks", () => {
    it("false для строкового content", () => {
      const messages: ChatMessage[] = [{ role: "user", content: "Привет" }];
      assert.equal(hasImageBlocks(messages), false);
    });

    it("false для массива только с text-блоками", () => {
      const messages: ChatMessage[] = [{
        role: "user",
        content: [{ type: "text", text: "Вопрос" }]
      }];
      assert.equal(hasImageBlocks(messages), false);
    });

    it("true для массива с image_url-блоком", () => {
      const messages: ChatMessage[] = [{
        role: "user",
        content: [
          { type: "text", text: "Что на скриншоте?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } }
        ]
      }];
      assert.equal(hasImageBlocks(messages), true);
    });

    it("true при наличии image-блока в любом сообщении", () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "Системный промт" },
        { role: "user", content: "Текстовый вопрос" },
        {
          role: "user",
          content: [
            { type: "text", text: "Оцени" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc" } }
          ]
        }
      ];
      assert.equal(hasImageBlocks(messages), true);
    });

    it("false для пустого массива messages", () => {
      assert.equal(hasImageBlocks([]), false);
    });
  });

  describe("extractTextFromContent", () => {
    it("возвращает строку как есть", () => {
      assert.equal(extractTextFromContent("Привет"), "Привет");
    });

    it("извлекает текст из text-блоков", () => {
      const content: ContentBlock[] = [
        { type: "text", text: "Первая часть" },
        { type: "text", text: "Вторая часть" }
      ];
      assert.equal(extractTextFromContent(content), "Первая частьВторая часть");
    });

    it("пропускает image_url-блоки", () => {
      const content: ContentBlock[] = [
        { type: "text", text: "Вопрос" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        { type: "text", text: "Дополнение" }
      ];
      assert.equal(extractTextFromContent(content), "ВопросДополнение");
    });

    it("пустая строка для массива только с image-блоками", () => {
      const content: ContentBlock[] = [
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } }
      ];
      assert.equal(extractTextFromContent(content), "");
    });

    it("пустой массив → пустая строка", () => {
      assert.equal(extractTextFromContent([]), "");
    });
  });

  describe("ContentBlock — OpenAI vision shape", () => {
    it("text-блок имеет правильную форму", () => {
      const block: ContentBlock = { type: "text", text: "Описание" };
      assert.equal(block.type, "text");
      assert.equal((block as { text: string }).text, "Описание");
    });

    it("image_url-блок имеет data URL", () => {
      const block: ContentBlock = {
        type: "image_url",
        image_url: { url: "data:image/png;base64,iVBORw0KGgo=", detail: "low" }
      };
      assert.equal(block.type, "image_url");
      const img = (block as { image_url: { url: string; detail?: string } }).image_url;
      assert.ok(img.url.startsWith("data:image/png;base64,"));
      assert.equal(img.detail, "low");
    });
  });
});
