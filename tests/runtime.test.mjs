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
  assert.equal(JSON.parse(messages[3].content).version, packageManifest.version);
  await handlers.get("before_agent_start")?.(
    { messageType: "user", prompt: "Explain a small function" },
    ctx,
  );
  const menus = [];
  const tui = {
    ...ctx,
    mode: "tui",
    hasUI: true,
    ui: {
      select: async (title, choices) => {
        menus.push({ title, choices });
        return choices.includes("Settings") ? "Settings" : "doctor";
      },
    },
  };
  await command.handler("", tui);
  assert.equal(menus.length, 2);
  assert.ok(menus[0].choices.includes("Settings"));
  assert.equal(menus[1].title, "Settings");
  assert.equal(JSON.parse(messages.at(-1).content).standalone, true);
  const configMenus = [];
  const configPanels = [];
  let panelClosed = false;
  let renderRequests = 0;
  const keybindings = {
    getKeys: (binding) =>
      binding === "tui.select.confirm" ? ["enter"] : ["escape"],
    matches: (data, binding) =>
      binding === "tui.select.confirm"
        ? data === "enter"
        : data === "escape",
  };
  const configTui = {
    ...tui,
    ui: {
      select: async (title, choices) => {
        configMenus.push({ title, choices });
        if (choices.includes("Settings")) return "Settings";
        return "mode";
      },
      custom: async (factory) => {
        const panel = await factory(
          { requestRender: () => renderRequests++ },
          { fg: (_color, value) => value, bold: (value) => value },
          keybindings,
          () => {
            panelClosed = true;
          },
        );
        configPanels.push(panel);
        assert.match(panel.render(80).join("\n"), /Current: Automatic/);
        assert.match(
          panel.render(80).join("\n"),
          /\[ Enter \] Switch to Observe decisions/,
        );

        await panel.handleInput("enter");
        let view = panel.render(80).join("\n");
        assert.match(view, /Current: Observe decisions/);
        assert.match(view, /\[ Enter \] Switch to Disabled/);
        let saved = JSON.parse(
          await readFile(join(defaults(name).storage.root, "config.json"), "utf8"),
        );
        assert.equal(saved.mode, "observe");
        assert.equal(saved.enabled, true);

        await panel.handleInput("enter");
        view = panel.render(80).join("\n");
        assert.match(view, /Current: Disabled/);
        assert.match(view, /\[ Enter \] Switch to Automatic/);
        saved = JSON.parse(
          await readFile(join(defaults(name).storage.root, "config.json"), "utf8"),
        );
        assert.equal(saved.mode, "off");
        assert.equal(saved.enabled, false);

        await panel.handleInput("enter");
        view = panel.render(80).join("\n");
        assert.match(view, /Current: Automatic/);
        assert.match(view, /Saved\. Current mode: Automatic\./);
        await panel.handleInput("escape");
      },
    },
  };
  await command.handler("", configTui);
  assert.equal(configMenus.length, 2);
  assert.ok(configMenus[1].choices.includes("mode"));
  assert.equal(configPanels.length, 1);
  assert.equal(panelClosed, true);
  assert.ok(renderRequests >= 6);
  const savedConfig = JSON.parse(
    await readFile(join(defaults(name).storage.root, "config.json"), "utf8"),
  );
  assert.equal(savedConfig.mode, "auto");
  assert.equal(savedConfig.enabled, true);
  const priorMessages = messages.length;
  await command.handler("", { ...tui, ui: { select: async () => undefined } });
  assert.equal(messages.length, priorMessages);
});
