# Implementation plan

## Evaluation criteria

### Tier 1 — deterministic, blocking

- Tests pass for every package and integration suite.
- Type checking, linting, formatting, and builds pass.
- No peer body reaches `prompt`, `promptAsync`, or `synthetic` APIs.
- Receive permission is requested before body retrieval.
- Search permission is requested before broker search execution.
- `always` applies only to an exact authenticated target/source pair.
- Reject performs zero body fetches.
- Broker consume is atomic and replay-safe.
- Broker rejects unauthenticated clients, oversized messages, expired messages, ACL violations, and rate-limit violations.
- Session search returns only opt-in registry metadata and never transcript data.

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

Status: complete. Seven live integration scenarios exercise the built default plugin, production MCP SDK channel, live broker daemon, SQLite/WAL, SSE recovery, once/always/reject semantics, pair isolation, restart/rotation, concurrent consume, and expiry.

## Final verification

- Unit: 216 passing, one privileged ownership test skipped in non-root execution
- Integration: 7 passing, 102 assertions
- Strict typecheck: root, protocol, broker, plugin, and integration
- Ordered clean-room builds: protocol → broker → plugin
- Lint and format checks: passing
- Dependency audit: no known vulnerabilities
- Static plugin auditor: passing
- Package/CLI smoke: passing
- Unit line coverage: 93.25%
- Independent reviewer: approved
- Independent architect: approved
- QA: approved on actual OpenCode 1.18.19 plus unclean broker crash recovery

The privileged wrong-owner database test remains root-gated and should run in privileged security CI before a public release.

## Ralph quality loop

1. Foundation implementer completes Batch 0 with tests.
2. Tier 1 foundation checks pass.
3. Broker and plugin implementers run in parallel on disjoint scopes.
4. Each team fixes its Tier 1 failures.
5. Reviewer and architect assess the integrated diff using Tier 1 outputs.
6. Integration implementer adds end-to-end tests and owning teams fix defects.
7. QA validates acceptance criteria.
8. Tech lead issues merge/no-merge decision. The user explicitly requested one final commit including these design documents.
