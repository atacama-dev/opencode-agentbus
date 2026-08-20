import { describe, expect, test } from "bun:test";
import {
  METHODS,
  PrincipalIdSchema,
  PROTOCOL_VERSION,
  ServerIdSchema,
  type EnqueueMessageReceipt,
  type PendingMessageEvent,
  type RegistrationResult,
} from "@opencode-agentbus/protocol";
import {
  createHarness,
  enqueueRequest,
  expectSuccess,
  registerRequest,
  requestId,
} from "./helpers";

describe("principal event replay", () => {
  test("persists monotonic metadata-only event IDs and replays strictly after a cursor", () => {
    const secret = "EVENT_BODY_SECRET";
    const harness = createHarness({ limits: { eventReplayWindow: 3 } });
    try {
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("source")),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("target")),
      );
      expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, secret),
        ),
      );
      const first = harness.service.replayEvents(harness.service.principal);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.events).toHaveLength(0);

      const all = harness.service.retainedEventsForTesting(harness.service.principal);
      expect(all).toHaveLength(1);
      expect(JSON.stringify(all)).not.toContain(secret);
      expect(Object.hasOwn((all[0] as PendingMessageEvent).header, "body")).toBe(false);

      expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, "second"),
        ),
      );
      const replay = harness.service.replayEvents(
        harness.service.principal,
        (all[0] as PendingMessageEvent).eventId,
      );
      expect(replay.ok).toBe(true);
      if (!replay.ok) return;
      expect(replay.events).toHaveLength(1);
      expect(BigInt(replay.events[0]?.eventId ?? "0")).toBeGreaterThan(
        BigInt((all[0] as PendingMessageEvent).eventId),
      );
    } finally {
      harness.close();
    }
  });

  test("returns a safe stale-cursor conflict and enforces principal ownership", () => {
    const harness = createHarness({ limits: { eventReplayWindow: 2 } });
    try {
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("source")),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("target")),
      );
      for (const body of ["one", "two", "three"]) {
        expectSuccess(
          harness.service.dispatch(
            harness.service.principal,
            enqueueRequest(source.identity, target.identity, body),
          ),
        );
      }

      const stale = harness.service.replayEvents(harness.service.principal, "1");
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error.error.code).toBe("EVENT_CURSOR_EXPIRED");

      const forged = {
        principalId: PrincipalIdSchema.parse("forged-principal"),
        serverId: ServerIdSchema.parse("forged-server"),
      };
      const forbidden = harness.service.replayEvents(forged);
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) expect(forbidden.error.error.code).toBe("FORBIDDEN");
    } finally {
      harness.close();
    }
  });

  test("event correlation IDs are enqueue request IDs", () => {
    const harness = createHarness();
    try {
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("source")),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("target")),
      );
      const correlationId = requestId("correlation");
      const enqueue = {
        protocolVersion: PROTOCOL_VERSION,
        requestId: correlationId,
        method: METHODS.ENQUEUE_MESSAGE,
        params: {
          source: source.identity,
          target: target.identity,
          body: "metadata event",
          ttlSeconds: 60,
        },
      } as const;
      expectSuccess(harness.service.dispatch(harness.service.principal, enqueue));
      const events = harness.service.retainedEventsForTesting(harness.service.principal);
      expect(events[0]?.correlationId).toBe(correlationId);
    } finally {
      harness.close();
    }
  });
});
