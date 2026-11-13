# Architecture

## Goal

Allow local OpenCode sessions to exchange messages without treating another agent as the user and without exposing session discovery or message bodies before native OpenCode approval.

## Components

### OpenCode plugin

- Registers exactly four model-facing custom tools: `agentbus_send`, `agentbus_receive`, `agentbus_search_sessions`, and `agentbus_reply`.
- Derives caller authority from trusted per-call `ToolContext.sessionID`, `directory`, and `worktree`; none are model-facing arguments.
- Parses the trusted context ID with `HostSessionIdSchema`, queries the OpenCode session-list for that exact directory, and parses the one exact projected host registration with the full strict `ForegroundSessionSchema`. It then verifies the current project and independently requires both trusted absolute worktree roots to safely contain the directory before broker readiness, authentication, probing, launch, channel creation, admission, or operation.
- Passes the resulting strict, correlated foreground registration to the runtime without a second host query.
- Calls `ToolContext.ask()` with sender-specific resources.
- Shows metadata-only pending-message notifications.
- Optionally coordinates one fixed, body-free `promptAsync` wake for the exact registered target host session. It coalesces pending state, tracks busy/idle events, and latches real receive attempts to prevent re-entrant wake loops.
- Optionally publishes `tui.session.select` for the trusted session ID on native receive approval and shows a fixed warning toast without mutating permission output.
- Maintains a bounded trusted per-session route map for pending toasts, status queries, fixed wakes, and approval focus across attached workspaces.
- Calls the broker through an internal programmatic MCP client using the locked MCP SDK. Broker methods are custom MCP JSON-RPC requests, never raw model-facing MCP tools.
- Returns approved peer bodies as structured, untrusted tool results.
- Lazily authenticates or starts the bundled broker without blocking plugin initialization.

### MCP-capable local broker

- Maintains an opt-in session registry and opaque session handles.
- Stores pending message envelopes and bodies outside OpenCode history.
- Authenticates plugin clients and validates source/target ACLs.
- Supports peek-before-approval and atomic consume-after-approval.
- Resolves direct replies from a retained delivered message ID after checking the authenticated caller was its exact target; the original source becomes the reply target.
- Executes approved registry searches without accessing OpenCode transcripts.
- Enforces TTL, byte limits, rate limits, and replay protection.
- Atomically admits verified foreground sessions under the configured per-principal active ceiling and pins operation dependencies during deterministic displacement. The default is 4096 and protocol v2 rejects values outside 2 through 16384; two is required to protect the source and one operation dependency together.
- Derives daemon traffic budgets from that same active ceiling `A`: `4A + 256` authentication challenges per minute, `ceil(A / 256) + 4` MCP sessions and SSE streams per principal, and twice each per-principal transport value as its separate global ceiling. Active-session and concurrent transport limits remain independent: the quotient is a dense-workspace sizing assumption, not authority for `A` concurrent sparse runtimes. Checked integer arithmetic caps these at 65792, 68, and 136 respectively.

The broker MCP surface is internal to the plugin. It is not registered as raw model-facing MCP tools because OpenCode's generic MCP permission resource is currently `*`.

## Broker lifecycle

- The broker remains a separate detached user process. It survives plugin disposal and termination of the OpenCode process that launched it.
- Autostart is enabled by default. The plugin first authenticates the configured endpoint and launches only the bundled broker CLI when the endpoint is unused.
- The plugin never stops, signals, replaces, or takes over a listener. An occupied unknown endpoint fails closed.
- Concurrent starts use a Linux abstract Unix socket lease keyed by effective UID, IP family, and TCP port. The winner acquires the lease before opening credentials or SQLite; losers exit with code `75` and poll bounded authenticated readiness.
- The child receives a minimal allowlisted environment. Cloud credentials, runtime injection variables, and arbitrary inherited capacity values are not inherited; the parsed trusted plugin capacity is passed explicitly.
- Readiness is re-authenticated rather than permanently cached. A later operation in the same plugin instance can relaunch a crashed broker with the existing credential and database.
- Manual operation remains available with `autoStartBroker: false` and a separately launched daemon. The plugin still authenticates readiness so it can classify a signed v1 mismatch and publish the same fixed upgrade guidance, but an unavailable manual-mode attempt returns immediately without the TCP startup probe or process launch.
- Manual CLI capacity comes from `OPENCODE_AGENTBUS_MAX_ACTIVE_SESSIONS_PER_PRINCIPAL` or defaults to 4096. The daemon reads the resolved broker service limit, so manual CLI and autostart use one derivation path for authentication and transport budgets. A running detached broker is never reconfigured in place and keeps its startup value until manual restart.

See [`broker-lifecycle-decision.md`](broker-lifecycle-decision.md) for the accepted lifecycle and exit-code contract.

## Transport and credentials

The HTTP input boundary authenticates before reading a body and reserves a finite per-principal/global in-flight request slot first, using the configured MCP ceilings. Existing sessions remain marked busy for reaping purposes during body reads. The broker caps actual streamed input at 128 KiB, checks any declared length, rejects malformed UTF-8/JSON and all JSON-RPC batches, and rechecks current credentials and lifecycle before SDK dispatch. Disconnect, stop, rotation and a 30-second read deadline cancel held reads; request slots are released on all exits. These application limits remain in place with MCP SDK 1.32.2 rather than relying on high-level SDK tool-server defaults that this low-level custom-method server does not use.

- MCP Streamable HTTP binds only to literal loopback (`127.0.0.1` or `::1`); the default is `http://127.0.0.1:4097`.
- The client performs normal MCP initialize/initialized negotiation. Custom JSON-RPC methods and envelopes are defined by `@opencode-agentbus/protocol` v2.
- Protocol v2 is a deliberate lockstep compatibility break: strict v1 method and envelope unions cannot accept direct reply or its linkage fields. The MCP connection must complete a successful v2 application handshake before registration or any message operation. A successful handshake also marks the current authenticated principal event-ready; the separate SSE endpoint returns conflict before that point, and credential rotation clears readiness.
- Direct reply is the protocol-v2 method `agentbus.message.reply`; receipt and delivery envelopes carry strict optional correlation fields.
- Application success and safe application errors travel inside JSON-RPC success results. MCP errors are reserved for authentication, framing, initialization/session, and unavailable-method failures.
- After principal-level v2 event readiness, a principal-wide authenticated SSE stream at `/events` carries metadata-only pending events. Events are hints; recovery list results are authoritative and may publish either a positive count or zero. During a receive attempt, a local list-empty result is deferred until its matching peek confirms `EMPTY`. Receive observations and the authenticated current first header are ordered so an older result cannot overwrite newer same-cursor state.
- The broker creates a persistent broker ID and 256-bit bearer credential file with owner-only mode `0600`. The file binds one stable principal ID to the token.
- Before every bearer-bearing MCP or SSE HTTP request, the plugin sends a fresh nonce to `/auth/challenge` and verifies the broker's domain-separated HMAC proof. Challenge reads are time- and size-bounded, and the MCP handshake must match the challenged broker ID.
- Endpoint and credential-file path come only from trusted plugin options/environment and are never model-visible.
- Credential rotation invalidates existing connections and requires MCP reinitialization and session re-registration.

### Mixed-version upgrade behavior

- A v1 client request sent to the v2 broker fails the application handshake. The connection remains application-unready, registration and message methods are rejected, and the separate event-recovery endpoint remains closed.
- A v2 runtime rejects a v1 handshake response before registration or event recovery.
- A normal v1 broker advertises v1 in its pre-bearer authenticated challenge. With autostart enabled or disabled, the v2 plugin verifies that response only to classify the operator-visible mismatch, then stops: it sends no bearer credential, does not reuse the listener, does not probe for takeover, and does not signal, stop, replace, or relaunch over the old broker.
- The model continues to receive only `Agent Bus is unavailable.` The fixed TUI toast tells the operator to stop and restart the detached broker manually.
- Plugin and broker packages must be upgraded together. Once the old process is stopped, the bundled v2 broker starts against the same credential and database and applies the ordered schema v3→v4→v5 migrations.

## Foreground admission under saturation

Project bootstrap remains bounded to the newest 256 sessions in each static plugin project/directory, but that per-workspace bound is separate from both the broker's configured principal capacity and concurrent transport capacity. Lifecycle insertion evicts and deregisters the oldest local membership at 256, and the trusted route map has the same bound. For default `A = 4096`, `W = ceil(4096 / 256) = 16` describes the expected densely populated topology; four operational slots raise the actual per-principal ceiling to 20 concurrent MCP sessions and 20 SSE streams, each independently capped at 40 globally. Sparse one-session workspaces may therefore exhaust transport topology with only 20 active sessions, while dense workspaces can aggregate toward `A` without creating one runtime that scans 4096 sessions. The hard topology remains 68 per principal and 136 globally for each transport. For each model-facing tool invocation, the plugin validates only trusted per-call `ToolContext.sessionID`, `directory`, and `worktree`. It first parses the context ID with `HostSessionIdSchema`, queries `session.list` with that exact directory, requires exactly one matching session ID with the exact directory, and projects that returned ID/title into the full strict `ForegroundSessionSchema`. It then queries `project.current` and matches the session project ID. The context worktree and returned project worktree are separate trusted host statements: both must be absolute and independently contain the exact context directory under safe path-relative containment. They need not equal each other, so a global project worktree `/` and a more-specific attached workspace root are valid together, as are different nested roots that both contain the directory. Non-absolute, unrelated, or too-specific roots from which the directory escapes fail before broker access, alongside invalid-character, control/Unicode-unsafe, empty, oversized, missing, duplicate, malformed-metadata, mismatched, or failed host results.

Successful validation yields one strict `HostSessionRegistration` correlated to the same `ToolContext.sessionID`. The plugin passes that registration into the runtime, which parses and correlates it again but performs no second host query. Direct runtime use retains the same trusted resolver as a fallback. A target handle, message ID, query, title, label, body, forged directory, or forged worktree supplied by the model cannot select the source being admitted.

An unknown current session first uses the internal non-activating `agentbus.session.resolve_foreground` method to obtain its stable broker-derived identity. Resolution creates no durable row, consumes no active or durable slot, and displaces nothing. The real send, reply, receive, or search request carries the verified foreground host context; only that operation transaction may create and admit the source. Existing background registrations remain valid for recovery, but they carry no authority to mark themselves foreground.

Within `BEGIN IMMEDIATE`, the broker:

1. verifies that the claimed operation identity is the canonical identity derived from the authenticated principal and verified host session ID;
2. protects the foreground source plus the send target or broker-resolved reply source when applicable;
3. if a slot is needed, selects an unprotected active victim by background-first ordering, then least `last_foreground_ms`, then stable creation/session-ID ties;
4. marks the victim displaced without deleting its row or durable state;
5. admits the source and any broker-displaced dependency, updates foreground recency only for the source, and executes the requested operation before commit.

The same operation transaction returns an authoritative pending-header snapshot for the foreground source and the authenticated principal's event-sequence high-water. This binds the snapshot to a precise replay boundary: `0` means that no principal event preceded the snapshot, while every positive value names the last event sequence included by that transaction.

### Causal pending recovery and SSE replay

SSE is never opened without a cursor. The runtime sends the snapshot high-water in `Last-Event-ID`; the broker rejects a missing, future, malformed, or no-longer-retained boundary with `EVENT_CURSOR_EXPIRED`. Cursor `0` remains replayable while no events exist or retained replay still begins at sequence 1, and becomes stale once retention has removed that first boundary. Positive cursors likewise become stale when later events exist but the named retained boundary has been removed.

The broker registers the principal-scoped live subscriber before reading replay state. It then transactionally captures the current high-water and all authorized metadata-only events strictly after the supplied cursor. Live events arriving during this read are buffered; replay is emitted first, buffered events follow in sequence order, and sequence deduplication prevents overlap from being delivered twice. Message bodies never enter the event table or stream.

Runtime pending recovery is serialized across registrations. Stream existence alone is insufficient: coverage is attached to the exact stream and a local registration-membership generation. The runtime prefers the saved acknowledged or disconnect cursor, opens replay from that boundary, and then obtains authoritative post-subscription snapshots for every active local registration. A foreground operation may supply one seed snapshot, but it cannot establish principal coverage for only its own registration. If replay is unavailable because the boundary is stale or absent, recovery obtains a fresh high-water and performs the same all-registration snapshot pass before reconnecting.

Registration addition, removal, or displaced foreground re-entry invalidates the generation and retries the bounded convergence pass; removed records stop blocking completion. Broker-displaced rows may answer only the authenticated body-free pending-list operation without being reactivated, allowing a runtime whose local membership has not yet observed broker displacement to finish principal recovery. Explicit deregistration remains ineligible, and peek/consume authorization is unchanged. Inactive records are excluded from event buffering and aggregate pending wake counts; transition from active to inactive removes only that target's buffered metadata and clears its local published count in the recovery lane. Durable broker state is recovered when a verified foreground operation re-admits the same identity. Duplicate and reordered events are keyed by sequence, and no `updatePending`, notification, or wake publication occurs until one stable pass covers every active record and every newer buffered target event. Stream loss and invalid frames preserve the last usable cursor for replay when possible; stale cursors force the authoritative fallback, and no path reconnects cursorlessly.

The runtime uses two one-way concurrency lanes. The ordered SSE ingestion lane validates the event schema, authenticated principal binding, and active current session binding; rejects already-applied or duplicate event IDs; inserts accepted metadata into a shared buffer bounded by the protocol replay maximum; and schedules recovery without awaiting it. It performs no broker list, convergence, cursor/count mutation, or publication. The serialized pending-recovery lane is the sole owner of those operations, including receive list/peek reconciliation and the authoritative refresh after a successful consume. Runtime guards reject pending count, current-header, cursor, or publication mutation outside that lane. It may await the ingestion lane as a barrier, but the ingestion lane never awaits pending recovery, which removes the former cyclic-wait possibility.

Scheduled recovery coalesces buffered targets. It barriers before selecting work, performs all-registration convergence when stream coverage or membership is invalid, otherwise lists only affected active targets, barriers again after the fetches, and retries when a newer buffered event or membership version is not covered by the returned high-water. Only the stable final snapshots are applied and published. Events at or below an applied per-target cursor are drained; newer events remain buffered. If an event arrives during publication or after a stable cut, one coalesced follow-up is scheduled. Buffer overflow records only the newest omitted relevant cursor and forces authoritative all-active-registration recovery; it clears only after every retained active target is covered, so memory and follow-up work remain bounded.

Background register/heartbeat activity never updates `last_foreground_ms`. A background registration that arrives at the active ceiling is persisted as displaced rather than stealing a slot. Default durable quotas scale safely from the active limit: 4× per principal and 16× globally, with a foreground reserve equal to the active limit and registration accounting sufficient for `max(256, active limit)` cold registrations. At the 16384 active hard maximum, the corresponding finite durable maxima are 65536 per principal and 262144 globally. At a hard durable boundary, foreground admission may reclaim only a deterministic inactive, state-free background row with no messages, replay events, enqueue accounting, or foreground history; protected dependencies and active registrations are excluded, and no safe candidate produces a canonical rate-limit failure. Heartbeats for displaced rows remain transport-successful but do not reactivate them, preventing reconnect storms. Explicit deregistration clears the displacement marker and is not eligible for dependency reactivation. Displaced rows retain their canonical identity, metadata, pending messages, bodies, events, reply correlation, TTLs, and approval-compatible fingerprints; a later verified tool call transparently re-admits the same identity.

Foreground search protects the deterministic, requested-limit match window observed immediately before source admission and unions matching snapshots from immediately before and after admission. The sole matching target therefore cannot be lost merely to admit the requester, while a following send transaction also protects and reactivates a broker-displaced target without changing its opaque identity.

### Trusted attached-workspace routing

The plugin keeps an internal `TrustedSessionRouteMap` keyed by exact host session ID and bounded to the same 256-session bootstrap maximum. A successful foreground validation records the trusted per-call directory and worktree. Trusted `session.created` and `session.updated` lifecycle events refresh the directory; `session.deleted` removes the route and wake state, and plugin disposal clears the map. Recency replacement keeps the map bounded.

Pending toasts, `/session/status`, the sole fixed `promptAsync` wake, `tui.session.select`, and the fixed approval warning resolve the exact session's route immediately before the host call. The plugin-start directory is only a fallback for IDs in the static-workspace bootstrap set. An unknown route suppresses the best-effort UI or wake action rather than falling back across workspaces. Peer bodies, titles, source metadata, broker envelopes, and model arguments cannot establish or select these routes, and directory/worktree values do not enter model-visible or peer-visible data.

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

## Direct replies and correlation

`agentbus_reply` accepts `{ messageId, body, ttlSeconds? }` and no target. The runtime sends the authenticated caller identity and original message ID to the broker. In one SQLite transaction, the broker:

1. verifies the caller owns the active session identity;
2. finds an original addressed to that exact session without selecting its body;
3. requires the retained original state to be `DELIVERED`;
4. resolves the original authenticated source as the new target and requires it to be active or broker-displaced, re-admitting a displaced source while it remains transactionally protected;
5. applies the normal send size, TTL, rate, pending, and durable quotas; and
6. enqueues a fresh message with `reply_to_message_id` set to the original ID.

Missing, foreign, and not-addressed identifiers are deliberately indistinguishable as `MESSAGE_NOT_FOUND`. An owned `PENDING`, `REJECTED`, or `EXPIRED` original returns `MESSAGE_NOT_REPLYABLE`. The method does not invoke receive approval or read the original body.

The new reply's body-free receipt contains its fresh `messageId` and the original `replyToMessageId`. Pending headers, metadata-only events, and the eventual delivered `peer_message` propagate the optional linkage. Ordinary sends omit it. These IDs are correlation metadata and grant no authority.

The runtime independently checks both send and reply receipts against the submitted body: `bodyHash` must equal SHA-256 of the exact UTF-8 body and `bodyBytes` must equal its UTF-8 byte length. Request/response IDs, reply linkage, and fresh reply identity are checked at the same boundary before a body-free receipt reaches the model.

## Wake coordinator state machine

Wake coordination is per registered host session and is enabled only by `wakeOnMessage`.

| Trigger | State/effect |
|---|---|
| First authoritative positive pending observation | Queue one wake; activity starts as `unknown`. |
| Activity `unknown` | Query the trusted OpenCode session-status API. Validate the plain transport container and every own target or unrelated entry against the locked compatible status union, including required `retry` fields. An error, malformed container, malformed entry, or prototype anomaly schedules a bounded retry and never assumes idle. |
| Fully validated status map omits the exact registered target, or reports it explicitly idle | Treat the target as idle and deliver the exact fixed wake if it is queued, unlatched, and outside cooldown. OpenCode 1.18.23 uses this sparse-map omission for idle sessions. |
| Explicit busy/retry status or trusted busy event | Keep the wake queued without prompting. |
| Trusted idle event | Deliver the exact fixed wake if it is queued, unlatched, and outside cooldown. |
| Successful wake | Latch the outstanding state and begin a 30-second per-recipient cooldown. |
| Failed wake | Retry within the configured attempt bound while pending remains authoritative. |
| Real `agentbus_receive` starts | Latch immediately and cancel queued wake work; the tool itself never waits for cooldown. |
| Authoritative list/peek remains positive | Preserve the latch while the receiver drains or awaits native permission. |
| Accepted authoritative zero from recovery list or receive peek | Clear pending and the latch; a later positive observation may rearm one wake after any remaining cooldown. |
| Session removal or plugin disposal | Cancel status, wake-retry, and cooldown timers. |

Receive executes list and peek under one recovery-lane observation number. A newer authoritative result at the same event cursor is distinguished through the local observation and current authenticated first-header snapshot: matching state may validate the peek, while conflicting state retries the pair iteratively up to three times. A rejected stale observation cannot return `EMPTY`, request permission, or consume. The recovery lane is released before native permission and remains released during atomic consume; current state is checked again in the lane before consume, and a successful consume is followed by a serialized authoritative list refresh. Exhaustion returns the safe retryable operation error.

Status queries likewise capture the target's activity generation before awaiting the host. A newer trusted busy or idle event increments that generation, so the older query result cannot overwrite the event-derived state.

The fixed instruction appears intentionally in both the exported test/display constant and as a literal inside `sendFixedAgentBusWake`. The product-source auditor accepts exactly one call only when its AST contains that literal, exact target and directory routing, one synthetic text part, and no extra statements. Keeping the audited literal independent from an identifier prevents runtime reassignment or indirection from weakening the static guarantee.

The OpenCode session surface uses a fail-closed AST direct-use policy: product code may use only the exact session-list call in host registration, the exact session-status call in wake activity resolution, and the sole structural fixed wake. Direct client access is limited to the known `.session` and `.tui` service paths. The auditor resolves PluginInput-root aliases introduced by `const`/`let` initializers or later simple identifier assignments, follows parenthesis/assertion wrappers and local alias chains, and propagates or rejects client/session destructuring. Passing or returning a resolved input alias is an escape violation. This is syntactic fixed-point analysis, not a claim of arbitrary interprocedural or type-derived alias proof. Negative fixtures cover these alias families plus the specifically tested reflection, descriptor, computed-name, assignment, return, assertion, and `.call`/`.apply`/`.bind` forms.

## Message state machine

```text
PENDING -> DELIVERED
   |----> REJECTED
   |----> EXPIRED
```

Delivery is an atomic compare-and-consume operation bound to message ID, target identity, and expected body hash. A reply is a separate message with the same state machine; it does not transition or reopen its delivered parent.

SQLite schema v4 adds nullable `messages.reply_to_message_id`. It intentionally has no foreign key: terminal cleanup erases bodies, retained parent rows may later be purged, and an already enqueued child remains independently valid. Canonical migration 4 starts from schema v3 with no reply-link column, adds nullable `TEXT` inside the migration transaction, validates the resulting non-primary-key, no-default, no-foreign-key shape, and only then advances `user_version`. Any v3 database where the column already exists is treated as a noncanonical partial/prerelease migration and fails before mutation, which also rejects hidden CHECK and unique-index restrictions. The default 24-hour terminal-retention window bounds how long a delivered message ID remains replyable.

SQLite schema v5 adds `sessions.displaced` and nullable `sessions.last_foreground_ms`, plus the deterministic admission index. Migration 5 first validates the complete canonical v4 sessions column, type, nullability, default, primary-key, foreign-key, CHECK, uniqueness, and index shape. It adds both columns and the index in one transaction, validates the complete v5 output before advancing `user_version`, and validates v5 again on reopen. Any malformed or partial v4/v5 shape fails closed. Foreground recency and displacement survive broker restart.

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
    PluginB->>AgentB: Optional fixed drain instruction (no peer fields)
    AgentB->>PluginB: agentbus_receive()

    PluginB->>Broker: Peek authenticated header
    Broker-->>PluginB: ID, source, target, hash, size
    PluginB->>PermB: Ask on exact target/source resource
    PluginB-->>UserB: Optional exact-session focus + fixed warning toast
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
- Send and reply receipts and their correlation IDs are body-free and grant no authority.
- A normal permission dialog exists only during real tool execution. With wake disabled, passive arrival produces only the metadata toast. With wake enabled, the fixed instruction starts an agent turn that must invoke `agentbus_receive`; the plugin never consumes directly and never fabricates `ToolContext`.
- Installing the plugin for a project is the MVP opt-in boundary. Bootstrap is deferred until after OpenCode returns plugin hooks and is bounded to 256 newest project/directory sessions. Sessions beyond that local bootstrap window remain eligible only when an actual trusted tool context resolves them; foreground admission then displaces deterministically without raising the broker cap.
- In server mode, the startup project/directory is not a universal route. Host UI and wake calls use the exact trusted session route, with static fallback limited to IDs bootstrapped in the startup workspace.
- The broker limits MCP/SSE connections, challenge rate, registration churn, per-source and principal durable messages, request/body sizes, and retained terminal state. Idle connections and stale data are reaped; slow SSE clients are closed rather than buffered without bound.
- SQLite uses ordered schema migrations, WAL durability, atomic consume/reject transitions, bounded retention, and fail-closed owner/mode/link checks for the database and sidecars.
- The current implementation targets Linux secure-file and abstract-socket semantics and requires `/proc/self/fd`. Separate broker credentials and Unix identities remain required for mutually untrusted operating-system users.

## Explicit non-goals

- Transcript-content search
- Cross-server federation
- Automatic execution of peer requests
- Automatic replies
- Peer body injection into OpenCode history
