# Architecture

Long tasks survive process loss and context changes through a task ledger, safe-boundary checkpoints, a bounded handoff and explicit replay policy. Pi keeps ownership of its agent loop and model.

`src/extension.ts` registers Pi commands, tools and lifecycle handlers.
`src/cli.ts` provides a noninteractive entry point. Domain code is exported from
`src/index.ts`; compiled declarations describe the public API: LongrunTask, RunRecord, CheckpointRecord, SideEffectPolicy, Longrun, transition, canCompleteRun, validateTasks.
`src/common/` bundles this release's storage, configuration, security and event
contracts. These are local copies with no runtime imports from sibling packages.
Each package owns exactly one state namespace. No shared database or load order is
required. Optional integrations operate exclusively over versioned public events.

## Event contract

Every event contains schemaVersion=1, eventId, eventType, source, correlationId,
emittedAt and payload, optionally taskId, runId and projectKey. Unknown versions,
duplicate IDs, older timestamps and other-project events are ignored. Listener
failures are counted and isolated. Discovery is bidirectional, so later extensions
can discover earlier ones. Provider advertisements expire after 60 seconds and can
be refreshed by a discovery request. Sources are extensible strings.

Channels: pi.ecosystem.capability.v1, pi.ecosystem.discover.v1,
pi.task.started.v1, pi.assessment.available.v1, pi.skills.selected.v1,
pi.plan.updated.v1, pi.gate.result.v1, pi.mcp.selection.v1,
pi.subagent.request.v1, pi.subagent.claim.v1, pi.subagent.decision.v1,
pi.subagent.result.v1. These are ecosystem events, not native Pi lifecycle events.
Sibling data is evidence to validate; it has no authority to raise permission or
budgets, bypass an acceptance check or write another extension's storage.

## Storage

StorageBase exposes metadata, versioned CRUD, ordered idempotent events, immutable
binary blobs, owner-scoped leases, checkpoints, recovery and portable snapshots.
FileStorage uses an exclusive process lock, same-directory temporary writes,
fsync and atomic replacement. The hash-chained JSONL journal is committed before
the materialized snapshot. Committed journal tails recover after a process crash.
A truncated final JSONL fragment is quarantined only after validating its entire
prefix; corrupt authoritative snapshots are rejected and preserved for review.
Live and foreign process locks cannot be stolen on TTL alone.

SQLite is opt-in and uses node:sqlite, WAL, transactions and a five-second busy
timeout. Durable is an opt-in experimental adapter using Pi Durable's typed
document/session commit API, not a second agent harness. All logical backends
preserve record versions, events, blob hashes, leases and checkpoints.
File snapshots and journals reference immutable hashed blob files, so large evidence
is stored once. Portable exports embed base64 for backend parity. Very large record
ledgers still need explicit history retention and archival management.
Network filesystems and distributed mutation are outside this release's contract.
