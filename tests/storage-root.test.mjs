import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { FileStorage, SqliteStorage } from "../dist/common/storage.js";
import { DurableStorage } from "../dist/common/durable.js";
test("namespace validation accepts canonical aliases and relative roots while rejecting actual links", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "namespace-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const Backend of [FileStorage, SqliteStorage, DurableStorage]) {
    const store = new Backend({
      root: relative(process.cwd(), join(root, "state-" + Backend.name)),
      extension: "test",
    });
    await store.open();
    await store.putRecord("data", "one", { value: 1 });
    assert.equal((await store.getRecord("data", "one")).value, 1);
    await store.close();
  }
  await mkdir(join(root, "target"));
  await symlink(
    join(root, "target"),
    join(root, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const path of [join(root, "linked"), join(root, "linked", "child")]) {
    for (const Backend of [FileStorage, SqliteStorage, DurableStorage]) {
      const linked = new Backend({ root: path, extension: "test" });
      await assert.rejects(linked.open(), /symlink-storage-root/);
      await linked.close();
    }
  }
  await assert.rejects(lstat(join(root, "target", "child")), {
    code: "ENOENT",
  });
});
