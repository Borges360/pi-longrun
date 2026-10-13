# Objective verification without an active longrun

The `pi-longrun` package includes a local verifier that works without an active run
or any sibling extension. It owns no second agent loop. Use `/longrun gate ...` or
`node dist/cli.js gate ...`. The requested gate is embedded in this package and
integrates with the existing `pi-acceptance-gate`; no sixth extension is required.

Actions: `status`, `discover`, `configure <json>`, `verify`, `profile <name>`,
`explain`, `evidence [id]`, `approve-human <requirement>`, `resolve <intent>`,
`config` and `doctor`. Commands are headless-safe. `discover` reads package scripts
without executing them or approving them.

Example gate-set JSON:

```json
{
  "schemaVersion": 1,
  "id": "artifact-check",
  "objective": "Produce the agreed artifact",
  "requirements": [
    {
      "id": "artifact",
      "kind": "artifact",
      "required": true,
      "path": "output.txt",
      "sha256": "EXPECTED_64_CHARACTER_SHA256"
    }
  ]
}
```

For commands, set `kind: "command"`, `executable` and an explicit `args` array.
Approve that exact executable/argument tuple using `/longrun approve-command
<policy.json>`. The policy may explicitly add `replay: "safe"` for a known safe
check. Unknown replay safety remains `never-automatic` after interruption.

An optional report requires `report: { "format": "junit", "path": "report.xml" }`
or format `json`. A JSON test report contains integer `tests`, `failures`, optional
`errors` and `skipped`. There must be at least one executed non-skipped test, zero
failures and zero errors. Invalid reports, XML entities, failure/error elements,
timeouts and missing reports cannot pass merely because the process exited zero.

Profiles are `none`, `fast`, `standard`, `strict`; locally detected risk always
sets the strict floor. All configured mandatory criteria still require evidence.
Profiles never remove a mandatory requirement. Human approvals are scoped to the
exact gate-set hash and one verification attempt. Repair attempts are capped by
the user configuration. Every check persists hashed evidence and a verdict.

Command intent is committed before execution. Its result and settled intent are
committed together. A crash or timeout of an unclassified command leaves an
unsettled intent, and subsequent checks block for review rather than replaying it.
`gate resolve <intent>` records a user review; no model tool exposes that operation.

Longrun task verification uses the same runner, with separate run/task scopes.
Its continuations explicitly include the next task and feedback. Failed dependencies
block successors, and read-only/path-scoped tasks enforce their scope before tool
intent. `longrun_evidence` retrieves bounded evidence from the current run.

## Existing pi-acceptance-gate 0.3.0

With both extensions loaded, start a run, then use `/longrun gate bind TASK-001`
and `/gate use TASK-001`. `/gate check` uses the existing gate's authorization and
publishes its verification through `suite:event`. The binding is an additional
completion prerequisite; it cannot replace any local required verifier. While the
bound gate is pending, it owns pending-check continuations and longrun does not
create a second repair loop. `/longrun gate integration` explains the binding.
`/longrun gate unbind` is an explicit user action that removes it.

The adapter checks schema, source, canonical project, session, task, timestamp,
contract hash and receipt IDs. Duplicate, foreign, incompatible and stale events
are ignored. Restarting the process/session requires fresh external verification.
Potentially mutating tools invalidate the supplemental receipt. The event bus is
an integration between trusted extensions in one process, not a security sandbox.
The adapter never reads the gate's private store, executes its checkers, or changes
its policy. Without a binding or the other extension, standalone verification is
unchanged. Disable the adapter with `disabledIntegrations: [pi-acceptance-gate]`.
