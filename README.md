# OpenCode Agent Bus

Secure, local inter-session messaging using the locked OpenCode 1.18.19 plugin API contract.

The system combines:

- an OpenCode plugin that owns session identity, permission prompts, notifications, and model-facing tools;
- a local MCP-capable broker that stores pending messages and an opt-in session directory;
- sender-scoped native OpenCode approvals for message receipt;
- tool-result delivery so peer content is never inserted as a user message.

Status: implemented and end-to-end QA-validated on Linux with Bun 1.3.9 and OpenCode 1.18.19. Built integration tests cover server-root/attached-workspace behavior through a simulated OpenCode host API, and compatibility tests cover the session-status map shape observed on the currently installed OpenCode 1.18.23 runtime. The opt-in real `opencode-server` attached-client wake, TUI navigation, and approval-flow gate remains outstanding.

## Security model

- Peer bodies remain in the broker until the receiving session passes native OpenCode approval.
- `once` approves one receive; `always` is scoped to the exact authenticated target/source pair.
- Search requires separate native approval for each canonical query.
- A semantic reply names the delivered message being answered; the broker verifies recipient ownership and resolves the original source without a model-supplied target.
- Received content is returned as `trust: "untrusted"` tool output, never injected as a user or synthetic message.
- Arrival notifications contain only a fixed pending count and do not themselves wake the model. A separate fixed wake is available only when explicitly enabled.
- Raw broker MCP methods are internal to the plugin and are not exposed as model tools.
- Every tool invocation strictly parses its trusted foreground ID and returned protocol registration, then validates directory/project identity and independently requires both trusted absolute worktree roots to contain the directory before broker readiness or connection work begins.
- Pending toasts, session-status checks, fixed wakes, and approval focus use a bounded trusted route for the exact host session; peer and model fields cannot select their workspace.

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

```bash
bun install --frozen-lockfile
bun run build
```

## Broker startup

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

Optional broker environment variables:

- `OPENCODE_AGENTBUS_HOST` — literal `127.0.0.1` or `::1`
- `OPENCODE_AGENTBUS_PORT`
- `OPENCODE_AGENTBUS_DB_PATH` — absolute path
- `OPENCODE_AGENTBUS_CREDENTIAL_FILE` — absolute path

The broker creates the database and 256-bit credential using owner-only permissions. It runs as a detached user process and survives plugin disposal or termination of the OpenCode process that launched it.

### Protocol-v2 upgrade

The plugin and broker are a lockstep protocol-v2 deployment. Version 2 is intentionally incompatible with version 1 because strict v1 envelopes cannot safely accept the reply method and linkage fields.

If a detached v1 broker is still listening after the plugin is upgraded, the v2 plugin authenticates only enough to identify the version mismatch, does not disclose its bearer token, and does not reuse, signal, kill, replace, or take over that listener. This detection and fixed OpenCode operator toast apply with either automatic or manual broker management; model-facing tools continue to return only the canonical unavailable error. Manual mode never performs the TCP startup probe or launches a process after an unavailable authentication attempt.

Stop the old user-owned broker manually, then start the bundled v2 broker (or restart OpenCode and let autostart launch it). Upgrade the plugin and broker packages together. On startup, the bundled v2 broker performs the ordered schema v3→v4→v5 migrations while preserving retained messages. A v3 database that already contains `reply_to_message_id`, or a noncanonical v4/v5 sessions schema, fails closed without advancing the schema version; back up persistent state before any manual operational migration.

## Configure OpenCode

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

Restart OpenCode after changing plugin configuration. Do not use OpenCode auto-approval if a physical user must approve messages.

Both visibility options default to `false`. When `wakeOnMessage` is enabled, authoritative pending detection sends one fixed synthetic instruction to the exact registered host session. The instruction contains no message body, title, source, hash, broker metadata, or peer-controlled text and tells the agent to call the real `agentbus_receive` tool until it returns `EMPTY`. Duplicate hints are coalesced, an unknown initial activity state is resolved through the trusted session-status API, busy sessions wait for an idle event, and receive attempts keep the same pending state latched. OpenCode 1.18.23 returns a sparse successful status map: after every own map entry has been validated against the compatible `idle`, `busy`, or `retry` shape, an already registered target omitted from that map is idle. Explicit target `busy` or `retry` remains non-idle. Error, malformed-entry, or malformed-container responses fail safe and retry instead of assuming idle. A successful wake starts a 30-second per-recipient cooldown for later rearmed pending states; it never delays an agent that is already draining the inbox with the real receive tool.

When `focusOnReceiveApproval` is enabled, an `agentbus_receive` native permission request publishes a TUI session-selection event for the trusted requesting session ID and a long-lived fixed warning toast. It does not change the native permission hook status or approve the request.

In server mode, the directory captured when the plugin starts is bootstrap scope, not foreground authority or a universal UI route. Exact per-call host validation populates a bounded per-session route map; trusted lifecycle events refresh it, deletion removes it, and plugin disposal clears it. The static startup directory is used only as a fallback for sessions bootstrapped in that exact workspace. If no trusted route exists, the plugin suppresses the corresponding toast, status query, wake, or focus action.

Installing the plugin for a project opts in up to 256 newest sessions returned by OpenCode for that project/directory. Session titles are searchable metadata; transcripts and filesystem paths are never indexed.

## Verify

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
