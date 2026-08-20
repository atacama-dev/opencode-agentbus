import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";

import {
  BODY_HASH_PATTERN,
  BrokerServerIdentitySchema,
  ConsumeMessageRequestSchema,
  ConsumedPeerMessageSchema,
  DEFAULT_MESSAGE_TTL_SECONDS,
  DeregisterSessionRequestSchema,
  EnqueueMessageReceiptSchema,
  EnqueueMessageRequestSchema,
  ERROR_MESSAGES,
  ErrorEnvelopeSchema,
  HASH_PATTERN,
  MAX_LABEL_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_METADATA_BYTES,
  MAX_QUERY_BYTES,
  MAX_SEARCH_LIMIT,
  MAX_TITLE_BYTES,
  METHODS,
  MESSAGE_STATES,
  MIN_MESSAGE_TTL_SECONDS,
  PendingMessageHeaderSchema,
  PeekNextMessageRequestSchema,
  PeekNextMessageResultSchema,
  PROTOCOL_VERSION,
  ReceivePermissionMetadataSchema,
  RegisterSessionRequestSchema,
  SearchSessionsRequestSchema,
  SearchSessionsResultSchema,
  SessionIdentitySchema,
  SessionMetadataSchema,
  bodySha256,
  brokerScopeFingerprint,
  hashNormalizedSearchQuery,
  normalizeSearchQuery,
  receivePermissionResource,
  searchPermissionResource,
  sessionFingerprint,
} from "../src/index";
import type {
  PendingMessageHeader,
  ReceivePermissionMetadata,
  SessionIdentity,
} from "../src/index";

const brokerInput = {
  brokerId: "broker_01",
  serverId: "server_01",
};

function session(sessionId: string, broker = brokerInput): SessionIdentity {
  return SessionIdentitySchema.parse({ broker, sessionId });
}

const source = session("session_source");
const target = session("session_target");
const now = "2026-08-20T10:00:00.000Z";
const later = "2026-08-20T11:00:00.000Z";

function requestBase(method: string) {
  return { protocolVersion: PROTOCOL_VERSION, requestId: "request_legacy", method };
}

function pendingHeader(): PendingMessageHeader {
  return PendingMessageHeaderSchema.parse({
    messageId: "message_01",
    source,
    target,
    bodyHash: bodySha256("peer secret"),
    bodyBytes: 11,
    state: "PENDING",
    enqueuedAt: now,
    expiresAt: later,
  });
}

describe("canonical identity and permission resources", () => {
  test("parsed session identity is immutable at both levels", () => {
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.broker)).toBe(true);
  });

  test("session and broker fingerprints are deterministic and domain-separated", () => {
    const first = sessionFingerprint(source);
    const second = sessionFingerprint(SessionIdentitySchema.parse({ ...source }));
    const scope = brokerScopeFingerprint(BrokerServerIdentitySchema.parse(brokerInput));

    expect(first).toBe(second);
    expect(first).toMatch(HASH_PATTERN);
    expect(scope).toMatch(HASH_PATTERN);
    expect(first).not.toBe(scope);
    expect(sessionFingerprint(session("session_other"))).not.toBe(first);
    expect(
      sessionFingerprint(session("session_source", { ...brokerInput, serverId: "server_02" })),
    ).not.toBe(first);
  });

  test("receive resources use the exact target/source order and safe characters", () => {
    const resource = receivePermissionResource(target, source);

    expect(resource).toBe(
      `target:${sessionFingerprint(target)}:sender:${sessionFingerprint(source)}`,
    );
    expect(resource).toMatch(/^target:[0-9a-f]{64}:sender:[0-9a-f]{64}$/);
    expect(resource).not.toMatch(/[?*[\]{}\\]/);
    expect(receivePermissionResource(target, session("session_other"))).not.toBe(resource);
    expect(receivePermissionResource(session("session_other_target"), source)).not.toBe(resource);
    expect(receivePermissionResource(source, target)).not.toBe(resource);
  });

  test("titles and labels never affect receive authorization", () => {
    const firstRegistration = RegisterSessionRequestSchema.parse({
      ...requestBase(METHODS.REGISTER_SESSION),
      params: {
        hostSessionId: "host_session_01",
        optIn: true,
        metadata: { title: "Build agent", labels: ["builder"] },
      },
    });
    const renamedRegistration = RegisterSessionRequestSchema.parse({
      ...requestBase(METHODS.REGISTER_SESSION),
      params: {
        hostSessionId: "host_session_01",
        optIn: true,
        metadata: { title: "Completely different title", labels: ["reviewer"] },
      },
    });

    expect(firstRegistration.params.metadata).not.toEqual(renamedRegistration.params.metadata);
    expect(receivePermissionResource(target, source)).toBe(
      receivePermissionResource(target, source),
    );
  });

  test("identity schemas reject wildcard, delimiter, whitespace, and control characters", () => {
    for (const sessionId of ["session*", "session?", "session:id", "session id", "session\n"])
      expect(SessionIdentitySchema.safeParse({ broker: brokerInput, sessionId }).success).toBe(
        false,
      );

    expect(
      BrokerServerIdentitySchema.safeParse({ ...brokerInput, brokerId: "broker\u0000id" }).success,
    ).toBe(false);
  });
});

describe("canonical content hashes and search resources", () => {
  test("body hashes are SHA-256 over exact UTF-8 bytes", () => {
    expect(bodySha256("abc") as string).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(bodySha256("é")).not.toBe(bodySha256("e\u0301"));
    expect(bodySha256("abc")).toMatch(BODY_HASH_PATTERN);
  });

  test("queries normalize with NFKC, case folding, trimming, and whitespace collapse", () => {
    const visuallyEquivalent = "  CAFÉ\u3000Agent  ";
    const decomposed = "cafe\u0301   agent";

    const normalizedVisual = normalizeSearchQuery(visuallyEquivalent);
    const normalizedDecomposed = normalizeSearchQuery(decomposed);
    expect(normalizedVisual as string).toBe("café agent");
    expect(normalizedDecomposed as string).toBe("café agent");
    expect(hashNormalizedSearchQuery(normalizedVisual)).toBe(
      hashNormalizedSearchQuery(normalizedDecomposed),
    );
    expect(hashNormalizedSearchQuery(normalizeSearchQuery("abc"))).not.toBe(bodySha256("abc"));
  });

  test("search resources bind the exact broker scope and normalized query hash", () => {
    const scope = BrokerServerIdentitySchema.parse(brokerInput);
    const reviewerQuery = normalizeSearchQuery("  REVIEWER  ");
    const resource = searchPermissionResource(scope, reviewerQuery);

    expect(resource).toBe(
      `scope:${brokerScopeFingerprint(scope)}:query:${hashNormalizedSearchQuery(reviewerQuery)}`,
    );
    expect(resource).toMatch(/^scope:[0-9a-f]{64}:query:[0-9a-f]{64}$/);
    expect(resource).not.toMatch(/[?*[\]{}\\]/);
    expect(searchPermissionResource(scope, normalizeSearchQuery("builder"))).not.toBe(resource);
    expect(
      searchPermissionResource(
        BrokerServerIdentitySchema.parse({ ...brokerInput, serverId: "server_02" }),
        reviewerQuery,
      ),
    ).not.toBe(resource);
  });
});

describe("bounded runtime schemas", () => {
  test("registration is explicit opt-in and deregistration is identity-only", () => {
    expect(
      RegisterSessionRequestSchema.safeParse({
        ...requestBase(METHODS.REGISTER_SESSION),
        params: { hostSessionId: "host_session_01", optIn: false, metadata: {} },
      }).success,
    ).toBe(false);
    expect(
      DeregisterSessionRequestSchema.safeParse({
        ...requestBase(METHODS.DEREGISTER_SESSION),
        params: { session: source, metadata: { title: "must not be accepted" } },
      }).success,
    ).toBe(false);
  });

  test("metadata limits use UTF-8 bytes and reject unsafe control characters", () => {
    const titleAtLimit = "é".repeat(MAX_TITLE_BYTES / 2);
    const labelAtLimit = "é".repeat(MAX_LABEL_BYTES / 2);

    expect(
      SessionMetadataSchema.safeParse({ title: titleAtLimit, labels: [labelAtLimit] }).success,
    ).toBe(true);
    expect(SessionMetadataSchema.safeParse({ title: `${titleAtLimit}é`, labels: [] }).success).toBe(
      false,
    );
    expect(
      SessionMetadataSchema.safeParse({ title: "unsafe\u0000title", labels: [] }).success,
    ).toBe(false);
    expect(
      SessionMetadataSchema.safeParse({ title: "safe", labels: ["line\nbreak"] }).success,
    ).toBe(false);

    const metadataTooLarge = {
      title: "a".repeat(MAX_TITLE_BYTES),
      labels: Array.from(
        { length: 16 },
        (_, index) => `${index}-${"b".repeat(MAX_LABEL_BYTES - 3)}`,
      ),
    };
    expect(Buffer.byteLength(JSON.stringify(metadataTooLarge), "utf8")).toBeGreaterThan(
      MAX_METADATA_BYTES,
    );
    expect(SessionMetadataSchema.safeParse(metadataTooLarge).success).toBe(false);
  });

  test("message and query limits count UTF-8 bytes rather than UTF-16 code units", () => {
    const bodyAtLimit = "💣".repeat(MAX_MESSAGE_BYTES / 4);
    const queryAtLimit = "é".repeat(MAX_QUERY_BYTES / 2);

    expect(
      EnqueueMessageRequestSchema.safeParse({
        ...requestBase(METHODS.ENQUEUE_MESSAGE),
        params: { source, target, body: bodyAtLimit, ttlSeconds: DEFAULT_MESSAGE_TTL_SECONDS },
      }).success,
    ).toBe(true);
    expect(
      EnqueueMessageRequestSchema.safeParse({
        ...requestBase(METHODS.ENQUEUE_MESSAGE),
        params: {
          source,
          target,
          body: `${bodyAtLimit}x`,
          ttlSeconds: DEFAULT_MESSAGE_TTL_SECONDS,
        },
      }).success,
    ).toBe(false);
    expect(
      SearchSessionsRequestSchema.safeParse({
        ...requestBase(METHODS.SEARCH_SESSIONS),
        params: { requester: source, scope: brokerInput, query: queryAtLimit, limit: 1 },
      }).success,
    ).toBe(true);
    expect(
      SearchSessionsRequestSchema.safeParse({
        ...requestBase(METHODS.SEARCH_SESSIONS),
        params: { requester: source, scope: brokerInput, query: `${queryAtLimit}é`, limit: 1 },
      }).success,
    ).toBe(false);
  });

  test("malformed, empty, oversized, and out-of-range requests fail closed", () => {
    expect(
      EnqueueMessageRequestSchema.safeParse({
        ...requestBase(METHODS.ENQUEUE_MESSAGE),
        params: { source, target, body: "", ttlSeconds: DEFAULT_MESSAGE_TTL_SECONDS },
      }).success,
    ).toBe(false);
    expect(
      EnqueueMessageRequestSchema.safeParse({
        ...requestBase(METHODS.ENQUEUE_MESSAGE),
        params: {
          source,
          target: session("remote_target", { ...brokerInput, serverId: "other_server" }),
          body: "hello",
          ttlSeconds: DEFAULT_MESSAGE_TTL_SECONDS,
        },
      }).success,
    ).toBe(false);
    expect(
      EnqueueMessageRequestSchema.safeParse({
        ...requestBase(METHODS.ENQUEUE_MESSAGE),
        params: {
          source,
          target,
          body: "hello",
          ttlSeconds: MIN_MESSAGE_TTL_SECONDS - 1,
        },
      }).success,
    ).toBe(false);
    expect(
      SearchSessionsRequestSchema.safeParse({
        ...requestBase(METHODS.SEARCH_SESSIONS),
        params: { requester: source, scope: brokerInput, query: "\u0000", limit: 1 },
      }).success,
    ).toBe(false);
    expect(
      SearchSessionsRequestSchema.safeParse({
        ...requestBase(METHODS.SEARCH_SESSIONS),
        params: {
          requester: source,
          scope: brokerInput,
          query: "reviewer",
          limit: MAX_SEARCH_LIMIT + 1,
        },
      }).success,
    ).toBe(false);
    expect(
      ConsumeMessageRequestSchema.safeParse({
        ...requestBase(METHODS.CONSUME_MESSAGE),
        params: { messageId: "message_01", target, expectedBodyHash: "not-a-hash" },
      }).success,
    ).toBe(false);
  });
});

describe("message envelopes do not disclose bodies before consume", () => {
  test("pending headers and receive permission metadata reject body fields", () => {
    const header = pendingHeader();
    expect(PendingMessageHeaderSchema.safeParse({ ...header, body: "peer secret" }).success).toBe(
      false,
    );

    const permissionMetadata: ReceivePermissionMetadata = ReceivePermissionMetadataSchema.parse({
      messageId: header.messageId,
      targetFingerprint: sessionFingerprint(target),
      sourceFingerprint: sessionFingerprint(source),
      bodyHash: header.bodyHash,
      bodyBytes: header.bodyBytes,
    });
    expect(
      ReceivePermissionMetadataSchema.safeParse({ ...permissionMetadata, body: "peer secret" })
        .success,
    ).toBe(false);

    // @ts-expect-error Pending headers intentionally have no body property.
    expect(header.body).toBeUndefined();
    // @ts-expect-error Permission metadata intentionally has no body property.
    expect(permissionMetadata.body).toBeUndefined();
  });

  test("peek returns only a nullable pending header", () => {
    expect(
      PeekNextMessageRequestSchema.safeParse({
        ...requestBase(METHODS.PEEK_NEXT_MESSAGE),
        params: { target },
      }).success,
    ).toBe(true);
    expect(PeekNextMessageResultSchema.safeParse({ header: pendingHeader() }).success).toBe(true);
    expect(PeekNextMessageResultSchema.safeParse({ header: null }).success).toBe(true);
    expect(
      PeekNextMessageResultSchema.safeParse({ header: { ...pendingHeader(), body: "secret" } })
        .success,
    ).toBe(false);
  });

  test("enqueue receipts expose stable metadata but no body", () => {
    expect(
      EnqueueMessageReceiptSchema.safeParse({
        messageId: "message_01",
        state: "PENDING",
        bodyHash: bodySha256("hello"),
        bodyBytes: 5,
        expiresAt: later,
      }).success,
    ).toBe(true);
    expect(
      EnqueueMessageReceiptSchema.safeParse({
        messageId: "message_01",
        state: "PENDING",
        bodyHash: bodySha256("hello"),
        bodyBytes: 5,
        expiresAt: later,
        body: "hello",
      }).success,
    ).toBe(false);
  });
});

describe("atomic consumption, registry search, and errors", () => {
  test("consume is bound to message ID, target, and expected body hash", () => {
    const header = pendingHeader();
    const request = ConsumeMessageRequestSchema.parse({
      ...requestBase(METHODS.CONSUME_MESSAGE),
      params: {
        messageId: header.messageId,
        target: header.target,
        expectedBodyHash: header.bodyHash,
      },
    });

    expect(request.params).toEqual({
      messageId: header.messageId,
      target: header.target,
      expectedBodyHash: header.bodyHash,
    });
    expect(ConsumeMessageRequestSchema.safeParse({ ...request, source }).success).toBe(false);
  });

  test("consumed peer bodies carry explicit type and untrusted labels", () => {
    const value = {
      type: "peer_message",
      trust: "untrusted",
      messageId: "message_01",
      source,
      target,
      body: "peer secret",
      bodyHash: bodySha256("peer secret"),
      bodyBytes: 11,
      state: "DELIVERED",
      deliveredAt: now,
    };

    expect(ConsumedPeerMessageSchema.safeParse(value).success).toBe(true);
    expect(ConsumedPeerMessageSchema.safeParse({ ...value, trust: "trusted" }).success).toBe(false);
    expect(ConsumedPeerMessageSchema.safeParse({ ...value, type: "user_message" }).success).toBe(
      false,
    );
  });

  test("search results contain only opt-in registry identity and metadata", () => {
    const match = {
      session: target,
      fingerprint: sessionFingerprint(target),
      metadata: { title: "Review agent", labels: ["reviewer"] },
    };

    const baseResult = {
      scope: target.broker,
      queryHash: hashNormalizedSearchQuery(normalizeSearchQuery("reviewer")),
      requestedLimit: 5,
      matches: [match],
    };
    expect(SearchSessionsResultSchema.safeParse(baseResult).success).toBe(true);
    expect(
      SearchSessionsResultSchema.safeParse({
        ...baseResult,
        matches: [{ ...match, transcript: "private history" }],
      }).success,
    ).toBe(false);
    expect(
      SearchSessionsResultSchema.safeParse({
        ...baseResult,
        matches: [{ ...match, body: "peer secret" }],
      }).success,
    ).toBe(false);
  });

  test("message states and stable error envelopes are closed enums", () => {
    expect(MESSAGE_STATES).toEqual(["PENDING", "DELIVERED", "REJECTED", "EXPIRED"]);
    expect(
      ErrorEnvelopeSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "request_legacy",
        ok: false,
        error: { code: "BODY_HASH_MISMATCH", message: ERROR_MESSAGES.BODY_HASH_MISMATCH },
      }).success,
    ).toBe(true);
    expect(
      ErrorEnvelopeSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "request_legacy",
        ok: false,
        error: { code: "SOMETHING_NEW", message: "unstable" },
      }).success,
    ).toBe(false);
  });
});
