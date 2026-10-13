# Benchmark protocol

`npm run benchmark` measures 50 persistent writes per backend, reopens each store,
checks all records and compares canonical logical hashes. It does not call a model.
The result explicitly records that model quality/cost comparisons have not run.

To analyze independently collected workload data:

```sh
npm run build
node benchmarks/run.mjs results.jsonl
```

Each JSONL record must contain `schemaVersion: 1`, `arm`, `taskId`,
`datasetVersion`, measured `costUsd`, `requirements`, objective `gates`, and
optionally `contextRatio`. Do not insert assistant judgments or estimated costs.
Use a fixed SWE-bench Verified dataset revision and a fixed Terminal-Bench revision.
Record model/provider IDs, prompts, tools, environment image, seeds, task oracle,
start/end timestamps and all input/output/cache/repair/child costs alongside results.

Compare A (strong fixed model), B (economist only), C (longrun), D (objective gate),
E (skills), F (plan), G (MCP), H (subagents) and each S-* standalone arm.
Run every arm against the same tasks and dataset version. Missing or incompatible
arms cannot establish improvement. Do not combine Terminal-Bench versions.

Release targets: verified completion drop <= 5 percentage points, cost reduction

> = 40%, no required-gate bypass, no duplicated unsafe effects, safe recovery 100%,
> context p95 < 0.70, replans <= 2 and child-token share <= 25% by default.
> These are targets, not observed results. This development release makes no GA claim.
