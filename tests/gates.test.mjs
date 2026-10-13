import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GateVerifier,
  completionAllowed,
  selectProfile,
} from "../dist/common/gates.js";
import { FileStorage } from "../dist/common/storage.js";
import { digest } from "../dist/common/security.js";
test("completion requires every mandatory objective verifier and cannot use assistant claims", () => {
  const required = [
    { id: "unit", kind: "command", required: true },
    { id: "types", kind: "command", required: true },
  ];
  const pass = {
    schemaVersion: 1,
    id: "x",
    requirementId: "unit",
    profile: "standard",
    evaluated: true,
    verified: true,
    rejected: false,
    evidenceRef: "e",
    outputDigest: "h",
    durationMs: 0,
  };
  assert.equal(completionAllowed(required, [pass]), false);
  assert.equal(
    completionAllowed(required, [pass, { ...pass, requirementId: "types" }]),
    true,
  );
  for (const field of ["evaluated", "verified", "evidenceRef", "outputDigest"])
    assert.equal(
      completionAllowed([required[0]], [{ ...pass, [field]: false }]),
      false,
    );
  assert.equal(completionAllowed([], []), false);
  assert.equal(selectProfile(["security"], false, true), "strict");
});
test("commands require user policy, capture exit codes, reject timeout, hash evidence and redact secrets", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gate-test-"));
  const root = join(cwd, "state");
  const store = new FileStorage({ root, extension: "test" });
  await store.open();
  t.after(async () => {
    await store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const args = [
    "-e",
    'console.log("Bearer example-sensitive-token");process.exit(0)',
  ];
  const verifier = new GateVerifier(store, cwd, {
    approvedCommands: [{ executable: process.execPath, args }],
    approvedHumans: [],
    timeoutMs: 1000,
    maxOutputBytes: 1024,
  });
  const denied = await verifier.verify(
    {
      id: "denied",
      kind: "command",
      required: true,
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
    },
    "strict",
  );
  assert.equal(denied.verified, false);
  const pass = await verifier.verify(
    {
      id: "unit",
      kind: "command",
      required: true,
      executable: process.execPath,
      args,
    },
    "standard",
  );
  assert.equal(pass.exitCode, 0);
  assert.equal(pass.verified, true);
  const blob = await store.readBlob(pass.evidenceRef);
  assert.equal(digest(blob), pass.outputDigest);
  assert.ok(!Buffer.from(blob).toString().includes("example-sensitive-token"));
});
