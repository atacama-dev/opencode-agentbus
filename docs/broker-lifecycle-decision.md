# Broker lifecycle decision

Status: accepted on 2026-08-21.

## Context

Requiring users to start a separate daemon before OpenCode made installation fragile. Embedding a broker in every plugin instance would couple persistence to one OpenCode process and create duplicate listeners. The broker must remain an independent persistence boundary while being effortless to start.

## Decision

- The plugin lazily authenticates the configured broker during deferred bootstrap and before tool operations in both automatic and manual modes.
- If the endpoint is unused and autostart is enabled, the plugin launches only the installed `@opencode-agentbus/broker` CLI as a detached process.
- The child receives only `PATH`, `HOME`, an optional trusted database path, and explicit Agent Bus host, port, credential, and parsed active-session-limit variables. An inherited manual-CLI limit is not forwarded implicitly.
- Plugin disposal never stops the broker. A later plugin operation re-authenticates and can recover from broker death within the same plugin instance.
- The broker CLI acquires a Linux abstract Unix socket lease keyed by effective UID, IP family, and TCP port before opening credentials or the database.
- Exactly one concurrent process owns the lease. Contenders never touch persistent state and never signal the winner.
- An occupied unknown TCP endpoint is not replaced or killed; startup fails closed.
- An authenticated protocol-v1 broker at the configured listener is treated as an upgrade mismatch, not as reusable readiness, whether autostart is enabled or disabled. The v2 plugin reports fixed operator guidance, keeps model errors generic, and does not probe for takeover, signal, stop, replace, or relaunch over it. Manual mode also performs no TCP startup probe or launch after generic unavailability.
- The trusted plugin option controls only a broker process that plugin autostart launches. Manual CLI startup reads `OPENCODE_AGENTBUS_MAX_ACTIVE_SESSIONS_PER_PRINCIPAL`; both paths default to 4096 and reject values outside 2 through 16384. The daemon derives from the resolved service limit in both modes: `4A + 256` authentication challenges per minute, `ceil(A / 256) + 4` MCP and SSE connections per principal, and twice each transport value globally. Hard ceilings are 65792 challenges, 68 per-principal MCP/SSE connections, and 136 global connections of each type. An authenticated already-running broker keeps its current capacity because the plugin never restarts or reconfigures it.

## CLI exit contract

| Code | Meaning | Plugin disposition |
|---|---|---|
| `0` | Clean exit | No recovery implication |
| `1` | Genuine startup or runtime failure | Fail promptly with safe unavailable status |
| `75` | Another broker startup owns the endpoint lease | Continue bounded authenticated readiness polling without relaunching |

Signal exits and unknown codes are genuine failures. All polling remains bounded by the original startup deadline.

## Persistence consequences

- The broker remains a separately running process and stores committed messages in SQLite/WAL with `synchronous = FULL`.
- Normal exit checkpoints the WAL. `SIGKILL` recovery uses the same database and credential and preserves unexpired committed messages.
- Atomic consume erases the delivered body and prevents replay. Rejected or expired bodies are also erased.

## Rejected alternatives

- **Manual daemon only:** simpler process ownership but poor installation and recovery ergonomics.
- **Broker embedded in the plugin:** duplicate instances and persistence lifetime coupled to OpenCode.
- **Filesystem or SQLite startup lock:** stale-state and multi-process races under concurrent cold start.
- **Kill or replace the current listener:** unsafe because endpoint ownership does not prove broker identity.

## Consequences

The plugin package has a runtime dependency on the broker package. Linux abstract-socket support is now part of the platform requirement. Installed-package execution, concurrent cold start, detached survival, and same-plugin crash recovery are release gates.

Capacity changes are startup configuration, not a live control plane. Operators must manually restart an existing detached broker for a new value to take effect; plugin disposal or configuration reload alone does not change it.

Plugin and broker application protocol versions are upgraded in lockstep. Because the broker is detached and intentionally survives plugin disposal, an operator upgrading from v1 to v2 must stop the old broker manually and then launch the bundled v2 broker or allow plugin autostart to do so. The restarted v2 broker opens the existing database and applies the ordered schema v3→v4→v5 migrations before readiness. Migration 5 validates canonical v4 input and canonical v5 output inside the migration transaction, and every v5 reopen validates the same final table, constraint, foreign-key, uniqueness, and index shape before serving operations.
