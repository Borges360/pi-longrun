import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host } from "../dist/common/runtime.js";
import { localBus } from "../dist/common/cli.js";
import { envelope } from "../dist/common/contracts.js";
import { FileStorage } from "../dist/common/storage.js";
test("absent, throwing, incompatible or corrupt peers cannot break standalone work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-interop-"));
  process.env.PI_ECOSYSTEM_STATE_ROOT = join(root, "state");
  const bus = localBus();
  const host = new Host(
    "isolated-extension",
    (h) => ({
      capabilities: ["own.v1"],
      menu: ["status"],
      command: async () => ({ ok: true }),
    }),
    root,
    bus,
  );
  await host.start();
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.PI_ECOSYSTEM_STATE_ROOT;
  });
  await mkdir(join(root, "state", "broken-peer"), { recursive: true });
  await writeFile(
    join(root, "state", "broken-peer", "snapshot.json"),
    "corrupt",
  );
  bus.emit("pi.assessment.available.v1", {
    ...envelope("broken-peer", "pi.assessment.available.v1", {}),
    schemaVersion: 999,
  });
  bus.on("peer-failure.v1", () => {
    throw new Error("peer-down");
  });
  assert.doesNotThrow(() => host.interop.emit("peer-failure.v1", {}));
  assert.deepEqual(
    await host.command("status", [], { cwd: root, trusted: false }),
    { ok: true },
  );
  await host.store.putRecord("runs", "one", { status: "active" });
  assert.equal((await host.store.getRecord("runs", "one")).status, "active");
});
