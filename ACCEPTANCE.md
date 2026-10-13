# Acceptance evidence and remaining work

Implemented and covered: independent startup, no sibling runtime imports, safe
defaults, versioned optional events, local failure isolation, file/SQLite/Durable
storage contracts, record CAS, ordered event deduplication, evidence hashing,
explicit migrations, native Pi source/dist loading, headless command discovery,
real process-kill recovery, two-process writer contention, corruption detection,
path traversal/symlink rejection and bounded child timeout.

Domain tests cover objective completion and attempt ceilings (longrun), skill
matching/audit/provenance (autoskills), mode boundaries/DAG/replan ceilings (autoplan),
isolation/recursion/dispatch ceilings (subagents), and capability/default-deny/
argument-scoped approvals (MCP). The ecosystem integration runner tests all five,
each removal and single-owner dispatch. See the generated validation report for
actual command outputs and counts, rather than interpreting this checklist as a
new test run.

Scope resolved by the user on 2026-10-13:

- The gate is embedded in pi-longrun and integrated with pi-acceptance-gate 0.3.0
  through public events and an explicit task binding. A sixth repository is not
  part of the delivery.
- Local Git is authorized for feature → develop → release → main, including push.
- Paid strong-model, SWE-bench and Terminal-Bench comparisons are excluded from
  this delivery. No quality/cost savings or GA benchmark SLO is claimed. The local
  storage/parity benchmark remains reproducible without provider credentials.

Limitations: file journals retain complete record snapshots with external hashed blobs;
record-history retention is still needed for very large ledgers. Migration corruption retains source backups for review. Context threshold handoffs
use a bounded compaction entry; /longrun resume --fresh creates a fresh Pi session.
The optional MCP durable-task interface needs a host-supplied task transport adapter.
No paid classifier or learned model router is implemented; compatible external
assessments are optional and deterministic rules remain operational.
