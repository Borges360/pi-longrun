import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host } from "../dist/common/runtime.js";
import { localBus } from "../dist/common/cli.js";
import { digest } from "../dist/common/security.js";
import { createService } from "../dist/longrun.js";
const check = {
  id: "artifact",
  kind: "artifact",
  required: true,
  path: "output",
  sha256: digest("ok"),
};
const task = (id, dependencies = []) => ({
  id,
  objective: `Implement ${id}`,
  dependencies,
  acceptance: [check],
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ledger-revision-"));
  process.env.PI_ECOSYSTEM_STATE_ROOT = join(root, "state");
  const bus = localBus();
  const host = new Host("pi-longrun", createService, root, bus);
  await host.start();
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.PI_ECOSYSTEM_STATE_ROOT;
  });
  return { host, service: host.service, root, bus };
}
test("verified replan preserves accepted tasks, global budgets and checkpoints", async (t) => {
  const { service, host, root } = await fixture(t);
  await writeFile(join(root, "output"), "ok");
  await service.startRun("Deliver both steps", [check]);
  await service.replaceTasks([task("done"), task("remaining", ["done"])]);
  await service.verify();
  assert.equal(
    (await service.tasks()).find((t) => t.id === "done").status,
    "accepted",
  );
  await writeFile(join(root, "output"), "broken");
  await service.verify();
  const proof = (await host.store.listRecords("ledger-evidence"))[0];
  assert.ok(proof);
  const before = await service.currentRun();
  await service.replaceTasks([task("replacement", ["done"])], {
    evidenceId: proof.id,
  });
  const after = await service.currentRun();
  assert.equal(after.replans, 1);
  assert.equal(after.spentUsd, before.spentUsd);
  assert.equal(after.autoContinuations, before.autoContinuations);
  assert.equal(after.maxCostUsd, before.maxCostUsd);
  assert.equal(
    (await service.tasks()).find((t) => t.id === "done").status,
    "accepted",
  );
  assert.ok(await host.store.getRecord("retired-tasks", "remaining"));
  assert.equal(
    (await host.store.getRecord("ledger-evidence", proof.id)).consumed,
    true,
  );
  assert.ok(
    (await host.store.listRecords("checkpoints")).some(
      (c) => c.phase === "ledger-revision",
    ),
  );
  await assert.rejects(
    service.replaceTasks([task("reuse-proof", ["done"])], {
      evidenceId: proof.id,
    }),
    /material-ledger-evidence/,
  );
});
test("unchanged accepted task cannot be weakened, pending effects cannot be retired", async (t) => {
  const { service, host, root } = await fixture(t);
  await writeFile(join(root, "output"), "ok");
  await service.startRun("Deliver", [check]);
  await service.replaceTasks([task("accepted"), task("write", ["accepted"])]);
  await service.verify();
  const accepted = (await service.tasks()).find((t) => t.id === "accepted");
  await assert.rejects(
    service.replaceTasks([{ ...accepted, objective: "changed" }, task("next")]),
    /accepted-task-immutable/,
  );
  await service.toolCall({
    toolName: "external_write",
    toolCallId: "uncertain",
  });
  await assert.rejects(
    service.replaceTasks([task("bypass")]),
    /pending-effect-before-replan/,
  );
  assert.equal(
    (await host.store.listRecords("retired-tasks")).some(
      (t) => t.id === "write",
    ),
    false,
  );
});
test("manual constraints use the same two-replan bound and task IDs are never recycled", async (t) => {
  const { service, root } = await fixture(t);
  await service.startRun("Bounded planning", [check]);
  await service.replaceTasks([task("initial")]);
  for (const name of ["replan-one", "replan-two"]) {
    await writeFile(
      join(root, "tasks.json"),
      JSON.stringify({ tasks: [task(name)] }),
    );
    await service.command("revise", ["tasks.json"], {
      cwd: root,
      trusted: false,
    });
  }
  assert.equal((await service.currentRun()).replans, 2);
  await writeFile(
    join(root, "tasks.json"),
    JSON.stringify({ tasks: [task("third")] }),
  );
  await assert.rejects(
    service.command("revise", ["tasks.json"], { cwd: root, trusted: false }),
    /ledger-replan-limit/,
  );
  await assert.rejects(
    service.replaceTasks([task("initial")]),
    /task-id-already-used/,
  );
});
test("metadata and gate tools do not bypass task tool-call budgets", async (t) => {
  const { service, host } = await fixture(t);
  host.config.maxToolCalls = 1;
  await service.startRun("Bounded metadata", [check]);
  await service.toolCall({
    toolName: "longrun_status",
    toolCallId: "status-1",
  });
  await service.toolResult({
    toolCallId: "status-1",
    isError: false,
    content: [],
  });
  assert.equal((await service.tasks())[0].toolCalls, 1);
  assert.equal(
    (
      await service.toolCall({
        toolName: "longrun_gate_verify",
        toolCallId: "gate-2",
      })
    ).reason,
    "longrun-budget-exhausted",
  );
  assert.equal(
    await service.toolCall({
      toolName: "longrun_tasks",
      toolCallId: "ledger-1",
    }),
    undefined,
  );
  assert.equal(
    (
      await service.toolCall({
        toolName: "longrun_tasks",
        toolCallId: "ledger-2",
      })
    ).reason,
    "ledger-definition-limit",
  );
});
test("autoplan proposals resolve only configured structured verifier IDs", async (t) => {
  const { service, host } = await fixture(t);
  await service.startRun("Bind a plan", [check]);
  await service.ingestPlan({
    planId: "plan",
    revision: 1,
    tasks: [
      {
        id: "bad",
        objective: "claim",
        dependsOn: [],
        acceptance: ["the model says done"],
      },
    ],
  });
  assert.equal(
    (await host.store.getRecord("suggested-plans", "plan")).reason,
    "structured-verifiers-required",
  );
  await service.ingestPlan({
    planId: "plan",
    revision: 2,
    tasks: [
      {
        id: "bound",
        objective: "verified artifact",
        dependsOn: [],
        acceptance: ["artifact"],
      },
    ],
  });
  assert.equal(
    (await host.store.getRecord("suggested-plans", "plan")).applied,
    true,
  );
  assert.equal((await service.tasks())[0].id, "bound");
  await service.ingestPlan({ planId: "plan", revision: 1, tasks: [] });
  assert.equal(
    (await host.store.getRecord("suggested-plans", "plan")).revision,
    2,
  );
});
