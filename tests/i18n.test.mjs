import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  catalogParity,
  loadProjectLanguage,
  parseUiLanguage,
  resolveMessage,
  saveProjectLanguage,
  translate,
} from "../dist/common/i18n.js";
import { defaults, loadConfig } from "../dist/common/config.js";

test("English and Brazilian Portuguese catalogs have matching keys and placeholders", () => {
  assert.deepEqual(catalogParity(), { keys: true, placeholders: true });
  assert.equal(parseUiLanguage("pt-BR"), "pt-BR");
  assert.equal(parseUiLanguage("pt-br"), undefined);
  assert.equal(
    translate("pt-BR", "menuActionsCount", { count: 3 }),
    "3 ações",
  );
  const fallback = resolveMessage("pt-BR", "actionStatus", {}, {
    en: { actionStatus: "Status" },
    "pt-BR": {},
  });
  assert.deepEqual(fallback, { text: "Status", usedFallback: true });
});

test("language preferences are isolated to trusted projects and preserve other settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-longrun-language-"));
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  await mkdir(join(projectA, ".pi"), { recursive: true });
  await mkdir(projectB, { recursive: true });
  await writeFile(
    join(projectA, ".pi", "pi-longrun.json"),
    JSON.stringify({ mode: "observe", customSetting: "keep", uiLanguage: "pt-BR" }),
  );
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(await loadProjectLanguage("pi-longrun", projectA, true), {
    language: "pt-BR",
  });
  assert.deepEqual(await loadProjectLanguage("pi-longrun", projectB, true), {
    language: "en",
  });
  assert.deepEqual(await loadProjectLanguage("pi-longrun", projectA, false), {
    language: "en",
  });
  await assert.rejects(
    saveProjectLanguage("pi-longrun", projectB, false, "pt-BR"),
    /project-not-trusted/,
  );
  await saveProjectLanguage("pi-longrun", projectB, true, "pt-BR");
  const savedA = JSON.parse(
    await readFile(join(projectA, ".pi", "pi-longrun.json"), "utf8"),
  );
  const savedB = JSON.parse(
    await readFile(join(projectB, ".pi", "pi-longrun.json"), "utf8"),
  );
  assert.deepEqual(savedA, {
    mode: "observe",
    customSetting: "keep",
    uiLanguage: "pt-BR",
  });
  assert.deepEqual(savedB, { uiLanguage: "pt-BR" });
  assert.deepEqual(await loadProjectLanguage("pi-longrun", projectA, true), {
    language: "pt-BR",
  });
  assert.deepEqual(await loadProjectLanguage("pi-longrun", projectB, true), {
    language: "pt-BR",
  });
});

test("missing and invalid project languages fall back to English with diagnostics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-longrun-invalid-language-"));
  await mkdir(join(root, ".pi"), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await loadProjectLanguage("pi-longrun", root, true), {
    language: "en",
  });
  await writeFile(
    join(root, ".pi", "pi-longrun.json"),
    JSON.stringify({ uiLanguage: "fr" }),
  );
  assert.deepEqual(await loadProjectLanguage("pi-longrun", root, true), {
    language: "en",
    warning: "invalid",
  });
  await writeFile(
    join(root, ".pi", "pi-longrun.json"),
    JSON.stringify({ uiLanguage: null }),
  );
  assert.deepEqual(await loadProjectLanguage("pi-longrun", root, true), {
    language: "en",
    warning: "invalid",
  });
});

test("loadConfig ignores uiLanguage in project and user settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-longrun-config-language-"));
  const previousStateRoot = process.env.PI_ECOSYSTEM_STATE_ROOT;
  process.env.PI_ECOSYSTEM_STATE_ROOT = join(root, "state");
  const project = join(root, "project");
  await mkdir(join(project, ".pi"), { recursive: true });
  await mkdir(defaults("pi-longrun").storage.root, { recursive: true });
  await writeFile(
    join(defaults("pi-longrun").storage.root, "config.json"),
    JSON.stringify({ uiLanguage: "pt-BR" }),
  );
  await writeFile(
    join(project, ".pi", "pi-longrun.json"),
    JSON.stringify({ uiLanguage: "pt-BR", mode: "observe" }),
  );
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    if (previousStateRoot === undefined)
      delete process.env.PI_ECOSYSTEM_STATE_ROOT;
    else process.env.PI_ECOSYSTEM_STATE_ROOT = previousStateRoot;
  });
  const config = await loadConfig("pi-longrun", project, true);
  assert.equal(config.mode, "observe");
  assert.equal(Object.hasOwn(config, "uiLanguage"), false);
});
