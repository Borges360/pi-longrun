import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "../dist/common/config.js";
import {
  ChildDispatcher,
  delegation,
  processRunner,
} from "../dist/common/children.js";
import { FileStorage } from "../dist/common/storage.js";
const agent = {
  schemaVersion: 1,
  id: "reviewer",
  description: "Review",
  instructions: "Read files and summarize.",
  readOnly: true,
  paths: [],
  trusted: true,
};
test("delegation is selective; depth, trust, writes and coupled work have deterministic ceilings", () => {
  const c = defaults("test");
  const opts = { cwd: process.cwd() };
  assert.equal(
    delegation("test", "small change", [agent], c, "t", opts).mode,
    "none",
  );
  assert.equal(
    delegation("test", "review", [agent], c, "t", { ...opts, review: true })
      .mode,
    "single",
  );
  assert.equal(
    delegation("test", "review", [agent], c, "t", {
      ...opts,
      review: true,
      depth: 1,
    }).mode,
    "none",
  );
  assert.equal(
    delegation("test", "review", [agent], c, "t", {
      ...opts,
      review: true,
      write: true,
      tightlyCoupled: true,
    }).mode,
    "none",
  );
  assert.equal(
    delegation("test", "review", [{ ...agent, trusted: false }], c, "t", {
      ...opts,
      review: true,
    }).mode,
    "none",
  );
});
test("child process timeout is bounded and returns a structured result", async () => {
  const c = { ...defaults("test"), childTimeoutMs: 100 };
  const result = await processRunner(
    {
      schemaVersion: 1,
      id: "timeout",
      taskId: "t",
      objective: "review",
      agent,
      depth: 1,
      ancestors: ["reviewer"],
      readOnly: true,
      independent: false,
      cwd: process.cwd(),
    },
    c,
  );
  assert.ok(["blocked", "failed"].includes(result.status));
  assert.ok(result.durationMs < 5000);
  assert.equal("transcript" in result, false);
});
test("dispatch persists intent, limits total children, prevents duplication and denies unsafe writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-dispatch-test-"));
  const store = new FileStorage({ root, extension: "test" });
  await store.open();
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  let runs = 0;
  const c = { ...defaults("test"), maxChildrenPerTask: 1 };
  const dispatcher = new ChildDispatcher(store, c, async (request) => {
    runs++;
    return {
      schemaVersion: 1,
      id: request.id,
      status: "completed",
      summary: "facts",
      verifiedFacts: [],
      evidenceRefs: [],
      filesRead: [],
      filesChanged: [],
      openQuestions: [],
    };
  });
  const request = {
    schemaVersion: 1,
    id: "child-1",
    taskId: "task-1",
    objective: "review",
    agent,
    depth: 1,
    ancestors: ["reviewer"],
    readOnly: true,
    independent: false,
    cwd: process.cwd(),
  };
  await dispatcher.dispatch(request);
  assert.equal(runs, 1);
  await assert.rejects(
    dispatcher.dispatch({ ...request, id: "child-2" }),
    /children-per-task/,
  );
  await assert.rejects(
    dispatcher.dispatch({ ...request, id: "child-3", readOnly: false }),
    /isolated-write/,
  );
  assert.equal(runs, 1);
});
