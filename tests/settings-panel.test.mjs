import test from "node:test";
import assert from "node:assert/strict";
import { SettingsPanel } from "../dist/common/settings-panel.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const keyNames = {
  "tui.select.confirm": "enter",
  "tui.select.cancel": "escape",
  "tui.select.up": "up",
  "tui.select.down": "down",
};
const keys = {
  getKeys: (binding) => [keyNames[binding]].filter(Boolean),
  matches: (data, binding) => keyNames[binding] === data,
};
const theme = {
  fg: (_color, value) => value,
  bg: (_color, value) => value,
  bold: (value) => value,
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

function makePanel({ rows, signal = new AbortController().signal, save, dirty, summary, title = "Settings 漢字 🙂", copy, formatError = () => "Save failed; the draft is still available." }) {
  let renderRequests = 0;
  let doneCalls = 0;
  const options = {
    title,
    summary: summary ?? (() => "Current value: 漢字 🙂"),
    rows,
    dirty: dirty ?? (() => false),
    signal,
    save: save ?? (async () => {}),
    formatError,
    copy,
  };
  const panel = new SettingsPanel(options, theme, keys, () => renderRequests++, () => doneCalls++);
  return {
    panel,
    counts: () => ({ renderRequests, doneCalls }),
  };
}

test("settings panel renders Unicode at 40/80/120 columns and returns from nested choices", async () => {
  let draft = "first";
  let saved = "first";
  const row = {
    id: "choice",
    label: "Plan 漢字 🙂 with a long label",
    value: () => draft,
    description: "Choose a value with Unicode 漢字 and an emoji 🙂.",
    activate: async (panel) => {
      const choice = await panel.choose("Choose 漢字 🙂", [
        { value: "first", label: "First 漢字" },
        { value: "second", label: "Second 🙂" },
      ], draft);
      if (choice) {
        draft = choice;
        panel.report(`Draft: ${draft}`);
      }
    },
  };
  const { panel, counts } = makePanel({
    rows: [row],
    dirty: () => draft !== saved,
    summary: () => `Saved: ${saved}; draft: ${draft}`,
    save: async () => { saved = draft; },
  });
  const render = () => panel.render(80).join("\n");

  for (const width of [40, 80, 120]) {
    assert.ok(panel.render(width).every((line) => visibleWidth(line) === width));
  }
  assert.match(render(), /Settings 漢字/);
  await panel.handleInput("enter");
  assert.match(render(), /Choose 漢字/);
  await panel.handleInput("escape");
  await panel.drain();
  assert.match(render(), /Settings 漢字/);
  assert.equal(draft, "first");

  await panel.handleInput("enter");
  await panel.handleInput("down");
  await panel.handleInput("enter");
  await panel.drain();
  assert.equal(draft, "second");
  assert.equal(saved, "first", "selection must not persist before Ctrl+S");
  assert.match(render(), /Draft: second/);
  await panel.handleInput("escape");
  assert.match(render(), /Unsaved changes/);
  assert.equal(counts().doneCalls, 0);
  await panel.handleInput("escape");
  assert.equal(counts().doneCalls, 1);
  assert.equal(saved, "first", "discard must leave persisted state unchanged");
});

test("settings panel applies localized labels, hints, errors and discard guidance", async () => {
  const copy = {
    back: "Voltar",
    authorize: "Autorizar",
    operationCanceled: "Operação cancelada.",
    canceling: "Cancelando…",
    unsaved: "Há alterações não salvas. Ctrl+S salva; pressione Esc novamente para descartar.",
    operationFailed: "A operação falhou. Tente novamente.",
    working: "Em andamento… Esc cancela a operação.",
    dialogHints: "↑↓ escolher · Enter confirmar · Esc voltar",
    footerHints: "↑↓ navegar · Enter editar/abrir · Ctrl+S salvar · Esc fechar",
  };
  const confirmRow = {
    id: "confirm",
    label: "Confirmar",
    value: () => "",
    description: "Confirme a operação.",
    activate: async (panel) => {
      if (await panel.confirm("Autorizar operação?")) panel.report("Autorizado.");
    },
  };
  const localized = makePanel({ rows: [confirmRow], copy });
  for (const width of [40, 80, 120])
    assert.ok(localized.panel.render(width).every((line) => visibleWidth(line) === width));
  await localized.panel.handleInput("enter");
  await tick();
  assert.match(localized.panel.render(80).join("\n"), /Voltar/);
  assert.match(localized.panel.render(80).join("\n"), /Autorizar/);
  await localized.panel.handleInput("down");
  await localized.panel.handleInput("enter");
  await localized.panel.drain();
  assert.match(localized.panel.render(80).join("\n"), /↑↓ navegar/);
  assert.match(localized.panel.render(80).join("\n"), /Autorizado/);
  localized.panel.close();

  const failing = makePanel({
    rows: [confirmRow],
    copy,
    dirty: () => true,
    save: async () => { throw new Error("fixture failure"); },
    formatError: () => undefined,
  });
  await failing.panel.handleInput("\u0013");
  await failing.panel.drain();
  assert.match(failing.panel.render(80).join("\n"), /A operação falhou/);
  await failing.panel.handleInput("escape");
  assert.match(failing.panel.render(80).join("\n"), /Há alterações não salvas/);
  failing.panel.close();
});

test("Ctrl+S retains a failed draft and retries the approved save", async () => {
  let draft = "observe";
  let saved = "auto";
  let attempts = 0;
  const row = {
    id: "mode",
    label: "Mode",
    value: () => draft,
    description: "Select a mode.",
    activate: async () => {},
  };
  const { panel } = makePanel({
    rows: [row],
    dirty: () => draft !== saved,
    save: async () => {
      attempts++;
      if (attempts === 1) throw new Error("temporary persistence failure");
      saved = draft;
    },
  });
  await panel.handleInput("\u0013");
  await panel.drain();
  assert.equal(saved, "auto");
  assert.equal(draft, "observe");
  assert.match(panel.render(80).join("\n"), /Save failed; the draft is still available/);
  assert.match(panel.render(80).join("\n"), /Settings 漢字.*\*/);

  await panel.handleInput("\u0013");
  await panel.drain();
  assert.equal(attempts, 2);
  assert.equal(saved, "observe");
  assert.doesNotMatch(panel.render(80).join("\n"), /Settings 漢字.*\*/);
  panel.close();
});

test("Escape cancels active work and host abort suppresses delayed panel updates", async () => {
  let release;
  const row = {
    id: "work",
    label: "Work",
    value: () => "ready",
    description: "Cancelable work.",
    activate: async (panel) => {
      await new Promise((resolve) => { release = resolve; });
      panel.report("Late callback");
    },
  };
  const first = makePanel({ rows: [row] });
  await first.panel.handleInput("enter");
  await tick();
  await first.panel.handleInput("escape");
  release();
  await first.panel.drain();
  assert.match(first.panel.render(80).join("\n"), /Operation canceled/);
  assert.equal(first.counts().doneCalls, 0, "cancel keeps the panel usable");
  first.panel.close();

  let releaseLate;
  const controller = new AbortController();
  const lateRow = {
    ...row,
    activate: async (panel) => {
      await new Promise((resolve) => { releaseLate = resolve; });
      panel.report("Late callback");
    },
  };
  const second = makePanel({ rows: [lateRow], signal: controller.signal });
  await second.panel.handleInput("enter");
  await tick();
  controller.abort();
  const requestsAtDispose = second.counts().renderRequests;
  releaseLate();
  await second.panel.drain();
  assert.equal(second.counts().doneCalls, 1);
  assert.equal(second.counts().renderRequests, requestsAtDispose);
});
