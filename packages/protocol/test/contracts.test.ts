import { describe, expect, test } from "bun:test";

import {
  AuthenticatedClientPrincipalSchema,
  AuthenticatedEnqueueOperationInputSchema,
  AuthenticatedPendingMessageEventInputSchema,
  AuthenticatedRegisterOperationInputSchema,
  CanonicalSearchQuerySchema,
  ConsumeMessageRequestSchema,
  ConsumedMessageResultSchema,
  DEFAULT_SESSION_LEASE_SECONDS,
  DeregisterSessionRequestSchema,
  ERROR_MESSAGES,
  EnqueueMessageRequestSchema,
  EXPIRY_SEMANTICS,
  ForegroundIdentityRequestSchema,
  ForegroundIdentityResponseSchema,
  HandshakeRequestSchema,
  ListPendingMessagesRequestSchema,
  ListPendingMessagesResultSchema,
  MAX_QUERY_BYTES,
  MAX_SESSION_LEASE_SECONDS,
  METHODS,
  MIN_SESSION_LEASE_SECONDS,
  OPERATION_OWNERSHIP_CLAIMS,
  PENDING_MESSAGE_EVENT_TYPE,
  PENDING_ORDERING,
  PROTOCOL_VERSION,
  PendingMessageEventSchema,
  PendingMessageHeaderSchema,
  PeerMessagePresentationSchema,
  PrincipalSessionBindingSchema,
  REGISTRATION_SEMANTICS,
  RejectMessageRequestSchema,
  RejectMessageResultSchema,
  RequestIdSchema,
  SSE_RECONNECT_SEMANTICS,
  SearchSessionsRequestSchema,
  SearchSessionsResultSchema,
  SessionHeartbeatResultSchema,
  SessionIdentitySchema,
  TRANSPORT_CONTRACT,
  bodySha256,
  brokerScopeFingerprint,
  comparePendingHeaders,
  consumeRequestMatchesHeader,
  consumedResultMatchesHeader,
  createErrorEnvelope,
  hashNormalizedSearchQuery,
  isExpiredAt,
  listPendingResultMatchesRequest,
  mapTransportError,
  negotiateProtocolVersion,
  normalizeSearchQuery,
  pendingEventMatchesTargetBinding,
  rejectRequestMatchesHeader,
  registrationResultMatchesInput,
  responseCorrelatesToRequest,
  searchPermissionResource,
  searchResultMatchesRequest,
  sessionFingerprint,
  toPeerMessagePresentation,
} from "../src/index";
import type {
  AuthenticatedClientPrincipal,
  PendingMessageHeader,
  SessionIdentity,
} from "../src/index";

const requestId = RequestIdSchema.parse("request_01");
const now = "2026-08-20T10:00:00.000Z";
const later = "2026-08-20T11:00:00.000Z";

const principal: AuthenticatedClientPrincipal = AuthenticatedClientPrincipalSchema.parse({
  principalId: "principal_01",
  serverId: "server_01",
});

function session(sessionId: string): SessionIdentity {
  return SessionIdentitySchema.parse({
    broker: { brokerId: "broker_01", serverId: principal.serverId },
    sessionId,
  });
}

const source = session("session_source");
const target = session("session_target");

function header(messageId = "message_01", enqueuedAt = now): PendingMessageHeader {
  return PendingMessageHeaderSchema.parse({
    messageId,
    source,
    target,
    bodyHash: bodySha256("peer secret"),
    bodyBytes: 11,
    state: "PENDING",
    enqueuedAt,
    expiresAt: later,
  });
}

function requestBase(method: string) {
  return { protocolVersion: PROTOCOL_VERSION, requestId, method };
}

describe("versioned transport contract", () => {
  test("freezes protocol version, method names, and loopback authenticated transports", () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(METHODS).toEqual({
      HANDSHAKE: "agentbus.handshake",
      REGISTER_SESSION: "agentbus.session.register",
      RESOLVE_FOREGROUND_SESSION: "agentbus.session.resolve_foreground",
      HEARTBEAT_SESSION: "agentbus.session.heartbeat",
      DEREGISTER_SESSION: "agentbus.session.deregister",
      ENQUEUE_MESSAGE: "agentbus.message.enqueue",
      REPLY_MESSAGE: "agentbus.message.reply",
      PEEK_NEXT_MESSAGE: "agentbus.message.peek_next",
      LIST_PENDING_MESSAGES: "agentbus.message.list_pending",
      CONSUME_MESSAGE: "agentbus.message.consume",
      REJECT_MESSAGE: "agentbus.message.reject",
      SEARCH_SESSIONS: "agentbus.session.search",
    });
    expect(TRANSPORT_CONTRACT.mcp).toEqual({
      transport: "streamable_http",
      bind: "loopback",
      path: "/mcp",
      authentication: "bearer_client_principal",
      exposure: "programmatic_plugin_only",
    });
    expect(TRANSPORT_CONTRACT.events.transport).toBe("sse");
    expect(TRANSPORT_CONTRACT.events.authentication).toBe("bearer_client_principal");
  });

  test("handshake negotiates only version 2 and rejects strict version-1 traffic", () => {
    const supported = HandshakeRequestSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      method: METHODS.HANDSHAKE,
      params: { supportedProtocolVersions: [2] },
    });
    const incompatible = HandshakeRequestSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      method: METHODS.HANDSHAKE,
      params: { supportedProtocolVersions: [1] },
    });

    const accepted = negotiateProtocolVersion(supported, "broker_01", principal);
    const rejected = negotiateProtocolVersion(incompatible, "broker_01", principal);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.protocolVersion).toBe(2);
      expect(accepted.requestId as string).toBe(requestId);
      expect(accepted.result.broker.serverId).toBe(principal.serverId);
    }
    expect(rejected).toEqual(createErrorEnvelope(requestId, "UNSUPPORTED_PROTOCOL_VERSION"));
    expect(
      EnqueueMessageRequestSchema.safeParse({
        ...requestBase(METHODS.ENQUEUE_MESSAGE),
        protocolVersion: 1,
        params: { source, target, body: "hello", ttlSeconds: 60 },
      }).success,
    ).toBe(false);
  });

  test("maps transport failures to stable non-sensitive errors", () => {
    expect(ERROR_MESSAGES.INTERNAL_ERROR).toBe("The broker could not complete the request.");
    expect(mapTransportError(new Error("secret database path"), requestId)).toEqual(
      createErrorEnvelope(requestId, "INTERNAL_ERROR"),
    );
    expect(createErrorEnvelope(requestId, "RATE_LIMITED", { retryAfterMs: 1_000 })).toMatchObject({
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: ERROR_MESSAGES.RATE_LIMITED,
        details: { retryAfterMs: 1_000 },
      },
    });
  });
});

describe("principal-bound registration lifecycle", () => {
  test("foreground identity resolution is strict and explicitly non-activating", () => {
    const request = ForegroundIdentityRequestSchema.parse({
      ...requestBase(METHODS.RESOLVE_FOREGROUND_SESSION),
      params: {
        hostSessionId: "host_foreground",
        metadata: { title: "Trusted current session" },
      },
    });

    expect(request.params.hostSessionId as string).toBe("host_foreground");
    expect(
      ForegroundIdentityRequestSchema.safeParse({
        ...request,
        params: { ...request.params, source: source, target, body: "peer-controlled" },
      }).success,
    ).toBe(false);
    expect(
      ForegroundIdentityResponseSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        ok: true,
        result: {
          hostSessionId: "host_foreground",
          identity: source,
          fingerprint: sessionFingerprint(source),
          metadata: { title: "Trusted current session" },
          leaseSeconds: DEFAULT_SESSION_LEASE_SECONDS,
        },
      }).success,
    ).toBe(true);
  });

  test("principal context is out-of-band and rejects bearer secrets", () => {
    expect(
      AuthenticatedClientPrincipalSchema.safeParse({
        ...principal,
        bearerToken: "must-never-enter-a-schema",
      }).success,
    ).toBe(false);
    expect(OPERATION_OWNERSHIP_CLAIMS[METHODS.ENQUEUE_MESSAGE]).toBe("params.source");
    expect(OPERATION_OWNERSHIP_CLAIMS[METHODS.SEARCH_SESSIONS]).toBe("params.requester");
  });

  test("registration accepts a host session ID and broker returns canonical identity", () => {
    const input = AuthenticatedRegisterOperationInputSchema.parse({
      principal,
      daemon: { brokerId: "broker_01" },
      request: {
        requestId,
        method: METHODS.REGISTER_SESSION,
        protocolVersion: PROTOCOL_VERSION,
        params: {
          hostSessionId: "host_session_01",
          optIn: true,
          metadata: { title: "Review agent", labels: ["reviewer"] },
        },
      },
    });
    const result = {
      hostSessionId: "host_session_01",
      identity: target,
      fingerprint: sessionFingerprint(target),
      metadata: input.request.params.metadata,
      registration: "created",
      leaseSeconds: DEFAULT_SESSION_LEASE_SECONDS,
      leaseExpiresAt: later,
    } as const;

    expect(registrationResultMatchesInput(input, result)).toBe(true);
    expect(
      registrationResultMatchesInput(input, {
        ...result,
        identity: SessionIdentitySchema.parse({
          broker: { brokerId: "broker_01", serverId: "other_server" },
          sessionId: "session_target",
        }),
      }),
    ).toBe(false);
    expect(REGISTRATION_SEMANTICS.idempotencyKey).toBe("principal_id+host_session_id");
    expect(REGISTRATION_SEMANTICS.reregistration).toContain("same canonical identity");
    expect(
      registrationResultMatchesInput(input, { ...result, registration: "refreshed" }, result),
    ).toBe(true);
    expect(
      registrationResultMatchesInput(input, { ...result, registration: "deferred" }, result),
    ).toBe(true);
    expect(
      registrationResultMatchesInput(
        input,
        {
          ...result,
          registration: "refreshed",
          identity: session("different_session"),
          fingerprint: sessionFingerprint(session("different_session")),
        },
        result,
      ),
    ).toBe(false);
  });

  test("lease limits and lifecycle operation contracts are bounded", () => {
    expect(MIN_SESSION_LEASE_SECONDS).toBeGreaterThanOrEqual(30);
    expect(DEFAULT_SESSION_LEASE_SECONDS).toBeGreaterThanOrEqual(MIN_SESSION_LEASE_SECONDS);
    expect(MAX_SESSION_LEASE_SECONDS).toBeGreaterThan(DEFAULT_SESSION_LEASE_SECONDS);

    expect(
      DeregisterSessionRequestSchema.safeParse({
        ...requestBase(METHODS.DEREGISTER_SESSION),
        params: { session: target },
      }).success,
    ).toBe(true);
    expect(
      SessionHeartbeatResultSchema.safeParse({
        identity: target,
        leaseSeconds: DEFAULT_SESSION_LEASE_SECONDS,
        leaseExpiresAt: later,
      }).success,
    ).toBe(true);
  });

  test("service-operation inputs cannot omit or mismatch authenticated ownership", () => {
    const request = EnqueueMessageRequestSchema.parse({
      ...requestBase(METHODS.ENQUEUE_MESSAGE),
      params: { source, target, body: "hello", ttlSeconds: 60 },
    });
    const binding = PrincipalSessionBindingSchema.parse({
      ownerPrincipalId: principal.principalId,
      hostSessionId: "host_session_01",
      identity: source,
    });

    expect(AuthenticatedEnqueueOperationInputSchema.safeParse({ request, binding }).success).toBe(
      false,
    );
    expect(
      AuthenticatedEnqueueOperationInputSchema.safeParse({
        principal: { ...principal, principalId: "other_principal" },
        binding,
        request,
      }).success,
    ).toBe(false);
    expect(
      AuthenticatedEnqueueOperationInputSchema.safeParse({ principal, binding, request }).success,
    ).toBe(true);
  });
});

describe("metadata-only notifications and pending recovery", () => {
  test("pending SSE events contain no peer-controlled display or content fields", () => {
    const eventInput = {
      protocolVersion: PROTOCOL_VERSION,
      event: PENDING_MESSAGE_EVENT_TYPE,
      eventId: "1",
      correlationId: requestId,
      target,
      header: header(),
    } as const;
    const event = PendingMessageEventSchema.parse(eventInput);
    expect(PendingMessageEventSchema.safeParse(event).success).toBe(true);
    for (const forbidden of ["body", "title", "labels", "query", "displayText"]) {
      expect(
        PendingMessageEventSchema.safeParse({ ...eventInput, [forbidden]: "unsafe" }).success,
      ).toBe(false);
    }

    const binding = PrincipalSessionBindingSchema.parse({
      ownerPrincipalId: principal.principalId,
      hostSessionId: "host_session_02",
      identity: target,
    });
    expect(
      AuthenticatedPendingMessageEventInputSchema.safeParse({
        principal,
        bindings: [binding],
        event,
      }).success,
    ).toBe(true);
    expect(pendingEventMatchesTargetBinding(event, binding)).toBe(true);
  });

  test("SSE is best effort and list/peek are authoritative ordered recovery", () => {
    expect(SSE_RECONNECT_SEMANTICS.delivery).toBe("best_effort");
    expect(SSE_RECONNECT_SEMANTICS.authoritativeRecovery).toEqual([
      METHODS.LIST_PENDING_MESSAGES,
      METHODS.PEEK_NEXT_MESSAGE,
    ]);
    expect(PENDING_ORDERING).toBe("enqueued_at_asc_then_message_id_asc");

    const first = header("message_01", "2026-08-20T09:00:00.000Z");
    const second = header("message_02", "2026-08-20T09:00:00.000Z");
    const request = ListPendingMessagesRequestSchema.parse({
      ...requestBase(METHODS.LIST_PENDING_MESSAGES),
      params: { target, limit: 20 },
    });
    expect(request.params.limit).toBe(20);
    const result = ListPendingMessagesResultSchema.parse({
      target,
      requestedLimit: 20,
      eventCursor: "0",
      headers: [first, second],
    });
    expect(listPendingResultMatchesRequest(request, result)).toBe(true);
    expect(
      ListPendingMessagesResultSchema.safeParse({
        target,
        requestedLimit: 20,
        eventCursor: "0",
        headers: [second, first],
      }).success,
    ).toBe(false);
    expect(
      ListPendingMessagesResultSchema.safeParse({
        target,
        requestedLimit: 20,
        headers: [first, second],
      }).success,
    ).toBe(false);
    expect(comparePendingHeaders(first, second)).toBeLessThan(0);
  });
});

describe("atomic consume/reject contracts", () => {
  test("consume and reject requests are expectation-bound to the peeked header", () => {
    const pending = header();
    const consume = ConsumeMessageRequestSchema.parse({
      ...requestBase(METHODS.CONSUME_MESSAGE),
      params: {
        messageId: pending.messageId,
        target: pending.target,
        expectedBodyHash: pending.bodyHash,
      },
    });
    const reject = RejectMessageRequestSchema.parse({
      ...requestBase(METHODS.REJECT_MESSAGE),
      params: {
        messageId: pending.messageId,
        target: pending.target,
        expectedBodyHash: pending.bodyHash,
      },
    });

    expect(consumeRequestMatchesHeader(pending, consume)).toBe(true);
    expect(rejectRequestMatchesHeader(pending, reject)).toBe(true);
    const otherMessage = RejectMessageRequestSchema.parse({
      ...reject,
      params: { ...reject.params, messageId: "message_other" },
    });
    expect(rejectRequestMatchesHeader(pending, otherMessage)).toBe(false);
  });

  test("reject is body-free, idempotent only for the same rejection, and race-safe", () => {
    const value = {
      messageId: "message_01",
      target,
      bodyHash: bodySha256("peer secret"),
      state: "REJECTED",
      disposition: "already_rejected",
      rejectedAt: now,
    } as const;
    expect(RejectMessageResultSchema.safeParse(value).success).toBe(true);
    expect(RejectMessageResultSchema.safeParse({ ...value, body: "peer secret" }).success).toBe(
      false,
    );
    expect(RejectMessageResultSchema.safeParse({ ...value, state: "DELIVERED" }).success).toBe(
      false,
    );
    expect(EXPIRY_SEMANTICS.rejectConflicts).toEqual([
      "DELIVERED",
      "EXPIRED",
      "BODY_HASH_MISMATCH",
    ]);
  });

  test("wire consume result is validated before untrusted model presentation", () => {
    const pending = header();
    const wire = ConsumedMessageResultSchema.parse({
      messageId: pending.messageId,
      source: pending.source,
      target: pending.target,
      body: "peer secret",
      bodyHash: pending.bodyHash,
      bodyBytes: pending.bodyBytes,
      state: "DELIVERED",
      deliveredAt: now,
    });
    expect(consumedResultMatchesHeader(pending, wire)).toBe(true);
    expect(
      consumedResultMatchesHeader(pending, {
        ...wire,
        source: session("unexpected_source"),
      }),
    ).toBe(false);

    const presentation = toPeerMessagePresentation(wire);
    expect(PeerMessagePresentationSchema.parse(presentation)).toMatchObject({
      type: "peer_message",
      trust: "untrusted",
    });
  });
});

describe("Unicode integrity and canonical search", () => {
  test("rejects isolated surrogates before sizing or hashing", () => {
    const isolated = "\ud800";
    const replacement = "\ufffd";

    expect(
      EnqueueMessageRequestSchema.safeParse({
        ...requestBase(METHODS.ENQUEUE_MESSAGE),
        params: { source, target, body: isolated, ttlSeconds: 60 },
      }).success,
    ).toBe(false);
    expect(() => bodySha256(isolated)).toThrow();
    const replacementHash = bodySha256(replacement);
    expect(replacementHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("normalizes first, then validates canonical byte and control limits", () => {
    const canonical = normalizeSearchQuery("  CAFÉ\u3000Agent  ");
    expect(canonical as string).toBe("café agent");
    expect(CanonicalSearchQuerySchema.safeParse(canonical).success).toBe(true);
    expect(CanonicalSearchQuerySchema.safeParse(" CAFÉ ").success).toBe(false);
    expect(normalizeSearchQuery(`${" ".repeat(MAX_QUERY_BYTES * 2)}a`) as string).toBe("a");
    expect(() => normalizeSearchQuery("é".repeat(MAX_QUERY_BYTES))).toThrow();
  });

  test("search request accepts only canonical query and result correlation is exact", () => {
    const query = normalizeSearchQuery(" Reviewer ");
    const request = SearchSessionsRequestSchema.parse({
      ...requestBase(METHODS.SEARCH_SESSIONS),
      params: { requester: source, scope: source.broker, query, limit: 5 },
    });
    const result = SearchSessionsResultSchema.parse({
      scope: source.broker,
      queryHash: hashNormalizedSearchQuery(query),
      requestedLimit: 5,
      matches: [
        {
          session: target,
          fingerprint: sessionFingerprint(target),
          metadata: { title: "Review agent", labels: ["reviewer"] },
        },
      ],
    });

    expect(
      SearchSessionsRequestSchema.safeParse({
        ...request,
        params: { ...request.params, query: " Reviewer " },
      }).success,
    ).toBe(false);
    expect(searchResultMatchesRequest(request, result)).toBe(true);
    expect(searchResultMatchesRequest(request, { ...result, requestedLimit: 4 })).toBe(false);
    expect(
      SearchSessionsResultSchema.safeParse({
        ...result,
        matches: [{ ...result.matches[0], fingerprint: sessionFingerprint(source) }],
      }).success,
    ).toBe(false);
    expect(searchPermissionResource(source.broker, query)).toBe(
      `scope:${brokerScopeFingerprint(source.broker)}:query:${result.queryHash}`,
    );
  });

  test("expiry is inclusive at the boundary", () => {
    expect(isExpiredAt(later, "2026-08-20T10:59:59.999Z")).toBe(false);
    expect(isExpiredAt(later, later)).toBe(true);
    expect(EXPIRY_SEMANTICS.expiredWhen).toBe("now_greater_than_or_equal_to_expires_at");
    expect(PendingMessageHeaderSchema.safeParse({ ...header(), expiresAt: now }).success).toBe(
      false,
    );
  });

  test("success and error envelopes correlate only to the originating request", () => {
    const request = EnqueueMessageRequestSchema.parse({
      ...requestBase(METHODS.ENQUEUE_MESSAGE),
      params: { source, target, body: "hello", ttlSeconds: 60 },
    });
    expect(responseCorrelatesToRequest(request, createErrorEnvelope(requestId, "CONFLICT"))).toBe(
      true,
    );
    expect(
      responseCorrelatesToRequest(request, createErrorEnvelope("request_other", "CONFLICT")),
    ).toBe(false);
  });
});
