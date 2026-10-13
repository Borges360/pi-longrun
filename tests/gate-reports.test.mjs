import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  testReportPassed,
  GateVerifier,
  runCommand,
} from "../dist/common/gates.js";
import { FileStorage } from "../dist/common/storage.js";
test("JUnit and JSON reports require executed tests and reject failure elements, entities and malformed counts", () => {
  assert.equal(
    testReportPassed(
      '<testsuites><testsuite tests="2" failures="0" errors="0"><testcase name="one"/><testcase name="two"/></testsuite></testsuites>',
      "junit",
    ),
    true,
  );
  for (const text of [
    '<testsuite tests="1" failures="0"><testcase><failure/></testcase></testsuite>',
    '<testsuite tests="1" errors="1"/>',
    '<testsuite tests="2" skipped="2"/>',
  ])
    assert.equal(testReportPassed(text, "junit"), false);
  for (const text of [
    '<testsuite tests="1">',
    '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///secret">]><testsuite tests="1"/>',
    '<testsuite tests="NaN"/>',
  ])
    assert.throws(() => testReportPassed(text, "junit"), /malformed/);
  assert.equal(
    testReportPassed('{"tests":3,"failures":0,"errors":0}', "json"),
    true,
  );
  assert.equal(testReportPassed('{"tests":3,"failures":1}', "json"), false);
  assert.throws(
    () => testReportPassed('{"tests":3,"failures":0,"skipped":-1}', "json"),
    /malformed/,
  );
});
test("exit zero cannot approve a malformed or failing required test report", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-gate-report-"));
  const store = new FileStorage({
    root: join(root, "state"),
    extension: "test",
  });
  await store.open();
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const args = ["-e", "process.exit(0)"];
  const verifier = new GateVerifier(store, root, {
    approvedCommands: [{ executable: process.execPath, args }],
    approvedHumans: [],
    timeoutMs: 1000,
    maxOutputBytes: 4096,
  });
  const req = {
    id: "unit",
    kind: "command",
    required: true,
    executable: process.execPath,
    args,
    report: { format: "junit", path: "report.xml" },
  };
  await writeFile(join(root, "report.xml"), "malformed");
  assert.equal((await verifier.verify(req, "standard")).verified, false);
  await writeFile(
    join(root, "report.xml"),
    '<testsuite tests="1" failures="1"/>',
  );
  assert.equal((await verifier.verify(req, "standard")).verified, false);
});
test("uncertain gate commands remain blocked instead of being replayed after a timeout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-gate-intent-"));
  const store = new FileStorage({ root, extension: "test" });
  await store.open();
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const args = ["-e", "setInterval(()=>{},1000)"];
  const verifier = new GateVerifier(store, root, {
    approvedCommands: [{ executable: process.execPath, args }],
    approvedHumans: [],
    timeoutMs: 50,
    maxOutputBytes: 1024,
  });
  const requirement = {
    id: "external",
    kind: "command",
    required: true,
    executable: process.execPath,
    args,
  };
  const first = await verifier.verify(requirement, "strict", undefined, {
    scopeId: "task-1",
  });
  assert.match(first.reason, /needs-gate-side-effect-review/);
  const second = await verifier.verify(requirement, "strict", undefined, {
    scopeId: "task-1",
  });
  assert.match(second.reason, /needs-gate-side-effect-review/);
  assert.equal((await store.listRecords("gate-intents")).length, 1);
});
test("combined stdout and stderr capture obey a byte ceiling", async () => {
  const output = await runCommand(
    process.execPath,
    [
      "-e",
      "process.stdout.write('é'.repeat(3000));process.stderr.write('x'.repeat(3000))",
    ],
    { cwd: process.cwd(), timeoutMs: 1000, maxOutputBytes: 1000 },
  );
  assert.equal(output.exitCode, 0);
  assert.ok(
    Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) <= 1000,
  );
  assert.equal(output.truncated, true);
});
