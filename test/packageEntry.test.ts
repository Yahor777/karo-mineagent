import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("extension package entry", () => {
  it("points VS Code at the compiled extension entrypoint", () => {
    const root = process.cwd();
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { main?: string };

    assert.equal(manifest.main, "./out/src/extension.js");
    assert.ok(existsSync(join(root, manifest.main)), `${manifest.main} must exist after compile`);
  });
});
