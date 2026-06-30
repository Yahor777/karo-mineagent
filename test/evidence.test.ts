import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { EvidenceService } from "../src/evidence/evidenceService";

describe("EvidenceService", () => {
  async function freshRoot(): Promise<string> {
    return mkdtemp(join(tmpdir(), "mineagent-evidence-"));
  }

  it("сохраняет метаданные запуска и перехватывает скриншоты", async () => {
    const root = await freshRoot();
    try {
      const runsPath = ".mineagent/runs";
      const service = new EvidenceService(root, runsPath);

      const runId = "test-run-123";
      const prompt = "Тестовый промпт";
      const startedAt = new Date().toISOString();
      const completedAt = new Date().toISOString();
      const summary = "Тестовый результат работы модели.";
      const projectMap = { loader: "forge", minecraftVersion: "1.20.1" };
      const phases = [{ name: "Understand", status: "complete" }];

      const toolCalls = [
        {
          name: "repo.search",
          input: { query: "myClass" },
          result: { files: ["MyClass.java"] }
        },
        {
          name: "minecraft.screenshot",
          input: {},
          result: { path: "some-tmp-screenshot.png" },
          // Передаем скриншот как base64 картинку
          images: [
            {
              data: Buffer.from("fake-png-data").toString("base64"),
              mimeType: "image/png"
            }
          ]
        },
        {
          name: "repo.patch",
          input: { patch: "diff-content-here" },
          result: { accepted: true }
        }
      ];

      const runDir = await service.saveRunEvidence(
        runId,
        prompt,
        startedAt,
        completedAt,
        summary,
        projectMap,
        toolCalls,
        phases
      );

      const expectedDir = join(root, runsPath, `run-${runId}`);
      assert.equal(runDir, expectedDir);
      assert.ok(existsSync(join(runDir, "run.json")));
      assert.ok(existsSync(join(runDir, "screenshots", "minecraft_screenshot-1.png")));
      assert.ok(existsSync(join(runDir, "patches", "patch-1.diff")));

      // Проверим содержимое run.json
      const jsonContent = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
      assert.equal(jsonContent.id, runId);
      assert.equal(jsonContent.prompt, prompt);
      assert.equal(jsonContent.status, "success");
      
      // Ссылка на скриншот должна быть относительной
      assert.equal(jsonContent.toolCalls[1].images[0].path, "screenshots/minecraft_screenshot-1.png");
      
      // Ссылка на патч должна быть относительной
      assert.equal(jsonContent.toolCalls[2].input.patchPath, "patches/patch-1.diff");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
