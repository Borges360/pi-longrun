import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
test("file backend remains operational when SQLite and all Durable packages are unavailable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-no-optional-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hook = join(root, "deny.mjs");
  await writeFile(
    hook,
    `import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(specifier==='node:sqlite'||specifier.startsWith('@earendil-works/pi-durable')||specifier.startsWith('@earendil-works/chord'))throw new Error('OPTIONAL_PACKAGE_UNAVAILABLE');return next(specifier,context);}});`,
  );
  const module = pathToFileURL(
    fileURLToPath(new URL("../dist/common/runtime.js", import.meta.url)),
  ).href;
  const bus = pathToFileURL(
    fileURLToPath(new URL("../dist/common/cli.js", import.meta.url)),
  ).href;
  const worker = join(root, "worker.mjs");
  await writeFile(
    worker,
    `import {Host} from ${JSON.stringify(module)};import {localBus} from ${JSON.stringify(bus)};process.env.PI_ECOSYSTEM_STATE_ROOT=process.argv[2];const h=new Host('independent',()=>({capabilities:[],menu:[],command:async()=>({})}),process.cwd(),localBus());await h.start();await h.store.putRecord('runs','one',{status:'active'});if((await h.store.getRecord('runs','one')).status!=='active')throw new Error('missing');await h.close();console.log('PASS');`,
  );
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(hook).href, worker, join(root, "state")],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "",
      err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, out, err }));
  });
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /PASS/);
});
