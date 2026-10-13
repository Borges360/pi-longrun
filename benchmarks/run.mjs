import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { FileStorage, SqliteStorage } from "../dist/common/storage.js";
import { DurableStorage } from "../dist/common/durable.js";
import { completionAllowed } from "../dist/common/gates.js";
import { digest } from "../dist/common/security.js";
const samples = [];
const root = await mkdtemp(join(tmpdir(), "pi-benchmark-"));
try {
  for (const Backend of [FileStorage, SqliteStorage, DurableStorage]) {
    const store = new Backend({
      root: join(root, Backend.name),
      extension: "benchmark",
    });
    await store.open();
    const start = performance.now();
    for (let i = 0; i < 50; i++)
      await store.putRecord("tasks", "task-" + i, {
        status: "pending",
        objective: "Independent oracle fixture " + i,
      });
    const durationMs = performance.now() - start;
    await store.close();
    await store.open();
    const records = await store.listRecords("tasks");
    const recovered = records.length === 50;
    await store.close();
    samples.push({
      backend: Backend.name,
      operations: 50,
      durationMs,
      recovery: recovered,
      logicalHash: digest(records),
    });
  }
  const parity = new Set(samples.map((s) => s.logicalHash)).size === 1;
  const report = {
    schemaVersion: 1,
    suite: "local-storage-conformance",
    piVersion: "1.2.0",
    node: process.versions.node,
    recordedAt: new Date().toISOString(),
    samples,
    parity,
    qualityCostBenchmarks: {
      status: "NOT_RUN",
      reason:
        "Requires independently verified workload results and measured provider usage. No inference-cost claim is made.",
    },
  };
  if (process.argv[2]) {
    const rows = (await readFile(process.argv[2], "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    const arms = new Map();
    for (const row of rows) {
      if (
        row.schemaVersion !== 1 ||
        !row.arm ||
        !row.taskId ||
        !row.datasetVersion ||
        typeof row.costUsd !== "number" ||
        row.costUsd < 0 ||
        !Number.isFinite(row.costUsd) ||
        !Array.isArray(row.requirements) ||
        !Array.isArray(row.gates)
      )
        throw new Error("invalid-benchmark-record");
      const verified = completionAllowed(row.requirements, row.gates);
      if (!arms.has(row.arm)) arms.set(row.arm, []);
      arms.get(row.arm).push({ ...row, verified });
    }
    report.qualityCostBenchmarks = {
      status: "MEASURED_INPUT",
      arms: [...arms.entries()].map(([arm, items]) => {
        const successes = items.filter((x) => x.verified).length,
          cost = items.reduce((n, x) => n + x.costUsd, 0);
        const contexts = items
          .map((x) => x.contextRatio)
          .filter((x) => typeof x === "number" && x >= 0 && x <= 1)
          .sort((a, b) => a - b);
        return {
          arm,
          tasks: items.length,
          verifiedCompletion: successes / items.length,
          totalCostUsd: cost,
          costPerVerifiedRun: successes ? cost / successes : null,
          verifiedCompletionPerDollar: cost ? successes / cost : null,
          contextP95: contexts.length
            ? contexts[Math.ceil(contexts.length * 0.95) - 1]
            : null,
          datasetVersions: [...new Set(items.map((x) => x.datasetVersion))],
        };
      }),
    };
  }
  console.log(JSON.stringify(report, null, 2));
  if (!parity || samples.some((s) => !s.recovery)) process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
