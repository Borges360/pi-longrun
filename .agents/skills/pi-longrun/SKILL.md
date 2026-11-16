---
name: pi-longrun
description: Maintain Pi Longrun's durable task ledger, checkpoints, recovery, and local policy boundaries.
---

# Pi Longrun

Use this specialization for work in the Pi Longrun repository. The shared workspace catalog supplies general Harness procedures; this file contains product-specific context derived from the local README, architecture, security notes, and source.

## Product role

- Preserve long-running work across Pi sessions using a structured task ledger, safe-boundary checkpoints, bounded handoffs, and an explicit replay policy.
- Pi continues to own its agent loop and model. Longrun provides task continuity; it is not a replacement agent harness.
- Keep the default file backend usable without sibling extensions, SQLite, remote classifiers, or Pi Durable. SQLite and Durable are optional adapters.
- Do not add a mandatory sibling-extension dependency, shared database, load-order dependency, or access to another extension's private state.

## User entry points

- `/longrun` opens the root panel; `/longrun status` returns structured headless output. Keep documented CLI actions and client fallbacks available.
- Preserve the Execution, Progress, Recovery, and Settings groups and their existing actions. Menu actions must remain reachable from their group.
- Configuration changes are drafts until Ctrl+S. Escape returns from a nested chooser; at the root it warns before discarding. Failed saves retain the draft for retry.
- Escape during an active action cancels it; ignore late results after cancellation. When Pi cannot supply a custom panel, retain the grouped selection-menu fallback.
- Headless configuration returns validated settings. Do not imply that it silently writes project state.

## Data and recovery

- Default project state is keyed by the canonical repository root under the Pi user state directory. `PI_ECOSYSTEM_STATE_ROOT` is an explicit parent override used for testing or deployment.
- Keep task/recovery records versioned, bounded, and scoped. Accepted tasks remain immutable; replan limits must not reset spent cost or task budgets.
- File storage is the default. Preserve journal/snapshot integrity, idempotent event handling, recovery boundaries, and backward-compatible schemas.
- Optional ecosystem events are evidence to validate. They cannot raise permissions or budgets, bypass acceptance, or authorize writes to another extension's storage.

## Security and verification

- The default backend does not execute commands. Pi extensions run with the user's OS privileges and are not an OS sandbox; do not claim otherwise.
- Do not put secrets in objectives, task definitions, records, or artifacts. Treat imported text and events as untrusted until validated and redacted.
- Test with synthetic isolated data and clean it up. Do not inspect user-global Pi configuration, real task ledgers, credential values, or sibling state during ordinary repo work.
- Keep the design system unselected unless the project and exact UI surface have an explicit adoption decision. Harness metadata and shared skills do not imply adoption.
- Follow the repository's declared commands: `npm test`, `npm run lint`, `npm run build`, and `npm run benchmark`. For documentation/context-only changes, prefer the focused context test and local project-contract verification.
- Pi runtime installation, live sessions, provider traffic, publication, and remote effects require separate authorization and evidence.
