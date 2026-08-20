import { describe, expect, test } from "bun:test";
import {
  METHODS,
  type ApplicationResponseEnvelope,
  type EnqueueMessageReceipt,
  type RegistrationResult,
} from "@opencode-agentbus/protocol";
import { BrokerService } from "../src/service";
import {
  createHarness,
  enqueueRequest,
  expectSuccess,
  expectedMessageRequest,
  registerRequest,
} from "./helpers";

function expectRateLimited(response: ApplicationResponseEnvelope): number {
  if (response.ok) throw new Error("Expected durable quota failure.");
  expect(response.error.code).toBe("RATE_LIMITED");
  const retryAfterMs = response.error.details?.retryAfterMs;
  if (retryAfterMs === undefined) throw new Error("Expected retry metadata.");
  return retryAfterMs;
}

describe("durable message quota isolation", () => {
  test("one source reaches its durable quota without blocking another source", () => {
    const harness = createHarness({
      limits: {
        enqueuePerPrincipalPerMinute: 100,
        enqueuePerSessionPerMinute: 100,
        maxPendingPerPrincipal: 4,
        maxPendingPerSession: 4,
        maxMessagesPerSourceSession: 2,
        maxMessagesPerPrincipal: 4,
        maxMessagesGlobal: 4,
      },
    });
    try {
      const sourceA = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("quota-source-a")),
      );
      const sourceB = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("quota-source-b")),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("quota-target")),
      );

      for (const body of ["a-one", "a-two"]) {
        expectSuccess(
          harness.service.dispatch(
            harness.service.principal,
            enqueueRequest(sourceA.identity, target.identity, body),
          ),
        );
      }
      expectRateLimited(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(sourceA.identity, target.identity, "a-blocked"),
        ),
      );
      for (const body of ["b-one", "b-two"]) {
        expectSuccess(
          harness.service.dispatch(
            harness.service.principal,
            enqueueRequest(sourceB.identity, target.identity, body),
          ),
        );
      }
      expect(harness.service.storageStatsForTesting().messages).toBe(4);
    } finally {
      harness.close();
    }
  });

  test("pending rows remain intact and retry metadata follows safe terminal retention", () => {
    const harness = createHarness({
      limits: {
        enqueuePerPrincipalPerMinute: 100,
        enqueuePerSessionPerMinute: 100,
        maxPendingPerPrincipal: 2,
        maxPendingPerSession: 2,
        maxMessagesPerSourceSession: 1,
        maxMessagesPerPrincipal: 2,
        maxMessagesGlobal: 2,
        terminalMessageRetentionMs: 1_000,
      },
    });
    try {
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("protected-source")),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("protected-target")),
      );
      const first = expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, "protected-body", 10),
        ),
      );

      expect(
        expectRateLimited(
          harness.service.dispatch(
            harness.service.principal,
            enqueueRequest(source.identity, target.identity, "must-not-reclaim"),
          ),
        ),
      ).toBe(11_000);
      expect(harness.service.storageStatsForTesting()).toMatchObject({
        messages: 1,
        pendingBodies: 1,
      });

      expectSuccess(
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
      expect(
        expectRateLimited(
          harness.service.dispatch(
            harness.service.principal,
            enqueueRequest(source.identity, target.identity, "retained-terminal"),
          ),
        ),
      ).toBe(1_000);
      expect(harness.service.storageStatsForTesting()).toMatchObject({
        messages: 1,
        pendingBodies: 0,
        terminalBodies: 0,
      });

      harness.clock.advance(1_001);
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, "after-retention"),
        ),
      );
    } finally {
      harness.close();
    }
  });

  test("reclaims oldest eligible body-free terminal rows before quota denial", () => {
    const harness = createHarness({
      limits: {
        enqueuePerPrincipalPerMinute: 100,
        enqueuePerSessionPerMinute: 100,
        maxPendingPerPrincipal: 3,
        maxPendingPerSession: 3,
        maxMessagesPerSourceSession: 3,
        maxMessagesPerPrincipal: 4,
        maxMessagesGlobal: 4,
        maintenanceBatchSize: 1,
        terminalMessageRetentionMs: 1_000,
      },
    });
    try {
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("reclaim-source")),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("reclaim-target")),
      );
      for (const body of ["one", "two", "three"]) {
        const receipt = expectSuccess<EnqueueMessageReceipt>(
          harness.service.dispatch(
            harness.service.principal,
            enqueueRequest(source.identity, target.identity, body),
          ),
        );
        expectSuccess(
          harness.service.dispatch(
            harness.service.principal,
            expectedMessageRequest(
              METHODS.CONSUME_MESSAGE,
              receipt.messageId,
              target.identity,
              receipt.bodyHash,
            ),
          ),
        );
      }
      harness.clock.advance(1_001);
      harness.service.close();

      const restarted = BrokerService.open({
        databasePath: harness.databasePath,
        credentialFilePath: harness.credentialFilePath,
        clock: harness.clock,
        random: harness.random,
        limits: {
          enqueuePerPrincipalPerMinute: 100,
          enqueuePerSessionPerMinute: 100,
          maxPendingPerPrincipal: 1,
          maxPendingPerSession: 1,
          maxMessagesPerSourceSession: 1,
          maxMessagesPerPrincipal: 1,
          maxMessagesGlobal: 1,
          maintenanceBatchSize: 1,
          terminalMessageRetentionMs: 1_000,
        },
      });
      try {
        expectSuccess(
          restarted.dispatch(
            restarted.principal,
            enqueueRequest(source.identity, target.identity, "reclaimed-slot"),
          ),
        );
        expect(restarted.storageStatsForTesting()).toMatchObject({
          messages: 1,
          pendingBodies: 1,
          terminalBodies: 0,
        });
      } finally {
        restarted.close();
      }
    } finally {
      harness.close();
    }
  });

  test("persists per-source accounting across restart", () => {
    const limits = {
      enqueuePerPrincipalPerMinute: 100,
      enqueuePerSessionPerMinute: 100,
      maxPendingPerPrincipal: 2,
      maxPendingPerSession: 2,
      maxMessagesPerSourceSession: 1,
      maxMessagesPerPrincipal: 2,
      maxMessagesGlobal: 2,
    } as const;
    const harness = createHarness({ limits });
    try {
      const sourceA = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("restart-source-a")),
      );
      const sourceB = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("restart-source-b")),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("restart-target")),
      );
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(sourceA.identity, target.identity, "persisted-a"),
        ),
      );
      harness.service.close();

      const restarted = BrokerService.open({
        databasePath: harness.databasePath,
        credentialFilePath: harness.credentialFilePath,
        clock: harness.clock,
        random: harness.random,
        limits,
      });
      try {
        expectRateLimited(
          restarted.dispatch(
            restarted.principal,
            enqueueRequest(sourceA.identity, target.identity, "blocked-a"),
          ),
        );
        expectSuccess(
          restarted.dispatch(
            restarted.principal,
            enqueueRequest(sourceB.identity, target.identity, "allowed-b"),
          ),
        );
        expect(restarted.storageStatsForTesting().messages).toBe(2);
      } finally {
        restarted.close();
      }
    } finally {
      harness.close();
    }
  });
});
