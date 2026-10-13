import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host } from "../dist/common/runtime.js";
import { localBus } from "../dist/common/cli.js";
import { createService } from "../dist/longrun.js";
import { digest } from "../dist/common/security.js";
test("automatic continuation explicitly supplies the new task instead of stale context", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-continuation-"));
  process.env.PI_ECOSYSTEM_STATE_ROOT = join(root, "state");
  const host = new Host("pi-longrun", createService, root, localBus());
  await host.start();
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.PI_ECOSYSTEM_STATE_ROOT;
  });
  await writeFile(join(root, "first.txt"), "verified");
  const requirement = {
    id: "a",
    kind: "artifact",
    required: true,
    path: "first.txt",
    sha256: digest("verified"),
  };
  await host.service.startRun("Two dependent tasks", [requirement]);
  await host.service.replaceTasks([
    {
      id: "first",
      objective: "First task",
      dependencies: [],
      acceptance: [requirement],
    },
    {
      id: "second",
      objective: "Second task must receive a new brief",
      dependencies: ["first"],
      acceptance: [{ ...requirement, id: "b", path: "second.txt" }],
    },
  ]);
  const boundary = await host.service.settle({
    outcome: "completed",
    context: { canContinue: true },
  });
  assert.equal(boundary.continue, true);
  assert.equal(boundary.entries[0].type, "custom_message");
  assert.match(
    boundary.entries[0].content,
    /Second task must receive a new brief/,
  );
  assert.equal((await host.service.currentTask()).id, "second");
});
test("parallel startup waits for exactly one completed service initialization", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-startup-"));
  process.env.PI_ECOSYSTEM_STATE_ROOT = join(root, "state");
  let initializations = 0;
  const host = new Host(
    "startup-test",
    () => ({
      capabilities: [],
      menu: [],
      command: async () => ({}),
      start: async () => {
        initializations++;
        await new Promise((resolve) => setImmediate(resolve));
      },
    }),
    root,
    localBus(),
  );
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.PI_ECOSYSTEM_STATE_ROOT;
  });
  await Promise.all([host.start(), host.start(), host.start()]);
  assert.equal(initializations, 1);
  await host.store.putRecord("runs", "one", {});
  assert.ok(await host.store.getRecord("runs", "one"));
});
