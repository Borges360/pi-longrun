import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Longrun,
  createService,
  transition,
  canCompleteRun,
  validateTasks,
} from "../dist/longrun.js";
import { Host } from "../dist/common/runtime.js";
import { localBus } from "../dist/common/cli.js";
import { digest } from "../dist/common/security.js";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-ledger-"));
  process.env.PI_ECOSYSTEM_STATE_ROOT = join(root, "state");
  const host = new Host("pi-longrun", createService, root, localBus());
  await host.start();
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.PI_ECOSYSTEM_STATE_ROOT;
  });
  return { host, root, service: host.service };
}
test("state machine cannot accept direct model claims or reopen accepted tasks", () => {
  for (const status of [
    "pending",
    "ready",
    "running",
    "blocked",
    "failed",
    "cancelled",
  ])
    assert.throws(() => transition({ status }, "accepted"));
  assert.throws(() => transition({ status: "accepted" }, "running"));
  assert.equal(
    canCompleteRun({ finalGate: "pending", requiredBlockers: 0 }, [
      { required: true, status: "accepted" },
    ]),
    false,
  );
  assert.equal(
    canCompleteRun({ finalGate: "passed", requiredBlockers: 1 }, [
      { required: true, status: "accepted" },
    ]),
    false,
  );
  assert.equal(
    canCompleteRun({ finalGate: "passed", requiredBlockers: 0 }, [
      { required: true, status: "accepted" },
    ]),
    true,
  );
});
test("DAG rejects missing dependencies, cycles and empty acceptance", () => {
  assert.throws(
    () =>
      validateTasks(
        [
          {
            id: "a",
            dependencies: ["missing"],
            acceptance: [{ required: true }],
          },
        ],
        20,
      ),
    /missing-dependency/,
  );
  assert.throws(
    () =>
      validateTasks(
        [{ id: "a", dependencies: ["a"], acceptance: [{ required: true }] }],
        20,
      ),
    /cycle/,
  );
  assert.throws(
    () => validateTasks([{ id: "a", dependencies: [], acceptance: [] }], 20),
    /acceptance/,
  );
});
test("artifact evidence accepts only hash matches and final gate determines completion", async (t) => {
  const { service, root } = await fixture(t);
  await writeFile(join(root, "output.txt"), "verified");
  const requirement = {
    id: "artifact",
    kind: "artifact",
    required: true,
    path: "output.txt",
    sha256: digest("verified"),
  };
  await service.startRun("Produce a verified artifact", [requirement]);
  assert.equal((await service.currentRun()).status, "active");
  assert.equal((await service.verify()).status, "accepted");
  assert.equal((await service.currentRun()).status, "completed");
  const checkpoints = await service.host.store.listRecords("checkpoints");
  assert.ok(checkpoints.some((c) => c.phase === "task-end"));
  assert.ok(checkpoints.some((c) => c.phase === "run-final-gate"));
});
test("failed required evidence cannot exceed attempt or automatic turn limits", async (t) => {
  const { service, host } = await fixture(t);
  host.config.maxAttempts = 2;
  host.config.maxAutomaticTurns = 1;
  await service.startRun("Needs objective verification", [
    {
      id: "missing",
      kind: "artifact",
      required: true,
      path: "absent",
      sha256: "0".repeat(64),
    },
  ]);
  assert.equal(
    (
      await service.settle({
        outcome: "completed",
        context: { canContinue: true },
      })
    ).continue,
    true,
  );
  assert.equal(
    await service.settle({
      outcome: "completed",
      context: { canContinue: true },
    }),
    undefined,
  );
  assert.equal((await service.currentRun()).autoContinuations, 1);
  await service.verify();
  const task = (await service.tasks())[0];
  assert.equal(task.attempt, 2);
  assert.equal(task.status, "failed");
  assert.notEqual((await service.currentRun()).status, "completed");
});
test("unsafe unfinished side effects block recovery and never replay automatically", async (t) => {
  const { service, host } = await fixture(t);
  await service.startRun("Perform bounded work");
  await service.toolCall({
    toolName: "external_write",
    toolCallId: "provider/call-1",
  });
  const result = await service.recover();
  assert.equal(result.unsafeIntents.length, 1);
  assert.equal((await service.currentRun()).status, "blocked");
  const task = (await service.tasks())[0];
  assert.match(task.blocker, /needs-side-effect-review/);
  await service.recover();
  assert.equal((await service.currentRun()).requiredBlockers, 1);
  assert.equal(
    (
      await service.toolCall({
        toolName: "external_write",
        toolCallId: "replay",
      })
    ).block,
    true,
  );
});
test("safe reads recover and bounded handoffs contain only relevant work state", async (t) => {
  const { service } = await fixture(t);
  await service.startRun("Read a repository");
  await service.toolCall({ toolName: "read", toolCallId: "read-1" });
  const result = await service.recover();
  assert.equal(result.safeReplay.length, 1);
  assert.equal((await service.currentRun()).status, "active");
  const handoff = await service.handoff();
  assert.ok(handoff.brief.length <= service.host.config.maxHandoffTokens * 3);
  assert.equal("transcript" in handoff, false);
});
test("run state persists through host shutdown without sibling extensions", async (t) => {
  const { host, service } = await fixture(t);
  const run = await service.startRun("Continue after restart");
  await service.command("pause", [], { cwd: host.cwd, trusted: false });
  await host.close();
  await host.start();
  assert.equal((await host.service.currentRun()).id, run.id);
  assert.equal((await host.service.currentRun()).status, "paused");
});
