import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Host } from "../dist/common/runtime.js";
import { localBus } from "../dist/common/cli.js";
const factory = () => ({
  capabilities: [],
  menu: [],
  command: async () => ({}),
});
for (const phase of ["after-seal", "after-pointer"]) {
  test(`migration process death ${phase} preserves every record and recovers the active backend`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-migration-crash-"));
    process.env.PI_ECOSYSTEM_STATE_ROOT = join(root, "state");
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
      delete process.env.PI_ECOSYSTEM_STATE_ROOT;
    });
    const module = pathToFileURL(
      fileURLToPath(new URL("../dist/common/runtime.js", import.meta.url)),
    ).href;
    const busModule = pathToFileURL(
      fileURLToPath(new URL("../dist/common/cli.js", import.meta.url)),
    ).href;
    const worker = join(root, "worker.mjs");
    await writeFile(
      worker,
      `import {Host} from ${JSON.stringify(module)};import {localBus} from ${JSON.stringify(busModule)};const host=new Host('crash-migration',()=>({capabilities:[],menu:[],command:async()=>({})}),process.argv[2],localBus());await host.start();await host.store.putRecord('runs','one',{status:'paused'});host.migrationFault=p=>{if(p===process.argv[3])process.kill(process.pid,'SIGKILL');};await host.migrate('sqlite');`,
    );
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [worker, root, phase], {
        windowsHide: true,
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
    assert.notEqual(result, 0);
    const host = new Host("crash-migration", factory, root, localBus());
    await host.start();
    assert.equal((await host.store.getRecord("runs", "one")).status, "paused");
    await host.store.putRecord("runs", "two", { status: "paused" });
    assert.equal((await host.store.listRecords("runs")).length, 2);
    await host.close();
  });
}
