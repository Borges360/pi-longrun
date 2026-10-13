# pi-longrun

Durable, evidence-driven work across Pi sessions.

Long tasks survive process loss and context changes through a task ledger, safe-boundary checkpoints, a bounded handoff and explicit replay policy. Pi keeps ownership of its agent loop and model.

## Install

Requires Node >= 22.19 and Pi **1.2.0**. Install this Git repository with Pi:

```sh
pi install git:github.com/Borges360/pi-longrun
```

From a local checkout:

```sh
npm ci
npm test
npm run build
pi -e ./src/extension.ts
node dist/cli.js doctor
```

The source entry point is loadable directly by Pi; npm packages include source and
compiled JavaScript/declarations. No sibling extension, SQLite driver, remote
classifier or Durable installation is required for the default file backend.

## Use

Run `/longrun` for the interactive menu, or `/longrun status` for structured
headless output. Domain actions: `start <goal>, status, tasks, inspect [task], verify, pause, resume, recover, stop, explain, approve-command <json>, approve-human <requirement>, resolve <intent>`. Shared actions: `auto`, `off`,
`observe`, `config`, `doctor`, `storage status`, `storage migrate files|sqlite|durable`.
The CLI uses the same actions: `node dist/cli.js status`.
TUI grouping: Run / Progress / Recovery / Settings. Config opens a small mode wizard in the TUI; headless config
returns validated settings. Edit the user config for advanced settings.

Default state: `~/.pi/agent/state/pi-longrun/projects/<sha256-of-canonical-repository-root>/`.
`PI_ECOSYSTEM_STATE_ROOT` changes the parent state directory for testing or deployment.
No project state is written implicitly.

## Guarantees and validation

Versioned optional events, bounded actions, optimistic record versions, secret
redaction at output boundaries, checksum validation, append-only journal and
fail-closed persistence. The same storage conformance tests run against files,
SQLite and pinned Pi Durable 1.2.0. Fault tests kill a real process after a durable
journal commit, race two processes and reject corrupt snapshots or symlink escapes.

```sh
npm test
npm run lint
npm run benchmark
npm pack --dry-run
```

This is a development release. Local correctness/recovery results do not establish
SWE-bench/Terminal-Bench quality or inference-cost savings. See [benchmarks](benchmarks/README.md)
and [acceptance status](ACCEPTANCE.md) for the limits of the evidence.

[Architecture](ARCHITECTURE.md) · [Configuration](CONFIGURATION.md) ·
[Security](SECURITY.md) · [Migration](MIGRATION.md) · [Compatibility](COMPATIBILITY.md).

[Local objective gates](LOCAL_GATES.md) work with no active longrun.

## Planning revisions and existing acceptance-gate

`longrun_tasks` defines a structured ledger before execution. After work starts,
changing the ledger requires a current, unconsumed material evidence ID from a
failed local verifier. Accepted tasks are immutable and retained automatically;
retired task IDs cannot be reused. Replans are capped at two by default and never
reset spent cost, automatic turns or retained task budgets. `/longrun revise
<tasks.json>` records an explicit user constraint through the same limits. Unsafe
pending effects must be reviewed before replanning.

Optional autoplan events resolve acceptance names against existing structured
verifiers; free-text claims remain unapplied suggestions. Inspect `status` and
`explain` for the current ledger. The existing gate integration is documented in
[LOCAL_GATES.md](LOCAL_GATES.md): `/longrun gate bind TASK-001`, `/gate use TASK-001`,
then `/gate check`. Local verification remains mandatory.
