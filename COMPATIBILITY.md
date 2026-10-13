# Compatibility

| Component                           | Declared and tested                            |
| ----------------------------------- | ---------------------------------------------- |
| Pi coding agent                     | @earendil-works/pi-coding-agent 1.2.0          |
| Pi Durable (optional, experimental) | @earendil-works/pi-durable 1.2.0               |
| Node                                | >=22.19; local validation on 24.14.0           |
| TypeBox                             | 1.3.27                                         |
| Files backend                       | Default; no SQLite/Durable runtime import      |
| SQLite                              | node:sqlite; explicit opt-in                   |
| Modes                               | TUI commands and headless RPC/JSON/print logic |

Source and compiled extensions are tested with the published Pi resource loader.
Types compile against the pinned published declarations. Native Pi hooks used:
session_start, session_shutdown, before_agent_start, tool_call, tool_result,
message_end and agent_before_settle. Optional MCP registration requires Pi's native
MCP facility. The local gate does not require another extension. There is no claim
of compatibility with older Pi API versions or experimental Durable upgrades.

CI runs Windows and Linux with Node 22 and 24. A green CI run, not this declaration
alone, establishes results for those platforms. The development host is Windows.

Primary API references:
https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
https://github.com/earendil-works/pi/blob/main/packages/durable/README.md
https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md

Optional legacy bridge: pi-acceptance-gate 0.3.0, suite:event schema 1. Its current real extension is exercised by the ecosystem acceptance integration harness.
