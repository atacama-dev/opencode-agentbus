# OpenCode Agent Bus — Delivery Rules

## Security invariants

1. Peer-controlled message bodies never enter `session.prompt`, `promptAsync`, `session.synthetic`, permission metadata, notification text, or tool arguments.
2. Message bodies are fetched only after `ToolContext.ask()` resolves.
3. Approved message bodies are returned only as explicitly untrusted tool output.
4. Native `always` approval is scoped to an exact authenticated `(target session, source session)` resource.
5. Permission resources are derived from broker-authenticated opaque IDs and encoded as fixed safe characters; never derive them from titles or model arguments.
6. Session search calls `ToolContext.ask()` before the broker executes the query.
7. The broker searches only its opt-in session registry. It never reads OpenCode transcripts.
8. Raw MCP tools are not exposed directly to the model because OpenCode currently grants them with resource `*`.
9. The broker binds locally, authenticates plugin clients, enforces body size, TTL, rate, ACL, and atomic consume rules, and fails closed.
10. Arrival notifications contain only trusted metadata. An explicitly enabled wake may use only the compile-time fixed Agent Bus drain instruction; peer content and metadata never enter it.
11. Broker autostart may execute only the declared bundled broker CLI with a minimal allowlisted environment; arbitrary configured commands are forbidden.
12. The plugin authenticates before reuse and never signals, stops, replaces, or takes over an occupied listener. Startup contenders must converge through the broker-owned lease.
13. Broker startup and recovery preserve the configured credential and SQLite/WAL database. A lease loser must not open either persistent resource.
14. Receive-approval visibility may navigate only to the trusted permission request's exact session ID and may display only fixed plugin-authored UI text; it never changes or bypasses native permission status.
15. A direct reply accepts the original delivered `messageId`, body, and optional TTL only. The broker, never the model or plugin-local state, verifies recipient ownership and resolves the original authenticated source as the new target.
16. Missing, foreign, or not-addressed reply IDs disclose no message state. Owned non-delivered originals use the distinct non-replyable error without exposing a body.
17. Send and reply receipts are body-free correlation metadata. Their IDs and linkage grant no authority, and a reply always receives a fresh message ID.
18. Reply linkage is retained independently of terminal body erasure and does not use a foreign key that would make child retention depend on the parent row.
19. Application protocol v2 is a lockstep plugin/broker boundary. No registration, event recovery, or message operation may run before a successful v2 handshake.
20. An authenticated detached v1 listener is never reused, signalled, stopped, replaced, or taken over, including when broker autostart is disabled. The plugin reports only fixed operator-authored upgrade guidance and preserves canonical model-safe errors.
21. Send and reply receipts must correlate their body hash and UTF-8 byte count to the submitted body before any receipt is returned to the model.
22. Foreground admission authority comes only from the trusted per-call `ToolContext.sessionID`, `directory`, and `worktree`. Before any broker readiness or access, the plugin must parse the context ID with `HostSessionIdSchema`, query that exact directory, require exactly one matching session ID and exact session directory, parse the projected returned registration with the full strict `ForegroundSessionSchema`, and match the session project to that directory's current project. The context worktree and current-project worktree are independent trusted roots: each must be absolute and safely contain the exact context directory, but they need not be equal when one is broader, including global `/`. Invalid, unsafe, empty, oversized, mismatched, malformed, non-absolute, unrelated, or escaping host identity/path/metadata must fail before authentication, probing, launch, channel creation, admission, or operation. Static plugin input is background/bootstrap scope only; model arguments cannot provide or override any foreground authority field.
23. Saturated admission and operation dependency protection are broker-atomic and never raise the strictly parsed configured active-session ceiling or the protocol-v2 hard maximum of 16384. The minimum is 2 so a source and dependency can be protected together; the default is 4096. Derived durable, reserve, registration, authentication-challenge, and per-principal/global MCP/SSE quotas remain finite, mutually reachable, and overflow-safe. Displacement preserves durable state; background registration and heartbeats cannot steal foreground capacity or update foreground recency.
24. Foreground identity resolution is non-activating. Only the real verified operation transaction may create/admit its source, reclaim a safe state-free background row, execute the operation, and return the authoritative pending snapshot plus principal event high-water captured in that transaction.
25. Every SSE connection requires that authenticated high-water as `Last-Event-ID`, including `0` when no prior event exists. The broker subscribes before replay, the runtime converges replay and any newer snapshot before publishing pending state, and stale cursors recover through a fresh snapshot/high-water; cursorless recovery is forbidden.
26. A principal SSE stream is usable only after it explicitly covers a stable generation of every active local registration. Saved-cursor replay is preferred, stale or absent boundaries fall back to authoritative all-registration snapshots, and registration addition, removal, or displaced foreground re-entry invalidates and retries coverage before publication.
27. The ordered SSE ingestion lane validates and deduplicates authenticated metadata into a bounded shared buffer, then schedules recovery without awaiting it. Only the serialized pending-recovery lane may list, converge, apply cursors/counts, drain covered events, or publish pending/wake state; that lane may await the ingestion barrier, while ingestion must never await recovery.
28. Receive list/peek reconciliation and post-consume authoritative refresh run in the pending-recovery lane. Native approval and atomic consume run only after releasing it. A same-cursor terminal change is ordered by the local pending observation and authenticated current-header snapshot, not cursor equality alone.
29. Inactive local registrations own no replay-buffer or wake/count state. Their events are ignored, active-to-inactive transitions prune only that registration's buffered events, and durable pending headers are recovered authoritatively only after verified foreground re-admission.
30. Pending toasts, session-status queries, fixed wakes, and receive-approval focus must route only through a bounded per-session map populated from trusted tool context or trusted host lifecycle data. Static plugin directory fallback is allowed only for sessions bootstrapped in that exact workspace; model and peer fields cannot select a filesystem route.

## Repository ownership

| Scope | Owner |
|---|---|
| Root workspace config, lockfile, package manifests/configs, and `packages/protocol/**` | Foundation implementer |
| `packages/broker/src/**`, `packages/broker/test/**` | Broker implementer |
| `packages/plugin/src/**`, `packages/plugin/test/**` | Plugin implementer |
| `tests/integration/**` | Integration implementer after plugin and broker stabilize |
| `docs/**`, `AGENTS.md` | Tech lead / architecture governance |

Parallel implementation is allowed only after the shared protocol package and root toolchain exist. Plugin and broker teams must not edit manifests, TypeScript configs, the root lockfile/toolchain, protocol, governance files, or each other's package.

## Required quality gates

- Unit and integration tests
- Type checking
- Lint/format checks
- Build/package checks
- Static test forbidding peer-body delivery through OpenCode prompt/synthetic APIs
- Security review
- Architecture review
- QA acceptance of once/always/reject and search approval flows
- Installed-package end-to-end send, approved delivery, semantic reply, and approved return delivery
- Concurrent cold-start convergence, detached survival, and same-plugin `SIGKILL` recovery
- Direct-reply ACL/state checks, restart persistence, correlation, shared quota enforcement, and concurrent multi-reply safety
- Mixed protocol-version fail-closed behavior and manual detached-broker upgrade recovery

## Knowledge base

- `docs/requirements.md` is the canonical functional and non-functional specification.
- `docs/architecture.md` and `docs/broker-lifecycle-decision.md` record the implemented design.
- `docs/qa.md` records verified behavior and remaining release gates.
