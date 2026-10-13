import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host } from "../dist/common/runtime.js";
import { localBus } from "../dist/common/cli.js";
import { digest } from "../dist/common/security.js";
import { createService } from "../dist/longrun.js";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "gate-bridge-"));
  process.env.PI_ECOSYSTEM_STATE_ROOT = join(root, "state");
  const bus = localBus();
  const host = new Host("pi-longrun", createService, root, bus);
  await host.start();
  await host.service.acceptanceGate.attach({
    sessionManager: { getSessionId: () => "session" },
  });
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.PI_ECOSYSTEM_STATE_ROOT;
  });
  const base = await realpath(root);
  return {
    host,
    root,
    bus,
    service: host.service,
    projectId: digest(process.platform === "win32" ? base.toLowerCase() : base),
  };
}
function event(projectId, patch = {}) {
  return {
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    source: "gate",
    projectId,
    sessionId: "session",
    occurredAt: new Date().toISOString(),
    kind: "gate.evaluated",
    payload: {
      taskId: "TASK-001",
      status: "accepted",
      contractHash: "a".repeat(64),
      evidenceIds: ["receipt"],
      verified: true,
    },
    ...patch,
  };
}
test("existing gate public event can satisfy only an explicitly bound supplementary check", async (t) => {
  const { service, root, bus, projectId } = await fixture(t);
  await writeFile(join(root, "output"), "ok");
  const req = {
    id: "file",
    kind: "artifact",
    required: true,
    path: "output",
    sha256: digest("ok"),
  };
  const run = await service.startRun("verified output", [req]);
  await service.command("gate", ["bind", "TASK-001"], {
    cwd: root,
    trusted: false,
  });
  assert.equal((await service.verify()).status, "accepted");
  assert.equal((await service.currentRun()).status, "active");
  assert.equal(
    await service.settle({
      outcome: "completed",
      context: { canContinue: true },
    }),
    undefined,
  );
  assert.equal((await service.currentRun()).autoContinuations, 0);
  bus.emit("suite:event", event(projectId));
  assert.equal(await service.acceptanceGate.ready(run.id), true);
  await service.verify();
  assert.equal((await service.currentRun()).status, "completed");
});
test("foreign, duplicate, old and incompatible gate events cannot bypass the binding", async (t) => {
  const { service, root, bus, projectId } = await fixture(t);
  const run = await service.startRun("Review a contract");
  await service.command("gate", ["bind", "TASK-001"], {
    cwd: root,
    trusted: false,
  });
  for (const patch of [
    { schemaVersion: 2 },
    { projectId: "foreign" },
    { sessionId: "other" },
    { occurredAt: "2020-01-01T00:00:00Z" },
    { source: "model" },
    { payload: { taskId: "TASK-001", status: "accepted", verified: true } },
  ])
    bus.emit("suite:event", event(projectId, patch));
  assert.equal(await service.acceptanceGate.ready(run.id), false);
  const accepted = event(projectId);
  bus.emit("suite:event", accepted);
  assert.equal(await service.acceptanceGate.ready(run.id), true);
  await service.acceptanceGate.invalidate(run.id);
  bus.emit("suite:event", accepted);
  assert.equal(await service.acceptanceGate.ready(run.id), false);
  await service.command("gate", ["unbind"], { cwd: root, trusted: false });
  assert.equal(await service.acceptanceGate.ready(run.id), true);
});
test("an external accepted summary never substitutes mandatory local evidence", async (t) => {
  const { service, root, bus, projectId } = await fixture(t);
  const run = await service.startRun("Missing local artifact", [
    {
      id: "missing",
      kind: "artifact",
      required: true,
      path: "absent",
      sha256: "0".repeat(64),
    },
  ]);
  await service.command("gate", ["bind", "TASK-001"], {
    cwd: root,
    trusted: false,
  });
  bus.emit("suite:event", event(projectId));
  assert.equal(await service.acceptanceGate.ready(run.id), true);
  await service.verify();
  assert.notEqual((await service.currentRun()).status, "completed");
});
