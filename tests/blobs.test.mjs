import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileStorage } from "../dist/common/storage.js";
test("large evidence is stored once as a hashed blob instead of repeated in every journal snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-blobs-"));
  const store = new FileStorage({ root, extension: "test" });
  await store.open();
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const bytes = Buffer.alloc(262144, "a");
  await store.writeBlob("large-evidence", bytes);
  for (let i = 0; i < 5; i++)
    await store.putRecord("tasks", "task-" + i, { status: "ready" });
  assert.ok((await readFile(join(root, "events.jsonl"))).length < 20000);
  assert.deepEqual(Buffer.from(await store.readBlob("large-evidence")), bytes);
  await writeFile(join(root, "blobs", "large-evidence.blob"), "tampered");
  await assert.rejects(store.recover(), /corrupt-blob/);
});
