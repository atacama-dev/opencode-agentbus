import { describe, expect, test } from "bun:test";
import {
  MAX_MESSAGE_BYTES,
  METHODS,
  PROTOCOL_VERSION,
  PrincipalIdSchema,
  SessionIdSchema,
  ServerIdSchema,
  bodySha256,
  type ConsumedMessageResult,
  type EnqueueMessageReceipt,
  type ListPendingMessagesResult,
  type RegistrationResult,
  type RegistrySearchMatch,
  type RejectMessageResult,
  type SearchSessionsResult,
  type SessionHeartbeatResult,
} from "@opencode-agentbus/protocol";
import { BrokerService } from "../src/service";
import {
  claimRequest,
  createHarness,
  enqueueRequest,
  expectError,
  expectSuccess,
  expectedMessageRequest,
  registerRequest,
  requestId,
} from "./helpers";

describe("broker registry and persistence", () => {
  test("registration is idempotent, refreshes metadata and leases, and survives restart", () => {
    const harness = createHarness();
    try {
      const first = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("host-a", "First")),
      );
      harness.clock.advance(1_000);
      const second = expectSuccess<RegistrationResult>(
        harness.service.dispatch(
          harness.service.principal,
          registerRequest("host-a", "Updated", ["fresh"]),
        ),
      );

      expect(first.registration).toBe("created");
      expect(second.registration).toBe("refreshed");
      expect(second.identity).toEqual(first.identity);
      expect(second.fingerprint).toBe(first.fingerprint);
      expect(second.metadata).toEqual({ title: "Updated", labels: ["fresh"] });
      expect(Date.parse(second.leaseExpiresAt)).toBeGreaterThan(Date.parse(first.leaseExpiresAt));

      const brokerId = harness.service.brokerId;
      harness.service.close();
      const restarted = BrokerService.open({
        databasePath: harness.databasePath,
        credentialFilePath: harness.credentialFilePath,
        clock: harness.clock,
        random: harness.random,
      });
      try {
        const third = expectSuccess<RegistrationResult>(
          restarted.dispatch(restarted.principal, registerRequest("host-a", "Restarted")),
        );
        expect(restarted.brokerId).toBe(brokerId);
        expect(third.identity).toEqual(first.identity);
        expect(third.registration).toBe("refreshed");
      } finally {
        restarted.close();
      }
    } finally {
      harness.close();
    }
  });

  test("heartbeat ownership is server-derived and expired registrations are not searchable", () => {
    const harness = createHarness();
    try {
      const registration = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("host-a", "Alpha")),
      );
      const forgedPrincipal = {
        principalId: PrincipalIdSchema.parse("other-principal"),
        serverId: ServerIdSchema.parse("other-server"),
      };

      expectError(
        harness.service.dispatch(
          forgedPrincipal,
          claimRequest(METHODS.HEARTBEAT_SESSION, registration.identity),
        ),
        "FORBIDDEN",
      );

      harness.clock.advance(121_000);
      const search = {
        protocolVersion: PROTOCOL_VERSION,
        requestId: requestId("search"),
        method: METHODS.SEARCH_SESSIONS,
        params: {
          requester: registration.identity,
          scope: registration.identity.broker,
          query: "alpha",
          limit: 20,
        },
      } as const;
      expectError(
        harness.service.dispatch(harness.service.principal, search),
        "SESSION_NOT_REGISTERED",
      );

      const heartbeat = expectSuccess<SessionHeartbeatResult>(
        harness.service.dispatch(
          harness.service.principal,
          claimRequest(METHODS.HEARTBEAT_SESSION, registration.identity),
        ),
      );
      expect(heartbeat.identity).toEqual(registration.identity);
      const revived = expectSuccess<SearchSessionsResult>(
        harness.service.dispatch(harness.service.principal, search),
      );
      expect(revived.matches).toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  test("deregistration is best-effort and removes targets from enqueue and search", () => {
    const harness = createHarness();
    try {
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("source")),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("target")),
      );
      const request = claimRequest(METHODS.DEREGISTER_SESSION, target.identity);
      const first = expectSuccess<{ disposition: string }>(
        harness.service.dispatch(harness.service.principal, request),
      );
      const second = expectSuccess<{ disposition: string }>(
        harness.service.dispatch(harness.service.principal, {
          ...request,
          requestId: requestId("deregister"),
        }),
      );

      expect(first.disposition).toBe("deregistered");
      expect(second.disposition).toBe("already_absent");
      expectError(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, "not delivered"),
        ),
        "TARGET_NOT_REGISTERED",
      );
    } finally {
      harness.close();
    }
  });

  test("defers background registrations instead of bypassing active-session limits", () => {
    const harness = createHarness({ limits: { maxActiveSessionsPerPrincipal: 2 } });
    try {
      expectSuccess(harness.service.dispatch(harness.service.principal, registerRequest("one")));
      expectSuccess(harness.service.dispatch(harness.service.principal, registerRequest("two")));
      expectSuccess(harness.service.dispatch(harness.service.principal, registerRequest("three")));
      expect(harness.service.storageStatsForTesting()).toMatchObject({
        sessions: 3,
        activeSessions: 2,
        displacedSessions: 1,
      });
    } finally {
      harness.close();
    }
  });

  test("does not bypass the active limit by refreshing an inactive existing registration", () => {
    const harness = createHarness({ limits: { maxActiveSessionsPerPrincipal: 2 } });
    try {
      const first = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("first")),
      );
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          claimRequest(METHODS.DEREGISTER_SESSION, first.identity),
        ),
      );
      const second = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("second")),
      );
      expectSuccess(harness.service.dispatch(harness.service.principal, registerRequest("third")));

      expectSuccess(harness.service.dispatch(harness.service.principal, registerRequest("first")));
      expect(harness.service.storageStatsForTesting()).toMatchObject({
        activeSessions: 2,
        displacedSessions: 1,
      });
      expect(second.registration).toBe("created");
    } finally {
      harness.close();
    }
  });

  test("does not bypass the active limit by heartbeating an expired registration", () => {
    const harness = createHarness({ limits: { maxActiveSessionsPerPrincipal: 2 } });
    try {
      const expired = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("expired")),
      );
      harness.clock.advance(121_000);
      expectSuccess(harness.service.dispatch(harness.service.principal, registerRequest("active")));
      expectSuccess(
        harness.service.dispatch(harness.service.principal, registerRequest("also-active")),
      );

      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          claimRequest(METHODS.HEARTBEAT_SESSION, expired.identity),
        ),
      );
      expect(harness.service.storageStatsForTesting()).toMatchObject({
        activeSessions: 2,
        displacedSessions: 1,
      });
    } finally {
      harness.close();
    }
  });

  test("fails closed for unknown sessions in the authenticated scope", () => {
    const harness = createHarness();
    try {
      const registered = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("known")),
      );
      const unknown = {
        ...registered.identity,
        sessionId: SessionIdSchema.parse("unknown-session"),
      };
      expectError(
        harness.service.dispatch(
          harness.service.principal,
          claimRequest(METHODS.HEARTBEAT_SESSION, unknown),
        ),
        "SESSION_NOT_REGISTERED",
      );
      expectError(
        harness.service.dispatch(
          harness.service.principal,
          claimRequest(METHODS.PEEK_NEXT_MESSAGE, unknown),
        ),
        "TARGET_NOT_REGISTERED",
      );
    } finally {
      harness.close();
    }
  });
});

describe("broker mailbox", () => {
  test("lists deterministic metadata headers without bodies and consumes exactly once", () => {
    const secret = "SECRET peer body";
    const harness = createHarness();
    try {
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("source")),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("target")),
      );
      const first = expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, secret),
        ),
      );
      const second = expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, "later"),
        ),
      );
      const listRequest = {
        protocolVersion: PROTOCOL_VERSION,
        requestId: requestId("list"),
        method: METHODS.LIST_PENDING_MESSAGES,
        params: { target: target.identity, limit: 20 },
      } as const;
      const listed = expectSuccess<ListPendingMessagesResult>(
        harness.service.dispatch(harness.service.principal, listRequest),
      );

      expect(listed.headers.map((header) => header.messageId)).toEqual([
        first.messageId,
        second.messageId,
      ]);
      expect(JSON.stringify(listed)).not.toContain(secret);
      expect(Object.hasOwn(listed.headers[0] ?? {}, "body")).toBe(false);

      expectError(
        harness.service.dispatch(
          harness.service.principal,
          expectedMessageRequest(
            METHODS.CONSUME_MESSAGE,
            first.messageId,
            target.identity,
            bodySha256("wrong"),
          ),
        ),
        "BODY_HASH_MISMATCH",
      );
      const consumed = expectSuccess<ConsumedMessageResult>(
        harness.service.dispatch(
          harness.service.principal,
          expectedMessageRequest(
            METHODS.CONSUME_MESSAGE,
            first.messageId,
            target.identity,
            first.bodyHash,
          ),
        ),
      );
      expect(consumed.body).toBe(secret);
      expect(consumed.state).toBe("DELIVERED");
      expectError(
        harness.service.dispatch(
          harness.service.principal,
          expectedMessageRequest(
            METHODS.CONSUME_MESSAGE,
            first.messageId,
            target.identity,
            first.bodyHash,
          ),
        ),
        "MESSAGE_NOT_PENDING",
      );
    } finally {
      harness.close();
    }
  });

  test("consume/reject races permit one transition and rejection never selects a body", async () => {
    const statements: string[] = [];
    const secret = "BODY_MUST_NOT_BE_SELECTED_ON_REJECT";
    const harness = createHarness({ statementObserver: (sql) => statements.push(sql) });
    try {
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("source")),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("target")),
      );
      const receipt = expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, secret),
        ),
      );
      statements.length = 0;

      const reject = expectedMessageRequest(
        METHODS.REJECT_MESSAGE,
        receipt.messageId,
        target.identity,
        receipt.bodyHash,
      );
      const consume = expectedMessageRequest(
        METHODS.CONSUME_MESSAGE,
        receipt.messageId,
        target.identity,
        receipt.bodyHash,
      );
      const [left, right] = await Promise.all([
        Promise.resolve().then(() => harness.service.dispatch(harness.service.principal, reject)),
        Promise.resolve().then(() => harness.service.dispatch(harness.service.principal, consume)),
      ]);

      expect(Number(left.ok) + Number(right.ok)).toBe(1);
      const rejectSelects = statements.filter(
        (sql) => sql.includes("reject-message") && /\bselect\b[\s\S]*\bbody\b/i.test(sql),
      );
      expect(rejectSelects).toEqual([]);
      expect(JSON.stringify(left.ok ? right : left)).not.toContain(secret);
    } finally {
      harness.close();
    }
  });

  test("rejection is idempotent for the same target/hash and does not return a body", () => {
    const harness = createHarness();
    try {
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("source")),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("target")),
      );
      const receipt = expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, "hidden"),
        ),
      );
      const reject = expectedMessageRequest(
        METHODS.REJECT_MESSAGE,
        receipt.messageId,
        target.identity,
        receipt.bodyHash,
      );
      const first = expectSuccess<RejectMessageResult>(
        harness.service.dispatch(harness.service.principal, reject),
      );
      const second = expectSuccess<RejectMessageResult>(
        harness.service.dispatch(harness.service.principal, {
          ...reject,
          requestId: requestId("reject"),
        }),
      );

      expect(first.disposition).toBe("rejected");
      expect(second.disposition).toBe("already_rejected");
      expect(Object.hasOwn(first, "body")).toBe(false);
    } finally {
      harness.close();
    }
  });

  test("expiry is enforced at the exact boundary", () => {
    const harness = createHarness();
    try {
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("source")),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("target")),
      );
      const receipt = expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, "expires", 10),
        ),
      );
      harness.clock.advance(10_000);

      expectError(
        harness.service.dispatch(
          harness.service.principal,
          expectedMessageRequest(
            METHODS.CONSUME_MESSAGE,
            receipt.messageId,
            target.identity,
            receipt.bodyHash,
          ),
        ),
        "MESSAGE_EXPIRED",
      );
      const peek = expectSuccess<{ header: unknown }>(
        harness.service.dispatch(
          harness.service.principal,
          claimRequest(METHODS.PEEK_NEXT_MESSAGE, target.identity),
        ),
      );
      expect(peek.header).toBeNull();
    } finally {
      harness.close();
    }
  });

  test("enforces body validity, UTF-8 bytes, TTL, rates, and pending limits", () => {
    const harness = createHarness({
      limits: {
        enqueuePerPrincipalPerMinute: 2,
        enqueuePerSessionPerMinute: 2,
        maxPendingPerPrincipal: 2,
        maxPendingPerSession: 2,
      },
    });
    try {
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("source")),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("target")),
      );

      expectError(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, "x".repeat(MAX_MESSAGE_BYTES + 1)),
        ),
        "MESSAGE_TOO_LARGE",
      );
      expectError(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, "bad \ud800"),
        ),
        "INVALID_REQUEST",
      );
      expectError(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, "ttl", 9),
        ),
        "TTL_OUT_OF_RANGE",
      );
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, "one"),
        ),
      );
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, "two"),
        ),
      );
      expectError(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, "three"),
        ),
        "RATE_LIMITED",
      );
    } finally {
      harness.close();
    }

    const pendingHarness = createHarness({
      limits: {
        enqueuePerPrincipalPerMinute: 100,
        enqueuePerSessionPerMinute: 100,
        maxPendingPerPrincipal: 1,
        maxPendingPerSession: 1,
      },
    });
    try {
      const source = expectSuccess<RegistrationResult>(
        pendingHarness.service.dispatch(
          pendingHarness.service.principal,
          registerRequest("source-limit"),
        ),
      );
      const target = expectSuccess<RegistrationResult>(
        pendingHarness.service.dispatch(
          pendingHarness.service.principal,
          registerRequest("target-limit"),
        ),
      );
      expectSuccess(
        pendingHarness.service.dispatch(
          pendingHarness.service.principal,
          enqueueRequest(source.identity, target.identity, "one"),
        ),
      );
      expectError(
        pendingHarness.service.dispatch(
          pendingHarness.service.principal,
          enqueueRequest(source.identity, target.identity, "two"),
        ),
        "RATE_LIMITED",
      );
    } finally {
      pendingHarness.close();
    }
  });

  test("pending mailbox and bodies persist across restart", () => {
    const harness = createHarness();
    try {
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("source")),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("target")),
      );
      const receipt = expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, "persisted"),
        ),
      );
      harness.service.close();

      const restarted = BrokerService.open({
        databasePath: harness.databasePath,
        credentialFilePath: harness.credentialFilePath,
        clock: harness.clock,
        random: harness.random,
      });
      try {
        const consumed = expectSuccess<ConsumedMessageResult>(
          restarted.dispatch(
            restarted.principal,
            expectedMessageRequest(
              METHODS.CONSUME_MESSAGE,
              receipt.messageId,
              target.identity,
              receipt.bodyHash,
            ),
          ),
        );
        expect(consumed.body).toBe("persisted");
      } finally {
        restarted.close();
      }
    } finally {
      harness.close();
    }
  });
});

describe("registry search privacy", () => {
  test("searches only active opt-in metadata with exact canonical queries and approved fields", () => {
    const secret = "transcript-secret-never-indexed";
    const harness = createHarness();
    try {
      const requester = expectSuccess<RegistrationResult>(
        harness.service.dispatch(
          harness.service.principal,
          registerRequest("requester", "Requester"),
        ),
      );
      expectSuccess<RegistrationResult>(
        harness.service.dispatch(
          harness.service.principal,
          registerRequest("match", "Build Agent", ["typescript"]),
        ),
      );
      const hidden = expectSuccess<RegistrationResult>(
        harness.service.dispatch(
          harness.service.principal,
          registerRequest("hidden", "Hidden Build Agent"),
        ),
      );
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(requester.identity, hidden.identity, secret),
        ),
      );
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          claimRequest(METHODS.DEREGISTER_SESSION, hidden.identity),
        ),
      );

      const makeSearch = (query: string) => ({
        protocolVersion: PROTOCOL_VERSION,
        requestId: requestId("search"),
        method: METHODS.SEARCH_SESSIONS,
        params: {
          requester: requester.identity,
          scope: requester.identity.broker,
          query,
          limit: 10,
        },
      });
      expectError(
        harness.service.dispatch(harness.service.principal, makeSearch(" Build  Agent ")),
        "INVALID_REQUEST",
      );
      const result = expectSuccess<SearchSessionsResult>(
        harness.service.dispatch(harness.service.principal, makeSearch("build agent")),
      );

      expect(result.matches).toHaveLength(1);
      const match = result.matches[0] as RegistrySearchMatch;
      expect(Object.keys(match).sort()).toEqual(["fingerprint", "metadata", "session"]);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain("hostSessionId");
    } finally {
      harness.close();
    }
  });
});
