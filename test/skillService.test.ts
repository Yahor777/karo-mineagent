import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillService } from "../src/skills/skillService";

// Этап 6: тесты SkillService — парсинг frontmatter, list, create, match.

const SAMPLE_SKILL = `---
name: test-skill
description: Тестовый скилл
triggers: [test, skill, example]
---
# Тестовый скилл

Это тело скилла с инструкциями.
`;

const NO_FRONTMATTER = `Простой markdown без frontmatter.`;

async function makeDir(): Promise<string> {
  const dir = join(tmpdir(), `mineagent-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("SkillService (Этап 6)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("list возвращает пустой массив для пустой директории", async () => {
    const service = new SkillService(dir);
    assert.deepEqual(await service.list(), []);
  });

  it("list загружает .md с frontmatter", async () => {
    await writeFile(join(dir, "test-skill.md"), SAMPLE_SKILL, "utf8");
    const service = new SkillService(dir);
    const skills = await service.list();
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.name, "test-skill");
    assert.equal(skills[0]!.description, "Тестовый скилл");
    assert.deepEqual(skills[0]!.triggers, ["test", "skill", "example"]);
    assert.match(skills[0]!.content, /Тестовый скилл/);
  });

  it("list загружает .md без frontmatter (fallback)", async () => {
    await writeFile(join(dir, "simple.md"), NO_FRONTMATTER, "utf8");
    const service = new SkillService(dir);
    const skills = await service.list();
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.name, "simple");
    assert.equal(skills[0]!.description, "");
    assert.deepEqual(skills[0]!.triggers, []);
  });

  it("create записывает .md с frontmatter", async () => {
    const service = new SkillService(dir);
    await service.create(
      { name: "new-skill", description: "Новый", triggers: ["new", "custom"] },
      "Тело скилла"
    );
    const skills = await service.list();
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.name, "new-skill");
    assert.equal(skills[0]!.description, "Новый");
    assert.deepEqual(skills[0]!.triggers, ["new", "custom"]);
    assert.equal(skills[0]!.content, "Тело скилла");
  });

  it("get возвращает скилл по имени", async () => {
    await writeFile(join(dir, "test-skill.md"), SAMPLE_SKILL, "utf8");
    const service = new SkillService(dir);
    const skill = await service.get("test-skill");
    assert.ok(skill);
    assert.equal(skill.name, "test-skill");
  });

  it("get возвращает undefined для несуществующего", async () => {
    const service = new SkillService(dir);
    const skill = await service.get("nope");
    assert.equal(skill, undefined);
  });

  it("remove удаляет скилл", async () => {
    await writeFile(join(dir, "test-skill.md"), SAMPLE_SKILL, "utf8");
    const service = new SkillService(dir);
    await service.remove("test-skill");
    assert.deepEqual(await service.list(), []);
  });

  it("remove readOnly скилла → throw", async () => {
    const readOnlySkill = `---
name: protected
description: Защищённый
triggers: [protected]
readOnly: true
---
Тело`;
    await writeFile(join(dir, "protected.md"), readOnlySkill, "utf8");
    const service = new SkillService(dir);
    await assert.rejects(() => service.remove("protected"), /защищён/);
  });

  it("match без embeddingService — возвращает topK без ranking", async () => {
    await writeFile(join(dir, "forge.md"), `---
name: forge
description: Forge event handler
triggers: [forge, event, handler]
---
Тело`, "utf8");
    await writeFile(join(dir, "fabric.md"), `---
name: fabric
description: Fabric client setup
triggers: [fabric, client, setup]
---
Тело`, "utf8");
    const service = new SkillService(dir);
    const results = await service.match("forge event handler", 2);
    // Keyword pre-filter должен найти forge-скилл
    assert.ok(results.length > 0);
    assert.ok(results.some((r) => r.skill.name === "forge"));
  });

  it("match с pinnedSkills — добавляет их к результатам", async () => {
    await writeFile(join(dir, "forge.md"), `---
name: forge
description: Forge events
triggers: [forge, event]
---
Тело`, "utf8");
    await writeFile(join(dir, "custom.md"), `---
name: custom
description: Custom workflow
triggers: [custom]
---
Тело`, "utf8");
    const service = new SkillService(dir);
    const results = await service.match("forge", 1, ["custom"]);
    assert.ok(results.some((r) => r.skill.name === "custom" && r.pinned));
    assert.ok(results.some((r) => r.skill.name === "forge"));
  });

  it("match с excludedSkills — исключает их", async () => {
    await writeFile(join(dir, "forge.md"), `---
name: forge
description: Forge events
triggers: [forge, event]
---
Тело`, "utf8");
    const service = new SkillService(dir);
    const results = await service.match("forge", 5, [], ["forge"]);
    assert.ok(!results.some((r) => r.skill.name === "forge"));
  });

  it("match возвращает пустой массив для пустой директории", async () => {
    const service = new SkillService(dir);
    const results = await service.match("anything", 3);
    assert.deepEqual(results, []);
  });
});
