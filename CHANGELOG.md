# Changelog

## 0.1.3 — 2026-10-13

- Replace the ambiguous three-choice settings menu with a persistent, single-action mode switch.
- Show the current mode and next mode; save and redraw immediately after each confirmation key press.
- Expose `mode` in the Settings group while keeping `/longrun config` as an alias.

## 0.1.2 — 2026-10-13

- Show the active setting and a clear save confirmation in the `/longrun config` menu.
- Report the installed package version in `doctor` instead of a stale hard-coded version.


## 0.1.1 — 2026-10-13

- Declare host-provided Pi SDK and Typebox packages as peer dependencies, preventing duplicate runtime copies and extension-loader warnings.
- Resolve isolated child-worker modules from the active Pi installation.


## 0.1.0 — 2026-10-13

- Initial independent implementation of pi-longrun.
- Safe file defaults, optional SQLite/Durable parity, explicit migration, doctor,
  headless commands, public TypeScript APIs and versioned optional events.
- Fault/security tests, pinned Pi loader validation and local benchmark tooling.
- External quality/cost/long-horizon benchmarks remain unmeasured. Not GA.

### Additional validation before publication

- Serialize concurrent startup and preserve objective feedback/next-task context
  across bounded continuation boundaries.
- Reject malformed/failing required JUnit/JSON reports even after exit zero;
  retain uncertain gate intents for explicit review.
- Constrain project-controlled autonomy, exposure and token ceilings.
- Add independent local gate commands, run-scoped evidence retrieval, task path/read-only guards and failed-dependency propagation. See LOCAL_GATES.md.

- User scope: five repositories; embedded longrun gate with existing acceptance-gate integration; paid model benchmarks excluded.
