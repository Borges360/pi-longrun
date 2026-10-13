import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Interop, envelope } from "../dist/common/contracts.js";
import { localBus } from "../dist/common/cli.js";
import { defaults, validateConfig } from "../dist/common/config.js";
import extension from "../dist/extension.js";
const name = JSON.parse(
  await (
    await import("node:fs/promises")
  ).readFile(new URL("../package.json", import.meta.url), "utf8"),
)
  .name.split("/")
  .at(-1);
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
  await handlers.get("before_agent_start")?.(
    { messageType: "user", prompt: "Explain a small function" },
    ctx,
  );
});
