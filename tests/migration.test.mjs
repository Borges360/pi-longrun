import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host } from "../dist/common/runtime.js";
import { localBus } from "../dist/common/cli.js";
const factory = (host) => ({
  capabilities: ["test.v1"],
  menu: ["status"],
  command: async () => host.store.listRecords("runs"),
});
test("explicit files -> sqlite -> durable -> files migrations preserve records and retain source backups", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-migration-"));
  process.env.PI_ECOSYSTEM_STATE_ROOT = join(root, "state");
  const host = new Host("migration-test", factory, root, localBus());
  await host.start();
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.PI_ECOSYSTEM_STATE_ROOT;
  });
  await host.store.putRecord("runs", "a", {
    status: "paused",
    schemaVersion: 1,
  });
  await host.store.writeBlob("evidence", Buffer.from("intact"));
  const source = host.store.options.root;
  for (const backend of ["sqlite", "durable", "files"]) {
    const result = await host.migrate(backend);
    assert.equal(result.verified, true);
    assert.equal((await host.store.getRecord("runs", "a")).status, "paused");
    assert.equal(
      Buffer.from(await host.store.readBlob("evidence")).toString(),
      "intact",
    );
  }
  assert.ok(
    (await readFile(join(source, "snapshot.json"), "utf8")).includes(
      "migratedTo",
    ),
  );
  await host.close();
  await host.start();
  assert.equal((await host.store.getRecord("runs", "a")).status, "paused");
});
