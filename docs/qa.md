# QA evidence

## Result

Approved for commit on 2026-08-20.

## Automated gates

- 216 unit tests passed; one wrong-owner database test was skipped because execution was non-root.
- 7 live integration scenarios passed using the built plugin, production MCP SDK channel, live broker, SQLite/WAL, and SSE.
- Strict typecheck, dependency-ordered builds, lint, format, package smoke, dependency audit, and static plugin audit passed.
- A source-only clean-room checkout passed frozen install and the full deterministic gate.

## Actual OpenCode 1.18.19

QA used the official `opencode-ai@1.18.19` package, the built Agent Bus plugin and broker, isolated state, auto-approval disabled, and a deterministic local provider with no external credentials.

Validated:

- plugin startup no longer blocks OpenCode project/session initialization;
- only `agentbus_send`, `agentbus_receive`, and `agentbus_search_sessions` are exposed;
- search asks through the native permission service and provides no broad `always` pattern;
- receive `once` asks again for the next A→B message;
- receive `always` allows later A→B messages only;
- saved A→B approval does not authorize C→B or A→C;
- reject and cancellation disclose no body and leave messages pending;
- peer bodies appear only in `trust: "untrusted"` tool results, never as user/synthetic messages;
- permission metadata contains only opaque IDs, fingerprints, hashes, and byte counts;
- no peer body appeared in captured OpenCode events, errors, logs, or non-tool history;
- no automatic target-model turn occurred before explicit receive.

Persistence of `always` approvals across an OpenCode restart is not claimed.

## Unclean broker termination

QA ran the built broker as a separate process, committed a pending adversarial message through the production plugin/MCP path, sent `SIGKILL`, and restarted with the same endpoint, database, and credential.

Validated:

- stable broker identity;
- nonce/HMAC listener challenge and plugin reconnect/re-registration;
- pending-message recovery and exactly-once consumption;
- SQLite `integrity_check = ok` and WAL journal mode;
- body-free receipts, notifications, logs, errors, and permission metadata;
- delivered content remained explicitly untrusted.

## Remaining release gate

Run the root-only wrong-owner database-file test in privileged security CI before public release.
