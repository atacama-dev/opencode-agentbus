import { chmodSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  METHODS,
  type EnqueueMessageReceipt,
  type RegistrationResult,
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
} from "./helpers";

describe("persistent retention and quotas", () => {
  test("enforces total session, message, and registration churn quotas", () => {
    const harness = createHarness({
      limits: {
        maxSessionsPerPrincipal: 3,
        maxSessionsGlobal: 3,
        foregroundSessionReserve: 1,
        maxMessagesPerPrincipal: 1,
        maxMessagesGlobal: 1,
        registrationsPerPrincipalPerMinute: 4,
      },
    });
    try {
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("quota-source")),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("quota-target")),
      );
      expectError(
        harness.service.dispatch(harness.service.principal, registerRequest("quota-third")),
        "RATE_LIMITED",
      );

      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, "first"),
        ),
      );
      expectError(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, "second"),
        ),
        "RATE_LIMITED",
      );

      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          registerRequest("quota-source", "Changed once"),
        ),
      );
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          registerRequest("quota-source", "Changed twice"),
        ),
      );
      expectError(
        harness.service.dispatch(
          harness.service.principal,
          registerRequest("quota-source", "Changed three times"),
        ),
        "RATE_LIMITED",
      );
    } finally {
      harness.close();
    }
  });

  test("scrubs expired bodies in bounded maintenance without a mailbox read", () => {
    const harness = createHarness({ limits: { maintenanceBatchSize: 1 } });
    try {
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("expiry-source")),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("expiry-target")),
      );
      for (const body of ["one", "two", "three"]) {
        expectSuccess(
          harness.service.dispatch(
            harness.service.principal,
            enqueueRequest(source.identity, target.identity, body, 10),
          ),
        );
      }
      harness.clock.advance(10_000);

      const first = harness.service.maintenance();
      const afterFirst = harness.service.storageStatsForTesting();
      expect(first.expiredMessages).toBe(1);
      expect(afterFirst.pendingBodies).toBe(2);
      harness.service.maintenance();
      harness.service.maintenance();
      const fullyScrubbed = harness.service.storageStatsForTesting();
      expect(fullyScrubbed.pendingBodies).toBe(0);
      expect(fullyScrubbed.terminalBodies).toBe(0);
      expect(fullyScrubbed.expiredMessages).toBe(3);
    } finally {
      harness.close();
    }
  });

  test("runs body-scrubbing maintenance on restart before serving operations", () => {
    const harness = createHarness();
    try {
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("restart-source")),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("restart-target")),
      );
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, "scrub-on-start", 10),
        ),
      );
      harness.clock.advance(10_000);
      harness.service.close();

      const restarted = BrokerService.open({
        databasePath: harness.databasePath,
        credentialFilePath: harness.credentialFilePath,
        clock: harness.clock,
        random: harness.random,
      });
      try {
        expect(restarted.storageStatsForTesting()).toMatchObject({
          pendingBodies: 0,
          terminalBodies: 0,
          expiredMessages: 1,
        });
      } finally {
        restarted.close();
      }
    } finally {
      harness.close();
    }
  });

  test("never retains delivered or rejected message bodies", () => {
    const harness = createHarness();
    try {
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("terminal-source")),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("terminal-target")),
      );
      const delivered = expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, "delivered-secret"),
        ),
      );
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          expectedMessageRequest(
            METHODS.CONSUME_MESSAGE,
            delivered.messageId,
            target.identity,
            delivered.bodyHash,
          ),
        ),
      );
      const rejected = expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, "rejected-secret"),
        ),
      );
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          expectedMessageRequest(
            METHODS.REJECT_MESSAGE,
            rejected.messageId,
            target.identity,
            rejected.bodyHash,
          ),
        ),
      );
      expect(harness.service.storageStatsForTesting().terminalBodies).toBe(0);
    } finally {
      harness.close();
    }
  });

  test("persists total quotas and registration churn accounting across restart", () => {
    const harness = createHarness({
      limits: {
        maxSessionsPerPrincipal: 3,
        maxSessionsGlobal: 3,
        foregroundSessionReserve: 1,
        maxMessagesPerPrincipal: 1,
        maxMessagesGlobal: 1,
        registrationsPerPrincipalPerMinute: 2,
      },
    });
    try {
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("persistent-source")),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("persistent-target")),
      );
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, "quota-persisted"),
        ),
      );
      harness.service.close();

      const restarted = BrokerService.open({
        databasePath: harness.databasePath,
        credentialFilePath: harness.credentialFilePath,
        clock: harness.clock,
        random: harness.random,
        limits: {
          maxSessionsPerPrincipal: 3,
          maxSessionsGlobal: 3,
          foregroundSessionReserve: 1,
          maxMessagesPerPrincipal: 1,
          maxMessagesGlobal: 1,
          registrationsPerPrincipalPerMinute: 2,
        },
      });
      try {
        expectSuccess(
          restarted.dispatch(restarted.principal, registerRequest("persistent-source")),
        );
        expectError(
          restarted.dispatch(
            restarted.principal,
            registerRequest("persistent-source", "Changed metadata"),
          ),
          "RATE_LIMITED",
        );
        harness.clock.advance(60_001);
        expectError(
          restarted.dispatch(restarted.principal, registerRequest("persistent-third")),
          "RATE_LIMITED",
        );
        expectError(
          restarted.dispatch(
            restarted.principal,
            enqueueRequest(source.identity, target.identity, "second"),
          ),
          "RATE_LIMITED",
        );
      } finally {
        restarted.close();
      }
    } finally {
      harness.close();
    }
  });

  test("purges terminal messages, old events/rates, and inactive sessions across restart", () => {
    const harness = createHarness({
      limits: {
        maintenanceBatchSize: 100,
        terminalMessageRetentionMs: 1_000,
        eventRetentionMs: 1_000,
        inactiveSessionRetentionMs: 1_000,
        rateRetentionMs: 60_000,
      },
    });
    try {
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("old-source")),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("old-target")),
      );
      const receipt = expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, "terminal-secret"),
        ),
      );
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          expectedMessageRequest(
            METHODS.REJECT_MESSAGE,
            receipt.messageId,
            target.identity,
            receipt.bodyHash,
          ),
        ),
      );
      for (const session of [source.identity, target.identity]) {
        expectSuccess(
          harness.service.dispatch(
            harness.service.principal,
            claimRequest(METHODS.DEREGISTER_SESSION, session),
          ),
        );
      }
      harness.clock.advance(60_001);
      harness.service.maintenance();
      expect(harness.service.storageStatsForTesting()).toMatchObject({
        sessions: 0,
        messages: 0,
        events: 0,
        enqueueRateRows: 0,
        registrationRateRows: 0,
        terminalBodies: 0,
      });
      harness.service.close();

      const restarted = BrokerService.open({
        databasePath: harness.databasePath,
        credentialFilePath: harness.credentialFilePath,
        clock: harness.clock,
        random: harness.random,
        limits: {
          maintenanceBatchSize: 100,
          terminalMessageRetentionMs: 1_000,
          eventRetentionMs: 1_000,
          inactiveSessionRetentionMs: 1_000,
          rateRetentionMs: 60_000,
        },
      });
      try {
        expect(restarted.storageStatsForTesting()).toMatchObject({
          sessions: 0,
          messages: 0,
          events: 0,
        });
      } finally {
        restarted.close();
      }
    } finally {
      harness.close();
    }
  });
});

describe("ordered schema migrations", () => {
  test("initializes fresh state and preserves the supported schema across restart", () => {
    const harness = createHarness();
    try {
      expect(harness.service.schemaVersionForTesting()).toBe(5);
      harness.service.close();
      const restarted = BrokerService.open({
        databasePath: harness.databasePath,
        credentialFilePath: harness.credentialFilePath,
        clock: harness.clock,
        random: harness.random,
      });
      try {
        expect(restarted.schemaVersionForTesting()).toBe(5);
      } finally {
        restarted.close();
      }
    } finally {
      harness.close();
    }
  });

  test("migrates version 1 in order", () => {
    const harness = createHarness();
    try {
      harness.service.close();
      const database = new Database(harness.databasePath);
      database.run("DROP INDEX IF EXISTS sessions_admission_idx");
      database.run("ALTER TABLE sessions DROP COLUMN last_foreground_ms");
      database.run("ALTER TABLE sessions DROP COLUMN displaced");
      database.run("ALTER TABLE messages DROP COLUMN reply_to_message_id");
      database.run("DROP TABLE IF EXISTS registration_rate");
      database.run("PRAGMA user_version = 1");
      database.close();
      chmodSync(harness.databasePath, 0o600);

      const migrated = BrokerService.open({
        databasePath: harness.databasePath,
        credentialFilePath: harness.credentialFilePath,
        clock: harness.clock,
        random: harness.random,
      });
      try {
        expect(migrated.schemaVersionForTesting()).toBe(5);
        expectSuccess(migrated.dispatch(migrated.principal, registerRequest("migrated")));
      } finally {
        migrated.close();
      }
    } finally {
      harness.close();
    }
  });

  test("rejects unsupported newer versions without rewriting them", () => {
    const harness = createHarness();
    try {
      harness.service.close();
      const database = new Database(harness.databasePath);
      database.run("PRAGMA user_version = 99");
      database.close();
      chmodSync(harness.databasePath, 0o600);

      expect(() =>
        BrokerService.open({
          databasePath: harness.databasePath,
          credentialFilePath: harness.credentialFilePath,
          clock: harness.clock,
          random: harness.random,
        }),
      ).toThrow("unsupported");
      const unchanged = new Database(harness.databasePath, { readonly: true });
      const version = unchanged.query<{ user_version: number }, []>("PRAGMA user_version").get();
      unchanged.close();
      expect(version?.user_version).toBe(99);
    } finally {
      harness.close();
    }
  });
});
