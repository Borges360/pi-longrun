import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStorage, SqliteStorage } from "../dist/common/storage.js";
import { DurableStorage } from "../dist/common/durable.js";
import { asLongrunStorage } from "../dist/longrun-storage.js";
for (const Backend of [FileStorage, SqliteStorage, DurableStorage])
  test(`${Backend.name}: typed LongrunStorage preserves scoped tasks, evidence and latest checkpoint`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "longrun-public-store-"));
    const store = asLongrunStorage(
      new Backend({ root, extension: "pi-longrun" }),
    );
    await store.open();
    t.after(async () => {
      await store.close();
      await rm(root, { recursive: true, force: true });
    });
    const run = { schemaVersion: 1, id: "run", goal: "test", status: "active" };
    await store.createRun(run);
    await assert.rejects(store.createRun(run), /already-exists/);
    assert.equal((await store.getRun("run")).goal, "test");
    await store.updateRun({ ...run, goal: "changed" });
    assert.equal((await store.getRun("run")).goal, "changed");
    const task = {
      schemaVersion: 1,
      id: "task",
      runId: "run",
      status: "running",
    };
    await store.createTask(task);
    await store.createTask({ ...task, id: "other", runId: "another" });
    assert.equal((await store.listTasks("run")).length, 1);
    await store.updateTask({ ...task, status: "verifying" });
    assert.equal((await store.getTask("task")).status, "verifying");
    for (const sequence of [1, 3, 2])
      await store.checkpoint({
        schemaVersion: 1,
        id: `cp-${sequence}`,
        runId: "run",
        taskId: "task",
        sequence,
        phase: "safe",
        createdAt: new Date().toISOString(),
      });
    assert.equal((await store.getLatestCheckpoint("task")).sequence, 3);
    const blob = await store.writeBlob("evidence", Buffer.from("proof"));
    await store.saveEvidence({
      ...blob,
      kind: "artifact",
      verified: true,
      createdAt: new Date().toISOString(),
    });
    await store.saveGateResult({
      schemaVersion: 1,
      id: "gate",
      requirementId: "artifact",
      profile: "standard",
      evaluated: true,
      verified: true,
      rejected: false,
      durationMs: 0,
      evidenceRef: blob.id,
    });
    assert.equal((await store.getRecord("gates", "gate")).verified, true);
    assert.equal(
      Buffer.from(await store.readBlob(blob.id)).toString(),
      "proof",
    );
  });
