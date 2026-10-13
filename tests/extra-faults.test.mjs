import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStorage, SqliteStorage } from "../dist/common/storage.js";
import { DatabaseSync } from "node:sqlite";
import { runCommand } from "../dist/common/gates.js";
for (const error of ["EACCES", "ENOSPC"]) {
  test(`${error} at snapshot boundary is uncertain and recovered without replay`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-extra-fault-"));
    let fail = false;
    const store = new FileStorage({
      root,
      extension: "fault",
      fault: (p) => {
        if (fail && p === "before-snapshot") throw new Error(error);
      },
    });
    await store.open();
    t.after(async () => {
      await store.close();
      await rm(root, { recursive: true, force: true });
    });
    fail = true;
    await assert.rejects(
      store.putRecord("intents", "one", { replay: "never-automatic" }),
      new RegExp(error),
    );
    fail = false;
    assert.equal((await store.recover()).recoveredCommits, 1);
    assert.equal(
      (await store.getRecord("intents", "one")).replay,
      "never-automatic",
    );
  });
}
test("SQLite busy rejects bounded writes and transaction rollback preserves the previous record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-sql-busy-"));
  let fail = false;
  const store = new SqliteStorage({
    root,
    extension: "fault",
    busyTimeoutMs: 30,
    fault: (p) => {
      if (fail && p === "before-snapshot") throw new Error("rollback");
    },
  });
  await store.open();
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.putRecord("runs", "one", { status: "pending" });
  const other = new DatabaseSync(join(root, "state.sqlite"));
  other.exec("BEGIN IMMEDIATE");
  const start = Date.now();
  await assert.rejects(store.putRecord("runs", "one", { status: "accepted" }));
  assert.ok(Date.now() - start < 1000);
  other.exec("ROLLBACK");
  other.close();
  fail = true;
  await assert.rejects(
    store.putRecord("runs", "one", { status: "accepted" }),
    /rollback/,
  );
  assert.equal((await store.getRecord("runs", "one")).status, "pending");
});
test("provider/gate-style process timeout is bounded and never reported as pass", async () => {
  const result = await runCommand(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { cwd: process.cwd(), timeoutMs: 50 },
  );
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
  // OS process-tree cleanup is separate from the 50 ms execution deadline.
  assert.ok(result.durationMs < 5000);
});
