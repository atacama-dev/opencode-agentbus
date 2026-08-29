import { chmodSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  MAX_MESSAGE_BYTES,
  METHODS,
  PROTOCOL_VERSION,
  type ConsumedMessageResult,
  type EnqueueMessageReceipt,
  type ListPendingMessagesResult,
  type PendingMessageEvent,
  type RegistrationResult,
  type ReplyMessageReceipt,
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
  replyRequest,
  requestId,
} from "./helpers";

function registerThree(harness: ReturnType<typeof createHarness>) {
  const source = expectSuccess<RegistrationResult>(
    harness.service.dispatch(harness.service.principal, registerRequest("source-a")),
  );
  const recipient = expectSuccess<RegistrationResult>(
    harness.service.dispatch(harness.service.principal, registerRequest("recipient-b")),
  );
  const foreign = expectSuccess<RegistrationResult>(
    harness.service.dispatch(harness.service.principal, registerRequest("foreign-c")),
  );
  return { source, recipient, foreign };
}

function sendAndDeliver(
  harness: ReturnType<typeof createHarness>,
  source: RegistrationResult,
  recipient: RegistrationResult,
  body = "original body",
) {
  const receipt = expectSuccess<EnqueueMessageReceipt>(
    harness.service.dispatch(
      harness.service.principal,
      enqueueRequest(source.identity, recipient.identity, body),
    ),
  );
  const delivered = expectSuccess<ConsumedMessageResult>(
    harness.service.dispatch(
      harness.service.principal,
      expectedMessageRequest(
        METHODS.CONSUME_MESSAGE,
        receipt.messageId,
        recipient.identity,
        receipt.bodyHash,
      ),
    ),
  );
  expect(delivered.messageId).toBe(receipt.messageId);
  return { receipt, delivered };
}

function listPending(
  service: BrokerService,
  target: RegistrationResult,
): ListPendingMessagesResult {
  return expectSuccess<ListPendingMessagesResult>(
    service.dispatch(service.principal, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId("list-replies"),
      method: METHODS.LIST_PENDING_MESSAGES,
      params: { target: target.identity, limit: 100 },
    }),
  );
}

describe("broker reply routing and ACL", () => {
  test("atomically resolves a delivered parent to its original source and emits correlated output", () => {
    const statements: string[] = [];
    const harness = createHarness({ statementObserver: (sql) => statements.push(sql) });
    try {
      const { source, recipient } = registerThree(harness);
      const original = sendAndDeliver(harness, source, recipient);
      statements.length = 0;

      const reply = expectSuccess<ReplyMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          replyRequest(recipient.identity, original.receipt.messageId, "reply body"),
        ),
      );
      expect(reply).toMatchObject({
        replyToMessageId: original.receipt.messageId,
        state: "PENDING",
      });
      expect(reply.messageId).not.toBe(original.receipt.messageId);
      expect(Object.hasOwn(reply, "body")).toBe(false);

      const pending = listPending(harness.service, source);
      expect(pending.headers).toHaveLength(1);
      expect(pending.headers[0]).toMatchObject({
        messageId: reply.messageId,
        replyToMessageId: original.receipt.messageId,
        source: recipient.identity,
        target: source.identity,
      });
      const retained = harness.service.retainedEventsForTesting(harness.service.principal);
      const replyEvent = retained.find((event) => event.header.messageId === reply.messageId);
      expect(replyEvent?.header.replyToMessageId).toBe(original.receipt.messageId);

      const deliveredReply = expectSuccess<ConsumedMessageResult>(
        harness.service.dispatch(
          harness.service.principal,
          expectedMessageRequest(
            METHODS.CONSUME_MESSAGE,
            reply.messageId,
            source.identity,
            reply.bodyHash,
          ),
        ),
      );
      expect(deliveredReply).toMatchObject({
        messageId: reply.messageId,
        replyToMessageId: original.receipt.messageId,
        body: "reply body",
      });

      const replySelects = statements.filter((sql) => sql.includes("reply-message"));
      expect(replySelects).toHaveLength(1);
      expect(replySelects.every((sql) => !/\bbody\b/i.test(sql))).toBe(true);
      const database = new Database(harness.databasePath, { readonly: true });
      const parent = database
        .query<{ body: string | null; state: string }, [string]>(
          "SELECT body, state FROM messages WHERE message_id = ?",
        )
        .get(original.receipt.messageId);
      database.close();
      expect(parent).toEqual({ body: null, state: "DELIVERED" });
    } finally {
      harness.close();
    }
  });

  test("conceals missing and non-addressed IDs while distinguishing owned non-delivered state", () => {
    const harness = createHarness();
    try {
      const { source, recipient, foreign } = registerThree(harness);
      const pending = expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, recipient.identity, "pending parent"),
        ),
      );

      expectError(
        harness.service.dispatch(
          harness.service.principal,
          replyRequest(recipient.identity, pending.messageId, "too early"),
        ),
        "MESSAGE_NOT_REPLYABLE",
      );
      for (const [caller, messageId] of [
        [source.identity, pending.messageId],
        [foreign.identity, pending.messageId],
        [recipient.identity, "message_guessed"],
      ] as const) {
        const response = harness.service.dispatch(
          harness.service.principal,
          replyRequest(caller, messageId, "must not disclose"),
        );
        expectError(response, "MESSAGE_NOT_FOUND");
        if (!response.ok) {
          expect(response.error).toEqual({
            code: "MESSAGE_NOT_FOUND",
            message: "The message does not exist.",
          });
        }
      }
    } finally {
      harness.close();
    }
  });

  test("rejects rejected, expired, and purged parents without reading retained content", () => {
    const harness = createHarness({ limits: { terminalMessageRetentionMs: 1_000 } });
    try {
      const { source, recipient } = registerThree(harness);

      const rejected = expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, recipient.identity, "rejected parent"),
        ),
      );
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          expectedMessageRequest(
            METHODS.REJECT_MESSAGE,
            rejected.messageId,
            recipient.identity,
            rejected.bodyHash,
          ),
        ),
      );
      expectError(
        harness.service.dispatch(
          harness.service.principal,
          replyRequest(recipient.identity, rejected.messageId, "no reply"),
        ),
        "MESSAGE_NOT_REPLYABLE",
      );

      const expired = expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, recipient.identity, "expired parent", 10),
        ),
      );
      harness.clock.advance(10_000);
      expectError(
        harness.service.dispatch(
          harness.service.principal,
          replyRequest(recipient.identity, expired.messageId, "no reply"),
        ),
        "MESSAGE_NOT_REPLYABLE",
      );

      const delivered = sendAndDeliver(harness, source, recipient, "purged parent");
      harness.clock.advance(1_001);
      harness.service.maintenance();
      expectError(
        harness.service.dispatch(
          harness.service.principal,
          replyRequest(recipient.identity, delivered.receipt.messageId, "too late"),
        ),
        "MESSAGE_NOT_FOUND",
      );
    } finally {
      harness.close();
    }
  });

  test("fails with TARGET_NOT_REGISTERED when the original source is no longer active", () => {
    const harness = createHarness();
    try {
      const { source, recipient } = registerThree(harness);
      const original = sendAndDeliver(harness, source, recipient);
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          claimRequest(METHODS.DEREGISTER_SESSION, source.identity),
        ),
      );
      expectError(
        harness.service.dispatch(
          harness.service.principal,
          replyRequest(recipient.identity, original.receipt.messageId, "inactive target"),
        ),
        "TARGET_NOT_REGISTERED",
      );
    } finally {
      harness.close();
    }
  });

  test("classifies reply body and TTL failures identically to send", () => {
    const harness = createHarness();
    try {
      const { source, recipient } = registerThree(harness);
      const original = sendAndDeliver(harness, source, recipient);
      expectError(
        harness.service.dispatch(
          harness.service.principal,
          replyRequest(
            recipient.identity,
            original.receipt.messageId,
            "x".repeat(MAX_MESSAGE_BYTES + 1),
          ),
        ),
        "MESSAGE_TOO_LARGE",
      );
      expectError(
        harness.service.dispatch(
          harness.service.principal,
          replyRequest(recipient.identity, original.receipt.messageId, "bad \ud800"),
        ),
        "INVALID_REQUEST",
      );
      expectError(
        harness.service.dispatch(
          harness.service.principal,
          replyRequest(recipient.identity, original.receipt.messageId, "bad ttl", 9),
        ),
        "TTL_OUT_OF_RANGE",
      );
    } finally {
      harness.close();
    }
  });
});

describe("broker reply persistence and limits", () => {
  test("allows multiple sequential replies with unique IDs, events, and normal quotas", () => {
    const harness = createHarness({
      limits: {
        enqueuePerPrincipalPerMinute: 20,
        enqueuePerSessionPerMinute: 20,
        maxPendingPerPrincipal: 20,
        maxPendingPerSession: 20,
      },
    });
    try {
      const { source, recipient } = registerThree(harness);
      const original = sendAndDeliver(harness, source, recipient);
      const responses = Array.from({ length: 5 }, (_, index) =>
        harness.service.dispatch(
          harness.service.principal,
          replyRequest(recipient.identity, original.receipt.messageId, `reply ${index}`),
        ),
      );
      const receipts = responses.map((response) => expectSuccess<ReplyMessageReceipt>(response));
      expect(new Set(receipts.map((receipt) => receipt.messageId)).size).toBe(5);
      expect(
        receipts.every((receipt) => receipt.replyToMessageId === original.receipt.messageId),
      ).toBe(true);
      const replyEvents = harness.service
        .retainedEventsForTesting(harness.service.principal)
        .filter((event: PendingMessageEvent) => event.header.replyToMessageId !== undefined);
      expect(replyEvents).toHaveLength(5);
      expect(new Set(replyEvents.map((event) => event.eventId)).size).toBe(5);
    } finally {
      harness.close();
    }
  });

  test("charges replies to the same rate policy as sends", () => {
    const harness = createHarness({
      limits: {
        enqueuePerPrincipalPerMinute: 2,
        enqueuePerSessionPerMinute: 2,
        maxPendingPerPrincipal: 10,
        maxPendingPerSession: 10,
      },
    });
    try {
      const { source, recipient } = registerThree(harness);
      const original = sendAndDeliver(harness, source, recipient);
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          replyRequest(recipient.identity, original.receipt.messageId, "first reply"),
        ),
      );
      expectError(
        harness.service.dispatch(
          harness.service.principal,
          replyRequest(recipient.identity, original.receipt.messageId, "limited reply"),
        ),
        "RATE_LIMITED",
      );
      expect(harness.service.storageStatsForTesting()).toMatchObject({
        messages: 2,
        pendingBodies: 1,
        terminalBodies: 0,
      });
    } finally {
      harness.close();
    }
  });

  test("charges replies to the same pending policy as sends", () => {
    const harness = createHarness({
      limits: {
        enqueuePerPrincipalPerMinute: 100,
        enqueuePerSessionPerMinute: 100,
        maxPendingPerPrincipal: 1,
        maxPendingPerSession: 1,
      },
    });
    try {
      const { source, recipient } = registerThree(harness);
      const original = sendAndDeliver(harness, source, recipient);
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          replyRequest(recipient.identity, original.receipt.messageId, "first pending reply"),
        ),
      );
      expectError(
        harness.service.dispatch(
          harness.service.principal,
          replyRequest(recipient.identity, original.receipt.messageId, "pending-limited reply"),
        ),
        "RATE_LIMITED",
      );
      expect(listPending(harness.service, source).headers).toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  test("charges replies to the same durable per-source policy as sends", () => {
    const harness = createHarness({
      limits: {
        enqueuePerPrincipalPerMinute: 100,
        enqueuePerSessionPerMinute: 100,
        maxPendingPerPrincipal: 3,
        maxPendingPerSession: 3,
        maxMessagesPerSourceSession: 1,
        maxMessagesPerPrincipal: 3,
        maxMessagesGlobal: 3,
      },
    });
    try {
      const { source, recipient } = registerThree(harness);
      const original = sendAndDeliver(harness, source, recipient);
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          replyRequest(recipient.identity, original.receipt.messageId, "first durable reply"),
        ),
      );
      expectError(
        harness.service.dispatch(
          harness.service.principal,
          replyRequest(recipient.identity, original.receipt.messageId, "durable-limited reply"),
        ),
        "RATE_LIMITED",
      );
      expect(harness.service.storageStatsForTesting().messages).toBe(2);
    } finally {
      harness.close();
    }
  });

  test("replies after broker restart within retention and does not require a local routing map", () => {
    const harness = createHarness();
    try {
      const { source, recipient } = registerThree(harness);
      const original = sendAndDeliver(harness, source, recipient);
      harness.service.close();
      const restarted = BrokerService.open({
        databasePath: harness.databasePath,
        credentialFilePath: harness.credentialFilePath,
        clock: harness.clock,
        random: harness.random,
      });
      try {
        const reply = expectSuccess<ReplyMessageReceipt>(
          restarted.dispatch(
            restarted.principal,
            replyRequest(recipient.identity, original.receipt.messageId, "after restart"),
          ),
        );
        expect(reply.replyToMessageId).toBe(original.receipt.messageId);
        expect(listPending(restarted, source).headers[0]?.messageId).toBe(reply.messageId);
      } finally {
        restarted.close();
      }
    } finally {
      harness.close();
    }
  });

  test("permits parent terminal-row purge while a reply child remains pending", () => {
    const harness = createHarness({ limits: { terminalMessageRetentionMs: 1_000 } });
    try {
      const { source, recipient } = registerThree(harness);
      const original = sendAndDeliver(harness, source, recipient);
      const reply = expectSuccess<ReplyMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          replyRequest(recipient.identity, original.receipt.messageId, "retained child", 60),
        ),
      );
      harness.clock.advance(1_001);
      harness.service.maintenance();

      const database = new Database(harness.databasePath, { readonly: true });
      const rows = database
        .query<{ message_id: string; reply_to_message_id: string | null }, []>(
          "SELECT message_id, reply_to_message_id FROM messages ORDER BY message_id",
        )
        .all();
      database.close();
      expect(rows).toEqual([
        { message_id: reply.messageId, reply_to_message_id: original.receipt.messageId },
      ]);
      expect(listPending(harness.service, source).headers[0]?.replyToMessageId).toBe(
        original.receipt.messageId,
      );
    } finally {
      harness.close();
    }
  });
});

describe("v3 to v4 reply-link migration", () => {
  test("upgrades v3 data in order and preserves pending/delivered rows with null linkage", () => {
    const harness = createHarness();
    try {
      const { source, recipient } = registerThree(harness);
      const pending = expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, recipient.identity, "pending v3"),
        ),
      );
      const delivered = sendAndDeliver(harness, source, recipient, "delivered v3");
      harness.service.close();

      const v3 = new Database(harness.databasePath);
      v3.run("DROP INDEX IF EXISTS sessions_admission_idx");
      v3.run("ALTER TABLE sessions DROP COLUMN last_foreground_ms");
      v3.run("ALTER TABLE sessions DROP COLUMN displaced");
      v3.run("ALTER TABLE messages DROP COLUMN reply_to_message_id");
      v3.run("PRAGMA user_version = 3");
      v3.close();
      chmodSync(harness.databasePath, 0o600);

      const migrated = BrokerService.open({
        databasePath: harness.databasePath,
        credentialFilePath: harness.credentialFilePath,
        clock: harness.clock,
        random: harness.random,
      });
      try {
        expect(migrated.schemaVersionForTesting()).toBe(5);
        const database = new Database(harness.databasePath, { readonly: true });
        const rows = database
          .query<{ message_id: string; state: string; reply_to_message_id: string | null }, []>(
            "SELECT message_id, state, reply_to_message_id FROM messages ORDER BY message_id",
          )
          .all();
        database.close();
        expect(rows).toContainEqual({
          message_id: pending.messageId,
          state: "PENDING",
          reply_to_message_id: null,
        });
        expect(rows).toContainEqual({
          message_id: delivered.receipt.messageId,
          state: "DELIVERED",
          reply_to_message_id: null,
        });
      } finally {
        migrated.close();
      }
    } finally {
      harness.close();
    }
  });

  test("reopens a valid v5 database and leaves user_version unchanged on migration failure", () => {
    const harness = createHarness();
    try {
      expect(harness.service.schemaVersionForTesting()).toBe(5);
      harness.service.close();
      chmodSync(harness.databasePath, 0o600);
      const reopened = BrokerService.open({
        databasePath: harness.databasePath,
        credentialFilePath: harness.credentialFilePath,
        clock: harness.clock,
        random: harness.random,
      });
      expect(reopened.schemaVersionForTesting()).toBe(5);
      reopened.close();

      const broken = new Database(harness.databasePath);
      broken.run("ALTER TABLE messages RENAME TO messages_broken");
      broken.run("PRAGMA user_version = 3");
      broken.close();
      chmodSync(harness.databasePath, 0o600);
      expect(() =>
        BrokerService.open({
          databasePath: harness.databasePath,
          credentialFilePath: harness.credentialFilePath,
          clock: harness.clock,
          random: harness.random,
        }),
      ).toThrow();
      const unchanged = new Database(harness.databasePath, { readonly: true });
      const version = unchanged.query<{ user_version: number }, []>("PRAGMA user_version").get();
      unchanged.close();
      expect(version?.user_version).toBe(3);
    } finally {
      harness.close();
    }
  });

  test.each([
    ["canonical nullable TEXT", "TEXT"],
    ["wrong type", "INTEGER"],
    ["NOT NULL/default", "TEXT NOT NULL DEFAULT ''"],
    ["non-null default", "TEXT DEFAULT 'message_default'"],
    ["restrictive foreign key", "TEXT REFERENCES messages(message_id) ON DELETE CASCADE"],
    ["restrictive CHECK", "TEXT CHECK(reply_to_message_id IS NULL)"],
  ])("rejects a partial v3 column with %s without advancing user_version", (_label, definition) => {
    const harness = createHarness();
    try {
      harness.service.close();
      const partial = new Database(harness.databasePath);
      partial.run("ALTER TABLE messages DROP COLUMN reply_to_message_id");
      partial.run(`ALTER TABLE messages ADD COLUMN reply_to_message_id ${definition}`);
      partial.run("PRAGMA user_version = 3");
      partial.close();
      chmodSync(harness.databasePath, 0o600);

      expect(() =>
        BrokerService.open({
          databasePath: harness.databasePath,
          credentialFilePath: harness.credentialFilePath,
          clock: harness.clock,
          random: harness.random,
        }),
      ).toThrow(/reply_to_message_id/i);
      const unchanged = new Database(harness.databasePath, { readonly: true });
      const version = unchanged.query<{ user_version: number }, []>("PRAGMA user_version").get();
      unchanged.close();
      expect(version?.user_version).toBe(3);
    } finally {
      harness.close();
    }
  });

  test("rejects a partial v3 column with a unique index without mutating the database", () => {
    const harness = createHarness();
    try {
      harness.service.close();
      const partial = new Database(harness.databasePath);
      partial.run("ALTER TABLE messages DROP COLUMN reply_to_message_id");
      partial.run("ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT");
      partial.run("CREATE UNIQUE INDEX messages_reply_unique ON messages(reply_to_message_id)");
      partial.run("PRAGMA user_version = 3");
      partial.close();
      chmodSync(harness.databasePath, 0o600);

      expect(() =>
        BrokerService.open({
          databasePath: harness.databasePath,
          credentialFilePath: harness.credentialFilePath,
          clock: harness.clock,
          random: harness.random,
        }),
      ).toThrow(/reply_to_message_id/i);
      const unchanged = new Database(harness.databasePath, { readonly: true });
      const version = unchanged.query<{ user_version: number }, []>("PRAGMA user_version").get();
      const indexes = unchanged
        .query<{ name: string }, []>("PRAGMA index_list(messages)")
        .all()
        .map((index) => index.name);
      unchanged.close();
      expect(version?.user_version).toBe(3);
      expect(indexes).toContain("messages_reply_unique");
    } finally {
      harness.close();
    }
  });
});
