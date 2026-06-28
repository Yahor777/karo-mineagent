import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMinecraftLog } from "../src/tools/logParser";

describe("parseMinecraftLog", () => {
  it("summarizes fatal lines and likely missing dependency causes", () => {
    const summary = parseMinecraftLog(`
[Render thread/ERROR] Failed to load class
java.lang.NoClassDefFoundError: software/bernie/geckolib/GeoModel
Caused by: java.lang.ClassNotFoundException: software.bernie.geckolib.GeoModel
Crash report saved to: D:/mods/run/crash-reports/crash.txt
`);

    assert.equal(summary.crashReportPath, "D:/mods/run/crash-reports/crash.txt");
    assert.equal(summary.likelyCause, "Missing class or dependency mismatch.");
    assert.ok(summary.fatalLines.some((line) => line.includes("NoClassDefFoundError")));
  });

  it("recognizes mixin failures", () => {
    const summary = parseMinecraftLog(`
[main/FATAL] Mixin apply failed
org.spongepowered.asm.mixin.transformer.throwables.MixinApplyError: Mixin failed
`);

    assert.equal(summary.likelyCause, "Mixin configuration or target signature mismatch.");
  });
});
