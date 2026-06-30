import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

export interface ToolCallEvidence {
  name: string;
  input: any;
  result: any;
  error?: string;
  images?: Array<{ data: string; mimeType: string }>;
}

export interface RunEvidence {
  id: string;
  prompt: string;
  startedAt: string;
  completedAt: string;
  status: string;
  summary: string;
  projectMap: any;
  toolCalls?: ToolCallEvidence[];
  phases?: any[];
}

export class EvidenceService {
  public constructor(
    private readonly root: string,
    private readonly runsPath: string
  ) {}

  public async saveRunEvidence(
    runId: string,
    prompt: string,
    startedAt: string,
    completedAt: string,
    summary: string,
    projectMap: any,
    toolCalls: any[] | undefined,
    phases: any[]
  ): Promise<string> {
    const runDirName = runId.startsWith("run-") ? runId : `run-${runId}`;
    const runDir = join(this.root, this.runsPath, runDirName);
    const screenshotsDir = join(runDir, "screenshots");
    const patchesDir = join(runDir, "patches");

    await mkdir(runDir, { recursive: true });

    let savedToolCalls: ToolCallEvidence[] | undefined = undefined;

    if (toolCalls && toolCalls.length) {
      savedToolCalls = [];
      let screenshotIndex = 1;
      let patchIndex = 1;

      for (const call of toolCalls) {
        const evidenceCall: ToolCallEvidence = {
          name: call.name,
          input: call.input,
          result: call.result,
          error: call.error
        };

        // 1. Обработка скриншотов / рендеров
        if (call.images && call.images.length) {
          await mkdir(screenshotsDir, { recursive: true });
          const savedImages: any[] = [];
          
          for (const img of call.images) {
            const ext = img.mimeType === "image/png" ? "png" : "jpg";
            const filename = `${call.name.replace(/\./g, "_")}-${screenshotIndex++}.${ext}`;
            const filepath = join(screenshotsDir, filename);
            const buffer = Buffer.from(img.data, "base64");
            await writeFile(filepath, buffer);

            savedImages.push({
              path: `screenshots/${filename}`,
              mimeType: img.mimeType
            });
          }
          
          evidenceCall.images = savedImages;
        }

        // 2. Обработка патчей
        if (call.name === "repo.patch" && call.input?.patch) {
          await mkdir(patchesDir, { recursive: true });
          const filename = `patch-${patchIndex++}.diff`;
          const filepath = join(patchesDir, filename);
          await writeFile(filepath, call.input.patch, "utf8");
          
          evidenceCall.input = {
            ...call.input,
            patchPath: `patches/${filename}`
          };
        }

        savedToolCalls.push(evidenceCall);
      }
    }

    const runJson: RunEvidence = {
      id: runId,
      prompt,
      startedAt,
      completedAt,
      status: (savedToolCalls?.some(c => c.error) ? "failed" : "success"),
      summary,
      projectMap,
      toolCalls: savedToolCalls,
      phases
    };

    const runJsonPath = join(runDir, "run.json");
    await writeFile(runJsonPath, JSON.stringify(runJson, null, 2), "utf8");

    return runDir;
  }
}
