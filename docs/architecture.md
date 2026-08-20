# Architecture

## Goal

Allow local OpenCode sessions to exchange messages without treating another agent as the user and without exposing session discovery or message bodies before native OpenCode approval.

## Components

### OpenCode plugin

- Registers the model-facing `agentbus_send`, `agentbus_receive`, and `agentbus_search_sessions` custom tools.
- Derives the caller identity from `ToolContext.sessionID`.
- Calls `ToolContext.ask()` with sender-specific resources.
- Shows metadata-only pending-message notifications.
- Calls the broker through an internal programmatic MCP client using the locked MCP SDK. Broker methods are custom MCP JSON-RPC requests, never raw model-facing MCP tools.
- Returns approved peer bodies as structured, untrusted tool results.

### MCP-capable local broker

- Maintains an opt-in session registry and opaque session handles.
- Stores pending message envelopes and bodies outside OpenCode history.
- Authenticates plugin clients and validates source/target ACLs.
- Supports peek-before-approval and atomic consume-after-approval.
- Executes approved registry searches without accessing OpenCode transcripts.
- Enforces TTL, byte limits, rate limits, and replay protection.

The broker MCP surface is internal to the plugin. It is not registered as raw model-facing MCP tools because OpenCode's generic MCP permission resource is currently `*`.

## Transport and credentials

- The broker is a separately launched daemon. The plugin never spawns, replaces, or terminates it.
- MCP Streamable HTTP binds only to literal loopback (`127.0.0.1` or `::1`); the default is `http://127.0.0.1:4097`.
- The client performs normal MCP initialize/initialized negotiation. Custom JSON-RPC methods and envelopes are defined by `@opencode-agentbus/protocol` v1.
- Application success and safe application errors travel inside JSON-RPC success results. MCP errors are reserved for authentication, framing, initialization/session, and unavailable-method failures.
- A principal-wide authenticated SSE stream at `/events` carries metadata-only pending events. Events are hints; list/peek recovery is authoritative.
- The broker creates a persistent broker ID and 256-bit bearer credential file with owner-only mode `0600`. The file binds one stable principal ID to the token.
- Before every bearer-bearing MCP or SSE HTTP request, the plugin sends a fresh nonce to `/auth/challenge` and verifies the broker's domain-separated HMAC proof. Challenge reads are time- and size-bounded, and the MCP handshake must match the challenged broker ID.
- Endpoint and credential-file path come only from trusted plugin options/environment and are never model-visible.
- Credential rotation invalidates existing connections and requires MCP reinitialization and session re-registration.

## Permission resources

Message receipt uses an exact resource:

```text
target:<target-fingerprint>:sender:<source-fingerprint>
```

Fingerprints use broker/server identity plus immutable session ID and are encoded as lowercase hexadecimal or base64url. Titles never participate in authorization.

- `once` authorizes the current tool call and one atomic consume.
- `always` stores the exact target/source resource, allowing later messages only for that pair.
- Native OpenCode reject/cancel leaves the body inaccessible and pending because OpenCode 1.18.19 exposes no stable typed denial discriminator to plugins. The broker protocol retains an explicit body-free reject operation for future trusted UI integration.

Search uses:

```text
scope:<scope-fingerprint>:query:<normalized-query-hash>
```

The initial implementation provides no broad `always` search pattern; each distinct query requires approval.

## Message state machine

```text
PENDING -> DELIVERED
   |----> REJECTED
   |----> EXPIRED
```

Delivery is an atomic compare-and-consume operation bound to message ID, target identity, and expected body hash.

## Sequence

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#0b0f14","primaryColor":"#111827","primaryTextColor":"#ffffff","primaryBorderColor":"#ffffff","lineColor":"#ffffff","actorBkg":"#111827","actorBorder":"#ffffff","actorTextColor":"#ffffff","actorLineColor":"#d1d5db","signalColor":"#ffffff","signalTextColor":"#ffffff","labelBoxBkgColor":"#111827","labelBoxBorderColor":"#ffffff","labelTextColor":"#ffffff","loopTextColor":"#ffffff","noteBkgColor":"#fef3c7","noteBorderColor":"#f59e0b","noteTextColor":"#111827","sequenceNumberColor":"#ffffff"}}}%%
sequenceDiagram
    autonumber
    actor UserA as Sender User
    participant AgentA as Sender Agent
    participant PluginA as Sender Plugin
    participant Broker as Local MCP Broker
    participant PluginB as Recipient Plugin
    actor UserB as Recipient User / TUI
    participant PermB as OpenCode Permission Service
    participant AgentB as Recipient Agent

    UserA->>AgentA: Send message to Agent B
    AgentA->>PluginA: agentbus_send(target, body)
    PluginA->>Broker: enqueue(authenticated sender, target, body)
    Broker->>Broker: Validate ACL and store PENDING
    Broker-->>PluginA: message ID
    Broker-->>PluginB: Pending metadata event (no body)
    PluginB-->>UserB: Metadata-only toast

    UserB->>AgentB: Check incoming messages
    AgentB->>PluginB: agentbus_receive()
    PluginB->>Broker: Peek authenticated header
    Broker-->>PluginB: ID, source, target, hash, size
    PluginB->>PermB: Ask on exact target/source resource
    PermB-->>UserB: Native once / always / reject dialog

    alt Reject or cancel
        UserB->>PermB: reject
        PermB-->>PluginB: denied
        PluginB-->>AgentB: Message not retrieved; remains pending
    else Once or always
        UserB->>PermB: once / always
        opt Always
            PermB->>PermB: Save exact target/source allow rule
        end
        PermB-->>PluginB: approved
        PluginB->>Broker: Atomic consume with expected hash
        Broker-->>PluginB: Peer body
        PluginB-->>AgentB: Untrusted peer_message tool result
    end
```

## Trust and limitations

- OpenCode auto-approval also approves native permission requests. Deployments requiring a physical human must disable auto mode.
- Tool-result role separation prevents confusion with a user message but does not make adversarial text harmless to an LLM. Receipt approval means disclosure, not authorization to execute requested actions.
- A normal permission dialog exists only during tool execution. Passive arrival therefore produces a notification; the user or agent must invoke inbox receipt to trigger approval.
- Installing the plugin for a project is the MVP opt-in boundary. Bootstrap is deferred until after OpenCode returns plugin hooks, is bounded to 256 newest project/directory sessions, and retries asynchronously when the broker is unavailable.
- The broker limits MCP/SSE connections, challenge rate, registration churn, per-source and principal durable messages, request/body sizes, and retained terminal state. Idle connections and stale data are reaped; slow SSE clients are closed rather than buffered without bound.
- SQLite uses ordered schema migrations, WAL durability, atomic consume/reject transitions, bounded retention, and fail-closed owner/mode/link checks for the database and sidecars.
- The current implementation targets Linux/Unix secure-file semantics. Separate broker credentials and Unix identities remain required for mutually untrusted operating-system users.

## Explicit non-goals

- Transcript-content search
- Cross-server federation
- Automatic execution of peer requests
- Automatic replies
- Peer body injection into OpenCode history
