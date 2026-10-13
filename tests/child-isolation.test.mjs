import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildDispatcher } from "../dist/common/children.js";
import { FileStorage } from "../dist/common/storage.js";
import { defaults } from "../dist/common/config.js";
const agent = {
  schemaVersion: 1,
  id: "writer",
  description: "Writer",
  instructions: "Write scoped files",
  readOnly: false,
  paths: ["src/"],
  trusted: true,
};
const request = (id, taskId) => ({
  schemaVersion: 1,
  id,
  taskId,
  objective: "Isolated write",
  agent,
  depth: 1,
  ancestors: ["writer"],
  readOnly: false,
  independent: true,
  cwd: process.cwd(),
});
test("write children archive results before cleanup; interrupted writes retain isolation for review", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-child-write-test-"));
  const store = new FileStorage({ root, extension: "test" });
  await store.open();
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const order = [];
  const worktrees = {
    create: async (r) => {
      order.push("create:" + r.id);
      return r.id;
    },
    finish: async (r, p, result) => {
      order.push("archive:" + r.id);
      result.evidenceRefs.push("archived-patch");
    },
    remove: async (p) => {
      order.push("remove:" + p);
      assert.equal(
        (await store.getRecord("child-results", p)).status,
        "completed",
      );
    },
  };
  const config = { ...defaults("test"), writeAccess: true };
  const dispatcher = new ChildDispatcher(
    store,
    config,
    async (r) => ({
      schemaVersion: 1,
      id: r.id,
      status: "completed",
      summary: "done",
      verifiedFacts: [],
      evidenceRefs: [],
      filesRead: [],
      filesChanged: ["src/a.ts"],
      openQuestions: [],
    }),
    worktrees,
  );
  await dispatcher.dispatch(request("safe-write", "t1"));
  assert.deepEqual(order, [
    "create:safe-write",
    "archive:safe-write",
    "remove:safe-write",
  ]);
  const interrupted = new ChildDispatcher(
    store,
    config,
    async () => {
      throw new Error("child-write-crash");
    },
    worktrees,
  );
  await assert.rejects(
    interrupted.dispatch(request("interrupted", "t2")),
    /crash/,
  );
  assert.ok(!order.includes("remove:interrupted"));
  assert.equal(
    (await store.getRecord("children", "interrupted")).worktree,
    "interrupted",
  );
});
test(
  "parallel dispatch respects two workers and persists both independent results",
  { timeout: 5000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-child-parallel-"));
    const store = new FileStorage({ root, extension: "test" });
    await store.open();
    t.after(async () => {
      await store.close();
      await rm(root, { recursive: true, force: true });
    });
    let release;
    const bothStarted = new Promise((resolve) => {
      release = resolve;
    });
    let active = 0,
      peak = 0;
    const dispatcher = new ChildDispatcher(
      store,
      defaults("test"),
      async (r) => {
        active++;
        peak = Math.max(peak, active);
        if (active === 2) release();
        await bothStarted;
        active--;
        return {
          schemaVersion: 1,
          id: r.id,
          status: "completed",
          summary: "done",
          verifiedFacts: [],
          evidenceRefs: [],
          filesRead: [],
          filesChanged: [],
          openQuestions: [],
        };
      },
    );
    const make = (id) => ({ ...request(id, "t"), readOnly: true });
    const results = await Promise.all([
      dispatcher.dispatch(make("one")),
      dispatcher.dispatch(make("two")),
    ]);
    assert.equal(results.length, 2);
    assert.equal(peak, 2);
    assert.equal((await store.listRecords("child-results")).length, 2);
  },
);
