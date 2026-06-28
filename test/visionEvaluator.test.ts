import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VisionEvaluator } from "../src/orchestrator/visionEvaluator";
import { TokenBudgetService } from "../src/providers/tokenBudget";
import type { ChatRequest, ChatResponse, ProviderAdapter, ProviderModel, StreamChunk } from "../src/providers/ProviderAdapter";
import { hasImageBlocks } from "../src/providers/ProviderAdapter";

// Этап 5: тесты VisionEvaluator — vision-модель оценивает артефакты (скрины,
// рендеры) через multimodal ChatRequest с image_url-блоками.
// (a) content-блоковый формат в ChatRequest (text+image)
// (b) visionCalls инкрементится в tokenBudget
// (c) images доходят до vision-модели (не теряются)

class ScriptedProvider implements ProviderAdapter {
  public readonly id = "cloudflare";
  public readonly displayName = "Cloudflare";
  public lastRequest: ChatRequest | undefined;
  public queue: string[] = [];

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    this.lastRequest = request;
    const next = this.queue.shift();
    return { model: request.model, content: next ?? '{"matches":true,"confidence":0.9,"notes":"Модель видна"}' };
  }

  public async *streamChat(request: ChatRequest): AsyncIterable<StreamChunk> {
    yield { contentDelta: (await this.chat(request)).content };
  }

  public async listModels(): Promise<ProviderModel[]> {
    return [
      {
        id: "@cf/meta/llama-4-scout-17b-16e-instruct",
        label: "Llama 4 Scout",
        provider: "cloudflare",
        capabilities: { vision: true, tools: true, jsonMode: true, speed: "medium" }
      },
      {
        id: "@cf/moonshotai/kimi-k2.7-code",
        label: "Kimi K2.7",
        provider: "cloudflare",
        capabilities: { vision: true, tools: true, jsonMode: true, speed: "fast" }
      }
    ];
  }

  public async validateKey(): Promise<boolean> {
    return true;
  }
}

describe("VisionEvaluator (Этап 5)", () => {
  it("строит multimodal ChatRequest с image_url-блоками", async () => {
    const provider = new ScriptedProvider();
    const evaluator = new VisionEvaluator({
      provider,
      models: await provider.listModels()
    });
    await evaluator.evaluate({
      images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
      taskDescription: "Модель видна?"
    });
    const request = provider.lastRequest!;
    assert.ok(request, "запрос должен быть отправлен");
    // content user-сообщения — массив блоков с image_url
    const userMsg = request.messages.find((m) => m.role === "user")!;
    assert.ok(Array.isArray(userMsg.content), "content должен быть массивом");
    const blocks = userMsg.content as Array<{ type: string }>;
    assert.ok(blocks.some((b) => b.type === "text"), "должен быть text-блок");
    assert.ok(blocks.some((b) => b.type === "image_url"), "должен быть image_url-блок");
  });

  it("image-блок содержит data URL с base64", async () => {
    const provider = new ScriptedProvider();
    const evaluator = new VisionEvaluator({
      provider,
      models: await provider.listModels()
    });
    await evaluator.evaluate({
      images: [{ data: "abc123", mimeType: "image/png" }],
      taskDescription: "Оцени"
    });
    const userMsg = provider.lastRequest!.messages.find((m) => m.role === "user")!;
    const blocks = userMsg.content as Array<{ type: string; image_url?: { url: string } }>;
    const imgBlock = blocks.find((b) => b.type === "image_url")!;
    assert.ok(imgBlock.image_url!.url.startsWith("data:image/png;base64,abc123"));
  });

  it("использует visionModel из options", async () => {
    const provider = new ScriptedProvider();
    const evaluator = new VisionEvaluator({
      provider,
      models: await provider.listModels(),
      visionModel: "@cf/moonshotai/kimi-k2.7-code"
    });
    await evaluator.evaluate({
      images: [{ data: "abc", mimeType: "image/png" }],
      taskDescription: "Оцени"
    });
    assert.equal(provider.lastRequest!.model, "@cf/moonshotai/kimi-k2.7-code");
  });

  it("fallback на дефолтную vision-модель если visionModel не задан", async () => {
    const provider = new ScriptedProvider();
    const evaluator = new VisionEvaluator({
      provider,
      models: await provider.listModels()
    });
    await evaluator.evaluate({
      images: [{ data: "abc", mimeType: "image/png" }],
      taskDescription: "Оцени"
    });
    // Должна быть выбрана vision-capable модель из каталога
    assert.equal(provider.lastRequest!.model, "@cf/moonshotai/kimi-k2.7-code");
  });

  it("парсит JSON-вердикт модели", async () => {
    const provider = new ScriptedProvider();
    provider.queue = ['{"matches":true,"confidence":0.85,"notes":"Модель видна, эффект корректный"}'];
    const evaluator = new VisionEvaluator({
      provider,
      models: await provider.listModels()
    });
    const verdict = await evaluator.evaluate({
      images: [{ data: "abc", mimeType: "image/png" }],
      taskDescription: "Оцени"
    });
    assert.equal(verdict.matches, true);
    assert.equal(verdict.confidence, 0.85);
    assert.equal(verdict.notes, "Модель видна, эффект корректный");
  });

  it("парсит JSON из markdown code block", async () => {
    const provider = new ScriptedProvider();
    provider.queue = ['```json\n{"matches":false,"confidence":0.3,"notes":"Не видна"}\n```'];
    const evaluator = new VisionEvaluator({
      provider,
      models: await provider.listModels()
    });
    const verdict = await evaluator.evaluate({
      images: [{ data: "abc", mimeType: "image/png" }],
      taskDescription: "Оцени"
    });
    assert.equal(verdict.matches, false);
    assert.equal(verdict.confidence, 0.3);
  });

  it("fallback вердикт при невалидном JSON", async () => {
    const provider = new ScriptedProvider();
    provider.queue = ["Модель не смогла оценить"];
    const evaluator = new VisionEvaluator({
      provider,
      models: await provider.listModels()
    });
    const verdict = await evaluator.evaluate({
      images: [{ data: "abc", mimeType: "image/png" }],
      taskDescription: "Оцени"
    });
    assert.equal(verdict.matches, false);
    assert.equal(verdict.confidence, 0);
  });

  it("confidence ограничивается 0..1", async () => {
    const provider = new ScriptedProvider();
    provider.queue = ['{"matches":true,"confidence":1.5,"notes":"x"}'];
    const evaluator = new VisionEvaluator({
      provider,
      models: await provider.listModels()
    });
    const verdict = await evaluator.evaluate({
      images: [{ data: "abc", mimeType: "image/png" }],
      taskDescription: "Оцени"
    });
    assert.equal(verdict.confidence, 1);
  });

  it("инкрементит visionCalls в tokenBudget", async () => {
    const provider = new ScriptedProvider();
    const budget = new TokenBudgetService();
    const evaluator = new VisionEvaluator({
      provider,
      models: await provider.listModels(),
      tokenBudget: budget
    });
    await evaluator.evaluate({
      images: [{ data: "abc", mimeType: "image/png" }],
      taskDescription: "Оцени"
    });
    const snapshot = budget.snapshot();
    assert.equal(snapshot.usage.visionCalls, 1, "visionCalls должен инкрементиться");
  });

  it("hasImageBlocks подтверждает presence image-блоков в запросе", async () => {
    const provider = new ScriptedProvider();
    const evaluator = new VisionEvaluator({
      provider,
      models: await provider.listModels()
    });
    await evaluator.evaluate({
      images: [{ data: "abc", mimeType: "image/png" }],
      taskDescription: "Оцени"
    });
    assert.ok(hasImageBlocks(provider.lastRequest!.messages), "запрос должен содержать image-блоки");
  });

  it("throw если images пуст", async () => {
    const provider = new ScriptedProvider();
    const evaluator = new VisionEvaluator({
      provider,
      models: await provider.listModels()
    });
    await assert.rejects(
      () => evaluator.evaluate({ images: [], taskDescription: "Оцени" }),
      /пуст/
    );
  });

  it("передаёт несколько изображений в одном запросе", async () => {
    const provider = new ScriptedProvider();
    const evaluator = new VisionEvaluator({
      provider,
      models: await provider.listModels()
    });
    await evaluator.evaluate({
      images: [
        { data: "img1", mimeType: "image/png" },
        { data: "img2", mimeType: "image/png" }
      ],
      taskDescription: "Сравни два скрина"
    });
    const userMsg = provider.lastRequest!.messages.find((m) => m.role === "user")!;
    const blocks = userMsg.content as Array<{ type: string }>;
    const imageBlocks = blocks.filter((b) => b.type === "image_url");
    assert.equal(imageBlocks.length, 2, "должно быть 2 image_url-блока");
  });
});
