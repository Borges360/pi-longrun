import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Host } from "../dist/common/runtime.js";
import { localBus } from "../dist/common/cli.js";
import { createService } from "../dist/longrun.js";
import { digest } from "../dist/common/security.js";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-task-scope-"));
  process.env.PI_ECOSYSTEM_STATE_ROOT = join(root, "state");
  const host = new Host("pi-longrun", createService, root, localBus());
  await host.start();
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.PI_ECOSYSTEM_STATE_ROOT;
  });
  return { host, root };
}
test("task read-only and path scope apply before tools acquire effect intents", async (t) => {
  const { host, root } = await fixture(t);
  await mkdir(join(root, "allowed"));
  await writeFile(join(root, "allowed", "a.txt"), "data");
  await writeFile(join(root, "outside.txt"), "outside");
  await host.service.startRun("Scoped investigation");
  await host.service.replaceTasks([
    {
      id: "scope",
      objective: "Read scoped files",
      dependencies: [],
      acceptance: [{ id: "a", kind: "human", required: true }],
      scope: { readOnly: true, paths: ["allowed"] },
    },
  ]);
  assert.equal(
    (
      await host.service.toolCall({
        toolName: "write",
        toolCallId: "write",
        input: { path: "allowed/a.txt" },
      })
    ).reason,
    "task-read-only",
  );
  assert.equal(
    (
      await host.service.toolCall({
        toolName: "read",
        toolCallId: "outside",
        input: { path: "outside.txt" },
      })
    ).reason,
    "task-path-outside-scope",
  );
  assert.equal(
    await host.service.toolCall({
      toolName: "read",
      toolCallId: "inside",
      input: { path: "allowed/a.txt" },
    }),
    undefined,
  );
  assert.equal((await host.store.listRecords("intents")).length, 1);
});
test("a fatal failed dependency blocks its transitive successors without reporting an active run", async (t) => {
  const { host } = await fixture(t);
  host.config.maxAttempts = 1;
  await host.service.startRun("Three tasks");
  const acceptance = [
    {
      id: "artifact",
      kind: "artifact",
      required: true,
      path: "absent",
      sha256: digest("missing"),
    },
  ];
  await host.service.replaceTasks([
    { id: "a", objective: "First", dependencies: [], acceptance },
    { id: "b", objective: "Second", dependencies: ["a"], acceptance },
    { id: "c", objective: "Third", dependencies: ["b"], acceptance },
  ]);
  await host.service.verify();
  assert.equal((await host.service.currentRun()).status, "blocked");
  assert.deepEqual(
    (await host.service.tasks()).map((task) => task.status),
    ["failed", "blocked", "blocked"],
  );
});
test("uncertain tool errors stay blocked until reviewed and cannot be silently retried", async (t) => {
  const { host } = await fixture(t);
  await host.service.startRun("External operation");
  await host.service.toolCall({
    toolName: "external_write",
    toolCallId: "uncertain",
  });
  await host.service.toolResult({
    toolCallId: "uncertain",
    isError: true,
    content: [{ type: "text", text: "Disconnected after submit" }],
  });
  assert.equal((await host.service.currentRun()).status, "blocked");
  const intent = (await host.store.listRecords("intents"))[0];
  assert.equal(intent.settled, false);
  assert.equal(
    (
      await host.service.toolCall({
        toolName: "external_write",
        toolCallId: "retry",
      })
    ).block,
    true,
  );
});
