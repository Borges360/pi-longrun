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
    isProjectTrusted: () => false,
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
        if (title === name)
          return rootSelections++ === 0 ? "Configurações" : undefined;
        if (choices.includes("Voltar ao Longrun"))
          return settingsSelections++ === 0 ? "doctor" : "Voltar ao Longrun";
        return undefined;
      },
    },
  };
  await command.handler("", tui);
  assert.equal(menus.length, 4);
  assert.ok(menus[0].choices.includes("Configurações"));
  assert.equal(menus[1].title, "Configurações");
  assert.equal(JSON.parse(messages.at(-1).content).standalone, true);
  const configMenus = [];
  const configPanels = [];
  let panelClosed = false;
  let renderRequests = 0;
  let configRootSelections = 0;
  let configSettingsSelections = 0;
  const keybindings = {
    getKeys: (binding) =>
      binding === "tui.select.confirm" ? ["enter"] : ["escape"],
    matches: (data, binding) =>
      binding === "tui.select.confirm" ? data === "enter" : data === "escape",
  };
  const configTui = {
    ...tui,
    ui: {
      select: async (title, choices) => {
        configMenus.push({ title, choices });
        if (title === name)
          return configRootSelections++ === 0 ? "Configurações" : undefined;
        if (choices.includes("Voltar ao Longrun"))
          return configSettingsSelections++ === 0
            ? "mode"
            : "Voltar ao Longrun";
        return undefined;
      },
      custom: async (factory, options) => {
        assert.equal(options.overlay, true);
        const panel = await factory(
          { requestRender: () => renderRequests++ },
          {
            fg: (_color, value) => value,
            bg: (_color, value) => value,
            bold: (value) => value,
          },
          keybindings,
          () => {
            panelClosed = true;
          },
        );
        configPanels.push(panel);
        const render = () =>
          panel
            .render(80)
            .map((line) => line.trimEnd())
            .join("\n");
        assert.match(render(), /MODO ATUAL\nAutomático/);
        assert.match(
          render(),
          /PRÓXIMA AÇÃO\n\[ Enter \] Mudar para Observar decisões/,
        );

        await panel.handleInput("enter");
        let view = render();
        assert.match(view, /MODO ATUAL\nObservar decisões/);
        assert.match(view, /\[ Enter \] Mudar para Desativado/);
        let saved = JSON.parse(
          await readFile(
            join(defaults(name).storage.root, "config.json"),
            "utf8",
          ),
        );
        assert.equal(saved.mode, "observe");
        assert.equal(saved.enabled, true);

        await panel.handleInput("enter");
        view = render();
        assert.match(view, /MODO ATUAL\nDesativado/);
        assert.match(view, /\[ Enter \] Mudar para Automático/);
        saved = JSON.parse(
          await readFile(
            join(defaults(name).storage.root, "config.json"),
            "utf8",
          ),
        );
        assert.equal(saved.mode, "off");
        assert.equal(saved.enabled, false);

        await panel.handleInput("enter");
        view = render();
        assert.match(view, /MODO ATUAL\nAutomático/);
        assert.match(view, /Salvo: Automático\./);
        await panel.handleInput("escape");
      },
    },
  };
  await command.handler("", configTui);
  assert.equal(configMenus.length, 4);
  assert.ok(configMenus[1].choices.includes("mode"));
  assert.ok(configMenus[2].choices.includes("Voltar ao Longrun"));
  assert.equal(configPanels.length, 1);
  assert.equal(panelClosed, true);
  assert.equal(renderRequests, 3);
  const savedConfig = JSON.parse(
    await readFile(join(defaults(name).storage.root, "config.json"), "utf8"),
  );
  assert.equal(savedConfig.mode, "auto");
  assert.equal(savedConfig.enabled, true);

  const directMenus = [];
  await command.handler("config", {
    ...tui,
    ui: {
      select: async (title, choices) => {
        directMenus.push({ title, choices });
        return title === "Configurações" ? "Voltar ao Longrun" : undefined;
      },
      custom: async (factory) => {
        const panel = await factory(
          { requestRender: () => {} },
          {
            fg: (_color, value) => value,
            bg: (_color, value) => value,
            bold: (value) => value,
          },
          keybindings,
          () => {},
        );
        await panel.handleInput("escape");
      },
    },
  });
  assert.equal(directMenus[0].title, "Configurações");
  assert.ok(directMenus[0].choices.includes("Voltar ao Longrun"));
  assert.equal(directMenus[1].title, name);
  const priorMessages = messages.length;
  await command.handler("", { ...tui, ui: { select: async () => undefined } });
  assert.equal(messages.length, priorMessages);
});
