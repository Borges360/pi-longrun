import test from "node:test";
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import {
  appendFile,
  mkdtemp,
  rm,
  writeFile,
  readFile,
  symlink,
  mkdir,
} from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FileStorage, SqliteStorage } from "../dist/common/storage.js";
import { contained, projectKey } from "../dist/common/security.js";
import { Host } from "../dist/common/runtime.js";
import { localBus } from "../dist/common/cli.js";
import { createService } from "../dist/longrun.js";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-fault-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("subdirectories and worktree .git markers share canonical repository identity", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "src"));
  await writeFile(join(root, ".git"), "gitdir: /unread-test-marker");
  assert.equal(await projectKey(root), await projectKey(join(root, "src")));
});
function runChild(file, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (x) => (out += x));
    child.stderr.on("data", (x) => (err += x));
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      resolve({ pid: child.pid, code, signal, out, err }),
    );
  });
}
test("actual process death after journal commit recovers acknowledged intent and orphan lock", async (t) => {
  const root = await fixture(t);
  const module = pathToFileURL(
    fileURLToPath(new URL("../dist/common/storage.js", import.meta.url)),
  ).href;
  const worker = join(root, "kill.mjs");
  await writeFile(
    worker,
    `import {FileStorage} from ${JSON.stringify(module)};const store=new FileStorage({root:process.argv[2],extension:'fault',fault:p=>{if(p==='after-journal')process.kill(process.pid,'SIGKILL');}});await store.open();await store.putRecord('intents','external-effect',{replay:'never-automatic',settled:false});`,
  );
  const result = await runChild(worker, [join(root, "state")]);
  assert.notEqual(result.code, 0);
  const store = new FileStorage({
    root: join(root, "state"),
    extension: "fault",
  });
  await store.open();
  assert.equal(
    (await store.getRecord("intents", "external-effect")).replay,
    "never-automatic",
  );
  await store.close();
});
test("forced Longrun restart blocks an unsettled external effect without replay", async (t) => {
  const root = await fixture(t);
  const projectRoot = join(root, "project");
  const stateRoot = join(root, "state");
  const marker = join(root, "external-effect.log");
  await mkdir(projectRoot);
  const runtime = pathToFileURL(
    fileURLToPath(new URL("../dist/common/runtime.js", import.meta.url)),
  ).href;
  const longrun = pathToFileURL(
    fileURLToPath(new URL("../dist/longrun.js", import.meta.url)),
  ).href;
  const cli = pathToFileURL(
    fileURLToPath(new URL("../dist/common/cli.js", import.meta.url)),
  ).href;
  const worker = join(root, "longrun-crash.mjs");
  await writeFile(
    worker,
    `import {appendFile} from 'node:fs/promises';import {Host} from ${JSON.stringify(runtime)};import {createService} from ${JSON.stringify(longrun)};import {localBus} from ${JSON.stringify(cli)};const [cwd,stateRoot,marker]=process.argv.slice(2);process.env.PI_ECOSYSTEM_STATE_ROOT=stateRoot;const host=new Host('pi-longrun',createService,cwd,localBus());await host.start();await host.service.startRun('Perform one external action');await host.service.toolCall({toolName:'external_write',toolCallId:'crash-before-result'});await appendFile(marker,'performed\\n');process.kill(process.pid,'SIGKILL');`,
  );

  const child = await runChild(worker, [projectRoot, stateRoot, marker]);
  assert.notEqual(child.code, 0);
  assert.equal(await readFile(marker, "utf8"), "performed\n");

  const previousStateRoot = process.env.PI_ECOSYSTEM_STATE_ROOT;
  process.env.PI_ECOSYSTEM_STATE_ROOT = stateRoot;
  const host = new Host("pi-longrun", createService, projectRoot, localBus());
  try {
    await host.start();
    const run = await host.service.currentRun();
    const tasks = await host.service.tasks(run.id);
    const intents = await host.store.listRecords("intents");
    assert.equal(run.status, "blocked");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, "blocked");
    assert.match(tasks[0].blocker, /^needs-side-effect-review:/);
    assert.equal(intents.length, 1);
    assert.equal(intents[0].toolName, "external_write");
    assert.equal(intents[0].settled, false);
    assert.equal(intents[0].replay, "never-automatic");

    const recovery = await host.service.recover();
    assert.deepEqual(recovery.unsafeIntents, [intents[0].id]);
    assert.equal(await readFile(marker, "utf8"), "performed\n");
  } finally {
    await host.close();
    if (previousStateRoot === undefined)
      delete process.env.PI_ECOSYSTEM_STATE_ROOT;
    else process.env.PI_ECOSYSTEM_STATE_ROOT = previousStateRoot;
  }
});
test("two separate writers acknowledge exactly one version and never lose an update", async (t) => {
  const root = await fixture(t);
  const stateRoot = join(root, "state");
  const store = new FileStorage({ root: stateRoot, extension: "fault" });
  await store.open();
  await store.putRecord("counter", "one", { n: 0 });
  await store.close();
  const module = pathToFileURL(
    fileURLToPath(new URL("../dist/common/storage.js", import.meta.url)),
  ).href;
  const worker = join(root, "writer.mjs");
  await writeFile(
    worker,
    `import {FileStorage} from ${JSON.stringify(module)};const store=new FileStorage({root:process.argv[2],extension:'fault'});try{await store.open();await store.putRecord('counter','one',{n:1},{expectedVersion:1});console.log('ack');}catch(e){console.log('rejected:'+e.message);}finally{await store.close();}`,
  );
  const results = await Promise.all([
    runChild(worker, [stateRoot]),
    runChild(worker, [stateRoot]),
  ]);
  assert.equal(results.filter((r) => r.out.includes("ack")).length, 1);
  await store.open();
  assert.equal((await store.exportSnapshot()).records.counter.one.version, 2);
  await store.close();
});
test("Durable orphan ownership recovery arbitrates concurrent claimants before native storage opens", async (t) => {
  const root = await fixture(t);
  const stateRoot = join(root, "durable-state");
  const module = pathToFileURL(
    fileURLToPath(new URL("../dist/common/durable.js", import.meta.url)),
  ).href;
  const seed = join(root, "seed.mjs");
  await writeFile(
    seed,
    `import {DurableStorage} from ${JSON.stringify(module)};const store=new DurableStorage({root:process.argv[2],extension:'fault'});await store.open();await store.putRecord('counter','one',{n:0});process.kill(process.pid,'SIGKILL');`,
  );
  assert.notEqual((await runChild(seed, [stateRoot])).code, 0);
  const writer = join(root, "durable-writer.mjs");
  await writeFile(
    writer,
    `import {DurableStorage} from ${JSON.stringify(module)};const store=new DurableStorage({root:process.argv[2],extension:'fault'});try{await store.open();await store.putRecord('counter','one',{n:1},{expectedVersion:1});console.log('ack');}catch(e){console.log('rejected:'+e.message);}finally{await store.close();}`,
  );
  const results = await Promise.all([
    runChild(writer, [stateRoot]),
    runChild(writer, [stateRoot]),
  ]);
  assert.equal(
    results.filter((result) => result.out.includes("ack")).length,
    1,
  );
  const { DurableStorage } = await import("../dist/common/durable.js");
  const store = new DurableStorage({ root: stateRoot, extension: "fault" });
  await store.open();
  await store.open();
  assert.equal((await store.exportSnapshot()).records.counter.one.version, 2);
  await store.close();
});
test("future schema and live or foreign lock fail closed", async (t) => {
  const root = await fixture(t);
  const store = new FileStorage({ root, extension: "fault" });
  await store.open();
  await writeFile(
    join(root, "writer.lock"),
    JSON.stringify({ id: "foreign", pid: process.pid, host: hostname() }),
  );
  await assert.rejects(store.putRecord("runs", "a", {}), /writer-busy/);
  await (await import("node:fs/promises")).unlink(join(root, "writer.lock"));
  await assert.rejects(
    store.setMetadata({
      schemaVersion: 99,
      extension: "fault",
      createdBy: "future",
    }),
    /unsupported/,
  );
  await store.close();
});
test("path traversal and symlink evidence escapes are rejected", async (t) => {
  const root = await fixture(t);
  await assert.rejects(contained(root, "../escape", true), /path-escape/);
  const outside = await fixture(t);
  await symlink(outside, join(root, "escape"), "junction");
  await assert.rejects(contained(root, "escape/secret", true), /symlink/);
});
