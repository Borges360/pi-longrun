# Configuration

Installing starts with safe defaults. `/longrun config` opens a mode wizard in
TUI or displays validated config in headless modes. User settings are stored in
`~/.pi/agent/state/pi-longrun/config.json` (or under PI_ECOSYSTEM_STATE_ROOT).
`schemas/config.schema.json` is the complete machine-readable schema, and
`defaults()` / `validateConfig()` are the public TypeScript implementations.

Precedence: user-command override, trusted project `.pi/pi-longrun.json`, user config,
built-in defaults. Project config is read only after Pi project trust. Project
config cannot change storage, credentialEnv, writeAccess, trust, budgets, retry
limits, delegation ceilings or immutable acceptance/security controls.

| Setting                                       | Default            |
| --------------------------------------------- | ------------------ |
| enabled / mode                                | true / auto        |
| storage.backend                               | files              |
| maxAttempts / maxAutomaticTurns               | 3 / 4              |
| maxOpenTasks / maxInitialTasks / maxReplans   | 20 / 12 / 2        |
| maxDependencyDepth                            | 6                  |
| targetRatio / compactAtRatio / handoffAtRatio | 0.45 / 0.60 / 0.75 |
| maxHandoffTokens / maxEvidenceTokens          | 1200 / 8000        |
| maxActive / minScore / maxSkillTokens         | 3 / 0.55 / 2400    |
| maxParallel / maxDepth / maxChildrenPerTask   | 2 / 1 / 3          |
| writeAccess / credentialEnv                   | false / []         |
| childTimeoutMs / maxChildTokens               | 300000 / 2000      |
| maxServersPerTask / maxDirectTools            | 2 / 12             |
| defaultAccess / requireApproval               | deny / true        |
| assistantClaims / requireEvidence             | false / true       |
| defaultProfile / maxRepairAttempts            | standard / 3       |
| maxCostUsd / maxToolCalls                     | null / 100         |

Common settings are bundled for conformance; each extension uses only settings
within its domain. Schema validation rejects invalid enums, non-finite values,
unknown keys, out-of-range limits and unordered context thresholds. The model has
no configuration tool and cannot raise its own limits or permissions.

Skill roots default to `~/.pi/agent/skills`; agent definitions to
`~/.pi/agent/agents`. Trusted projects may add `.pi/skills` and `.pi/agents`.
Skills use YAML frontmatter name, description, optional keywords, paths, stack and
kind=playbook. Agents use name, description, optional readOnly, paths, provider and
model, with instructions in the Markdown body. Child provider credentials must be
explicitly allowlisted as environment variable names; auth.json is not inherited.

Gate command approval is an exact executable/argument tuple supplied by a user
command. Artifact checks require an expected SHA-256. Human criteria require a
user approval. No assistant claim or raw tool transcript can substitute a gate.
MCP capabilities are authored through `capabilities add <json>`; all candidate
permission and trust fields are explicit local policy. Approval binds tool, server,
task, argument hash and expiry, and is consumed once. MCP `servers add <json>` uses
id, url and optional headerEnv (header -> environment variable name); credentials
are resolved in memory.

Project-owned numeric limits can reduce user/default ceilings, but cannot raise
them. Skill/agent root access remains user-controlled. Disabled user integrations
cannot be re-enabled by a project config.
