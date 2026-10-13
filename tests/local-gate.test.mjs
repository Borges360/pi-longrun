import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Host } from "../dist/common/runtime.js";
import { localBus } from "../dist/common/cli.js";
import { createService } from "../dist/longrun.js";
import { validateGateSet, profileWithFloor } from "../dist/gate.js";
import { digest } from "../dist/common/security.js";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-local-gate-"));
  process.env.PI_ECOSYSTEM_STATE_ROOT = join(root, "state");
  const host = new Host("pi-longrun", createService, root, localBus());
  await host.start();
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.PI_ECOSYSTEM_STATE_ROOT;
  });
  return { host, root, context: { cwd: root, trusted: false } };
}
test("local gate works with no longrun, hashes required evidence and enforces the security profile floor", async (t) => {
  const { host, root, context } = await fixture(t);
  await writeFile(join(root, "artifact.txt"), "correct");
  const set = {
    schemaVersion: 1,
    id: "artifact-check",
    objective: "Verify security artifact",
    requirements: [
      {
        id: "artifact",
        kind: "artifact",
        required: true,
        path: "artifact.txt",
        sha256: digest("correct"),
      },
    ],
  };
  await writeFile(join(root, "gates.json"), JSON.stringify(set));
  await host.command("gate", ["configure", "gates.json"], context);
  await host.command("gate", ["profile", "fast"], context);
  const result = await host.command("gate", ["verify"], context);
  assert.equal(result.status, "passed");
  assert.equal(result.profile, "strict");
  assert.ok(await host.store.readBlob(result.results[0].evidenceRef));
  assert.equal(await host.service.currentRun(), null);
  assert.equal(profileWithFloor("none", ["database"]), "strict");
});
test("human approval is scoped to the gate set and a single verification attempt", async (t) => {
  const { host, root, context } = await fixture(t);
  await writeFile(
    join(root, "gates.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "human",
      objective: "Review a specific artifact",
      requirements: [{ id: "review", kind: "human", required: true }],
    }),
  );
  await host.command("gate", ["configure", "gates.json"], context);
  await host.command("gate", ["approve-human", "review"], context);
  assert.equal(
    (await host.command("gate", ["verify"], context)).status,
    "passed",
  );
  assert.equal(
    (await host.command("gate", ["verify"], context)).status,
    "blocked",
  );
});
test("discovery does not execute untrusted package scripts and invalid gate sets are rejected", async (t) => {
  const { host, root, context } = await fixture(t);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      scripts: { test: "throw must never execute", lint: "invalid" },
    }),
  );
  const result = await host.command("gate", ["discover"], context);
  assert.equal(result.requirements.length, 2);
  assert.equal(result.trustedProject, false);
  assert.throws(
    () =>
      validateGateSet({
        schemaVersion: 1,
        id: "empty",
        objective: "Verify",
        requirements: [],
      }),
    /invalid/,
  );
});
test("zero automatic turns still allows objective completion at the final boundary", async (t) => {
  const { host, root } = await fixture(t);
  host.config.maxAutomaticTurns = 0;
  await writeFile(join(root, "artifact.txt"), "correct");
  await host.service.startRun("Verify artifact", [
    {
      id: "artifact",
      kind: "artifact",
      required: true,
      path: "artifact.txt",
      sha256: digest("correct"),
    },
  ]);
  assert.equal(
    await host.service.settle({
      outcome: "completed",
      context: { canContinue: true },
    }),
    undefined,
  );
  assert.equal((await host.service.currentRun()).status, "completed");
});
