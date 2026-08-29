# Implementation plan

## Evaluation criteria

### Tier 1 — deterministic, blocking

- Tests pass for every package and integration suite.
- Type checking, linting, formatting, and builds pass.
- No peer body reaches `prompt`, `promptAsync`, or `synthetic` APIs.
- The sole allowed `promptAsync` call has the AST-enforced fixed wake shape and exact host-session route; no peer body or metadata reaches it.
- Receive permission is requested before body retrieval.
- Search permission is requested before broker search execution.
- `always` applies only to an exact authenticated target/source pair.
- Reject performs zero body fetches.
- Broker consume is atomic and replay-safe.
- Broker rejects unauthenticated clients, oversized messages, expired messages, ACL violations, and rate-limit violations.
- Session search returns only opt-in registry metadata and never transcript data.
- Broker autostart authenticates before reuse, launches only the bundled CLI, and never replaces an occupied listener.
- Concurrent starts converge on one authenticated daemon; lease losers do not open credentials or SQLite.
- Same-plugin crash recovery preserves the credential, WAL-backed pending messages, and exactly-once consume behavior.
- Duplicate wake hints coalesce, busy sessions defer until idle, prompt failures retry within a bound, receive state latches until empty, and disposal cancels wake work.
- Receive approval focus uses only the trusted requesting session ID, fixed UI text, and leaves permission output unchanged.
- Direct reply routing is broker-authoritative, targetless at the model surface, recipient-bound, restricted to retained delivered originals, and body-blind during lookup.
- Reply persistence, optional correlation metadata, restart behavior, shared quotas, and concurrent multi-reply behavior pass deterministic coverage without weakening ordinary-message schemas.
- Protocol v2 rejects mixed-version handshakes before registration or delivery; automatic and manual modes classify an authenticated detached v1 listener without a bearer credential, reuse, TCP startup probe, launch, or replacement.
- Saturated foreground admission is ToolContext-derived, host-verified, broker-atomic, deterministic, dependency-protecting, and bounded to the configured per-principal active-session limit across independent plugin clients.
- Active-session capacity defaults to 4096, accepts only integers from 2 through the protocol-v2 hard maximum of 16384, derives coherent finite durable/reserve/registration/transport quotas with overflow-safe arithmetic, and is absent from all model tool schemas and outputs.
- Plugin autostart passes only the strict trusted option's parsed capacity in the minimal child environment; manual CLI startup parses the dedicated environment variable independently, and neither path reconfigures an already-running detached broker.
- Every foreground host validation parses the context ID and returned registration through protocol schemas before broker readiness or connection work, and the runtime consumes that strict correlated registration without a second host query.
- Pending toast, status, fixed wake, and receive-approval focus calls use a bounded trusted route for the exact attached-workspace session.

### Tier 2 — advisory but weighted

- Reviewer: correctness, authorization, prompt injection, race, replay, leakage, and supply-chain risk.
- Architect: package boundaries, protocol stability, maintainability, and OpenCode compatibility.

### QA acceptance

- First message from A to B displays native approval.
- `once` permits one message and asks again for the next.
- `always` permits future A-to-B messages without allowing C-to-B or A-to-other-target messages.
- `reject` reveals no body to the receiving model.
- Message content appears only as a tool result.
- Search executes only after native approval.
- Arrival notification contains no peer-controlled body.
- Enabled wake reaches only the recipient with the exact fixed drain instruction and still requires the real receive tool and native approval.
- Background receive approval selects the exact requesting session and shows fixed warning text without auto-approval.
- Default autostart, manual disabled mode, detached survival, concurrent cold start, and same-plugin `SIGKILL` recovery pass in isolated state.
- A delivered message can be answered by ID without session search or a model-supplied target; the resulting receipt and delivery identify both the fresh message and original correlation ID.
- Foreign, not-addressed, missing, non-delivered, expired, and purged reply parents fail with the specified non-disclosing error classes.
- Two sessions attached to one real server but different workspaces receive only their own pending toast, status, fixed wake, and approval-focus effects.

## Batch 0 — shared foundation (sequential)

Owner writes only root toolchain files and `packages/protocol/**`.

Deliverables:

- Bun/TypeScript workspace and deterministic scripts
- Shared schemas and error model
- Canonical fingerprint/resource functions
- Message/session/search protocol types
- Security-focused protocol tests

This batch must pass Tier 1 before parallel work starts.

Status: complete. Foundation reviewer and architect approved Batch 1 after 56 tests, package smoke validation, dependency/static audits, and full deterministic checks passed.

## Batch 1 — parallel implementation

### Team A: broker

Write scope: `packages/broker/src/**`, `packages/broker/test/**`

Deliverables:

- Local authenticated daemon/MCP service
- Opt-in registry
- Pending mailbox persistence
- Peek and atomic consume
- Search execution
- TTL, size, ACL, rate, and replay controls
- Broker unit tests

### Team B: plugin

Write scope: `packages/plugin/src/**`, `packages/plugin/test/**`

Deliverables:

- OpenCode custom tools
- Authenticated session registration
- Sender/target resource construction
- Native `ToolContext.ask()` flows
- Metadata-only notifications
- Structured untrusted tool results
- Plugin unit tests with mocked broker and permission context

The two teams consume the built `packages/protocol` package without editing it. Package manifests/configs and the root lock/toolchain are frozen; no new dependencies are allowed during Batch 1.

Status: complete. Broker and plugin teams passed deterministic checks and resolved all reviewer/architect findings, including listener authentication, secure persistence, connection/resource bounds, deferred OpenCode bootstrap, and exact permission ordering.

## Batch 2 — integration (sequential)

Write scope: `tests/integration/**` plus narrowly approved fixes returned to owning teams.

Deliverables:

- End-to-end sender-to-receiver flow
- Once/always/reject cases
- Sender and target isolation
- Search approval ordering
- Body non-disclosure assertions
- Crash/restart, expiry, replay, and concurrent-consume cases

Status: complete. Core live integration scenarios exercise the built default plugin, production MCP SDK channel, live broker daemon, SQLite/WAL, SSE recovery, once/always/reject semantics, pair isolation, direct reply across restart, genuinely overlapping replies from five independent plugin clients, shared quotas, credential rotation, concurrent consume, expiry, and more than 256 sessions across independently instantiated workspaces. Additional integration scenarios cover broker autostart, v1-listener upgrade handling, bundled ordered migration through v5, and recovery.

## Batch 3 — plugin-managed broker lifecycle

Deliverables:

- Deferred authenticate-first broker autostart with manual opt-out
- Bundled installed-package CLI resolution and detached launch
- Minimal child environment and fail-closed unknown-listener behavior
- Linux abstract-socket process lease acquired before persistent state
- Stable lease-contention exit contract and bounded winner readiness polling
- Same-plugin crash relaunch with SQLite/WAL message recovery
- Concurrent cold-start, installed-package execution, and lifecycle tests

Status: complete. Reviewer and architect approved after same-plugin readiness recovery, installed-package execution, child-environment isolation, process-lease convergence, and lease-loser polling defects were resolved. QA approved all lifecycle acceptance criteria.

## Direct-reply increment

Deliverables:

- Lockstep protocol-v2 `agentbus.message.reply` method and strict correlation schemas
- Mixed v1/v2 handshake rejection plus fixed manual detached-broker restart guidance
- Broker-authoritative lookup, recipient ACL, delivered-state gate, and original-source routing
- SQLite schema v4 nullable linkage migration without a parent foreign key
- Shared send/reply persistence, TTL, rate, pending, durable quota, and metadata-event path
- Exactly four model tools with targetless `agentbus_reply`
- Body-free send/reply correlation receipts and optional reply linkage on pending/delivered output
- Unit, hardened migration, live-client concurrency, restart, built integration, and installed-package end-to-end coverage

Status: implemented. Final deterministic gate evidence is recorded below.

## Bounded foreground-admission increment

Deliverables:

- Trusted per-call resolution from `ToolContext.sessionID`, `directory`, and `worktree`, with exact-directory session/project queries and server-root/attached-workspace coverage
- Pre-broker `HostSessionIdSchema`/`ForegroundSessionSchema` validation, independent safe containment for the trusted context/project worktrees without false global-root equality, one-query success flow, zero auth/probe/launch/channel/runtime work for invalid or malformed host identity, and strict prevalidated runtime correlation
- Bounded exact-session route storage with lifecycle refresh/removal and per-workspace toast/status/wake/focus routing
- Internal non-activating foreground-identity resolution with no model-controlled source selector or standalone displacement
- Broker-atomic row creation, source admission, deterministic background/LRU displacement, send/reply dependency protection, operation execution, and pending-state snapshot
- Persistent displacement and foreground-recency state in ordered SQLite schema v5
- Stable identity, pending-body, event, TTL, reply-linkage, and restart preservation
- Background registration/heartbeat deferral plus durable foreground reservation and safe state-free reclamation, without slot stealing or reconnect storms
- Canonical v4 input and v5 output/reopen validation with malformed-schema rollback coverage
- Unit and built integration coverage for more than 256 sessions, durable-row saturation, concurrent independent plugin workspaces, wrong-context rejection, authoritative recovery, re-entry, and strict active-count bounds
- Simulated OpenCode host coverage for a server-root plugin serving attached-workspace tools and independent per-session UI/wake routes; the real-server gate remains manual and opt-in

Status: implemented and included in the final deterministic gates below.

## Configurable active-session-capacity increment

Deliverables:

- Protocol constants for functional minimum 2, default 4096, and hard maximum 16384, with strict trusted connection parsing and bounded protocol-v2 event bindings
- Broker defaults derived from the configured active limit: 4× durable rows per principal, 16× global durable rows, an equal foreground reserve, and `max(256, active limit)` registration accounting
- Finite hard maxima of 65536 durable rows per principal, 262144 globally, 16384 foreground reserve, and 16384 registrations per principal per minute, enforced with safe-integer and checked-multiplication validation
- Strict manual CLI parsing of `OPENCODE_AGENTBUS_MAX_ACTIVE_SESSIONS_PER_PRINCIPAL`, with no whitespace, sign, leading zero, non-integer, or out-of-range forms
- Trusted plugin option propagation through the exact minimal child environment without inheriting an arbitrary manual-CLI value or exposing the setting to model tools
- Unit coverage for default/minimum/maximum/invalid configuration, derived quotas, hard maxima, and 300 active sessions without premature registration or durable-quota displacement
- Built integration coverage for 300 sessions aggregated across two workspaces and for deterministic saturation/displacement at a configured limit of 8
- Installed-package smoke coverage for exact capacity propagation and child-environment secret exclusion
- Authentication challenge capacity `4A + 256`, bounded at 65792 per minute, covering cold registration, one heartbeat per active session per minute, recovery/normal operations, reconnect bursts, and fixed workspace-startup headroom
- Per-principal MCP/SSE capacity `ceil(A / 256) + 4`, with separate global ceilings at twice that value and hard maxima of 68 and 136
- Configured-limit-2 built end-to-end search/send/receive/reply coverage with deterministic background displacement and an invariant active count of 2
- Actual nine-workspace built MCP/SSE integration coverage above the historical eight-stream ceiling, plus policy boundary and hard-maximum topology tests
- Ordinary-CI store stress coverage that registers all 4096 default active sessions without displacement or quota exhaustion
- Operator and architecture documentation distinguishing the 256-session per-workspace bootstrap/route bound from aggregate broker capacity and requiring manual restart for a detached broker to adopt a changed value

Status: implemented; final deterministic gate evidence is recorded below.

## Final verification

- Unit: 467 passing, 2,217 assertions, one privileged ownership test skipped in non-root execution
- Integration: 27 passing, 260 assertions
- Strict typecheck: root, protocol, broker, plugin, and integration
- Ordered clean-room builds: protocol → broker → plugin
- Lint and format checks: passing
- Dependency audit: no known vulnerabilities
- Static plugin auditor: passing
- Package/CLI smoke: passing
- Unit coverage: 92.79% lines, 87.78% functions
- Follow-up reviewer and architect findings addressed; subsequent independent sign-off is not recorded here.
- QA: approved on actual OpenCode 1.18.19 plus detached autostart, concurrent cold start, installed-package execution, and same-plugin unclean broker recovery; installed OpenCode 1.18.23 sparse session-status compatibility is covered by regression tests

The privileged wrong-owner database test remains root-gated and should run in privileged security CI before a public release.

The wake/approval-visibility increment adds unit and built integration coverage, including simulated server-root/attached-workspace routing. Interactive wake, receive approval, and TUI focus behavior on the installed OpenCode 1.18.23 `opencode-server` remains an opt-in manual QA gate; the automated host verifies status compatibility, exact legacy publish events, warning payloads, and directory isolation but does not run or render a real OpenCode server/client UI.

## Ralph quality loop

1. Foundation implementer completes Batch 0 with tests.
2. Tier 1 foundation checks pass.
3. Broker and plugin implementers run in parallel on disjoint scopes.
4. Each team fixes its Tier 1 failures.
5. Reviewer and architect assess the integrated diff using Tier 1 outputs.
6. Integration implementer adds end-to-end tests and owning teams fix defects.
7. QA validates acceptance criteria.
8. Tech lead issues the merge/no-merge decision and aligns the knowledge base with accepted behavior.
