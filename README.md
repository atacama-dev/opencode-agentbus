# OpenCode Agent Bus

<p align="center">
  <img src="assets/icon.svg" width="192" height="192" alt="Agent Bus: three connected AI agents in a mint-green bus" />
</p>

Secure, local inter-session messaging for OpenCode. V1 is released; this source line prepares an experimental stock OpenCode V2 adapter alongside the legacy development entries.

The system combines:

- an OpenCode plugin that owns session identity, permission prompts, notifications, and model-facing tools;
- a local MCP-capable broker that stores pending messages and an opt-in session directory;
- sender-scoped native OpenCode approvals for message receipt;
- tool-result delivery so peer content is never inserted as a user message.

V1 evidence: historical end-to-end QA on Linux with Bun 1.3.9 and OpenCode 1.18.19, built integration tests using a simulated host API, and sparse session-status compatibility observed on OpenCode 1.18.23. These are not native stock V2 acceptance results; the detailed evidence and remaining gates are recorded in [QA evidence](docs/qa.md).

V1 `0.1.0` was released from the protected V1 tag and remains on `maintenance/opencode-v1`. See the [release history](docs/releasing.md); its historical evidence is separate from the V2 experiment below.

Design decision (2026-11-12, partially implemented): [project association is discovery metadata, not message authorization](docs/session-identity-decision.md). The required behavior is that moving a session does not revoke its mailbox or exact target/source approvals, and the V2 port preserves automatic fixed wakes when enabled. The public experiment delivers across project moves, but native cross-project `always` still prompts again. The legacy placement checks and QA claims below do not establish the revised design.

The V2 entries remain experimental: the default V2 server requires our paired host, while the explicit `stock-experimental` entry uses public OpenCode 2.2.7 APIs. Neither is a supported stock release. The V2 archive selects the public stock experiment, not the paired adapter. See [V2 compatibility and remaining limits](docs/v2-port.md) and the [isolated native test procedure](docs/manual-v2-qa.md). The maintainer has authorized V2 `0.1.0` publication following reported manual functional acceptance; see the [release decision](docs/qa.md#initial-v2-010-release-decision). [Release automation](docs/releasing.md) still requires tagged-source and artifact checks. Dependency findings remain visible under an [expiring risk-acceptance policy](docs/dependency-exceptions.md), not a clean-audit claim.

## Security model

- Peer bodies remain in the broker until the receiving session passes native OpenCode approval.
- `once` approves one receive; `always` is scoped to the exact authenticated target/source pair.
- Search requires separate native approval for each canonical query.
- A semantic reply names the delivered message being answered; the broker verifies recipient ownership and resolves the original source without a model-supplied target.
- Received content is returned as `trust: "untrusted"` tool output, never injected as a user or synthetic message.
- Arrival notifications contain only a fixed pending count and do not themselves wake the model. A separate fixed wake is available only when explicitly enabled.
- Raw broker MCP methods are internal to the plugin and are not exposed as model tools.
- The stock V2 adapter derives foreground authority from the authentic native tool invocation and an exact same-host session lookup before broker operations. Project association is discovery/routing metadata, not mailbox authority. V1 and paired-host development entries retain separate legacy placement checks.
- Notifications and fixed wakes target the exact trusted host session ID; legacy APIs requiring a directory use bounded trusted routes, never peer/model-selected workspaces. Receive-approval focus is not implemented by the stock V2 experiment.

Receipt approval authorizes disclosure only. It does not authorize instructions contained in a peer message.

## Model-facing tools and correlation

The plugin exposes exactly four Agent Bus tools:

- `agentbus_send({ target, body, ttlSeconds? })`
- `agentbus_receive()`
- `agentbus_search_sessions({ query })`
- `agentbus_reply({ messageId, body, ttlSeconds? })`

A successful send returns a body-free receipt with the newly allocated `messageId`. Retain that ID when later correlation matters.

After `agentbus_receive` returns a delivered `peer_message`, pass that message's `messageId` to `agentbus_reply`. Do not search for a session or copy `source.sessionId` into a reply target: the broker requires the caller to be the original recipient and routes the new message to the original authenticated source. The reply receipt contains a fresh `messageId` and `replyToMessageId` equal to the delivered message being answered. Both fields are correlation metadata only and grant no authority.

When the reply is delivered, its pending header and `peer_message` include the optional `replyToMessageId`. Ordinary sends and receives omit that field. Reply bodies have the same UTF-8 size, TTL, rate, pending, and durable-storage limits as ordinary sends.

## Build

Machine-specific paths and service recipes belong in the git-ignored `.local/` directory, not in shared documentation. See the [manual attached-client QA procedure](docs/manual-qa.md) for a portable checklist.

```bash
bun install --frozen-lockfile
bun run build
```

## Broker startup

The defaults in this section describe the legacy development entry. The stock V2 experiment requires explicit, independent endpoint, credential, database and namespace settings; see the [isolated V2 procedure](docs/manual-v2-qa.md). Do not implicitly reuse a V1 deployment.

The plugin starts the bundled broker automatically by default. No separate daemon command is required. It reuses an authenticated running broker and never replaces an occupied unknown listener.

For explicit manual operation, disable autostart in plugin configuration and run:

```bash
bun run broker:start
```

Defaults:

| Setting | Default |
|---|---|
| Endpoint | `http://127.0.0.1:4097` |
| Database | `~/.local/state/opencode-agentbus/broker.sqlite` |
| Credential | `~/.config/opencode-agentbus/credential.json` |
| Active sessions per principal | `4096` |

Optional broker environment variables:

- `OPENCODE_AGENTBUS_HOST` — literal `127.0.0.1` or `::1`
- `OPENCODE_AGENTBUS_PORT`
- `OPENCODE_AGENTBUS_DB_PATH` — absolute path
- `OPENCODE_AGENTBUS_CREDENTIAL_FILE` — absolute path
- `OPENCODE_AGENTBUS_MAX_ACTIVE_SESSIONS_PER_PRINCIPAL` — canonical integer from 2 through 16384; default 4096

The broker creates the database and 256-bit credential using owner-only permissions. It runs as a detached user process and survives plugin disposal or termination of the OpenCode process that launched it. The environment capacity setting is the manual CLI contract. A broker already running keeps the capacity selected when it started; changing this value requires the operator to restart that detached broker manually.

### Protocol-v2 upgrade

The plugin and broker are a lockstep protocol-v2 deployment. Version 2 is intentionally incompatible with version 1 because strict v1 envelopes cannot safely accept the reply method and linkage fields.

If a detached v1 broker is still listening after the plugin is upgraded, the v2 plugin authenticates only enough to identify the version mismatch, does not disclose its bearer token, and does not reuse, signal, kill, replace, or take over that listener. This detection and fixed OpenCode operator toast apply with either automatic or manual broker management; model-facing tools continue to return only the canonical unavailable error. Manual mode never performs the TCP startup probe or launches a process after an unavailable authentication attempt.

Stop the old user-owned broker manually, then start the bundled v2 broker (or restart OpenCode and let autostart launch it). Upgrade the plugin and broker packages together. On startup, the bundled v2 broker performs the ordered schema v3→v4→v5 migrations while preserving retained messages. A v3 database that already contains `reply_to_message_id`, or a noncanonical v4/v5 sessions schema, fails closed without advancing the schema version; back up persistent state before any manual operational migration.

## Configure OpenCode

This example configures the **legacy V1 development entry**, not the stock V2 archive. For V2, follow the [isolated stock procedure](docs/manual-v2-qa.md) and its compatibility requirements.

Use the absolute built plugin path and credential path:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///absolute/path/to/opencode-agentbus/packages/plugin/dist/index.js",
      {
        "endpoint": "http://127.0.0.1:4097",
        "credentialFilePath": "/home/user/.config/opencode-agentbus/credential.json",
        "timeoutMs": 5000,
        "autoStartBroker": true,
        "brokerStartupTimeoutMs": 5000,
        "maxActiveSessionsPerPrincipal": 4096,
        "wakeOnMessage": true,
        "focusOnReceiveApproval": true
      }
    ]
  ],
  "permission": {
    "agentbus_receive": "ask",
    "agentbus_search_sessions": "ask"
  }
}
```

Alternatively, provide trusted plugin configuration through:

- `OPENCODE_AGENTBUS_ENDPOINT`
- `OPENCODE_AGENTBUS_CREDENTIAL_FILE`
- `OPENCODE_AGENTBUS_TIMEOUT_MS`
- `OPENCODE_AGENTBUS_AUTO_START_BROKER` — `true` by default; set `false` for manual operation
- `OPENCODE_AGENTBUS_BROKER_STARTUP_TIMEOUT_MS` — 100 through 30000; default 5000
- `OPENCODE_AGENTBUS_WAKE_ON_MESSAGE` — fixed trusted recipient wake; `false` by default
- `OPENCODE_AGENTBUS_FOCUS_ON_RECEIVE_APPROVAL` — focus the exact requesting session and show a fixed warning toast; `false` by default

`maxActiveSessionsPerPrincipal` is a trusted plugin option, not a model tool argument or plugin-environment override. It accepts only an integer from 2 through 16384 and defaults to 4096. Two is the functional minimum because a two-party search/send/reply operation must protect both its foreground source and dependency. Autostart passes that exact parsed value to the bundled broker through its minimal child environment; an arbitrary inherited `OPENCODE_AGENTBUS_MAX_ACTIVE_SESSIONS_PER_PRINCIPAL` is ignored. If the plugin authenticates an already-running detached broker, it does not replace or restart it, so the existing process keeps its prior capacity until a manual restart.

The broker derives all session-related and transport capacity from the same parsed active limit `A`, whether it was started manually or by plugin autostart:

| Limit | Formula | Default (`A = 4096`) | Hard maximum (`A = 16384`) |
|---|---:|---:|---:|
| Durable sessions per principal | `4 × A` | 16384 | 65536 |
| Durable sessions globally | `16 × A` | 65536 | 262144 |
| Foreground durable reserve | `A` | 4096 | 16384 |
| Registrations per principal/minute | `max(256, A)` | 4096 | 16384 |
| Authentication challenges/minute | `4 × A + 256` | 16640 | 65792 |
| Expected densely populated workspace topology `W` | `ceil(A / 256)` | 16 | 64 |
| MCP sessions per principal | `ceil(A / 256) + 4` | 20 | 68 |
| SSE streams per principal | `ceil(A / 256) + 4` | 20 | 68 |
| MCP or SSE global ceiling, each | `2 × (ceil(A / 256) + 4)` | 40 | 136 |

Every authenticated MCP request, including each session heartbeat, performs a fresh challenge. With the default 120-second lease, an active session schedules one heartbeat per minute. The challenge formula reserves one active-sized share each for cold registration, steady heartbeat, normal operation/recovery, and reconnect/burst work, plus one 256-request workspace-startup headroom. The challenge endpoint remains locally bound and rate-limited.

Active-session capacity and concurrent workspace-runtime transport capacity are separate finite bounds. `W = ceil(A / 256)` is the expected topology when workspace runtimes are densely populated with their maximum 256 sessions, not a promise that `A` one-session workspaces can connect concurrently. At the default, 16 expected dense workspace runtimes plus 4 reconnect/overlap slots permit exactly 20 concurrent MCP sessions and 20 concurrent SSE streams per principal; each transport has its own independent global ceiling of 40. Sparse one-session workspaces can therefore reach the 20-runtime transport ceiling well before reaching 4096 active sessions. At the active hard maximum the corresponding transport ceilings remain 68 per principal and 136 globally for each transport.

Restart OpenCode after changing plugin configuration. Do not use OpenCode auto-approval if a physical user must approve messages.

Both visibility options default to `false`. When `wakeOnMessage` is enabled, authoritative pending detection sends one fixed synthetic instruction to the exact registered host session. The instruction contains no message body, title, source, hash, broker metadata, or peer-controlled text and tells the agent to call the real `agentbus_receive` tool until it returns `EMPTY`. Duplicate hints are coalesced, an unknown initial activity state is resolved through the trusted session-status API, busy sessions wait for an idle event, and receive attempts keep the same pending state latched. OpenCode 1.18.23 returns a sparse successful status map: after every own map entry has been validated against the compatible `idle`, `busy`, or `retry` shape, an already registered target omitted from that map is idle. Explicit target `busy` or `retry` remains non-idle. Error, malformed-entry, or malformed-container responses fail safe and retry instead of assuming idle. A successful wake starts a 30-second per-recipient cooldown for later rearmed pending states; it never delays an agent that is already draining the inbox with the real receive tool.

When `focusOnReceiveApproval` is enabled, an `agentbus_receive` native permission request publishes a TUI session-selection event for the trusted requesting session ID and a long-lived fixed warning toast. It does not change the native permission hook status or approve the request.

In server mode, the directory captured when the plugin starts is bootstrap scope, not foreground authority or a universal UI route. Exact per-call host validation populates a bounded per-session route map; trusted lifecycle events refresh it, deletion removes it, and plugin disposal clears it. The static startup directory is used only as a fallback for sessions bootstrapped in that exact workspace. If no trusted route exists, the plugin suppresses the corresponding toast, status query, wake, or focus action.

Installing the plugin for a project opts in up to 256 newest sessions returned by OpenCode for that one project/directory. This per-workspace bootstrap and trusted-route bound is distinct from both broker active-session capacity and transport topology. Multiple densely populated plugin workspaces can aggregate beyond 256 toward the configured active limit while remaining within the independent MCP/SSE ceilings; sparse workspaces may hit transport capacity first. Each runtime's session membership and trusted route map remains capped at 256, so a densely populated default topology uses 16 bounded workspace runtimes rather than one 4096-entry runtime scan. Session titles are searchable metadata; transcripts and filesystem paths are never indexed.

## Verify

Release preparation uses separate OpenCode V1/V2 package profiles and tests the actual npm archives in independent consumers. See the [release procedure](docs/releasing.md) for local commands, guarded GitHub/npm automation, and the planned V1 preservation followed by the V2 transition. Publication is disabled initially; producing a development archive is not release approval.

```bash
bun run test
bun run typecheck
bun run lint
bun run format-check
bun run coverage
bun run package-smoke
bun run audit
```

The deterministic suite does not restart the user's OpenCode server. The opt-in real-server attached-client procedure and its exact routing assertions are recorded in [`docs/qa.md`](docs/qa.md#opt-in-real-opencode-server-gate).

## Platform and limitations

- The current implementation targets Linux and requires UID checks, owner-only modes, no-follow opens, `/proc/self/fd`, and abstract Unix sockets.
- Transport is literal-loopback HTTP. A fresh nonce/HMAC challenge authenticates the broker immediately before every bearer-bearing MCP or SSE request.
- Application protocol v2 requires a successful v2 handshake before registration, event recovery, or message operations. Mixed v1/v2 plugin and broker deployments fail closed and require a manual old-broker restart.
- Native OpenCode reject/cancel cannot be distinguished by a stable typed plugin error in 1.18.19, so the body remains pending and undisclosed.
- Approval focusing uses the 1.18.19-compatible legacy `tui.publish` route with the v2 `tui.session.select` event. Automated tests verify the exact publish shape; interactive TUI navigation remains a manual QA item.
- `always` behavior is guaranteed for the current OpenCode instance; persistence across OpenCode restart is not claimed.
- Cross-server federation, transcript search, automatic replies, and automatic execution of peer requests are intentionally unsupported. `agentbus_reply` is an explicit model tool call, never an automatic reply.

See:

- [`docs/README.md`](docs/README.md)
- [`docs/requirements.md`](docs/requirements.md)
- [`docs/architecture.md`](docs/architecture.md)
- [`docs/broker-lifecycle-decision.md`](docs/broker-lifecycle-decision.md)
- [`docs/implementation-plan.md`](docs/implementation-plan.md)
- [`docs/qa.md`](docs/qa.md)

## License

Copyright (C) 2026 Julien Tesson <julien@atacama.tech>.

OpenCode Agent Bus is free software: you can redistribute it and/or modify it under the GNU General Public License, version 3 or (at your option) any later version. It is distributed without any warranty, including the implied warranties of merchantability or fitness for a particular purpose. See [LICENSE](LICENSE) for the full terms and [dependency licensing notes](docs/licensing.md) for redistribution constraints.

Partly developed using [Roster](https://github.com/mathiasbourgoin/roster).
