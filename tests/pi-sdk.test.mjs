import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
test("published Pi 1.2.0 loader accepts source and built distribution without credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-loader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["../src/extension.ts", "../dist/extension.js"]) {
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({}),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL(path, import.meta.url))],
    });
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    assert.ok(result.extensions.length >= 1);
  }
});
