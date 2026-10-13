import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  appendFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStorage, SqliteStorage } from "../dist/common/storage.js";
import { DurableStorage } from "../dist/common/durable.js";
import { digest, canonical } from "../dist/common/security.js";
async function fixture(t, Backend = FileStorage, fault) {
  const root = await mkdtemp(join(tmpdir(), "pi-store-test-"));
  const store = new Backend({ root, extension: "test-extension", fault });
  await store.open();
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { store, root };
}
for (const Backend of [FileStorage, SqliteStorage, DurableStorage]) {
  test(`${Backend.name}: CRUD, CAS, events, blobs, lease ownership and reopen`, async (t) => {
    const { store, root } = await fixture(t, Backend);
    await store.putRecord(
      "runs",
      "one",
      { schemaVersion: 1, status: "active" },
      { expectedVersion: 0 },
    );
    await assert.rejects(
      store.putRecord("runs", "one", { status: "bad" }, { expectedVersion: 0 }),
      /version-conflict/,
    );
    await store.putRecord(
      "runs",
      "one",
      { status: "done" },
      { expectedVersion: 1 },
    );
    assert.equal((await store.getRecord("runs", "one")).status, "done");
    const event = {
      schemaVersion: 1,
      eventId: "e1",
      eventType: "test",
      emittedAt: new Date().toISOString(),
      payload: { value: 1 },
    };
    await store.appendEvent(event);
    await store.appendEvent(event);
    assert.equal((await store.exportSnapshot()).events.length, 1);
    const bytes = Buffer.from([0, 255, 127, 13, 10, 128, 1]);
    const ref = await store.writeBlob("binary", bytes);
    assert.deepEqual(Buffer.from(await store.readBlob("binary")), bytes);
    assert.equal(ref.sha256, digest(bytes));
    const lease = await store.acquireLease("run-one", 60000);
    await assert.rejects(store.acquireLease("run-one", 1000), /lease-held/);
    await store.releaseLease({ ...lease, owner: "wrong" });
    await assert.rejects(store.acquireLease("run-one", 1000), /lease-held/);
    await store.releaseLease(lease);
    await store.close();
    await store.open();
    assert.equal((await store.getRecord("runs", "one")).status, "done");
    await store.deleteRecord("runs", "one");
    assert.equal(await store.getRecord("runs", "one"), null);
    await assert.rejects(store.putRecord("../escape", "x", {}), /unsafe/);
    await assert.rejects(store.putRecord("runs", "..", {}), /unsafe/);
    await assert.rejects(store.putRecord("constructor", "one", {}), /unsafe/);
    await assert.rejects(store.putRecord("runs", "toString", {}), /unsafe/);
  });
  test(`${Backend.name}: rollback before commit and no secret records`, async (t) => {
    let fail = false;
    const { store } = await fixture(t, Backend, (point) => {
      if (fail && point === "before-journal")
        throw new Error("ENOSPC-injected");
    });
    await store.putRecord("runs", "one", {
      status: "pending",
      token: "hidden",
      message: "Bearer sensitive-token-value",
    });
    fail = true;
    await assert.rejects(
      store.putRecord("runs", "one", { status: "accepted" }),
      /ENOSPC/,
    );
    assert.equal((await store.getRecord("runs", "one")).status, "pending");
    assert.equal((await store.getRecord("runs", "one")).token, "[REDACTED]");
    assert.ok(
      !canonical(await store.exportSnapshot()).includes(
        "sensitive-token-value",
      ),
    );
  });
  test(`${Backend.name}: concurrent optimistic writes never lose an acknowledged update`, async (t) => {
    const { store } = await fixture(t, Backend);
    await store.putRecord("counter", "one", { n: 0 });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        store.putRecord("counter", "one", { n: 1 }, { expectedVersion: 1 }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await store.exportSnapshot()).records.counter.one.version, 2);
  });
}
test("files: committed journal recovers after snapshot fault", async (t) => {
  let fail = false;
  const { store } = await fixture(t, FileStorage, (p) => {
    if (fail && p === "after-journal") throw new Error("crash");
  });
  await store.putRecord("runs", "one", { status: "pending" });
  fail = true;
  await assert.rejects(
    store.putRecord("runs", "one", { status: "accepted" }),
    /crash/,
  );
  fail = false;
  const recovery = await store.recover();
  assert.equal(recovery.recoveredCommits, 1);
  assert.equal((await store.getRecord("runs", "one")).status, "accepted");
});
test("files: partial tail is quarantined, middle corruption fails closed", async (t) => {
  const { store, root } = await fixture(t);
  await store.putRecord("runs", "one", {});
  await appendFile(join(root, "events.jsonl"), '{"partial":');
  assert.equal((await store.recover()).repairedTail, true);
  await appendFile(join(root, "events.jsonl"), "not json\n");
  await assert.rejects(store.recover(), /corrupt-journal/);
});
test("files: invalid authoritative snapshot is never silently reset", async (t) => {
  const { store, root } = await fixture(t);
  await store.putRecord("runs", "one", {});
  await writeFile(join(root, "snapshot.json"), "partial");
  await assert.rejects(store.recover(), /corrupt-snapshot-read-only/);
});
test("files: checksum and sequence mutations are detected", async (t) => {
  const { store, root } = await fixture(t);
  await store.putRecord("runs", "one", {});
  const path = join(root, "events.jsonl");
  const line = JSON.parse((await readFile(path, "utf8")).trim());
  line.state.revision = 100;
  await writeFile(path, JSON.stringify(line) + "\n");
  await assert.rejects(store.recover(), /journal-checksum-or-sequence/);
});
test("files and sqlite portable snapshots preserve logical records and binary hashes", async (t) => {
  const { store: source } = await fixture(t);
  await source.putRecord("plans", "p", { revision: 3, tasks: ["a"] });
  await source.writeBlob("artifact", Buffer.from("evidence"));
  await source.appendEvent({
    schemaVersion: 1,
    eventId: "a",
    eventType: "test",
    emittedAt: new Date().toISOString(),
    payload: {},
  });
  const { store: target } = await fixture(t, SqliteStorage);
  const snapshot = await source.exportSnapshot();
  await target.importSnapshot(snapshot);
  const actual = await target.exportSnapshot();
  assert.deepEqual(actual.records, snapshot.records);
  assert.deepEqual(actual.events, snapshot.events);
  assert.deepEqual(actual.blobs, snapshot.blobs);
  assert.deepEqual(actual.metadata, snapshot.metadata);
});
