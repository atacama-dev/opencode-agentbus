# QA evidence

## Result

Original messaging flow approved on 2026-08-20. Plugin-managed broker lifecycle approved on 2026-08-21. The direct-reply, bounded foreground-admission, configurable active-session-capacity, principal-wide causal-recovery, and trusted attached-workspace routing increments are implemented and covered by automated protocol, broker, plugin, built integration, migration, restart, and package-smoke tests.

## Automated gates

### Initial V1 0.1.0 release decision

On 2026-11-16, the maintainer authorized publishing V1 `0.1.0` using the existing historical native evidence and current automated/installed-archive checks, without repeating manual native-host acceptance. The maintainer no longer has the V1 test setup and accepts evaluating subsequent reports. The attached-client wake/focus, routing and approval observations below remain **unrun on the current release source**, not passed or certified. This decision does not change native permission enforcement or authorize a V2 release.

The initial npm publication bootstraps the real, exact tagged CI-tested archive through interactive authentication; it is **not an OIDC-provenance publication**. The normal guarded OIDC publisher remains unchanged. See the [one-time bootstrap boundary](releasing.md#initial-v1-010-bootstrap).

### Historical automated baseline

This section records the historical baseline, not a clean audit of the current dependencies. Current dependency findings and the temporary acceptance criteria are documented in [dependency exceptions](dependency-exceptions.md); a passing policy does not remove those findings.

- 467 unit tests (2,217 assertions) passed; one wrong-owner database test was skipped because execution was non-root.
- 27 integration scenarios (260 assertions) passed using the built plugin, production MCP SDK channel, live broker, SQLite/WAL, SSE, independent plugin clients, detached subprocesses, and a compatible simulated OpenCode host API for server-root/attached-workspace routing.
- Strict typecheck, dependency-ordered builds, lint, format, package smoke, dependency audit, and static plugin audit passed.
- Unit coverage was 92.79% lines and 87.78% functions.
- A source-only clean-room checkout passed frozen install and the full deterministic gate.

## Actual OpenCode 1.18.19

QA used the official `opencode-ai@1.18.19` package, the built Agent Bus plugin and broker, isolated state, auto-approval disabled, and a deterministic local provider with no external credentials.

Validated:

- plugin startup no longer blocks OpenCode project/session initialization;
- the then-current baseline exposed only `agentbus_send`, `agentbus_receive`, and `agentbus_search_sessions`;
- search asks through the native permission service and provides no broad `always` pattern;
- receive `once` asks again for the next A→B message;
- receive `always` allows later A→B messages only;
- saved A→B approval does not authorize C→B or A→C;
- reject and cancellation disclose no body and leave messages pending;
- peer bodies appear only in `trust: "untrusted"` tool results, never as user/synthetic messages;
- permission metadata contains only opaque IDs, fingerprints, hashes, and byte counts;
- no peer body appeared in captured OpenCode events, errors, logs, or non-tool history;
- no automatic target-model turn occurred before explicit receive.

Persistence of `always` approvals across an OpenCode restart is not claimed.

## OpenCode 1.18.23 session-status compatibility

Direct observation of the currently installed managed OpenCode 1.18.23 runtime showed that `/session/status` returns `{}` while sessions are idle, returns an entry such as `{sessionID: {type: "busy"}}` while a session is busy, and returns `{}` again after it becomes idle.

Automated compatibility coverage therefore verifies that:

- an exact runtime-registered target omitted from a successful valid status map is treated as idle;
- all own target and unrelated entries are validated before omission is interpreted, including complete locked-SDK `retry` fields and plain JSON-compatible containers;
- explicit `idle` wakes, while explicit `busy` and `retry` defer;
- error responses, malformed target or unrelated entries, and container/prototype anomalies remain fail-safe and retry within the existing bound;
- newer trusted busy or idle events supersede an older in-flight status query.

This evidence does not establish the wake prompt, visible TUI navigation, or native approval flow on OpenCode 1.18.23.

## Plugin-managed broker lifecycle

QA used isolated temporary state and dynamic non-default ports. Existing OpenCode processes and the user's broker were not touched.

Validated:

- plugin hook initialization remains deferred and non-blocking;
- default autostart executes only the bundled broker CLI and reaches authenticated readiness;
- an authenticated broker is reused without spawning, while manual disabled mode spawns nothing;
- unknown listeners and insecure credentials fail closed without replacement or termination;
- the detached broker survives launcher exit and plugin disposal;
- the child environment excludes unrelated secrets and runtime injection variables;
- concurrent independent starts produce one long-lived broker and all callers reach authenticated readiness;
- the Linux abstract-socket lease is acquired before credentials or SQLite are opened;
- lease contention exits with code `75` and polls the winner; genuine startup failure fails promptly;
- deliberate daemon stop force-closes stale HTTP keep-alive connections so an immediate same-port restart cannot keep serving the old daemon's unavailable response; and
- installed-package smoke starts the copied broker CLI, instantiates two copied production plugin clients, performs approved A→B delivery, replies B→A by original message ID, and performs approved return delivery with fresh/linkage ID assertions.

## Unclean broker termination

QA autostarted the built broker, committed a pending adversarial message through the production plugin/MCP path, sent `SIGKILL`, and recovered through the same plugin/hooks instance with the same endpoint, database, and credential.

Validated:

- stable broker identity;
- automatic detached relaunch from the same plugin instance;
- nonce/HMAC listener challenge and plugin reconnect/re-registration;
- pending-message recovery and exactly-once consumption;
- SQLite `integrity_check = ok` and WAL journal mode;
- body-free receipts, notifications, logs, errors, and permission metadata;
- delivered content remained explicitly untrusted.

## Direct-reply increment

Automated coverage validates:

- the current plugin and installed-package seam expose exactly `agentbus_send`, `agentbus_receive`, `agentbus_search_sessions`, and `agentbus_reply`;
- the reply model input accepts only the original `messageId`, body, and optional TTL, with no model-supplied target and no native permission request;
- the broker requires the caller to be the original authenticated target, hides missing/foreign/not-addressed distinctions behind `MESSAGE_NOT_FOUND`, and uses `MESSAGE_NOT_REPLYABLE` for an owned non-delivered original;
- reply lookup and routing use retained metadata without reading an erased original body, and fail after the parent is purged;
- each reply gets a fresh message ID, persists `replyToMessageId`, emits body-free metadata, and delivers as an explicitly untrusted `peer_message` to the original source;
- strict reply receipt, pending-header, consumed-message, presentation, and event schemas reject self-linkage where `replyToMessageId === messageId`;
- ordinary sends omit reply linkage, while multiple replies to one delivered original remain independently consumable;
- five independent built plugin/MCP clients issue overlapping replies to one original, hit the shared sixth-reply pending quota, produce unique IDs and body-free correlated events, and all five replies are consumed;
- reply bodies and TTLs receive the same error classification and rate, pending, durable, and active-target controls as ordinary sends;
- canonical schema v3 migrates transactionally through v4 and v5 without losing pending or delivered rows; any pre-existing v3 `reply_to_message_id` column fails before mutation or version advancement, including nullable `TEXT`, wrong type, `NOT NULL`, default, foreign-key, restrictive CHECK, and unique-index variants; valid v5 reopens unchanged, and no foreign key prevents independent child retention;
- broker restart with the same database and credential preserves replyability during the terminal-retention window; and
- send and reply runtimes reject body-free broker receipts whose hash or UTF-8 byte count does not match the submitted body;
- installed-package smoke exercises the full production four-tool send/deliver/reply/return path rather than tool-list or readiness seams alone.

## Protocol-v2 compatibility and upgrade

Automated coverage validates:

- protocol v2 is the sole accepted application envelope version and reply is not represented as additive v1 behavior;
- a live v2 broker rejects a v1 handshake, retains zero registrations, rejects operations, and returns conflict from the separate event-recovery endpoint until a successful v2 application handshake;
- a v2 runtime rejects a v1 broker handshake response before registration or event recovery;
- an authenticated v1 challenge at an occupied listener produces one fixed operator upgrade toast in automatic and manual modes, sends no bearer request, leaves the listener running, and exposes only the canonical unavailable error to the model;
- manual mode does not perform the TCP startup probe or launch after unavailable readiness, while unreachable, non-Agent-Bus, and invalid-auth endpoints produce no false upgrade toast;
- bootstrap does not probe, spawn, replace, or take over after a classified protocol mismatch; and
- after manual old-process restart, the bundled v2 broker migrates the same database from schema v3 through v5 before authenticated readiness.

## Bounded foreground admission

Automated coverage validates:

- 300 sessions aggregate across two independently instantiated built plugin/workspace clients sharing one authenticated broker principal, with all 300 active and none displaced;
- the functional minimum of 2 completes built search → send → approved receive → broker-authoritative reply → approved return delivery, never exceeds 2 active sessions, and deterministically displaces the unprotected background session;
- trusted foreground operations at a configured small limit of 8 complete while deterministic displacement keeps the persisted active count exactly 8;
- non-activating foreground identity resolution leaves durable and active counts unchanged, and reconnect resolves identity immediately before the real operation rather than registering it first;
- independent workspaces reach a configured durable-row boundary, preserve the foreground reserve, reclaim one deterministic state-free background row, and remain within both durable and active bounds;
- all four tools parse trusted per-call `ToolContext.sessionID` with `HostSessionIdSchema`, parse the exact returned registration with strict `ForegroundSessionSchema`, and complete exact-directory/session/project checks before broker readiness or runtime work;
- context and current-project worktrees are each required to be absolute and independently contain the exact directory, while valid unequal roots include global `/` plus a specific attached workspace and different nested roots; unrelated, escaping, or non-absolute roots fail pre-broker for send, reply, receive, and search;
- one successful call performs exactly one host validation in `session` → `project` → `ready` → `runtime` order, and the runtime strictly correlates the prevalidated registration without a second host query;
- a built server-mode composition uses a compatible simulated host with plugin startup at a simulated user home, a global current-project worktree `/`, and a more-specific attached ToolContext worktree; it executes search/send/receive/reply and verifies that static root scope and model-forged directory/worktree fields neither block nor override the trusted caller;
- invalid-character, control/Unicode-unsafe, empty, oversized, mismatched, malformed-metadata, missing, duplicate, failed, wrong-project, wrong-directory, and wrong-worktree host results return canonical unavailable and execute no broker readiness, authentication/probe/launch path, channel admission, or model operation;
- independent `/workspace/A` and `/workspace/B` sessions route status, pending toast, fixed wake, TUI selection, and approval warning only through their own trusted directories;
- trusted route entries are bounded to 256, refreshed by foreground/lifecycle data, removed on deletion, and cleared on disposal, while peer titles and bodies cannot select or leak a route;
- the model-facing send/reply/search/receive schemas expose no session, directory, worktree, or source selector, and receipts and peer results expose none of those filesystem authority fields;
- background/bootstrap rows are displaced before foreground-used rows, foreground recency survives restart, heartbeats do not refresh it, and stable creation/session-ID ties make victim selection deterministic;
- send protects its target, reply protects the broker-resolved original source, and simultaneous source/dependency reactivation occurs inside the same SQLite transaction;
- displaced sessions keep stable canonical identities and transparently re-enter on the next trusted tool call;
- pending bodies, headers, events, TTLs, and reply linkage survive displacement, and peer bodies remain absent from non-tool host surfaces;
- background registration and heartbeat activity does not steal foreground capacity or trigger channel reconnect loops; and
- a restart at saturation recovers pending state from a non-receive foreground operation before exactly-once receive, while an event racing the operation snapshot triggers a post-snapshot recovery; and
- fresh schema v5, canonical v4→v5 migration, persisted recency after restart, partial-migration rejection, malformed v4 type/null/default/PK/FK/CHECK/unique/index fixtures, rollback, and malformed-v5 reopen rejection are covered.

## Configurable active-session capacity

Automated coverage validates:

- the strict trusted plugin configuration defaults to 4096, accepts integer boundaries 2 and 16384, and rejects zero, one, negatives, fractions, `NaN`, strings, whitespace-padded strings, and values above the hard maximum;
- the manual broker CLI independently defaults to 4096 and rejects empty, signed, leading-zero, whitespace, fractional, exponent, non-numeric, zero, one, negative, and above-maximum environment values;
- an inherited `OPENCODE_AGENTBUS_MAX_ACTIVE_SESSIONS_PER_PRINCIPAL` does not override trusted plugin configuration, while autostart passes the exact parsed trusted option explicitly through the otherwise minimal child environment;
- the default broker quotas are 4096 active, 16384 durable per principal, 65536 durable globally, 4096 foreground reserve, and 4096 registrations per principal per minute;
- minimum, 300-session, and hard-maximum configurations derive coherent 4× per-principal and 16× global durable bounds, equal foreground reserve, and a registration budget of `max(256, active limit)`;
- active capacity above 16384 and derived durable, global, reserve, or registration quotas above 65536, 262144, 16384, and 16384 respectively fail closed;
- 300 direct registrations stay active without durable or registration accounting causing premature displacement, and 300 bootstrapped sessions across two workspaces remain active through a foreground search;
- protocol-v2 pending-event bindings accept more than the historical 256-session ceiling while remaining bounded by the 16384 hard maximum;
- the default store admits all 4096 active sessions in the ordinary unit suite without displacement, durable-cap exhaustion, or registration-rate exhaustion;
- authentication challenges derive as `4A + 256`: 16640 at the default and a finite maximum of 65792, while an actual 256-session lifecycle burst of `4A + 6` challenges remains below its derived 1280 budget and explicit smaller limiter overrides still rate-limit and refill deterministically;
- each active session's 120-second lease schedules its steady heartbeat every 60 seconds, and every authenticated MCP/heartbeat and SSE-opening request performs a fresh challenge, accounting for the active-sized heartbeat share of the formula;
- active-session and concurrent transport capacities are separate finite bounds: `W = ceil(4096 / 256) = 16` is the default dense-workspace estimate, four operational slots yield 20 MCP and 20 SSE connections per principal, and each transport is independently capped at 40 globally; sparse one-session workspaces may reach transport capacity before 4096 active sessions;
- deterministic lower-level server admission tests accept exactly 20 MCP sessions and 20 SSE streams for one principal, reject the 21st, accept exactly 40 of each across distinct test principals, reject the 41st globally, release one connection, accept its replacement, and clean every connection back to zero;
- MCP and SSE policy ceilings remain finite at 68 per principal and 136 globally at the hard active maximum, with invalid, above-maximum, and per-principal-above-global overrides rejected;
- a live lower-level server accepts and cleans nine simultaneous SSE streams under derived defaults, and a built integration sustains nine independent workspace runtimes with nine MCP sessions and nine SSE streams;
- plugin lifecycle membership and trusted session routes remain capped at 256 per runtime, evicting/deregistering the oldest local membership rather than creating a single 4096-session runtime map;
- all four model tool schemas and outputs omit the trusted capacity setting; and
- installed-package smoke verifies exact configured propagation and excludes cloud credentials and runtime injection variables from the broker child environment.

## Causal foreground recovery increment

Automated coverage validates:

- foreground operation and pending-list snapshots carry a required principal event high-water captured in the same SQLite transaction as pending headers;
- strict protocol-v2 parsing rejects a missing watermark, while cursor `0` is accepted as the explicit no-prior-event boundary;
- a live production broker SSE connection from cursor `0` receives the first later event without exposing its body, and the HTTP endpoint rejects missing, future, and retention-stale cursors;
- the broker subscribes before replay and orders/deduplicates replay overlap with buffered live events;
- the runtime closes the first-subscription gap with a post-subscription authoritative snapshot and does not publish an intermediate stale pending count;
- an active stream supersedes a delayed older foreground snapshot, while reordered and duplicate racing events converge to one final pending publication;
- event-triggered recovery refuses to apply a snapshot whose high-water precedes the triggering event;
- stale-cursor, invalid-frame, disconnect, and startup-timeout paths recover a new watermark and never reconnect cursorlessly;
- a disconnected-stream race in which registration A's foreground operation wins reconnect still recovers registration B's later event, and the scheduled resume observes the already-proved all-registration coverage rather than launching a competing partial recovery;
- saved-cursor replay and stale-cursor fallback both recover every active local registration; three-plus-registration tests restart convergence across concurrent addition, removal, and displaced foreground re-entry without publishing removed or partial state;
- duplicate and reordered cross-registration replay publishes only the stable final count and one notification, while a body-free pending-list snapshot remains available for an owned broker-displaced inbox without reactivation or active-cap change;
- timeout-bounded concurrency tests block A's authoritative list while B is added or broker-displaced B re-enters through foreground send and reply; releasing the list resolves every event, registration, and operation promise with one final A/B publication and no cyclic wait;
- reconnect startup can ingest a buffered replay event without hanging, duplicate event IDs coalesce across the ingestion/recovery handoff, and multiple events arriving during an authoritative fetch force a refetch to the final high-water without publishing the older count;
- a built-plugin/live-MCP test commits the first event after a foreground search response but before forwarding the runtime's first SSE request, then observes replay, the post-subscription list, one body-free notification, and exactly-once approved delivery; and
- the built plugin/live MCP/SQLite/SSE integrations force a stale cursor, observe HTTP 409 and one converged notification, recover an event committed only for another active local registration, reconnect with a non-null watermark, and preserve exactly-once pending delivery.

This increment introduces no new TUI permission flow: `agentbus_reply` does not disclose the original body. Existing manual OpenCode 1.18.23 wake, focus, and receive-approval gates remain unchanged.

## Remaining release gates

- Run the root-only wrong-owner database-file test in privileged security CI before public release.
- Run the opt-in real OpenCode server gate below. It changes the selected test server's configuration, may require a restart, and sends live messages, so it is not part of deterministic automation and has not been run in this increment.

## Opt-in real OpenCode server gate

Follow the [manual attached-client QA procedure](manual-qa.md). It preserves the server-root/attached-workspace condition and the eight acceptance observations without assuming a particular home directory, binary path, second project, or systemd unit. Keep machine-specific commands and results in the ignored `.local/` directory. This gate remains unrun; simulated integration coverage does not establish installed-host acceptance.

## Wake and approval visibility increment

Automated coverage verifies:

- authoritative arrival routes one exact fixed synthetic wake to the registered recipient host session;
- adversarial bodies, titles, source metadata, hashes, and broker strings do not enter the wake, permission UI, notifications, logs, or other non-tool surfaces;
- duplicate/recovery hints coalesce, unknown activity follows the validated sparse-map semantics, busy delivery waits for idle, failed or malformed status/host requests retry within a bound, and disposal cancels queued work;
- a real receive attempt latches the outstanding state, consume does not speculate an empty inbox, reject leaves it pending without another wake, and only authoritative empty clears the latch;
- receive-local list-empty/peek-positive disagreement preserves positive state, recovery-list zero remains authoritative, stale empty/positive attempts retry under a three-attempt bound without false `EMPTY`, stale permission, or stale consume, and local observation/current-header matching distinguishes equal-watermark terminal changes from unchanged recovery;
- an accepted positive observation that becomes stale during native approval cannot consume, and exhausted observation retries fail with the safe operation error;
- receive list/peek publication and post-consume refresh are recovery-lane-owned while native approval and consume remain outside the lane; concurrent receive/consume yields one delivery and an authoritative same-cursor `EMPTY` without replay;
- inactive registrations ignore cap-plus-one event floods, active-to-inactive and reconnect-to-inactive transitions prune only their buffered events and clear wake/count ownership, and foreground re-admission recovers durable pending headers before delivery;
- later pending state rearms subject to one 30-second per-recipient successful-wake cooldown;
- built arrival → wake → real receive preserves permission-before-consume ordering, rejection pending behavior, and exact per-peer `always` behavior;
- only `agentbus_receive` permission requests publish exact-session selection before fixed long-lived warning text, with SDK method receivers preserved, UI failures contained, and hook output unchanged;
- the product-tree auditor requires exactly one fixed wake call with its trusted resolved directory and otherwise permits only the exact direct host-list and routed wake-status session calls;
- negative fixtures verify rejection of aliased `Reflect.get`, `Object.getOwnPropertyDescriptor`, unknown helper arguments, whole-client escapes, client/session assignments/returns/destructuring, `.call`/`.apply`/`.bind`, assertion wrappers, other direct session members, and unresolved computed protected names;
- PluginInput-root alias fixtures cover declaration and later-assignment aliases, assertion wrappers, dynamic access, input→client→session alias chains, local helper argument/return escapes, and a full tree containing one legitimate fixed wake. The auditor does not claim arbitrary interprocedural or type-derived alias proof.

The integration host captures and validates the locked OpenCode 1.18.19-compatible API shapes, including independent attached-workspace routes, but is not a real server or interactive terminal. The opt-in gate above must still confirm fixed wake delivery, real receive approval behavior, `tui.session.select` navigation from a background/child request, route isolation, and usable warning duration on installed OpenCode 1.18.23.
