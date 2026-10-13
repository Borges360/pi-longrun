# Security

Pi extensions execute with the user's operating-system privileges. This package
is not an OS sandbox. Use a container or a suitable sandbox for untrusted code.

The default backend never executes commands. Tool-output and event/record text is
redacted before persistence. Secret fields, bearer credentials, common API keys and
private-key blocks are masked; no heuristic can recognize every arbitrary secret.
Do not put secrets in objectives, definitions or artifacts. Binary blobs preserve
exact bytes; callers must sanitize sensitive text before calling writeBlob.

Namespace files use mode 0700/0600 where supported. Windows ACL inheritance follows
the user's profile; POSIX mode bits are not a Windows security boundary. Record IDs
reject traversal and reserved device names. Evidence paths reject traversal and
symlinks. The implementation assumes no hostile local process races filesystem
checks; container isolation is required against such an attacker.

Remote MCP annotations are advisory. Unknown capabilities and tools are denied.
Only local policy can establish trust/read-only behavior. Destructive or open-world
writes need a one-use approval bound to exact arguments and task. No automatic
retry follows an uncertain external effect. Unsupported durable tasks fail closed.

Skill installation requires an explicit source, expected hash, successful static
audit and valid metadata. HTTPS fetches disallow redirects and enforce timeout and
size ceilings. Audits are defense in depth, not a proof that instructions are safe.
Selected content is checked against its audited hash before disclosure.

Children get a fresh agent directory, no parent transcript, no extensions, no MCP,
no project context files, no shell and only explicit scoped filesystem tools.
Environment inheritance is an allowlist. Credentials must be explicitly configured.
Writes are disabled by default and require isolated worktrees. Patches and changed
files are archived before successful cleanup; interrupted write worktrees are kept
for review. Nothing applies or merges child changes into the parent automatically.

Report suspected vulnerabilities privately to the repository owner through GitHub.
Never attach credentials or raw sensitive state to an issue.
