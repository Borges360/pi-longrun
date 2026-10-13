import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { FileStorage } from "../dist/common/storage.js";
test("namespace validation accepts canonical aliases and relative roots while rejecting actual links", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "namespace-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStorage({
    root: relative(process.cwd(), join(root, "state")),
    extension: "test",
  });
  await store.open();
  await store.putRecord("data", "one", { value: 1 });
  assert.equal((await store.getRecord("data", "one")).value, 1);
  await store.close();
  await mkdir(join(root, "target"));
  await symlink(
    join(root, "target"),
    join(root, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const path of [join(root, "linked"), join(root, "linked", "child")]) {
    const linked = new FileStorage({ root: path, extension: "test" });
    await assert.rejects(linked.open(), /symlink-storage-root/);
    await linked.close();
  }
});
