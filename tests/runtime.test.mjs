import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Interop, envelope } from "../dist/common/contracts.js";
import { localBus } from "../dist/common/cli.js";
import { defaults, validateConfig } from "../dist/common/config.js";
import extension from "../dist/extension.js";
const packageManifest = JSON.parse(
  await (
    await import("node:fs/promises")
  ).readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const name = packageManifest.name.split("/").at(-1);
const displayName = "Longrun";
test("event bus ignores duplicates, future schemas, old events and isolates consumer failures", async () => {
  const bus = localBus();
  const a = new Interop("a", bus, "project");
  let count = 0;
  a.listen("test.v1", () => {
    count++;
  });
  const e = envelope("b", "test.v1", {}, { projectKey: "project" });
  bus.emit("test.v1", e);
  bus.emit("test.v1", e);
  bus.emit("test.v1", { ...e, eventId: "future", schemaVersion: 2 });
  bus.emit("test.v1", {
    ...e,
    eventId: "old",
    emittedAt: "2000-01-01T00:00:00Z",
  });
  assert.equal(count, 1);
  a.listen("failure.v1", async () => {
    throw new Error("offline");
  });
  bus.emit(
    "failure.v1",
    envelope("b", "failure.v1", {}, { projectKey: "project" }),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(a.failures, 1);
  a.close();
});
test("capability discovery works regardless of startup order and removal", () => {
  const bus = localBus();
  const a = new Interop("a", bus, "p"),
    b = new Interop("b", bus, "p");
  a.start(["one"]);
  b.start(["two"]);
  assert.equal(a.healthy("b", "two"), true);
  assert.equal(b.healthy("a", "one"), true);
  b.close();
  a.close();
});
test("safe configuration rejects model escalation and malformed numeric values", () => {
  const c = defaults(name);
  assert.equal(c.storage.backend, "files");
  assert.throws(() => validateConfig({ ...c, assistantClaims: true }));
  assert.throws(() => validateConfig({ ...c, requireApproval: false }));
  assert.throws(() => validateConfig({ ...c, maxParallel: Infinity }));
  assert.throws(() =>
    validateConfig({ ...c, compactAtRatio: 0.9, handoffAtRatio: 0.7 }),
  );
});
test("extension loads independently and all discovery commands work without TUI", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-extension-test-"));
  process.env.PI_ECOSYSTEM_STATE_ROOT = join(root, "state");
  await mkdir(join(root, "cwd"));
  const cwd = join(root, "cwd");
  const handlers = new Map(),
    commands = new Map(),
    tools = new Map(),
    messages = [];
  let active = ["read", "write", "mcp__untrusted__drop"];
  const pi = {
    events: localBus(),
    on: (n, f) => {
      handlers.set(n, f);
      return () => handlers.delete(n);
    },
    registerCommand: (n, d) => commands.set(n, d),
    registerTool: (t) => {
      tools.set(t.name, t);
    },
    sendMessage: (m) => messages.push(m),
    getAllTools: () => [
      { name: "read" },
      { name: "write" },
      {
        name: "mcp__untrusted__drop",
        namespace: { name: "mcp__untrusted" },
        annotations: { readOnlyHint: true },
      },
    ],
    getActiveTools: () => active,
    setActiveTools: (tools) => {
      active = tools;
    },
    registerMcpServer: () => {},
    unregisterMcpServer: () => {},
  };
  extension(pi);
  assert.equal(commands.size, 1);
  assert.ok(tools.size >= 1);
  assert.equal(messages.length, 0);
  const ctx = {
    cwd,
    mode: "print",
    hasUI: false,
    ui: new Proxy(
      {},
      {
        get: () => () => {
          throw new Error("TUI accessed headlessly");
        },
      },
    ),
    isProjectTrusted: () => true,
    getContextUsage: () => undefined,
    compact: () => {},
    signal: undefined,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => {},
    shutdown: () => {},
    getSystemPrompt: () => "",
    sessionManager: {},
    modelRegistry: {},
    model: undefined,
  };
  await handlers.get("session_start")?.({}, ctx);
  t.after(async () => {
    await handlers.get("session_shutdown")?.({}, ctx);
    await rm(root, { recursive: true, force: true });
    delete process.env.PI_ECOSYSTEM_STATE_ROOT;
  });
  const command = [...commands.values()][0];
  for (const action of ["status", "explain", "config", "doctor", "off", "auto"])
    await command.handler(action, ctx);
  assert.ok(messages.length >= 6);
  assert.equal(JSON.parse(messages.at(-1).content).enabled, true);
  assert.equal(
    JSON.parse(messages[3].content).version,
    packageManifest.version,
  );
  await handlers.get("before_agent_start")?.(
    { messageType: "user", prompt: "Explain a small function" },
    ctx,
  );
  const menus = [];
  let rootSelections = 0;
  let settingsSelections = 0;
  const tui = {
    ...ctx,
    mode: "tui",
    hasUI: true,
    ui: {
      select: async (title, choices) => {
        menus.push({ title, choices });
        if (title === displayName)
          return rootSelections++ === 0 ? "Settings" : undefined;
        if (title === `${displayName} / Settings`)
          return settingsSelections++ === 0 ? "Doctor" : undefined;
        return undefined;
      },
    },
  };
  await command.handler("", tui);
  assert.equal(menus.length, 4);
  assert.ok(menus[0].choices.includes("Settings"));
  assert.equal(menus[1].title, `${displayName} / Settings`);
  assert.equal(menus[2].title, `${displayName} / Settings`);
  assert.equal(menus[3].title, displayName);
  assert.ok(menus[1].choices.includes("Mode"));
  assert.ok(menus[1].choices.includes("Language"));
  assert.equal(menus[1].choices.includes("Voltar ao Longrun"), false);
  assert.equal(JSON.parse(messages.at(-1).content).standalone, true);
  const configMenus = [];
  let panelRuns = 0;
  let closedPanels = 0;
  let renderRequests = 0;
  const keybindings = {
    getKeys: (binding) =>
      ({
        "tui.select.confirm": ["enter"],
        "tui.select.cancel": ["escape"],
        "tui.select.up": ["up"],
        "tui.select.down": ["down"],
      })[binding] ?? [],
    matches: (data, binding) =>
      ({
        "tui.select.confirm": "enter",
        "tui.select.cancel": "escape",
        "tui.select.up": "up",
        "tui.select.down": "down",
      })[binding] === data,
  };
  const configTui = {
    ...tui,
    ui: {
      select: async (title, choices) => {
        configMenus.push({ title, choices });
        return undefined;
      },
      custom: async (factory, options) => {
        assert.equal(options.overlay, true);
        const panel = await factory(
          { requestRender: () => renderRequests++, terminal: { rows: 24 } },
          {
            fg: (_color, value) => value,
            bg: (_color, value) => value,
            bold: (value) => value,
          },
          keybindings,
          () => closedPanels++,
        );
        const render = () =>
          panel
            .render(80)
            .map((line) => line.trimEnd())
            .join("\n");
        const waitFor = async (predicate, message) => {
          for (let attempt = 0; attempt < 100; attempt++) {
            if (predicate()) return;
            await new Promise((resolve) => setImmediate(resolve));
          }
          assert.fail(message);
        };
        const configPath = join(defaults(name).storage.root, "config.json");
        if (panelRuns++ === 0) {
          assert.equal(render().includes(displayName), true);
          for (const [group, expectedActions] of [
            ["Execution", ["Status", "Start", "Pause", "Resume", "Stop"]],
            ["Progress", ["Tasks", "Inspect", "Verify", "Gate status", "Gate verify"]],
            ["Recovery", ["Recover"]],
            ["Settings", ["Mode", "Doctor", "Language"]],
          ]) {
            await panel.handleInput("enter");
            await waitFor(
              () => render().includes(`${displayName} / ${group}`),
              `${group} actions should open from the root menu`,
            );
            for (const action of expectedActions) assert.ok(render().includes(action));
            await panel.handleInput("escape");
            await panel.drain();
            if (group !== "Settings") await panel.handleInput("down");
          }
        await panel.handleInput("enter");
        await waitFor(
          () => render().includes("Language"),
          "the language action should appear in trusted project settings",
        );
        await panel.handleInput("down");
        await panel.handleInput("down");
        await panel.handleInput("enter");
        await waitFor(
          () => render().includes("Settings / Language"),
          "language selection should open as a nested choice dialog",
        );
        await panel.handleInput("down");
        await panel.handleInput("enter");
        await panel.drain();
        assert.match(render(), /Rascunho do idioma: Português \(Brasil\)/);
        const projectLanguagePath = join(cwd, ".pi", `${name}.json`);
        await assert.rejects(readFile(projectLanguagePath), { code: "ENOENT" });
        await panel.handleInput("escape");
        assert.match(render(), /Há alterações não salvas/);
        await panel.handleInput("escape");
          panel.close();
          return;
        }

        assert.match(render(), new RegExp(`${displayName} / Settings`));
        await panel.handleInput("enter");
        await waitFor(
          () => render().includes("Mode") && render().includes("Doctor"),
          "the Settings group should open its actions",
        );
        assert.ok(render().includes("Mode"));
        assert.ok(render().includes("Doctor"));
        await panel.handleInput("enter");
        await waitFor(
          () => render().includes(`${displayName} / Settings / Mode`),
          "mode should open as a nested choice dialog",
        );
        assert.match(render(), /Automatic/);
        await panel.handleInput("down");
        await panel.handleInput("enter");
        await panel.drain();
        assert.match(render(), /Mode draft: Observe/);
        const unchanged = JSON.parse(await readFile(configPath, "utf8"));
        assert.equal(unchanged.mode, "auto");
        assert.equal(unchanged.enabled, true);
        if (panelRuns === 2) {
          await panel.handleInput("escape");
          assert.match(render(), /Unsaved changes/);
          assert.equal(
            JSON.parse(await readFile(configPath, "utf8")).mode,
            "auto",
          );
          await panel.handleInput("escape");
        } else {
          await panel.handleInput("enter");
          await waitFor(
            () => render().includes("Language"),
            "the language action should remain available after a mode draft",
          );
          await panel.handleInput("down");
          await panel.handleInput("down");
          await panel.handleInput("enter");
          await waitFor(
            () => render().includes("Settings / Language"),
            "language selection should open before saving both drafts",
          );
          await panel.handleInput("down");
          await panel.handleInput("enter");
          await panel.drain();
          assert.match(render(), /Rascunho do idioma/);
          assert.equal(
            JSON.parse(await readFile(configPath, "utf8")).mode,
            "auto",
            "Ctrl+S has not been pressed yet",
          );
          await panel.handleInput("\u0013");
          await panel.drain();
          assert.match(render(), /Configurações salvas\./);
          const saved = JSON.parse(await readFile(configPath, "utf8"));
          assert.equal(saved.mode, "observe");
          assert.equal(saved.enabled, true);
          const projectSaved = JSON.parse(
            await readFile(join(cwd, ".pi", `${name}.json`), "utf8"),
          );
          assert.equal(projectSaved.uiLanguage, "pt-BR");
          panel.close();
        }
      },
    },
  };
  const dashboardTui = {
    ...configTui,
    ui: {
      ...configTui.ui,
      select: tui.ui.select,
    },
  };
  await command.handler("", dashboardTui);
  await command.handler("config", configTui);
  await command.handler("config", configTui);
  assert.equal(configMenus.length, 0);
  assert.equal(closedPanels, 3);
  assert.ok(renderRequests > 0);
  const savedConfig = JSON.parse(
    await readFile(join(defaults(name).storage.root, "config.json"), "utf8"),
  );
  assert.equal(savedConfig.mode, "observe");
  assert.equal(savedConfig.enabled, true);
  const priorMessages = messages.length;
  await command.handler("", { ...tui, ui: { select: async () => undefined } });
  assert.equal(messages.length, priorMessages);
  const fallbackMenus = [];
  let rootChoice = 0;
  let settingsChoice = 0;
  await command.handler("", {
    ...tui,
    ui: {
      select: async (title, choices) => {
        fallbackMenus.push({ title, choices });
        if (title === "Longrun")
          return rootChoice++ === 0 ? "Configurações" : undefined;
        if (title === "Longrun / Configurações")
          return settingsChoice++ === 0 ? "Idioma" : undefined;
        if (title.includes("/ Idioma — atual:")) return "English";
        if (title === "Rascunho do idioma: English")
          return "Descartar rascunho";
        return undefined;
      },
    },
  });
  assert.equal(fallbackMenus[0].choices.includes("Configurações"), true);
  assert.equal(fallbackMenus[1].choices.includes("Idioma"), true);
  assert.equal(fallbackMenus[2].choices.includes("English"), true);
  assert.equal(
    JSON.parse(await readFile(join(cwd, ".pi", `${name}.json`), "utf8"))
      .uiLanguage,
    "pt-BR",
    "discarding fallback language selection leaves the project preference unchanged",
  );
});
