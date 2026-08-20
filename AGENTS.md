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
10. Arrival notifications contain only trusted metadata and never wake the model with peer content.

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
