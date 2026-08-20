export const PROTOCOL_VERSION = 1 as const;

export const METHODS = Object.freeze({
  HANDSHAKE: "agentbus.handshake",
  REGISTER_SESSION: "agentbus.session.register",
  HEARTBEAT_SESSION: "agentbus.session.heartbeat",
  DEREGISTER_SESSION: "agentbus.session.deregister",
  ENQUEUE_MESSAGE: "agentbus.message.enqueue",
  PEEK_NEXT_MESSAGE: "agentbus.message.peek_next",
  LIST_PENDING_MESSAGES: "agentbus.message.list_pending",
  CONSUME_MESSAGE: "agentbus.message.consume",
  REJECT_MESSAGE: "agentbus.message.reject",
  SEARCH_SESSIONS: "agentbus.session.search",
} as const);

export type Method = (typeof METHODS)[keyof typeof METHODS];

// These are custom MCP JSON-RPC request methods, never MCP tool names and never raw model tools.
export const PENDING_MESSAGE_EVENT_TYPE = "agentbus.pending" as const;

export const DEFAULT_BROKER_ENDPOINT = "http://127.0.0.1:4097" as const;

export const AUTH_CHALLENGE_ENDPOINT = "/auth/challenge" as const;
export const AUTH_CHALLENGE_CLIENT_NONCE_HEADER = "X-AgentBus-Client-Nonce" as const;
export const AUTH_CHALLENGE_CONTENT_TYPE = "application/json" as const;
export const AUTH_CHALLENGE_PROOF_DOMAIN = "opencode-agentbus/auth-challenge-proof/v1" as const;

export const AUTH_CHALLENGE_HTTP_CONTRACT = Object.freeze({
  method: "GET",
  path: AUTH_CHALLENGE_ENDPOINT,
  clientNonceHeader: AUTH_CHALLENGE_CLIENT_NONCE_HEADER,
  contentType: AUTH_CHALLENGE_CONTENT_TYPE,
  authorization: "forbidden",
  query: "forbidden",
  body: "forbidden",
  cacheControl: "no-store",
  contentTypeOptions: "nosniff",
  errorBody: "canonical_application_error_envelope",
  rateLimit: "required_product_policy",
} as const);

export const AUTH_CHALLENGE_USAGE_CONTRACT = Object.freeze({
  bearerDisclosure: "only_after_successful_challenge_verification",
  mcp: "new_challenge_immediately_before_first_bearer_request",
  sse: "new_challenge_immediately_before_each_bearer_connection",
  mcpBrokerCorrelation: "handshake_broker_id_must_equal_challenge_broker_id",
} as const);

export const MCP_INITIALIZATION_CONTRACT = Object.freeze({
  initializeRequestMethod: "initialize",
  initializedNotificationMethod: "notifications/initialized",
  sessionHeader: "MCP-Session-Id",
  sessionManagedBy: "@modelcontextprotocol/sdk@1.30.0",
} as const);

export const MCP_HTTP_CONTRACT = Object.freeze({
  method: "POST",
  path: "/mcp",
  contentType: "application/json",
  accept: "application/json, text/event-stream",
  authentication: "bearer_client_principal",
  redirects: "forbidden",
} as const);

export const MCP_JSON_RPC_ERROR_USES = Object.freeze([
  "authentication_failure",
  "malformed_json_rpc",
  "mcp_initialization_or_session_failure",
  "unavailable_method",
] as const);

export const MCP_CUSTOM_METHOD_CONTRACT = Object.freeze({
  kind: "custom_json_rpc_request_methods",
  mcpToolRegistration: "none",
  openCodeRawMcpExposure: "forbidden",
  caller: "plugin_programmatic_sdk_client_only",
} as const);

export const CONNECTION_SECURITY_CONTRACT = Object.freeze({
  allowedHosts: Object.freeze(["127.0.0.1", "::1"]),
  protocol: "http_only_mvp",
  dns: "forbidden",
  tls: "forbidden_mvp",
  redirects: "forbidden",
  userinfoQueryFragment: "forbidden",
} as const);

export const SSE_HTTP_CONTRACT = Object.freeze({
  method: "GET",
  path: "/events",
  accept: "text/event-stream",
  contentType: "text/event-stream; charset=utf-8",
  authentication: "bearer_client_principal",
  cursorHeader: "Last-Event-ID",
} as const);

export const TRANSPORT_CONTRACT = Object.freeze({
  mcp: Object.freeze({
    transport: "streamable_http",
    bind: "loopback",
    path: "/mcp",
    authentication: "bearer_client_principal",
    exposure: "programmatic_plugin_only",
  }),
  events: Object.freeze({
    transport: "sse",
    bind: "loopback",
    path: "/events",
    authentication: "bearer_client_principal",
    content: "metadata_only",
  }),
} as const);

export const SSE_RECONNECT_SEMANTICS = Object.freeze({
  delivery: "best_effort",
  eventId: "monotonic_per_authenticated_principal_stream",
  lastEventId: "advisory_resume_cursor",
  authoritativeRecovery: Object.freeze([METHODS.LIST_PENDING_MESSAGES, METHODS.PEEK_NEXT_MESSAGE]),
} as const);

export const DEFAULT_EVENT_REPLAY_WINDOW = 256;
export const MAX_EVENT_REPLAY_WINDOW = 1_024;

export const EVENT_STREAM_REPLAY_CONTRACT = Object.freeze({
  sequenceScope: "authenticated_principal",
  connectionScope: "one_connection_receives_all_active_targets_owned_by_principal",
  delivery: "hint_only_best_effort",
  cursorReplay: "valid_cursor_replays_events_strictly_after_cursor",
  missingCursor: "list_pending_recovery_then_connect_live",
  staleOrUnknownCursor: "EVENT_CURSOR_EXPIRED",
  staleCursorRecovery: "list_pending_then_reconnect_without_cursor",
  cursorExpiredHttpStatus: 409,
  cursorErrorBody: "canonical_application_error_envelope",
  cursorErrorRequestId: "broker_generated_safe_correlation_id",
  boundedReplayWindow: DEFAULT_EVENT_REPLAY_WINDOW,
  authoritativeRecovery: Object.freeze([METHODS.LIST_PENDING_MESSAGES, METHODS.PEEK_NEXT_MESSAGE]),
} as const);

export const BROKER_LIFECYCLE_CONTRACT = Object.freeze({
  launch: "separately_launched_daemon",
  pluginProcessManagement: "never_spawn_or_kill",
} as const);

export const CREDENTIAL_FILE_MODE = 0o600;
export const CREDENTIAL_PROVISIONING_CONTRACT = Object.freeze({
  tokenEntropyBits: 256,
  tokenEncoding: "base64url_without_padding",
  brokerId: "generated_once_and_persisted_by_daemon",
  principalUniqueness: "globally_unique_per_credential_file_and_plugin_installation",
  source: "trusted_plugin_options_or_environment_only",
  authenticationMapping: "bearer_token_to_unique_principal_id",
  exposure: "secret_out_of_band_never_model_facing",
} as const);

export const TOKEN_ROTATION_CONTRACT = Object.freeze({
  action: "replace_token_and_invalidate_existing_connections",
  requiredRecovery: Object.freeze(["reconnect", "mcp_reinitialize", "reregister_sessions"]),
} as const);

export const IDENTITY_AUTHORITY = Object.freeze({
  brokerId: "broker_daemon_identity",
  serverId: "authenticated_client_principal",
  sessionId: "broker_issued_or_derived",
} as const);

export const REGISTRATION_SEMANTICS = Object.freeze({
  idempotencyKey: "principal_id+host_session_id",
  principalGuarantee: "principal_id_is_unique_per_credential_file_and_plugin_installation",
  reregistration: "same canonical identity; replace safe metadata and refresh the session lease",
  reconnect: "repeat registration after reconnect before using the canonical identity",
} as const);

export const PENDING_ORDERING = "enqueued_at_asc_then_message_id_asc" as const;

export const EXPIRY_SEMANTICS = Object.freeze({
  pendingWhen: "now_less_than_expires_at",
  expiredWhen: "now_greater_than_or_equal_to_expires_at",
  rejectConflicts: Object.freeze(["DELIVERED", "EXPIRED", "BODY_HASH_MISMATCH"]),
} as const);

export const REJECT_SEMANTICS = Object.freeze({
  transition: "PENDING_to_REJECTED_atomic",
  bodyReturned: false,
  replay: "same_target_message_and_hash_returns_already_rejected",
  conflicts: EXPIRY_SEMANTICS.rejectConflicts,
} as const);

export const MIN_ID_BYTES = 1;
export const MAX_ID_BYTES = 128;

export const MAX_TITLE_BYTES = 256;
export const MAX_LABEL_BYTES = 64;
export const MAX_LABELS = 16;
export const MAX_METADATA_BYTES = 1_024;

export const MAX_MESSAGE_BYTES = 65_536;
export const MIN_MESSAGE_TTL_SECONDS = 10;
export const MAX_MESSAGE_TTL_SECONDS = 86_400;
export const DEFAULT_MESSAGE_TTL_SECONDS = 3_600;

export const MIN_SESSION_LEASE_SECONDS = 30;
export const MAX_SESSION_LEASE_SECONDS = 300;
export const DEFAULT_SESSION_LEASE_SECONDS = 120;

export const MAX_QUERY_BYTES = 512;
export const MIN_SEARCH_LIMIT = 1;
export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_PENDING_LIST_LIMIT = 100;
export const DEFAULT_PENDING_LIST_LIMIT = 20;
export const MAX_ACTIVE_SESSIONS_PER_PRINCIPAL = 256;

export const MIN_RETRY_AFTER_MS = 100;
export const MAX_RETRY_AFTER_MS = 60_000;
export const MAX_ERROR_MESSAGE_BYTES = 512;
export const MAX_SUPPORTED_PROTOCOL_VERSIONS = 8;
export const MIN_CONNECTION_TIMEOUT_MS = 100;
export const MAX_CONNECTION_TIMEOUT_MS = 30_000;
export const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
export const MAX_CREDENTIAL_FILE_PATH_BYTES = 4_096;

export const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const HASH_PATTERN = /^[0-9a-f]{64}$/;
export const BODY_HASH_PATTERN = HASH_PATTERN;

export const MESSAGE_STATES = ["PENDING", "DELIVERED", "REJECTED", "EXPIRED"] as const;

export const ERROR_CODES = [
  "INVALID_REQUEST",
  "UNSUPPORTED_PROTOCOL_VERSION",
  "EVENT_CURSOR_EXPIRED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "SESSION_NOT_REGISTERED",
  "TARGET_NOT_REGISTERED",
  "MESSAGE_NOT_FOUND",
  "MESSAGE_NOT_PENDING",
  "MESSAGE_TOO_LARGE",
  "MESSAGE_EXPIRED",
  "MESSAGE_REJECTED",
  "BODY_HASH_MISMATCH",
  "TTL_OUT_OF_RANGE",
  "RATE_LIMITED",
  "CONFLICT",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = Object.freeze({
  INVALID_REQUEST: "The request is invalid.",
  UNSUPPORTED_PROTOCOL_VERSION: "No supported protocol version was offered.",
  EVENT_CURSOR_EXPIRED: "The event replay cursor is unknown or no longer retained.",
  UNAUTHENTICATED: "Authentication is required.",
  FORBIDDEN: "The authenticated principal does not own the requested session.",
  SESSION_NOT_REGISTERED: "The source session is not registered.",
  TARGET_NOT_REGISTERED: "The target session is not registered.",
  MESSAGE_NOT_FOUND: "The message does not exist.",
  MESSAGE_NOT_PENDING: "The message is no longer pending.",
  MESSAGE_TOO_LARGE: "The message exceeds the configured size limit.",
  MESSAGE_EXPIRED: "The message has expired.",
  MESSAGE_REJECTED: "The message was rejected.",
  BODY_HASH_MISMATCH: "The expected body hash does not match.",
  TTL_OUT_OF_RANGE: "The requested message lifetime is outside the allowed range.",
  RATE_LIMITED: "The request rate limit was exceeded.",
  CONFLICT: "The request conflicts with current broker state.",
  INTERNAL_ERROR: "The broker could not complete the request.",
});

export const HTTP_STATUS_BY_ERROR_CODE: Readonly<Record<ErrorCode, number>> = Object.freeze({
  INVALID_REQUEST: 400,
  UNSUPPORTED_PROTOCOL_VERSION: 400,
  EVENT_CURSOR_EXPIRED: 409,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  SESSION_NOT_REGISTERED: 404,
  TARGET_NOT_REGISTERED: 404,
  MESSAGE_NOT_FOUND: 404,
  MESSAGE_NOT_PENDING: 409,
  MESSAGE_TOO_LARGE: 413,
  MESSAGE_EXPIRED: 409,
  MESSAGE_REJECTED: 409,
  BODY_HASH_MISMATCH: 409,
  TTL_OUT_OF_RANGE: 400,
  RATE_LIMITED: 429,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
});

export const OPERATION_OWNERSHIP_CLAIMS = Object.freeze({
  [METHODS.HEARTBEAT_SESSION]: "params.session",
  [METHODS.DEREGISTER_SESSION]: "params.session",
  [METHODS.ENQUEUE_MESSAGE]: "params.source",
  [METHODS.PEEK_NEXT_MESSAGE]: "params.target",
  [METHODS.LIST_PENDING_MESSAGES]: "params.target",
  [METHODS.CONSUME_MESSAGE]: "params.target",
  [METHODS.REJECT_MESSAGE]: "params.target",
  [METHODS.SEARCH_SESSIONS]: "params.requester",
} as const);
