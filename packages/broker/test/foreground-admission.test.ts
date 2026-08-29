import { chmodSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  METHODS,
  PROTOCOL_VERSION,
  type EnqueueMessageReceipt,
  type ForegroundIdentityResult,
  type RegistrationResult,
  type ReplyMessageReceipt,
  type SearchSessionsResult,
  type SessionIdentity,
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

function foreground(hostSessionId: string, title = hostSessionId) {
  return { hostSessionId, metadata: { title, labels: ["test"] } } as const;
}

function activeHosts(databasePath: string): readonly string[] {
  const database = new Database(databasePath, { readonly: true });
  const rows = database
    .query<{ host_session_id: string }, []>(
      "SELECT host_session_id FROM sessions WHERE opt_in = 1 AND lease_expires_ms > 0 ORDER BY host_session_id",
    )
    .all();
  database.close();
  return rows.map((row) => row.host_session_id);
}

function allHosts(databasePath: string): readonly string[] {
  const database = new Database(databasePath, { readonly: true });
  const rows = database
    .query<{ host_session_id: string }, []>(
      "SELECT host_session_id FROM sessions ORDER BY host_session_id",
    )
    .all();
  database.close();
  return rows.map((row) => row.host_session_id);
}

function downgradeSessionsSchemaToV4(databasePath: string): void {
  const database = new Database(databasePath);
  database.run("DROP INDEX IF EXISTS sessions_admission_idx");
  const columns = database.query<{ name: string }, []>("PRAGMA table_info(sessions)").all();
  for (const columnName of ["last_foreground_ms", "displaced"]) {
    if (columns.some((column) => column.name === columnName)) {
      database.run(`ALTER TABLE sessions DROP COLUMN ${columnName}`);
    }
  }
  database.run("PRAGMA user_version = 4");
  database.close();
  chmodSync(databasePath, 0o600);
}

function rewriteSessionsTableSql(databasePath: string, transform: (sql: string) => string): void {
  const database = new Database(databasePath);
  const row = database
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'sessions'",
    )
    .get();
  if (!row) throw new Error("Missing sessions schema fixture.");
  const rewritten = transform(row.sql);
  if (rewritten === row.sql) throw new Error("Malformed schema fixture did not change the table.");
  database.run("PRAGMA foreign_keys = OFF");
  for (const table of ["events", "enqueue_rate", "messages", "sessions"]) {
    database.run(`DROP TABLE ${table}`);
  }
  database.run(rewritten);
  database.run(`
    CREATE TABLE messages (
      message_id TEXT PRIMARY KEY,
      source_session_id TEXT NOT NULL,
      target_session_id TEXT NOT NULL,
      target_principal_id TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      body_bytes INTEGER NOT NULL,
      body TEXT,
      state TEXT NOT NULL CHECK (state IN ('PENDING', 'DELIVERED', 'REJECTED', 'EXPIRED')),
      enqueued_ms INTEGER NOT NULL,
      expires_ms INTEGER NOT NULL,
      delivered_ms INTEGER,
      rejected_ms INTEGER,
      reply_to_message_id TEXT,
      FOREIGN KEY (source_session_id) REFERENCES sessions(session_id),
      FOREIGN KEY (target_session_id) REFERENCES sessions(session_id),
      FOREIGN KEY (target_principal_id) REFERENCES principals(principal_id)
    )
  `);
  database.run(`
    CREATE TABLE events (
      principal_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      target_session_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      created_ms INTEGER NOT NULL,
      PRIMARY KEY (principal_id, sequence),
      FOREIGN KEY (principal_id) REFERENCES principals(principal_id),
      FOREIGN KEY (target_session_id) REFERENCES sessions(session_id)
    )
  `);
  database.run(`
    CREATE TABLE enqueue_rate (
      principal_id TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      occurred_ms INTEGER NOT NULL,
      FOREIGN KEY (principal_id) REFERENCES principals(principal_id),
      FOREIGN KEY (source_session_id) REFERENCES sessions(session_id)
    )
  `);
  database.run(
    "CREATE INDEX sessions_active_idx ON sessions(principal_id, opt_in, lease_expires_ms)",
  );
  database.run(
    "CREATE INDEX sessions_retention_idx ON sessions(opt_in, lease_expires_ms, updated_ms)",
  );
  database.run(
    "CREATE INDEX messages_pending_target_idx ON messages(target_session_id, state, expires_ms, enqueued_ms, message_id)",
  );
  database.run(
    "CREATE INDEX messages_pending_principal_idx ON messages(target_principal_id, state, expires_ms)",
  );
  database.run(
    "CREATE INDEX messages_terminal_idx ON messages(state, delivered_ms, rejected_ms, expires_ms)",
  );
  database.run("CREATE INDEX events_created_idx ON events(principal_id, created_ms)");
  database.run(
    "CREATE INDEX enqueue_rate_idx ON enqueue_rate(principal_id, source_session_id, occurred_ms)",
  );
  database.close();
  chmodSync(databasePath, 0o600);
}

function resolveIdentity(
  harness: ReturnType<typeof createHarness>,
  hostSessionId: string,
  title = hostSessionId,
): ForegroundIdentityResult {
  return expectSuccess<ForegroundIdentityResult>(
    harness.service.dispatch(harness.service.principal, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId("foreground-identity"),
      method: METHODS.RESOLVE_FOREGROUND_SESSION,
      params: foreground(hostSessionId, title),
    }),
  );
}

function searchRequest(requester: SessionIdentity, hostSessionId: string, query = "no-match") {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId("foreground-search"),
    method: METHODS.SEARCH_SESSIONS,
    params: {
      requester,
      foreground: foreground(hostSessionId),
      scope: requester.broker,
      query,
      limit: 10,
    },
  } as const;
}

describe("broker-authoritative foreground admission", () => {
  test("resolves a canonical foreground identity without creating a row or consuming an active slot", () => {
    const harness = createHarness({ limits: { maxActiveSessionsPerPrincipal: 1 } });
    try {
      const before = harness.service.storageStatsForTesting();
      const resolved = expectSuccess<ForegroundIdentityResult>(
        harness.service.dispatch(harness.service.principal, {
          protocolVersion: PROTOCOL_VERSION,
          requestId: requestId("foreground-identity"),
          method: METHODS.RESOLVE_FOREGROUND_SESSION,
          params: foreground("identity-only", "Identity only"),
        }),
      );
      expect(resolved).toMatchObject({
        hostSessionId: "identity-only",
        metadata: { title: "Identity only", labels: ["test"] },
      });
      expect(resolved.fingerprint).toBeDefined();
      expect(harness.service.storageStatsForTesting()).toEqual(before);
    } finally {
      harness.close();
    }
  });

  test("captures a zero-event watermark atomically and replays the first later event", () => {
    const harness = createHarness();
    try {
      const requester = resolveIdentity(harness, "watermark-requester");
      const response = harness.service.dispatch(
        harness.service.principal,
        searchRequest(requester.identity, "watermark-requester", "unmatched needle"),
      );
      if (!response.ok || !("foregroundRecovery" in response)) {
        throw new Error("Missing foreground recovery watermark.");
      }
      expect(String(response.foregroundRecovery.eventCursor)).toBe("0");

      const sender = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("watermark-sender")),
      );
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(sender.identity, requester.identity, "after zero watermark"),
        ),
      );
      const replay = harness.service.replayEvents(
        harness.service.principal,
        response.foregroundRecovery.eventCursor,
      );
      expect(replay.ok).toBe(true);
      if (replay.ok) expect(replay.events.map((event) => String(event.eventId))).toEqual(["1"]);
    } finally {
      harness.close();
    }
  });

  test("reserves durable rows for foreground operations instead of filling them from background bootstrap", () => {
    const harness = createHarness({
      limits: {
        maxActiveSessionsPerPrincipal: 3,
        maxSessionsPerPrincipal: 4,
        maxSessionsGlobal: 4,
        foregroundSessionReserve: 1,
        registrationsPerPrincipalPerMinute: 20,
      },
    });
    try {
      for (const hostSessionId of ["reserve-a", "reserve-b", "reserve-c"]) {
        expectSuccess(
          harness.service.dispatch(harness.service.principal, registerRequest(hostSessionId)),
        );
      }
      expectError(
        harness.service.dispatch(harness.service.principal, registerRequest("reserve-blocked")),
        "RATE_LIMITED",
      );
      expect(allHosts(harness.databasePath)).toEqual(["reserve-a", "reserve-b", "reserve-c"]);
    } finally {
      harness.close();
    }
  });

  test("reclaims only the deterministic state-free background row at the durable boundary", () => {
    const harness = createHarness({
      limits: {
        maxActiveSessionsPerPrincipal: 3,
        maxSessionsPerPrincipal: 4,
        maxSessionsGlobal: 4,
        foregroundSessionReserve: 1,
        registrationsPerPrincipalPerMinute: 20,
      },
    });
    try {
      expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("durable-safe-oldest")),
      );
      harness.clock.advance(1);
      const statefulTarget = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("durable-stateful")),
      );
      harness.clock.advance(1);
      const statefulSource = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("durable-source")),
      );
      const pending = expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(statefulSource.identity, statefulTarget.identity, "stateful durable body"),
        ),
      );

      const firstForeground = resolveIdentity(harness, "durable-foreground-1");
      expectSuccess<SearchSessionsResult>(
        harness.service.dispatch(
          harness.service.principal,
          searchRequest(firstForeground.identity, "durable-foreground-1"),
        ),
      );
      const secondForeground = resolveIdentity(harness, "durable-foreground-2");
      expectSuccess<SearchSessionsResult>(
        harness.service.dispatch(
          harness.service.principal,
          searchRequest(secondForeground.identity, "durable-foreground-2"),
        ),
      );

      expect(allHosts(harness.databasePath)).toEqual([
        "durable-foreground-1",
        "durable-foreground-2",
        "durable-source",
        "durable-stateful",
      ]);
      expect(harness.service.storageStatsForTesting()).toMatchObject({
        sessions: 4,
        pendingBodies: 1,
      });
      const recovered = expectSuccess<{ headers: readonly { messageId: string }[] }>(
        harness.service.dispatch(harness.service.principal, {
          protocolVersion: PROTOCOL_VERSION,
          requestId: requestId("stateful-list"),
          method: METHODS.LIST_PENDING_MESSAGES,
          params: {
            target: statefulTarget.identity,
            foreground: foreground("durable-stateful"),
            limit: 10,
          },
        }),
      );
      expect(recovered.headers.map((header) => header.messageId)).toEqual([pending.messageId]);
    } finally {
      harness.close();
    }
  });

  test("protects the sole search match from durable reclamation and active displacement", () => {
    const harness = createHarness({
      limits: {
        maxActiveSessionsPerPrincipal: 2,
        maxSessionsPerPrincipal: 3,
        maxSessionsGlobal: 3,
        foregroundSessionReserve: 1,
        registrationsPerPrincipalPerMinute: 20,
      },
    });
    try {
      expectSuccess(
        harness.service.dispatch(harness.service.principal, registerRequest("search-reclaimable")),
      );
      harness.clock.advance(1);
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(
          harness.service.principal,
          registerRequest("search-protected-durable", "Only Durable Match"),
        ),
      );
      const first = resolveIdentity(harness, "search-fill-foreground");
      expectSuccess<SearchSessionsResult>(
        harness.service.dispatch(
          harness.service.principal,
          searchRequest(first.identity, "search-fill-foreground", "unmatched needle"),
        ),
      );
      const requester = resolveIdentity(harness, "search-boundary-requester");
      const found = expectSuccess<SearchSessionsResult>(
        harness.service.dispatch(
          harness.service.principal,
          searchRequest(requester.identity, "search-boundary-requester", "only durable match"),
        ),
      );
      expect(found.matches.map((match) => match.session)).toEqual([target.identity]);
      expect(allHosts(harness.databasePath)).toEqual([
        "search-boundary-requester",
        "search-fill-foreground",
        "search-protected-durable",
      ]);
      expect(activeHosts(harness.databasePath)).toContain("search-protected-durable");
    } finally {
      harness.close();
    }
  });

  test("fails canonically at the durable boundary when every row is stateful or foreground-used", () => {
    const harness = createHarness({
      limits: {
        maxActiveSessionsPerPrincipal: 3,
        maxSessionsPerPrincipal: 4,
        maxSessionsGlobal: 4,
        foregroundSessionReserve: 1,
        registrationsPerPrincipalPerMinute: 20,
      },
    });
    try {
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("full-state-source")),
      );
      const targetA = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("full-state-a")),
      );
      const targetB = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("full-state-b")),
      );
      for (const target of [targetA, targetB]) {
        expectSuccess(
          harness.service.dispatch(
            harness.service.principal,
            enqueueRequest(
              source.identity,
              target.identity,
              `state for ${target.identity.sessionId}`,
            ),
          ),
        );
      }
      const firstForeground = resolveIdentity(harness, "full-state-foreground");
      expectSuccess<SearchSessionsResult>(
        harness.service.dispatch(
          harness.service.principal,
          searchRequest(firstForeground.identity, "full-state-foreground"),
        ),
      );
      const blocked = resolveIdentity(harness, "full-state-blocked");
      expectError(
        harness.service.dispatch(
          harness.service.principal,
          searchRequest(blocked.identity, "full-state-blocked"),
        ),
        "RATE_LIMITED",
      );
      expect(allHosts(harness.databasePath)).toEqual([
        "full-state-a",
        "full-state-b",
        "full-state-foreground",
        "full-state-source",
      ]);
      expect(harness.service.storageStatsForTesting().pendingBodies).toBe(2);
    } finally {
      harness.close();
    }
  });

  test("atomically admits a saturated source, protects the send target, and evicts deterministically", () => {
    const harness = createHarness({ limits: { maxActiveSessionsPerPrincipal: 3 } });
    try {
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("foreground-source")),
      );
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          claimRequest(METHODS.DEREGISTER_SESSION, source.identity),
        ),
      );
      const oldestBackground = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("background-oldest")),
      );
      harness.clock.advance(1);
      const newerBackground = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("background-newer")),
      );
      harness.clock.advance(1);
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("protected-target")),
      );

      const request = enqueueRequest(
        source.identity,
        target.identity,
        "foreground saturation send",
        60,
      );
      const sent = expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(harness.service.principal, {
          ...request,
          params: { ...request.params, foreground: foreground("foreground-source") },
        }),
      );
      expect(sent.state).toBe("PENDING");
      expect(activeHosts(harness.databasePath)).toEqual([
        "background-newer",
        "foreground-source",
        "protected-target",
      ]);
      expect(activeHosts(harness.databasePath)).toHaveLength(3);

      harness.clock.advance(1_000);
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          claimRequest(METHODS.HEARTBEAT_SESSION, newerBackground.identity),
        ),
      );
      expectSuccess<SearchSessionsResult>(
        harness.service.dispatch(
          harness.service.principal,
          searchRequest(oldestBackground.identity, "background-oldest"),
        ),
      );
      expect(activeHosts(harness.databasePath)).toEqual([
        "background-oldest",
        "foreground-source",
        "protected-target",
      ]);

      expectSuccess<SearchSessionsResult>(
        harness.service.dispatch(
          harness.service.principal,
          searchRequest(newerBackground.identity, "background-newer"),
        ),
      );
      expect(activeHosts(harness.databasePath)).toEqual(
        ["background-newer", "foreground-source", "background-oldest"].sort(),
      );
      expect(new Set(activeHosts(harness.databasePath)).size).toBe(3);

      const beforeForgedAdmission = activeHosts(harness.databasePath);
      const forged = searchRequest(newerBackground.identity, "forged-host");
      expectError(harness.service.dispatch(harness.service.principal, forged), "FORBIDDEN");
      expect(activeHosts(harness.databasePath)).toEqual(beforeForgedAdmission);
    } finally {
      harness.close();
    }
  });

  test("atomically reactivates a displaced source and displaced send dependency", () => {
    const harness = createHarness({ limits: { maxActiveSessionsPerPrincipal: 2 } });
    try {
      expectSuccess(
        harness.service.dispatch(harness.service.principal, registerRequest("both-background-a")),
      );
      harness.clock.advance(1);
      expectSuccess(
        harness.service.dispatch(harness.service.principal, registerRequest("both-background-b")),
      );
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("both-source")),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("both-target")),
      );
      expect(source.registration).toBe("deferred");
      expect(target.registration).toBe("deferred");
      expect(activeHosts(harness.databasePath)).toEqual(["both-background-a", "both-background-b"]);

      const request = enqueueRequest(source.identity, target.identity, "both dependencies return");
      expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(harness.service.principal, {
          ...request,
          params: { ...request.params, foreground: foreground("both-source") },
        }),
      );
      expect(activeHosts(harness.databasePath)).toEqual(["both-source", "both-target"]);
      expect(harness.service.storageStatsForTesting()).toMatchObject({
        activeSessions: 2,
        displacedSessions: 2,
        pendingBodies: 1,
      });
    } finally {
      harness.close();
    }
  });

  test("accepts repeated heartbeats from a displaced background session without reactivation", () => {
    const harness = createHarness({ limits: { maxActiveSessionsPerPrincipal: 1 } });
    try {
      const background = expectSuccess<RegistrationResult>(
        harness.service.dispatch(
          harness.service.principal,
          registerRequest("heartbeat-background"),
        ),
      );
      const foregroundIdentity = expectSuccess<RegistrationResult>(
        harness.service.dispatch(
          harness.service.principal,
          registerRequest("heartbeat-foreground"),
        ),
      );
      expect(foregroundIdentity.registration).toBe("deferred");
      expectSuccess<SearchSessionsResult>(
        harness.service.dispatch(
          harness.service.principal,
          searchRequest(foregroundIdentity.identity, "heartbeat-foreground", "unmatched needle"),
        ),
      );
      for (let index = 0; index < 2; index += 1) {
        expectSuccess(
          harness.service.dispatch(
            harness.service.principal,
            claimRequest(METHODS.HEARTBEAT_SESSION, background.identity),
          ),
        );
      }
      expect(activeHosts(harness.databasePath)).toEqual(["heartbeat-foreground"]);
      expect(harness.service.storageStatsForTesting().displacedSessions).toBe(1);
    } finally {
      harness.close();
    }
  });

  test("uses foreground recency before deterministic session-id ties when all victims are foreground", () => {
    const harness = createHarness({ limits: { maxActiveSessionsPerPrincipal: 2 } });
    try {
      const first = resolveIdentity(harness, "foreground-lru-first");
      expectSuccess<SearchSessionsResult>(
        harness.service.dispatch(
          harness.service.principal,
          searchRequest(first.identity, "foreground-lru-first", "unmatched needle"),
        ),
      );
      harness.clock.advance(1);
      const second = resolveIdentity(harness, "foreground-lru-second");
      expectSuccess<SearchSessionsResult>(
        harness.service.dispatch(
          harness.service.principal,
          searchRequest(second.identity, "foreground-lru-second", "unmatched needle"),
        ),
      );
      harness.clock.advance(1);
      expectSuccess<SearchSessionsResult>(
        harness.service.dispatch(
          harness.service.principal,
          searchRequest(first.identity, "foreground-lru-first", "unmatched needle"),
        ),
      );
      harness.clock.advance(1);
      const third = resolveIdentity(harness, "foreground-lru-third");
      expectSuccess<SearchSessionsResult>(
        harness.service.dispatch(
          harness.service.principal,
          searchRequest(third.identity, "foreground-lru-third", "unmatched needle"),
        ),
      );
      expect(activeHosts(harness.databasePath)).toEqual([
        "foreground-lru-first",
        "foreground-lru-third",
      ]);
    } finally {
      harness.close();
    }

    const tieHarness = createHarness({ limits: { maxActiveSessionsPerPrincipal: 2 } });
    try {
      const tied = [
        resolveIdentity(tieHarness, "foreground-tie-a"),
        resolveIdentity(tieHarness, "foreground-tie-b"),
      ];
      for (const identity of tied) {
        expectSuccess<SearchSessionsResult>(
          tieHarness.service.dispatch(
            tieHarness.service.principal,
            searchRequest(identity.identity, identity.metadata.title ?? "tie", "unmatched needle"),
          ),
        );
      }
      const newcomer = resolveIdentity(tieHarness, "foreground-tie-c");
      expectSuccess<SearchSessionsResult>(
        tieHarness.service.dispatch(
          tieHarness.service.principal,
          searchRequest(newcomer.identity, "foreground-tie-c", "unmatched needle"),
        ),
      );
      const victim = [...tied].sort((left, right) =>
        left.identity.sessionId.localeCompare(right.identity.sessionId),
      )[0];
      expect(victim).toBeDefined();
      expect(activeHosts(tieHarness.databasePath)).not.toContain(victim?.metadata.title);
      expect(activeHosts(tieHarness.databasePath)).toHaveLength(2);
    } finally {
      tieHarness.close();
    }
  });

  test("preserves a pending body while its target is displaced and returns it after foreground re-admission", () => {
    const harness = createHarness({ limits: { maxActiveSessionsPerPrincipal: 2 } });
    try {
      const newcomer = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("newcomer")),
      );
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          claimRequest(METHODS.DEREGISTER_SESSION, newcomer.identity),
        ),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("pending-target")),
      );
      harness.clock.advance(1);
      const sender = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("pending-sender")),
      );
      const pending = expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(sender.identity, target.identity, "body survives displacement"),
        ),
      );

      expectSuccess<SearchSessionsResult>(
        harness.service.dispatch(
          harness.service.principal,
          searchRequest(newcomer.identity, "newcomer"),
        ),
      );
      expect(activeHosts(harness.databasePath)).not.toContain("pending-target");

      const passiveRecovery = expectSuccess<{ headers: readonly { messageId: string }[] }>(
        harness.service.dispatch(harness.service.principal, {
          protocolVersion: PROTOCOL_VERSION,
          requestId: requestId("displaced-passive-list"),
          method: METHODS.LIST_PENDING_MESSAGES,
          params: { target: target.identity, limit: 10 },
        }),
      );
      expect(passiveRecovery.headers.map((header) => header.messageId)).toEqual([
        pending.messageId,
      ]);
      expect(activeHosts(harness.databasePath)).not.toContain("pending-target");

      const list = {
        protocolVersion: PROTOCOL_VERSION,
        requestId: requestId("foreground-list"),
        method: METHODS.LIST_PENDING_MESSAGES,
        params: {
          target: target.identity,
          foreground: foreground("pending-target"),
          limit: 10,
        },
      } as const;
      const recovered = expectSuccess<{ headers: readonly { messageId: string }[] }>(
        harness.service.dispatch(harness.service.principal, list),
      );
      expect(recovered.headers.map((header) => header.messageId)).toEqual([pending.messageId]);
      expect(activeHosts(harness.databasePath)).toHaveLength(2);
      expect(harness.service.storageStatsForTesting().pendingBodies).toBe(1);
    } finally {
      harness.close();
    }
  });

  test("protects a search match from source admission and keeps it available for the following send", () => {
    const harness = createHarness({ limits: { maxActiveSessionsPerPrincipal: 2 } });
    try {
      const source = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("search-source")),
      );
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          claimRequest(METHODS.DEREGISTER_SESSION, source.identity),
        ),
      );
      const target = expectSuccess<RegistrationResult>(
        harness.service.dispatch(
          harness.service.principal,
          registerRequest("search-target", "Exact Saturated Target"),
        ),
      );
      harness.clock.advance(1);
      expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("search-other")),
      );

      const found = expectSuccess<SearchSessionsResult>(
        harness.service.dispatch(
          harness.service.principal,
          searchRequest(source.identity, "search-source", "exact saturated target"),
        ),
      );
      expect(found.matches.map((match) => match.session)).toEqual([target.identity]);
      expect(activeHosts(harness.databasePath)).toContain("search-target");

      const request = enqueueRequest(source.identity, target.identity, "post-search delivery");
      expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(harness.service.principal, {
          ...request,
          params: { ...request.params, foreground: foreground("search-source") },
        }),
      );
      expect(activeHosts(harness.databasePath)).toEqual(["search-source", "search-target"]);
      expect(harness.service.storageStatsForTesting()).toMatchObject({
        activeSessions: 2,
        pendingBodies: 1,
      });
    } finally {
      harness.close();
    }
  });

  test("re-admits the broker-resolved original source during reply without model target authority", () => {
    const harness = createHarness({ limits: { maxActiveSessionsPerPrincipal: 3 } });
    try {
      const originalSource = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("original-source")),
      );
      harness.clock.advance(1);
      const recipient = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("replying-recipient")),
      );
      harness.clock.advance(1);
      expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("reply-other")),
      );
      const original = expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(originalSource.identity, recipient.identity, "original"),
        ),
      );
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          expectedMessageRequest(
            METHODS.CONSUME_MESSAGE,
            original.messageId,
            recipient.identity,
            original.bodyHash,
          ),
        ),
      );

      const newcomer = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("reply-newcomer")),
      );
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          claimRequest(METHODS.DEREGISTER_SESSION, newcomer.identity),
        ),
      );
      expectSuccess<SearchSessionsResult>(
        harness.service.dispatch(
          harness.service.principal,
          searchRequest(newcomer.identity, "reply-newcomer"),
        ),
      );
      expect(activeHosts(harness.databasePath)).not.toContain("original-source");

      const request = replyRequest(recipient.identity, original.messageId, "reply body");
      const reply = expectSuccess<ReplyMessageReceipt>(
        harness.service.dispatch(harness.service.principal, {
          ...request,
          params: {
            ...request.params,
            foreground: foreground("replying-recipient"),
          },
        }),
      );
      expect(reply.replyToMessageId).toBe(original.messageId);
      expect(activeHosts(harness.databasePath)).toContain("original-source");
      expect(activeHosts(harness.databasePath)).toHaveLength(3);
    } finally {
      harness.close();
    }
  });

  test("preserves reply linkage, replay event, and TTL semantics while the reply target is displaced", () => {
    const harness = createHarness({ limits: { maxActiveSessionsPerPrincipal: 2 } });
    try {
      const originalSource = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("ttl-original-source")),
      );
      const recipient = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("ttl-reply-source")),
      );
      const original = expectSuccess<EnqueueMessageReceipt>(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(originalSource.identity, recipient.identity, "ttl original"),
        ),
      );
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          expectedMessageRequest(
            METHODS.CONSUME_MESSAGE,
            original.messageId,
            recipient.identity,
            original.bodyHash,
          ),
        ),
      );
      const request = replyRequest(recipient.identity, original.messageId, "short reply", 10);
      const reply = expectSuccess<ReplyMessageReceipt>(
        harness.service.dispatch(harness.service.principal, {
          ...request,
          params: { ...request.params, foreground: foreground("ttl-reply-source") },
        }),
      );

      const newcomer = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("ttl-newcomer")),
      );
      expect(newcomer.registration).toBe("deferred");
      expectSuccess<SearchSessionsResult>(
        harness.service.dispatch(
          harness.service.principal,
          searchRequest(newcomer.identity, "ttl-newcomer", "unmatched needle"),
        ),
      );
      expect(activeHosts(harness.databasePath)).not.toContain("ttl-original-source");

      const retained = new Database(harness.databasePath, { readonly: true });
      const event = retained
        .query<{ event_json: string }, [string]>(
          "SELECT event_json FROM events WHERE target_session_id = ? ORDER BY sequence DESC LIMIT 1",
        )
        .get(originalSource.identity.sessionId);
      const message = retained
        .query<{ reply_to_message_id: string | null; expires_ms: number; state: string }, [string]>(
          "SELECT reply_to_message_id, expires_ms, state FROM messages WHERE message_id = ?",
        )
        .get(reply.messageId);
      retained.close();
      expect(event?.event_json).toContain(reply.messageId);
      expect(message).toMatchObject({
        reply_to_message_id: original.messageId,
        expires_ms: harness.clock.now() + 10_000,
        state: "PENDING",
      });

      harness.clock.advance(10_000);
      const consume = expectedMessageRequest(
        METHODS.CONSUME_MESSAGE,
        reply.messageId,
        originalSource.identity,
        reply.bodyHash,
      );
      expectError(
        harness.service.dispatch(harness.service.principal, {
          ...consume,
          params: { ...consume.params, foreground: foreground("ttl-original-source") },
        }),
        "MESSAGE_EXPIRED",
      );
      const expired = new Database(harness.databasePath, { readonly: true });
      expect(
        expired
          .query<
            { reply_to_message_id: string | null; state: string; body: string | null },
            [string]
          >("SELECT reply_to_message_id, state, body FROM messages WHERE message_id = ?")
          .get(reply.messageId),
      ).toEqual({ reply_to_message_id: original.messageId, state: "EXPIRED", body: null });
      expired.close();
    } finally {
      harness.close();
    }
  });

  test("migrates v4 foreground recency to v5 and preserves deterministic admission across restart", () => {
    const harness = createHarness({ limits: { maxActiveSessionsPerPrincipal: 2 } });
    try {
      harness.service.close();
      downgradeSessionsSchemaToV4(harness.databasePath);

      const migrated = BrokerService.open({
        databasePath: harness.databasePath,
        credentialFilePath: harness.credentialFilePath,
        clock: harness.clock,
        random: harness.random,
        limits: { maxActiveSessionsPerPrincipal: 2 },
      });
      try {
        expect(migrated.schemaVersionForTesting()).toBe(5);
        const first = expectSuccess<RegistrationResult>(
          migrated.dispatch(migrated.principal, registerRequest("restart-first")),
        );
        const second = expectSuccess<RegistrationResult>(
          migrated.dispatch(migrated.principal, registerRequest("restart-second")),
        );
        expectSuccess<SearchSessionsResult>(
          migrated.dispatch(migrated.principal, searchRequest(first.identity, "restart-first")),
        );
        migrated.close();

        const restarted = BrokerService.open({
          databasePath: harness.databasePath,
          credentialFilePath: harness.credentialFilePath,
          clock: harness.clock,
          random: harness.random,
          limits: { maxActiveSessionsPerPrincipal: 2 },
        });
        try {
          const third = expectSuccess<RegistrationResult>(
            restarted.dispatch(restarted.principal, registerRequest("restart-third")),
          );
          expectSuccess(
            restarted.dispatch(
              restarted.principal,
              claimRequest(METHODS.DEREGISTER_SESSION, third.identity),
            ),
          );
          expectSuccess<SearchSessionsResult>(
            restarted.dispatch(restarted.principal, searchRequest(third.identity, "restart-third")),
          );
          expect(activeHosts(harness.databasePath)).toEqual(["restart-first", "restart-third"]);
          expect(second.identity.sessionId).not.toBe(first.identity.sessionId);
        } finally {
          restarted.close();
        }
      } finally {
        migrated.close();
      }
    } finally {
      harness.close();
    }
  });

  test.each(["displaced", "last_foreground_ms"] as const)(
    "rejects a partial v4 migration containing only %s without advancing user_version",
    (retainedColumn) => {
      const harness = createHarness();
      try {
        harness.service.close();
        const partial = new Database(harness.databasePath);
        partial.run("DROP INDEX IF EXISTS sessions_admission_idx");
        const removedColumn = retainedColumn === "displaced" ? "last_foreground_ms" : "displaced";
        partial.run(`ALTER TABLE sessions DROP COLUMN ${removedColumn}`);
        partial.run("PRAGMA user_version = 4");
        partial.close();
        chmodSync(harness.databasePath, 0o600);

        expect(() =>
          BrokerService.open({
            databasePath: harness.databasePath,
            credentialFilePath: harness.credentialFilePath,
            clock: harness.clock,
            random: harness.random,
          }),
        ).toThrow(/sessions schema v4 columns.*noncanonical/i);
        const unchanged = new Database(harness.databasePath, { readonly: true });
        const version = unchanged.query<{ user_version: number }, []>("PRAGMA user_version").get();
        const columns = unchanged
          .query<{ name: string }, []>("PRAGMA table_info(sessions)")
          .all()
          .map((column) => column.name);
        unchanged.close();
        expect(version?.user_version).toBe(4);
        expect(columns).toContain(retainedColumn);
        expect(columns).not.toContain(removedColumn);
      } finally {
        harness.close();
      }
    },
  );

  test.each([
    ["type", (sql: string) => sql.replace("host_session_id TEXT", "host_session_id INTEGER")],
    [
      "nullability",
      (sql: string) => sql.replace("metadata_json TEXT NOT NULL", "metadata_json TEXT"),
    ],
    [
      "default",
      (sql: string) =>
        sql.replace("metadata_search TEXT NOT NULL", "metadata_search TEXT NOT NULL DEFAULT '[]'"),
    ],
    [
      "primary key",
      (sql: string) =>
        sql.replace(
          "PRIMARY KEY (principal_id, host_session_id)",
          "PRIMARY KEY (host_session_id, principal_id)",
        ),
    ],
    [
      "foreign key",
      (sql: string) =>
        sql.replace(
          "FOREIGN KEY (principal_id) REFERENCES principals(principal_id)",
          "FOREIGN KEY (principal_id) REFERENCES principals(server_id)",
        ),
    ],
    [
      "check",
      (sql: string) => sql.replace("CHECK (opt_in IN (0, 1))", "CHECK (opt_in IN (0, 1, 2))"),
    ],
    [
      "additional check",
      (sql: string) =>
        sql.replace(
          "updated_ms INTEGER NOT NULL",
          "updated_ms INTEGER NOT NULL CHECK (updated_ms >= 0)",
        ),
    ],
  ] as const)("rejects malformed v4 sessions %s and rolls migration back", (_, transform) => {
    const harness = createHarness();
    try {
      harness.service.close();
      downgradeSessionsSchemaToV4(harness.databasePath);
      rewriteSessionsTableSql(harness.databasePath, transform);
      expect(() =>
        BrokerService.open({
          databasePath: harness.databasePath,
          credentialFilePath: harness.credentialFilePath,
          clock: harness.clock,
          random: harness.random,
        }),
      ).toThrow(/sessions schema v4.*noncanonical/i);
      const unchanged = new Database(harness.databasePath, { readonly: true });
      expect(
        unchanged.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
      ).toBe(4);
      expect(
        unchanged
          .query<{ name: string }, []>("PRAGMA table_info(sessions)")
          .all()
          .map((column) => column.name),
      ).not.toContain("displaced");
      unchanged.close();
    } finally {
      harness.close();
    }
  });

  test.each(["unique", "index"] as const)(
    "rejects a malformed v4 sessions %s and leaves user_version unchanged",
    (fixture) => {
      const harness = createHarness();
      try {
        harness.service.close();
        downgradeSessionsSchemaToV4(harness.databasePath);
        const malformed = new Database(harness.databasePath);
        if (fixture === "unique") {
          malformed.run("CREATE UNIQUE INDEX sessions_bad_unique_idx ON sessions(metadata_json)");
        } else {
          malformed.run("DROP INDEX sessions_active_idx");
          malformed.run(
            "CREATE INDEX sessions_active_idx ON sessions(opt_in, principal_id, lease_expires_ms)",
          );
        }
        malformed.close();
        chmodSync(harness.databasePath, 0o600);
        expect(() =>
          BrokerService.open({
            databasePath: harness.databasePath,
            credentialFilePath: harness.credentialFilePath,
            clock: harness.clock,
            random: harness.random,
          }),
        ).toThrow(/sessions schema v4.*noncanonical/i);
        const unchanged = new Database(harness.databasePath, { readonly: true });
        expect(
          unchanged.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
        ).toBe(4);
        unchanged.close();
      } finally {
        harness.close();
      }
    },
  );

  test("rejects a malformed v5 admission index on reopen", () => {
    const harness = createHarness();
    try {
      harness.service.close();
      const malformed = new Database(harness.databasePath);
      malformed.run("DROP INDEX sessions_admission_idx");
      malformed.run(
        `CREATE INDEX sessions_admission_idx
         ON sessions(principal_id, last_foreground_ms, opt_in, lease_expires_ms, created_ms, session_id)`,
      );
      malformed.close();
      chmodSync(harness.databasePath, 0o600);
      expect(() =>
        BrokerService.open({
          databasePath: harness.databasePath,
          credentialFilePath: harness.credentialFilePath,
          clock: harness.clock,
          random: harness.random,
        }),
      ).toThrow(/sessions schema v5 indexes.*noncanonical/i);
      const unchanged = new Database(harness.databasePath, { readonly: true });
      expect(
        unchanged.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
      ).toBe(5);
      unchanged.close();
    } finally {
      harness.close();
    }
  });
});
