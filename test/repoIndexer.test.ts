import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { RepoIndexer } from "../src/repo/repoIndexer";

describe("RepoIndexer", () => {
  it("detects core Forge project facts", async () => {
    const root = join(tmpdir(), `mineagent-index-${Date.now()}`);
    try {
      await write(root, "settings.gradle", "pluginManagement { repositories { gradlePluginPortal() } }");
      await write(root, "gradle.properties", "minecraft_version=1.20.1\njava_version=17\n");
      await write(root, "build.gradle", `
plugins { id 'net.minecraftforge.gradle' version '6.0.+' }
java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }
tasks.register("runClient") {}
`);
      await write(root, "src/main/resources/META-INF/mods.toml", 'modId="domainmod"\n');
      await write(root, "src/main/resources/assets/domainmod/lang/en_us.json", "{}");
      await write(root, "src/main/java/com/example/domain/DomainMod.java", `
@Mod("domainmod")
public class DomainMod {
  public static final DeferredRegister<Item> ITEMS = DeferredRegister.create(ForgeRegistries.ITEMS, "domainmod");
  public static final RegistryObject<Item> CURSED_TOOL = ITEMS.register("cursed_tool", Item::new);
  @SubscribeEvent public static void onTick(TickEvent.ServerTickEvent event) {}
}
`);

      const projectMap = await new RepoIndexer(root).buildProjectMap();

      assert.equal(projectMap.loader, "forge");
      assert.equal(projectMap.minecraftVersion, "1.20.1");
      assert.equal(projectMap.javaVersion, "17");
      assert.equal(projectMap.mainModId, "domainmod");
      assert.ok(projectMap.gradleTasks.includes("runClient"));
      assert.ok(projectMap.resources.lang.includes("src/main/resources/assets/domainmod/lang/en_us.json"));
      assert.ok(projectMap.architectureHints.includes("Forge-style deferred registration"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefers the [[mods]] modId over dependency modIds", async () => {
    const root = join(tmpdir(), `mineagent-index-modid-${Date.now()}`);
    try {
      await write(root, "build.gradle", "plugins { id 'net.minecraftforge.gradle' version '6.0.+' }\n");
      await write(root, "src/main/resources/META-INF/mods.toml", `
[[mods]]
modId="karo_arcana"
displayName="Karo Arcana"

[[dependencies.karo_arcana]]
modId="forge"

[[dependencies.karo_arcana]]
modId="minecraft"
`);

      const projectMap = await new RepoIndexer(root).buildProjectMap();

      assert.equal(projectMap.mainModId, "karo_arcana");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves templated Forge modId from gradle.properties", async () => {
    const root = join(tmpdir(), `mineagent-index-template-modid-${Date.now()}`);
    try {
      await write(root, "gradle.properties", "mod_id=karo_arcana\nminecraft_version=1.20.1\n");
      await write(root, "build.gradle", "plugins { id 'net.minecraftforge.gradle' version '6.0.+' }\n");
      await write(root, "src/main/resources/META-INF/mods.toml", `
[[mods]]
modId="\${mod_id}"
displayName="\${mod_name}"

[[dependencies.\${mod_id}]]
modId="forge"
`);

      const projectMap = await new RepoIndexer(root).buildProjectMap();

      assert.equal(projectMap.mainModId, "karo_arcana");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function write(root: string, relativePath: string, text: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}
