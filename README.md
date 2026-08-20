# OpenCode Agent Bus

Secure, local inter-session messaging for OpenCode 1.18.19.

The system combines:

- an OpenCode plugin that owns session identity, permission prompts, notifications, and model-facing tools;
- a local MCP-capable broker that stores pending messages and an opt-in session directory;
- sender-scoped native OpenCode approvals for message receipt;
- tool-result delivery so peer content is never inserted as a user message.

Status: implemented and QA-validated on Linux with Bun 1.3.9 and OpenCode 1.18.19.

## Security model

- Peer bodies remain in the broker until the receiving session passes native OpenCode approval.
- `once` approves one receive; `always` is scoped to the exact authenticated target/source pair.
- Search requires separate native approval for each canonical query.
- Received content is returned as `trust: "untrusted"` tool output, never injected as a user or synthetic message.
- Arrival notifications contain only a fixed pending count and do not wake the model.
- Raw broker MCP methods are internal to the plugin and are not exposed as model tools.

Receipt approval authorizes disclosure only. It does not authorize instructions contained in a peer message.

## Build

```bash
bun install --frozen-lockfile
bun run build
```

## Start the broker

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

The broker creates the database and 256-bit credential using owner-only permissions. Start it before OpenCode when practical; the plugin also fails closed and retries if the broker starts later.

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
        "timeoutMs": 5000
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

Restart OpenCode after changing plugin configuration. Do not use OpenCode auto-approval if a physical user must approve messages.

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

## Platform and limitations

- The current secure file implementation targets Linux/Unix and requires UID checks, owner-only modes, no-follow opens, and `/proc/self/fd` support.
- Transport is literal-loopback HTTP. A fresh nonce/HMAC challenge authenticates the broker immediately before every bearer-bearing MCP or SSE request.
- Native OpenCode reject/cancel cannot be distinguished by a stable typed plugin error in 1.18.19, so the body remains pending and undisclosed.
- `always` behavior is guaranteed for the current OpenCode instance; persistence across OpenCode restart is not claimed.
- Cross-server federation, transcript search, automatic replies, and automatic execution of peer requests are intentionally unsupported.

See:

- [`docs/architecture.md`](docs/architecture.md)
- [`docs/implementation-plan.md`](docs/implementation-plan.md)
- [`docs/qa.md`](docs/qa.md)
