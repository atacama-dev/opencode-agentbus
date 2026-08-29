import { Buffer } from "node:buffer";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
  BrokerIdSchema,
  ConsumedMessageResultSchema,
  DEFAULT_ACTIVE_SESSIONS_PER_PRINCIPAL,
  DEFAULT_PENDING_LIST_LIMIT,
  EnqueueMessageReceiptSchema,
  EventCursorSchema,
  MAX_ACTIVE_SESSIONS_PER_PRINCIPAL,
  MIN_ACTIVE_SESSIONS_PER_PRINCIPAL,
  PendingMessageEventSchema,
  PROTOCOL_VERSION,
  RegistrationResultSchema,
  ForegroundIdentityResultSchema,
  RegistrySearchMatchSchema,
  RejectMessageResultSchema,
  ReplyMessageReceiptSchema,
  SessionMetadataSchema,
  SessionHeartbeatResultSchema,
  bodySha256,
  canonicalizeSearchQueryUnchecked,
  hashNormalizedSearchQuery,
  sessionFingerprint,
  type AuthenticatedClientPrincipal,
  type BrokerId,
  type DeregisterSessionResult,
  type EnqueueMessageReceipt,
  type ErrorCode,
  type EventCursor,
  type ForegroundSession,
  type ForegroundIdentityResult,
  type ForegroundPendingRecovery,
  type PendingMessageEvent,
  type PendingMessageHeader,
  type RegistrationResult,
  type RejectMessageResult,
  type ReplyMessageReceipt,
  type SafeErrorDetails,
  type SearchSessionsResult,
  type SessionHeartbeatResult,
  type SessionIdentity,
  type SessionMetadata,
} from "@opencode-agentbus/protocol";
import {
  assertSecureDatabaseFiles,
  ensureSecureDatabaseFile,
  type SecureParentHandle,
} from "./secure-files";

export interface StoreClock {
  now(): number;
}

export interface StoreRandom {
  bytes(length: number): Uint8Array;
}

export interface StoreLimits {
  readonly maxActiveSessionsPerPrincipal: number;
  readonly maxSessionsPerPrincipal: number;
  readonly maxSessionsGlobal: number;
  readonly foregroundSessionReserve: number;
  readonly registrationsPerPrincipalPerMinute: number;
  readonly enqueuePerPrincipalPerMinute: number;
  readonly enqueuePerSessionPerMinute: number;
  readonly maxPendingPerPrincipal: number;
  readonly maxPendingPerSession: number;
  readonly maxMessagesPerSourceSession: number;
  readonly maxMessagesPerPrincipal: number;
  readonly maxMessagesGlobal: number;
  readonly eventReplayWindow: number;
  readonly sessionLeaseSeconds: number;
  readonly maintenanceBatchSize: number;
  readonly terminalMessageRetentionMs: number;
  readonly eventRetentionMs: number;
  readonly inactiveSessionRetentionMs: number;
  readonly rateRetentionMs: number;
}

export const BROKER_SESSION_LIMIT_POLICY = Object.freeze({
  durableSessionsPerActiveSession: 4,
  globalDurableSessionsPerActiveSession: 16,
  minimumRegistrationBudget: 256,
  maxDurableSessionsPerPrincipal: MAX_ACTIVE_SESSIONS_PER_PRINCIPAL * 4,
  maxDurableSessionsGlobal: MAX_ACTIVE_SESSIONS_PER_PRINCIPAL * 16,
  maxForegroundSessionReserve: MAX_ACTIVE_SESSIONS_PER_PRINCIPAL,
  maxRegistrationsPerPrincipalPerMinute: MAX_ACTIVE_SESSIONS_PER_PRINCIPAL,
});

type SessionLimitDefaults = Pick<
  StoreLimits,
  | "maxActiveSessionsPerPrincipal"
  | "maxSessionsPerPrincipal"
  | "maxSessionsGlobal"
  | "foregroundSessionReserve"
  | "registrationsPerPrincipalPerMinute"
>;

function checkedSessionLimitScale(value: number, factor: number, hardMaximum: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    !Number.isSafeInteger(factor) ||
    factor <= 0 ||
    value > Math.floor(hardMaximum / factor)
  ) {
    throw new TypeError("Broker session limit derivation is unsafe.");
  }
  const scaled = value * factor;
  if (!Number.isSafeInteger(scaled) || scaled > hardMaximum) {
    throw new TypeError("Broker session limit derivation is unsafe.");
  }
  return scaled;
}

export function deriveSessionLimitDefaults(
  maxActiveSessionsPerPrincipal: number,
): SessionLimitDefaults {
  if (
    !Number.isSafeInteger(maxActiveSessionsPerPrincipal) ||
    maxActiveSessionsPerPrincipal < MIN_ACTIVE_SESSIONS_PER_PRINCIPAL ||
    maxActiveSessionsPerPrincipal > MAX_ACTIVE_SESSIONS_PER_PRINCIPAL
  ) {
    throw new TypeError("Active-session limit exceeds the protocol range.");
  }
  return {
    maxActiveSessionsPerPrincipal,
    maxSessionsPerPrincipal: checkedSessionLimitScale(
      maxActiveSessionsPerPrincipal,
      BROKER_SESSION_LIMIT_POLICY.durableSessionsPerActiveSession,
      BROKER_SESSION_LIMIT_POLICY.maxDurableSessionsPerPrincipal,
    ),
    maxSessionsGlobal: checkedSessionLimitScale(
      maxActiveSessionsPerPrincipal,
      BROKER_SESSION_LIMIT_POLICY.globalDurableSessionsPerActiveSession,
      BROKER_SESSION_LIMIT_POLICY.maxDurableSessionsGlobal,
    ),
    foregroundSessionReserve: maxActiveSessionsPerPrincipal,
    registrationsPerPrincipalPerMinute: Math.max(
      BROKER_SESSION_LIMIT_POLICY.minimumRegistrationBudget,
      maxActiveSessionsPerPrincipal,
    ),
  };
}

export interface MaintenanceResult {
  readonly expiredMessages: number;
  readonly purgedMessages: number;
  readonly purgedEvents: number;
  readonly purgedRateRows: number;
  readonly purgedSessions: number;
}

export interface StorageStats {
  readonly sessions: number;
  readonly activeSessions: number;
  readonly displacedSessions: number;
  readonly messages: number;
  readonly events: number;
  readonly enqueueRateRows: number;
  readonly registrationRateRows: number;
  readonly pendingBodies: number;
  readonly terminalBodies: number;
  readonly expiredMessages: number;
}

export class BrokerOperationError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly details?: SafeErrorDetails,
  ) {
    super(code);
    this.name = "BrokerOperationError";
  }
}

interface SessionRow {
  principal_id: string;
  host_session_id: string;
  session_id: string;
  metadata_json: string;
  metadata_search: string;
  opt_in: number;
  lease_expires_ms: number;
  displaced: number;
  last_foreground_ms: number | null;
  created_ms: number;
  updated_ms: number;
}

interface MessageHeaderRow {
  message_id: string;
  reply_to_message_id: string | null;
  source_session_id: string;
  target_session_id: string;
  body_hash: string;
  body_bytes: number;
  state: "PENDING" | "DELIVERED" | "REJECTED" | "EXPIRED";
  enqueued_ms: number;
  expires_ms: number;
}

interface ConsumableMessageRow extends MessageHeaderRow {
  body: string | null;
}

interface RejectableMessageRow {
  message_id: string;
  target_session_id: string;
  body_hash: string;
  state: "PENDING" | "DELIVERED" | "REJECTED" | "EXPIRED";
  expires_ms: number;
  rejected_ms: number | null;
}

interface ReplyOriginalRow {
  message_id: string;
  source_session_id: string;
  target_session_id: string;
  state: "PENDING" | "DELIVERED" | "REJECTED" | "EXPIRED";
}

interface CountRow {
  count: number;
}

interface MessageQuotaCounts {
  source_count: number;
  principal_count: number;
  global_count: number;
}

interface SequenceRow {
  sequence: number;
}

interface BrokerStateRow {
  broker_id: string;
}

interface RateRow {
  oldest: number;
}

interface NullableTimestampRow {
  oldest: number | null;
}

type MessageQuotaScope = "source" | "principal" | "global";

interface EventRow {
  sequence: number;
  event_json: string;
}

export interface EventReplaySnapshot {
  readonly cursor: EventCursor;
  readonly events: readonly PendingMessageEvent[];
}

interface UserVersionRow {
  user_version: number;
}

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKeyInfoRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

interface IndexListRow {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface IndexInfoRow {
  seqno: number;
  name: string;
}

interface SchemaSqlRow {
  sql: string | null;
}

interface MutationFailure {
  readonly ok: false;
  readonly error: BrokerOperationError;
}

interface MutationSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

type MutationResult<T> = MutationFailure | MutationSuccess<T>;

type BrokerDatabase = Omit<Database, "run"> & {
  run(sql: string, ...bindings: SQLQueryBindings[]): { changes: number | bigint };
};

const CURRENT_SCHEMA_VERSION = 5;

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function randomBase64Url(random: StoreRandom, length = 32): string {
  const bytes = random.bytes(length);
  if (bytes.byteLength !== length) throw new Error("Random source returned an invalid byte count.");
  return Buffer.from(bytes).toString("base64url");
}

function samePrincipal(
  left: AuthenticatedClientPrincipal,
  right: AuthenticatedClientPrincipal,
): boolean {
  return left.principalId === right.principalId && left.serverId === right.serverId;
}

function canonicalMetadataJson(metadata: SessionMetadata): string {
  return JSON.stringify({
    ...(metadata.title === undefined ? {} : { title: metadata.title }),
    ...(metadata.labels === undefined ? {} : { labels: metadata.labels }),
  });
}

function metadataSearchFields(metadata: SessionMetadata): readonly string[] {
  return [metadata.title, ...(metadata.labels ?? [])]
    .filter((field): field is string => field !== undefined)
    .map((field) => canonicalizeSearchQueryUnchecked(field));
}

function metadataSearchText(metadata: SessionMetadata): string {
  return JSON.stringify(metadataSearchFields(metadata));
}

function parseMetadataSearchFields(serialized: string): readonly string[] {
  const candidate: unknown = JSON.parse(serialized);
  if (!Array.isArray(candidate) || !candidate.every((field) => typeof field === "string")) {
    throw new Error("Broker metadata search index is invalid.");
  }
  return candidate;
}

export class BrokerStore {
  readonly brokerId: BrokerId;
  private readonly database: BrokerDatabase;
  private readonly parent: SecureParentHandle;
  private closed = false;

  constructor(
    databasePath: string,
    private readonly clock: StoreClock,
    private readonly random: StoreRandom,
    private readonly limits: StoreLimits,
    private readonly statementObserver?: (sql: string) => void,
  ) {
    this.parent = ensureSecureDatabaseFile(databasePath);
    const previousUmask = process.umask(0o077);
    let database: BrokerDatabase | undefined;
    try {
      database = new Database(this.parent.filePath, {
        create: true,
        readwrite: true,
        strict: true,
      }) as BrokerDatabase;
      this.database = database;
      assertSecureDatabaseFiles(this.parent);
      this.database.run("PRAGMA foreign_keys = ON");
      this.database.run("PRAGMA busy_timeout = 5000");
      this.database.run("PRAGMA synchronous = FULL");
      this.database.run("PRAGMA journal_mode = WAL");
      assertSecureDatabaseFiles(this.parent);
      this.migrate();
      this.brokerId = this.loadOrCreateBrokerId();
    } catch (error) {
      database?.close(false);
      this.parent.close();
      throw error;
    } finally {
      process.umask(previousUmask);
    }
  }

  private observe(sql: string): string {
    this.statementObserver?.(sql);
    return sql;
  }

  private migrate(): void {
    const initialVersion = this.schemaVersion();
    if (initialVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error("Broker database schema version is unsupported.");
    }
    for (let version = initialVersion + 1; version <= CURRENT_SCHEMA_VERSION; version += 1) {
      this.transaction(() => {
        if (version === 1) this.applyMigration1();
        else if (version === 2) this.applyMigration2();
        else if (version === 3) this.applyMigration3();
        else if (version === 4) this.applyMigration4();
        else if (version === 5) this.applyMigration5();
        else throw new Error("Broker database migration is unavailable.");
        this.database.run(`PRAGMA user_version = ${version}`);
      });
    }
    this.assertCanonicalSessionsSchema(CURRENT_SCHEMA_VERSION);
  }

  private applyMigration1(): void {
    this.database.run(`
        CREATE TABLE IF NOT EXISTS broker_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          broker_id TEXT NOT NULL
        )
      `);
    this.database.run(`
        CREATE TABLE IF NOT EXISTS principals (
          principal_id TEXT PRIMARY KEY,
          server_id TEXT NOT NULL UNIQUE,
          created_ms INTEGER NOT NULL,
          updated_ms INTEGER NOT NULL
        )
      `);
    this.database.run(`
        CREATE TABLE IF NOT EXISTS sessions (
          principal_id TEXT NOT NULL,
          host_session_id TEXT NOT NULL,
          session_id TEXT NOT NULL UNIQUE,
          metadata_json TEXT NOT NULL,
          metadata_search TEXT NOT NULL,
          opt_in INTEGER NOT NULL CHECK (opt_in IN (0, 1)),
          lease_expires_ms INTEGER NOT NULL,
          created_ms INTEGER NOT NULL,
          updated_ms INTEGER NOT NULL,
          PRIMARY KEY (principal_id, host_session_id),
          FOREIGN KEY (principal_id) REFERENCES principals(principal_id)
        )
      `);
    this.database.run(`
        CREATE TABLE IF NOT EXISTS messages (
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
          FOREIGN KEY (source_session_id) REFERENCES sessions(session_id),
          FOREIGN KEY (target_session_id) REFERENCES sessions(session_id),
          FOREIGN KEY (target_principal_id) REFERENCES principals(principal_id)
        )
      `);
    this.database.run(`
        CREATE TABLE IF NOT EXISTS principal_sequences (
          principal_id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL,
          FOREIGN KEY (principal_id) REFERENCES principals(principal_id)
        )
      `);
    this.database.run(`
        CREATE TABLE IF NOT EXISTS events (
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
    this.database.run(`
        CREATE TABLE IF NOT EXISTS enqueue_rate (
          principal_id TEXT NOT NULL,
          source_session_id TEXT NOT NULL,
          occurred_ms INTEGER NOT NULL,
          FOREIGN KEY (principal_id) REFERENCES principals(principal_id),
          FOREIGN KEY (source_session_id) REFERENCES sessions(session_id)
        )
      `);
    this.database.run(
      "CREATE INDEX IF NOT EXISTS sessions_active_idx ON sessions(principal_id, opt_in, lease_expires_ms)",
    );
    this.database.run(
      "CREATE INDEX IF NOT EXISTS messages_pending_target_idx ON messages(target_session_id, state, expires_ms, enqueued_ms, message_id)",
    );
    this.database.run(
      "CREATE INDEX IF NOT EXISTS messages_pending_principal_idx ON messages(target_principal_id, state, expires_ms)",
    );
    this.database.run(
      "CREATE INDEX IF NOT EXISTS enqueue_rate_idx ON enqueue_rate(principal_id, source_session_id, occurred_ms)",
    );
  }

  private applyMigration2(): void {
    this.database.run(`
      CREATE TABLE IF NOT EXISTS registration_rate (
        principal_id TEXT NOT NULL,
        occurred_ms INTEGER NOT NULL,
        FOREIGN KEY (principal_id) REFERENCES principals(principal_id)
      )
    `);
    this.database.run(
      "CREATE INDEX IF NOT EXISTS registration_rate_idx ON registration_rate(principal_id, occurred_ms)",
    );
    this.database.run(
      "CREATE INDEX IF NOT EXISTS messages_terminal_idx ON messages(state, delivered_ms, rejected_ms, expires_ms)",
    );
    this.database.run(
      "CREATE INDEX IF NOT EXISTS events_created_idx ON events(principal_id, created_ms)",
    );
    this.database.run(
      "CREATE INDEX IF NOT EXISTS sessions_retention_idx ON sessions(opt_in, lease_expires_ms, updated_ms)",
    );
  }

  private applyMigration3(): void {
    const rows = this.database
      .query<{ session_id: string; metadata_json: string }, []>(
        "SELECT session_id, metadata_json FROM sessions ORDER BY session_id ASC",
      )
      .all();
    for (const row of rows) {
      const metadata = SessionMetadataSchema.parse(JSON.parse(row.metadata_json));
      this.database.run(
        "UPDATE sessions SET metadata_json = ?, metadata_search = ? WHERE session_id = ?",
        canonicalMetadataJson(metadata),
        metadataSearchText(metadata),
        row.session_id,
      );
    }
  }

  private applyMigration4(): void {
    const existingColumns = this.database
      .query<TableInfoRow, []>("PRAGMA table_info(messages)")
      .all();
    if (existingColumns.some((column) => column.name === "reply_to_message_id")) {
      throw new Error("Broker reply_to_message_id column is a noncanonical partial migration.");
    }
    this.database.run("ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT");
    const columns = this.database.query<TableInfoRow, []>("PRAGMA table_info(messages)").all();
    const replyColumn = columns.find((column) => column.name === "reply_to_message_id");
    if (
      !replyColumn ||
      replyColumn.type.trim().toUpperCase() !== "TEXT" ||
      replyColumn.notnull !== 0 ||
      replyColumn.dflt_value !== null ||
      replyColumn.pk !== 0
    ) {
      throw new Error("Broker reply_to_message_id column is incompatible.");
    }
    const foreignKeys = this.database
      .query<ForeignKeyInfoRow, []>("PRAGMA foreign_key_list(messages)")
      .all();
    if (foreignKeys.some((foreignKey) => foreignKey.from === "reply_to_message_id")) {
      throw new Error("Broker reply_to_message_id foreign key is incompatible.");
    }
  }

  private applyMigration5(): void {
    this.assertCanonicalSessionsSchema(4);
    this.database.run(
      "ALTER TABLE sessions ADD COLUMN displaced INTEGER NOT NULL DEFAULT 0 CHECK (displaced IN (0, 1))",
    );
    this.database.run("ALTER TABLE sessions ADD COLUMN last_foreground_ms INTEGER");
    this.database.run(
      `CREATE INDEX sessions_admission_idx
       ON sessions(principal_id, opt_in, lease_expires_ms, last_foreground_ms, created_ms, session_id)`,
    );
    this.assertCanonicalSessionsSchema(5);
  }

  private assertCanonicalSessionsSchema(version: 4 | 5): void {
    const expectedColumns: readonly TableInfoRow[] = [
      { name: "principal_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { name: "host_session_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
      { name: "session_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "metadata_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "metadata_search", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "opt_in", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "lease_expires_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "created_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "updated_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      ...(version === 5
        ? [
            {
              name: "displaced",
              type: "INTEGER",
              notnull: 1,
              dflt_value: "0",
              pk: 0,
            },
            {
              name: "last_foreground_ms",
              type: "INTEGER",
              notnull: 0,
              dflt_value: null,
              pk: 0,
            },
          ]
        : []),
    ];
    const columns = this.database.query<TableInfoRow, []>("PRAGMA table_info(sessions)").all();
    const normalizedColumns = columns.map((column) => ({
      name: column.name,
      type: column.type.trim().toUpperCase(),
      notnull: column.notnull,
      dflt_value: column.dflt_value,
      pk: column.pk,
    }));
    if (JSON.stringify(normalizedColumns) !== JSON.stringify(expectedColumns)) {
      throw new Error(`Broker sessions schema v${version} columns are noncanonical.`);
    }

    const tableSql = this.database
      .query<SchemaSqlRow, [string]>(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
      )
      .get("sessions")?.sql;
    if (
      !tableSql ||
      !/CHECK\s*\(\s*opt_in\s+IN\s*\(\s*0\s*,\s*1\s*\)\s*\)/i.test(tableSql) ||
      (version === 5 &&
        !/CHECK\s*\(\s*displaced\s+IN\s*\(\s*0\s*,\s*1\s*\)\s*\)/i.test(tableSql)) ||
      (tableSql.match(/\bCHECK\s*\(/gi)?.length ?? 0) !== (version === 5 ? 2 : 1)
    ) {
      throw new Error(`Broker sessions schema v${version} checks are noncanonical.`);
    }

    const foreignKeys = this.database
      .query<ForeignKeyInfoRow, []>("PRAGMA foreign_key_list(sessions)")
      .all();
    if (
      foreignKeys.length !== 1 ||
      foreignKeys[0]?.table !== "principals" ||
      foreignKeys[0]?.from !== "principal_id" ||
      foreignKeys[0]?.to !== "principal_id" ||
      foreignKeys[0]?.on_update.toUpperCase() !== "NO ACTION" ||
      foreignKeys[0]?.on_delete.toUpperCase() !== "NO ACTION" ||
      foreignKeys[0]?.match.toUpperCase() !== "NONE"
    ) {
      throw new Error(`Broker sessions schema v${version} foreign key is noncanonical.`);
    }

    const indexes = this.database.query<IndexListRow, []>("PRAGMA index_list(sessions)").all();
    const indexColumns = (name: string): readonly string[] =>
      this.database
        .query<IndexInfoRow, []>(`PRAGMA index_info(${JSON.stringify(name)})`)
        .all()
        .sort((left, right) => left.seqno - right.seqno)
        .map((column) => column.name);
    const uniqueConstraints = indexes
      .filter((index) => index.unique === 1)
      .map((index) => ({ origin: index.origin, columns: indexColumns(index.name) }))
      .sort((left, right) => left.origin.localeCompare(right.origin));
    const expectedUniqueConstraints = [
      { origin: "pk", columns: ["principal_id", "host_session_id"] },
      { origin: "u", columns: ["session_id"] },
    ].sort((left, right) => left.origin.localeCompare(right.origin));
    if (JSON.stringify(uniqueConstraints) !== JSON.stringify(expectedUniqueConstraints)) {
      throw new Error(`Broker sessions schema v${version} uniqueness is noncanonical.`);
    }

    const expectedIndexes = new Map<string, readonly string[]>([
      ["sessions_active_idx", ["principal_id", "opt_in", "lease_expires_ms"]],
      ["sessions_retention_idx", ["opt_in", "lease_expires_ms", "updated_ms"]],
      ...(version === 5
        ? [
            [
              "sessions_admission_idx",
              [
                "principal_id",
                "opt_in",
                "lease_expires_ms",
                "last_foreground_ms",
                "created_ms",
                "session_id",
              ],
            ] as const,
          ]
        : []),
    ]);
    const explicitIndexes = indexes.filter((index) => index.origin === "c");
    if (
      explicitIndexes.length !== expectedIndexes.size ||
      explicitIndexes.some(
        (index) =>
          index.unique !== 0 ||
          index.partial !== 0 ||
          JSON.stringify(indexColumns(index.name)) !==
            JSON.stringify(expectedIndexes.get(index.name)),
      )
    ) {
      throw new Error(`Broker sessions schema v${version} indexes are noncanonical.`);
    }
  }

  schemaVersion(): number {
    const row = this.database.query<UserVersionRow, []>("PRAGMA user_version").get();
    if (!row || !Number.isInteger(row.user_version) || row.user_version < 0) {
      throw new Error("Broker database schema version is invalid.");
    }
    return row.user_version;
  }

  private loadOrCreateBrokerId(): BrokerId {
    return this.transaction(() => {
      const row = this.database
        .query<BrokerStateRow, []>("SELECT broker_id FROM broker_state WHERE singleton = 1")
        .get();
      if (row) return BrokerIdSchema.parse(row.broker_id);
      const brokerId = BrokerIdSchema.parse(randomBase64Url(this.random));
      this.database.run("INSERT INTO broker_state(singleton, broker_id) VALUES (1, ?)", brokerId);
      return brokerId;
    });
  }

  ensurePrincipal(principal: AuthenticatedClientPrincipal): void {
    const now = this.clock.now();
    this.transaction(() => {
      const existing = this.database
        .query<{ server_id: string }, [string]>(
          "SELECT server_id FROM principals WHERE principal_id = ?",
        )
        .get(principal.principalId);
      if (existing && existing.server_id !== principal.serverId) {
        throw new Error("Principal identity conflicts with persisted state.");
      }
      this.database.run(
        `INSERT INTO principals(principal_id, server_id, created_ms, updated_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(principal_id) DO UPDATE SET updated_ms = excluded.updated_ms`,
        principal.principalId,
        principal.serverId,
        now,
        now,
      );
    });
  }

  register(
    principal: AuthenticatedClientPrincipal,
    hostSessionId: string,
    metadata: SessionMetadata,
  ): RegistrationResult {
    const now = this.clock.now();
    const leaseExpires = now + this.limits.sessionLeaseSeconds * 1_000;
    return this.transaction(() => {
      const existing = this.database
        .query<SessionRow, [string, string]>(
          `SELECT principal_id, host_session_id, session_id, metadata_json, metadata_search,
                  opt_in, lease_expires_ms, displaced, last_foreground_ms, created_ms, updated_ms
           FROM sessions WHERE principal_id = ? AND host_session_id = ?`,
        )
        .get(principal.principalId, hostSessionId);
      const metadataJson = canonicalMetadataJson(metadata);
      const existingMetadataJson = existing
        ? canonicalMetadataJson(SessionMetadataSchema.parse(JSON.parse(existing.metadata_json)))
        : undefined;
      if (!existing) {
        const principalSessions = this.database
          .query<CountRow, [string]>(
            "SELECT COUNT(*) AS count FROM sessions WHERE principal_id = ?",
          )
          .get(principal.principalId)?.count;
        const globalSessions = this.database
          .query<CountRow, []>("SELECT COUNT(*) AS count FROM sessions")
          .get()?.count;
        if (
          (principalSessions ?? 0) >=
            this.limits.maxSessionsPerPrincipal - this.limits.foregroundSessionReserve ||
          (globalSessions ?? 0) >= this.limits.maxSessionsGlobal
        ) {
          throw new BrokerOperationError("RATE_LIMITED", { retryAfterMs: 100 });
        }
      }

      const alreadyActive =
        existing !== null &&
        existing !== undefined &&
        existing.opt_in === 1 &&
        existing.lease_expires_ms > now;
      const active = this.activeSessionCount(principal.principalId, now);
      const deferred =
        existing?.displaced === 1 ||
        (!alreadyActive && active >= this.limits.maxActiveSessionsPerPrincipal);
      const isChargedChange =
        !deferred && (!existing || existing.opt_in !== 1 || existingMetadataJson !== metadataJson);
      if (isChargedChange) this.enforceRegistrationRate(principal, now);

      const sessionId = existing?.session_id ?? this.canonicalSessionId(principal, hostSessionId);
      this.database.run(
        `INSERT INTO sessions(
           principal_id, host_session_id, session_id, metadata_json, metadata_search,
           opt_in, lease_expires_ms, created_ms, updated_ms, displaced, last_foreground_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(principal_id, host_session_id) DO UPDATE SET
            metadata_json = excluded.metadata_json,
            metadata_search = excluded.metadata_search,
            opt_in = excluded.opt_in,
            lease_expires_ms = excluded.lease_expires_ms,
            displaced = excluded.displaced,
            updated_ms = excluded.updated_ms`,
        principal.principalId,
        hostSessionId,
        sessionId,
        metadataJson,
        metadataSearchText(metadata),
        deferred ? 0 : 1,
        leaseExpires,
        now,
        now,
        deferred ? 1 : 0,
      );
      if (isChargedChange) {
        this.database.run(
          "INSERT INTO registration_rate(principal_id, occurred_ms) VALUES (?, ?)",
          principal.principalId,
          now,
        );
      }
      const identity = this.identity(principal.serverId, sessionId);
      return RegistrationResultSchema.parse({
        hostSessionId,
        identity,
        fingerprint: sessionFingerprint(identity),
        metadata,
        registration: deferred ? "deferred" : existing ? "refreshed" : "created",
        leaseSeconds: this.limits.sessionLeaseSeconds,
        leaseExpiresAt: iso(leaseExpires),
      });
    });
  }

  resolveForegroundIdentity(
    principal: AuthenticatedClientPrincipal,
    foreground: ForegroundSession,
  ): ForegroundIdentityResult {
    const sessionId = this.canonicalSessionId(principal, foreground.hostSessionId);
    const identity = this.identity(principal.serverId, sessionId);
    return ForegroundIdentityResultSchema.parse({
      hostSessionId: foreground.hostSessionId,
      identity,
      fingerprint: sessionFingerprint(identity),
      metadata: foreground.metadata,
      leaseSeconds: this.limits.sessionLeaseSeconds,
    });
  }

  heartbeat(
    principal: AuthenticatedClientPrincipal,
    claim: SessionIdentity,
  ): SessionHeartbeatResult {
    const now = this.clock.now();
    const leaseExpires = now + this.limits.sessionLeaseSeconds * 1_000;
    return this.transaction(() => {
      const session = this.requireOwnedSession(principal, claim, false, "SESSION_NOT_REGISTERED");
      if (session.displaced === 1) {
        return SessionHeartbeatResultSchema.parse({
          identity: claim,
          leaseSeconds: this.limits.sessionLeaseSeconds,
          leaseExpiresAt: iso(leaseExpires),
        });
      }
      if (session.opt_in !== 1) throw new BrokerOperationError("SESSION_NOT_REGISTERED");
      if (session.lease_expires_ms <= now) {
        if (
          this.activeSessionCount(principal.principalId, now) >=
          this.limits.maxActiveSessionsPerPrincipal
        ) {
          this.database.run(
            `UPDATE sessions SET opt_in = 0, displaced = 1, updated_ms = ?
             WHERE principal_id = ? AND session_id = ?`,
            now,
            principal.principalId,
            session.session_id,
          );
          return SessionHeartbeatResultSchema.parse({
            identity: claim,
            leaseSeconds: this.limits.sessionLeaseSeconds,
            leaseExpiresAt: iso(leaseExpires),
          });
        }
      }
      this.database.run(
        `UPDATE sessions SET opt_in = 1, displaced = 0, lease_expires_ms = ?, updated_ms = ?
         WHERE principal_id = ? AND session_id = ?`,
        leaseExpires,
        now,
        principal.principalId,
        session.session_id,
      );
      return SessionHeartbeatResultSchema.parse({
        identity: claim,
        leaseSeconds: this.limits.sessionLeaseSeconds,
        leaseExpiresAt: iso(leaseExpires),
      });
    });
  }

  deregister(
    principal: AuthenticatedClientPrincipal,
    claim: SessionIdentity,
  ): DeregisterSessionResult {
    this.assertClaimScope(principal, claim);
    return this.transaction(() => {
      const row = this.database
        .query<{ principal_id: string; opt_in: number }, [string]>(
          "SELECT principal_id, opt_in FROM sessions WHERE session_id = ?",
        )
        .get(claim.sessionId);
      if (row && row.principal_id !== principal.principalId) {
        throw new BrokerOperationError("FORBIDDEN");
      }
      const disposition = row?.opt_in === 1 ? "deregistered" : "already_absent";
      if (row) {
        this.database.run(
          `UPDATE sessions SET opt_in = 0, displaced = 0, updated_ms = ?
           WHERE principal_id = ? AND session_id = ?`,
          this.clock.now(),
          principal.principalId,
          claim.sessionId,
        );
      }
      return { identity: claim, disposition };
    });
  }

  enqueue(
    principal: AuthenticatedClientPrincipal,
    sourceClaim: SessionIdentity,
    targetClaim: SessionIdentity,
    body: string,
    ttlSeconds: number,
    correlationId: string,
    foreground?: ForegroundSession,
  ): {
    receipt: EnqueueMessageReceipt;
    event: PendingMessageEvent;
    foregroundRecovery?: ForegroundPendingRecovery;
  } {
    const now = this.clock.now();
    return this.transaction(() => {
      let source: SessionRow;
      let target: SessionRow;
      if (foreground) {
        this.assertForegroundClaim(principal, foreground, sourceClaim);
        const protectedSessionIds = new Set([sourceClaim.sessionId, targetClaim.sessionId]);
        this.requireOwnedSession(principal, targetClaim, false, "TARGET_NOT_REGISTERED");
        source = this.admitForegroundInTransaction(
          principal,
          foreground,
          sourceClaim,
          protectedSessionIds,
          now,
        ).row;
        target = this.admitDisplacedDependency(
          principal,
          targetClaim,
          protectedSessionIds,
          now,
          "TARGET_NOT_REGISTERED",
        );
      } else {
        source = this.requireOwnedSession(principal, sourceClaim, true, "SESSION_NOT_REGISTERED");
        target = this.requireOwnedSession(principal, targetClaim, true, "TARGET_NOT_REGISTERED");
      }
      const stored = this.enqueueResolved(
        principal,
        source,
        target,
        body,
        ttlSeconds,
        correlationId,
        now,
      );
      return foreground
        ? {
            ...stored,
            foregroundRecovery: this.pendingRecovery(principal, source, now),
          }
        : stored;
    });
  }

  reply(
    principal: AuthenticatedClientPrincipal,
    sourceClaim: SessionIdentity,
    originalMessageId: string,
    body: string,
    ttlSeconds: number,
    correlationId: string,
    foreground?: ForegroundSession,
  ): {
    receipt: ReplyMessageReceipt;
    event: PendingMessageEvent;
    foregroundRecovery?: ForegroundPendingRecovery;
  } {
    const now = this.clock.now();
    return this.transaction(() => {
      if (foreground) this.assertForegroundClaim(principal, foreground, sourceClaim);
      const sql = this.observe(`/* reply-message */
        SELECT message_id, source_session_id, target_session_id, state
        FROM messages WHERE message_id = ?`);
      const original = this.database.query<ReplyOriginalRow, [string]>(sql).get(originalMessageId);
      if (!original || original.target_session_id !== sourceClaim.sessionId) {
        throw new BrokerOperationError("MESSAGE_NOT_FOUND");
      }
      if (original.state !== "DELIVERED") {
        throw new BrokerOperationError("MESSAGE_NOT_REPLYABLE");
      }
      const targetClaim = this.identity(principal.serverId, original.source_session_id);
      let source: SessionRow;
      let target: SessionRow;
      if (foreground) {
        const protectedSessionIds = new Set([sourceClaim.sessionId, targetClaim.sessionId]);
        this.requireOwnedSession(principal, targetClaim, false, "TARGET_NOT_REGISTERED");
        source = this.admitForegroundInTransaction(
          principal,
          foreground,
          sourceClaim,
          protectedSessionIds,
          now,
        ).row;
        target = this.admitDisplacedDependency(
          principal,
          targetClaim,
          protectedSessionIds,
          now,
          "TARGET_NOT_REGISTERED",
        );
      } else {
        source = this.requireOwnedSession(principal, sourceClaim, true, "SESSION_NOT_REGISTERED");
        target = this.requireOwnedSession(principal, targetClaim, true, "TARGET_NOT_REGISTERED");
      }
      const stored = this.enqueueResolved(
        principal,
        source,
        target,
        body,
        ttlSeconds,
        correlationId,
        now,
        originalMessageId,
      );
      return {
        receipt: ReplyMessageReceiptSchema.parse({
          ...stored.receipt,
          replyToMessageId: originalMessageId,
        }),
        event: stored.event,
        ...(foreground === undefined
          ? {}
          : { foregroundRecovery: this.pendingRecovery(principal, source, now) }),
      };
    });
  }

  peek(
    principal: AuthenticatedClientPrincipal,
    targetClaim: SessionIdentity,
    foreground?: ForegroundSession,
  ): PendingMessageHeader | null {
    const now = this.clock.now();
    return this.transaction(() => {
      const target = foreground
        ? this.admitForegroundInTransaction(
            principal,
            foreground,
            targetClaim,
            new Set([targetClaim.sessionId]),
            now,
          ).row
        : this.requireOwnedSession(principal, targetClaim, true, "TARGET_NOT_REGISTERED");
      const row = this.database
        .query<MessageHeaderRow, [string, number]>(
          `SELECT message_id, reply_to_message_id, source_session_id, target_session_id,
                  body_hash, body_bytes, state, enqueued_ms, expires_ms
           FROM messages
           WHERE target_session_id = ? AND state = 'PENDING' AND expires_ms > ?
           ORDER BY enqueued_ms ASC, message_id ASC LIMIT 1`,
        )
        .get(target.session_id, now);
      return row ? this.headerFromRow(row, principal.serverId) : null;
    });
  }

  listPending(
    principal: AuthenticatedClientPrincipal,
    targetClaim: SessionIdentity,
    limit: number,
    foreground?: ForegroundSession,
  ): ForegroundPendingRecovery {
    const now = this.clock.now();
    return this.transaction(() => {
      const target = foreground
        ? this.admitForegroundInTransaction(
            principal,
            foreground,
            targetClaim,
            new Set([targetClaim.sessionId]),
            now,
          ).row
        : this.requireRecoverableSession(principal, targetClaim, "TARGET_NOT_REGISTERED");
      const headers = this.database
        .query<MessageHeaderRow, [string, number, number]>(
          `SELECT message_id, reply_to_message_id, source_session_id, target_session_id,
                  body_hash, body_bytes, state, enqueued_ms, expires_ms
           FROM messages
           WHERE target_session_id = ? AND state = 'PENDING' AND expires_ms > ?
           ORDER BY enqueued_ms ASC, message_id ASC LIMIT ?`,
        )
        .all(target.session_id, now, limit)
        .map((row) => this.headerFromRow(row, principal.serverId));
      return {
        target: this.identity(principal.serverId, target.session_id),
        requestedLimit: limit,
        eventCursor: this.currentEventCursor(principal),
        headers,
      };
    });
  }

  consume(
    principal: AuthenticatedClientPrincipal,
    targetClaim: SessionIdentity,
    messageId: string,
    expectedBodyHash: string,
    foreground?: ForegroundSession,
  ):
    | {
        messageId: string;
        source: SessionIdentity;
        target: SessionIdentity;
        body: string;
        bodyHash: string;
        bodyBytes: number;
        state: "DELIVERED";
        deliveredAt: string;
      }
    | never {
    const now = this.clock.now();
    const outcome = this.transaction<MutationResult<ConsumedMessageResultLike>>(() => {
      if (foreground) {
        this.admitForegroundInTransaction(
          principal,
          foreground,
          targetClaim,
          new Set([targetClaim.sessionId]),
          now,
        );
      } else {
        this.requireOwnedSession(principal, targetClaim, true, "TARGET_NOT_REGISTERED");
      }
      const sql = this.observe(`/* consume-message */
        SELECT message_id, reply_to_message_id, source_session_id, target_session_id,
               body_hash, body_bytes, body, state, enqueued_ms, expires_ms
        FROM messages WHERE message_id = ?`);
      const row = this.database.query<ConsumableMessageRow, [string]>(sql).get(messageId);
      if (!row || row.target_session_id !== targetClaim.sessionId) {
        return { ok: false, error: new BrokerOperationError("MESSAGE_NOT_FOUND") };
      }
      if (row.body_hash !== expectedBodyHash) {
        return { ok: false, error: new BrokerOperationError("BODY_HASH_MISMATCH") };
      }
      if (row.state === "PENDING" && now >= row.expires_ms) {
        this.database.run(
          "UPDATE messages SET state = 'EXPIRED', body = NULL WHERE message_id = ? AND state = 'PENDING'",
          messageId,
        );
        return {
          ok: false,
          error: new BrokerOperationError("MESSAGE_EXPIRED", { currentState: "EXPIRED" }),
        };
      }
      if (row.state === "REJECTED") {
        return {
          ok: false,
          error: new BrokerOperationError("MESSAGE_REJECTED", { currentState: "REJECTED" }),
        };
      }
      if (row.state === "EXPIRED") {
        return {
          ok: false,
          error: new BrokerOperationError("MESSAGE_EXPIRED", { currentState: "EXPIRED" }),
        };
      }
      if (row.state !== "PENDING") {
        return {
          ok: false,
          error: new BrokerOperationError("MESSAGE_NOT_PENDING", { currentState: row.state }),
        };
      }
      if (row.body === null) throw new Error("Pending message body is unavailable.");
      const changed = this.database.run(
        `UPDATE messages SET state = 'DELIVERED', delivered_ms = ?, body = NULL
         WHERE message_id = ? AND state = 'PENDING' AND target_session_id = ? AND body_hash = ?`,
        now,
        messageId,
        targetClaim.sessionId,
        expectedBodyHash,
      ).changes;
      if (changed !== 1) {
        return { ok: false, error: new BrokerOperationError("MESSAGE_NOT_PENDING") };
      }
      return {
        ok: true,
        value: {
          messageId: row.message_id,
          ...(row.reply_to_message_id === null
            ? {}
            : { replyToMessageId: row.reply_to_message_id }),
          source: this.identity(principal.serverId, row.source_session_id),
          target: targetClaim,
          body: row.body,
          bodyHash: row.body_hash,
          bodyBytes: row.body_bytes,
          state: "DELIVERED",
          deliveredAt: iso(now),
        },
      };
    });
    if (!outcome.ok) throw outcome.error;
    return ConsumedMessageResultSchema.parse(outcome.value);
  }

  reject(
    principal: AuthenticatedClientPrincipal,
    targetClaim: SessionIdentity,
    messageId: string,
    expectedBodyHash: string,
    foreground?: ForegroundSession,
  ): RejectMessageResult {
    const now = this.clock.now();
    const outcome = this.transaction<MutationResult<RejectMessageResult>>(() => {
      if (foreground) {
        this.admitForegroundInTransaction(
          principal,
          foreground,
          targetClaim,
          new Set([targetClaim.sessionId]),
          now,
        );
      } else {
        this.requireOwnedSession(principal, targetClaim, true, "TARGET_NOT_REGISTERED");
      }
      const sql = this.observe(`/* reject-message */
        SELECT message_id, target_session_id, body_hash, state, expires_ms, rejected_ms
        FROM messages WHERE message_id = ?`);
      const row = this.database.query<RejectableMessageRow, [string]>(sql).get(messageId);
      if (!row || row.target_session_id !== targetClaim.sessionId) {
        return { ok: false, error: new BrokerOperationError("MESSAGE_NOT_FOUND") };
      }
      if (row.body_hash !== expectedBodyHash) {
        return { ok: false, error: new BrokerOperationError("BODY_HASH_MISMATCH") };
      }
      if (row.state === "REJECTED") {
        return {
          ok: true,
          value: RejectMessageResultSchema.parse({
            messageId,
            target: targetClaim,
            bodyHash: expectedBodyHash,
            state: "REJECTED",
            disposition: "already_rejected",
            rejectedAt: iso(row.rejected_ms ?? now),
          }),
        };
      }
      if (row.state === "PENDING" && now >= row.expires_ms) {
        this.database.run(
          "UPDATE messages SET state = 'EXPIRED', body = NULL WHERE message_id = ? AND state = 'PENDING'",
          messageId,
        );
        return {
          ok: false,
          error: new BrokerOperationError("MESSAGE_EXPIRED", { currentState: "EXPIRED" }),
        };
      }
      if (row.state === "EXPIRED") {
        return {
          ok: false,
          error: new BrokerOperationError("MESSAGE_EXPIRED", { currentState: "EXPIRED" }),
        };
      }
      if (row.state !== "PENDING") {
        return {
          ok: false,
          error: new BrokerOperationError("MESSAGE_NOT_PENDING", { currentState: row.state }),
        };
      }
      const changed = this.database.run(
        `UPDATE messages SET state = 'REJECTED', rejected_ms = ?, body = NULL
         WHERE message_id = ? AND state = 'PENDING' AND target_session_id = ? AND body_hash = ?`,
        now,
        messageId,
        targetClaim.sessionId,
        expectedBodyHash,
      ).changes;
      if (changed !== 1) {
        return { ok: false, error: new BrokerOperationError("MESSAGE_NOT_PENDING") };
      }
      return {
        ok: true,
        value: RejectMessageResultSchema.parse({
          messageId,
          target: targetClaim,
          bodyHash: expectedBodyHash,
          state: "REJECTED",
          disposition: "rejected",
          rejectedAt: iso(now),
        }),
      };
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  search(
    principal: AuthenticatedClientPrincipal,
    requester: SessionIdentity,
    query: string,
    limit: number,
    foreground?: ForegroundSession,
  ): {
    result: SearchSessionsResult;
    foregroundRecovery?: ForegroundPendingRecovery;
  } {
    const now = this.clock.now();
    return this.transaction(() => {
      let preAdmissionMatches: readonly SessionRow[] = [];
      if (foreground) {
        this.assertForegroundClaim(principal, foreground, requester);
        preAdmissionMatches = [...this.matchingActiveSessions(principal, query, now)]
          .sort((left, right) => left.session_id.localeCompare(right.session_id))
          .slice(0, limit);
        const protectedSessionIds = new Set([
          requester.sessionId,
          ...preAdmissionMatches.map((row) => row.session_id),
        ]);
        this.admitForegroundInTransaction(
          principal,
          foreground,
          requester,
          protectedSessionIds,
          now,
        );
      } else {
        this.requireOwnedSession(principal, requester, true, "SESSION_NOT_REGISTERED");
      }
      const bySessionId = new Map(
        [...preAdmissionMatches, ...this.matchingActiveSessions(principal, query, now)].map(
          (row) => [row.session_id, row],
        ),
      );
      const rows = [...bySessionId.values()]
        .sort((left, right) => left.session_id.localeCompare(right.session_id))
        .slice(0, limit);
      const matches = rows.map((row) => {
        const session = this.identity(principal.serverId, row.session_id);
        return RegistrySearchMatchSchema.parse({
          session,
          fingerprint: sessionFingerprint(session),
          metadata: JSON.parse(row.metadata_json),
        });
      });
      const result = {
        scope: requester.broker,
        queryHash: hashNormalizedSearchQuery(
          query as Parameters<typeof hashNormalizedSearchQuery>[0],
        ),
        requestedLimit: limit,
        matches,
      };
      return foreground
        ? {
            result,
            foregroundRecovery: this.pendingRecovery(
              principal,
              this.requireOwnedSession(principal, requester, true, "SESSION_NOT_REGISTERED"),
              now,
            ),
          }
        : { result };
    });
  }

  private matchingActiveSessions(
    principal: AuthenticatedClientPrincipal,
    query: string,
    now: number,
  ): readonly SessionRow[] {
    return this.database
      .query<SessionRow, [string, number]>(
        `SELECT principal_id, host_session_id, session_id, metadata_json, metadata_search,
                opt_in, lease_expires_ms, displaced, last_foreground_ms, created_ms, updated_ms
         FROM sessions
         WHERE principal_id = ? AND opt_in = 1 AND lease_expires_ms > ?`,
      )
      .all(principal.principalId, now)
      .filter((row) =>
        parseMetadataSearchFields(row.metadata_search).some((field) => field.includes(query)),
      );
  }

  private pendingRecovery(
    principal: AuthenticatedClientPrincipal,
    target: SessionRow,
    now: number,
  ): ForegroundPendingRecovery {
    const headers = this.database
      .query<MessageHeaderRow, [string, number, number]>(
        `SELECT message_id, reply_to_message_id, source_session_id, target_session_id,
                body_hash, body_bytes, state, enqueued_ms, expires_ms
         FROM messages
         WHERE target_session_id = ? AND state = 'PENDING' AND expires_ms > ?
         ORDER BY enqueued_ms ASC, message_id ASC LIMIT ?`,
      )
      .all(target.session_id, now, DEFAULT_PENDING_LIST_LIMIT)
      .map((row) => this.headerFromRow(row, principal.serverId));
    return {
      target: this.identity(principal.serverId, target.session_id),
      requestedLimit: DEFAULT_PENDING_LIST_LIMIT,
      eventCursor: this.currentEventCursor(principal),
      headers,
    };
  }

  private currentEventCursor(principal: AuthenticatedClientPrincipal): EventCursor {
    const sequence = this.database
      .query<SequenceRow, [string]>(
        "SELECT sequence FROM principal_sequences WHERE principal_id = ?",
      )
      .get(principal.principalId)?.sequence;
    return EventCursorSchema.parse(String(sequence ?? 0));
  }

  replayEvents(principal: AuthenticatedClientPrincipal, cursor?: string): EventReplaySnapshot {
    return this.transaction(() => {
      const highWater = this.currentEventCursor(principal);
      if (cursor === undefined) return { cursor: highWater, events: [] };
      const parsedCursor = EventCursorSchema.parse(cursor);
      const cursorSequence = Number(parsedCursor);
      const highWaterSequence = Number(highWater);
      const retainedBoundaryRow =
        cursorSequence >= highWaterSequence
          ? undefined
          : this.database
              .query<{ readonly retained: number }, [string, number]>(
                "SELECT 1 AS retained FROM events WHERE principal_id = ? AND sequence = ?",
              )
              .get(principal.principalId, cursorSequence === 0 ? 1 : cursorSequence);
      const retainedBoundary =
        cursorSequence >= highWaterSequence ||
        (retainedBoundaryRow !== null && retainedBoundaryRow !== undefined);
      if (cursorSequence > highWaterSequence || !retainedBoundary) {
        throw new BrokerOperationError("EVENT_CURSOR_EXPIRED");
      }
      const events = this.database
        .query<EventRow, [string, number, string, number]>(
          `SELECT e.sequence, e.event_json
           FROM events e
           JOIN sessions s ON s.session_id = e.target_session_id
           WHERE e.principal_id = ? AND e.sequence > ?
             AND s.principal_id = ? AND s.opt_in = 1 AND s.lease_expires_ms > ?
           ORDER BY e.sequence ASC`,
        )
        .all(principal.principalId, cursorSequence, principal.principalId, this.clock.now())
        .map((row) => PendingMessageEventSchema.parse(JSON.parse(row.event_json)));
      return { cursor: highWater, events };
    });
  }

  retainedEvents(principal: AuthenticatedClientPrincipal): readonly PendingMessageEvent[] {
    return this.database
      .query<EventRow, [string]>(
        "SELECT sequence, event_json FROM events WHERE principal_id = ? ORDER BY sequence ASC",
      )
      .all(principal.principalId)
      .map((row) => PendingMessageEventSchema.parse(JSON.parse(row.event_json)));
  }

  hasPrincipal(principal: AuthenticatedClientPrincipal): boolean {
    const row = this.database
      .query<{ server_id: string }, [string]>(
        "SELECT server_id FROM principals WHERE principal_id = ?",
      )
      .get(principal.principalId);
    return row?.server_id === principal.serverId;
  }

  maintenance(): MaintenanceResult {
    const now = this.clock.now();
    const batch = this.limits.maintenanceBatchSize;
    return this.transaction(() => {
      const expiredMessages = Number(
        this.database.run(
          `UPDATE messages SET state = 'EXPIRED', body = NULL
           WHERE message_id IN (
             SELECT message_id FROM messages
             WHERE state = 'PENDING' AND expires_ms <= ?
             ORDER BY expires_ms ASC, message_id ASC LIMIT ?
           )`,
          now,
          batch,
        ).changes,
      );

      const enqueueRates = Number(
        this.database.run(
          `DELETE FROM enqueue_rate WHERE rowid IN (
             SELECT rowid FROM enqueue_rate WHERE occurred_ms <= ?
             ORDER BY occurred_ms ASC, rowid ASC LIMIT ?
           )`,
          now - this.limits.rateRetentionMs,
          batch,
        ).changes,
      );
      const registrationRates = Number(
        this.database.run(
          `DELETE FROM registration_rate WHERE rowid IN (
             SELECT rowid FROM registration_rate WHERE occurred_ms <= ?
             ORDER BY occurred_ms ASC, rowid ASC LIMIT ?
           )`,
          now - this.limits.rateRetentionMs,
          batch,
        ).changes,
      );
      const purgedEvents = Number(
        this.database.run(
          `DELETE FROM events WHERE rowid IN (
             SELECT rowid FROM events WHERE created_ms <= ?
             ORDER BY created_ms ASC, rowid ASC LIMIT ?
           )`,
          now - this.limits.eventRetentionMs,
          batch,
        ).changes,
      );
      const purgedMessages = Number(
        this.database.run(
          `DELETE FROM messages WHERE message_id IN (
             SELECT message_id FROM messages
             WHERE state != 'PENDING'
               AND CASE state
                 WHEN 'DELIVERED' THEN delivered_ms
                 WHEN 'REJECTED' THEN rejected_ms
                 ELSE expires_ms
               END <= ?
             ORDER BY CASE state
               WHEN 'DELIVERED' THEN delivered_ms
               WHEN 'REJECTED' THEN rejected_ms
               ELSE expires_ms
             END ASC, message_id ASC
             LIMIT ?
           )`,
          now - this.limits.terminalMessageRetentionMs,
          batch,
        ).changes,
      );
      const purgedSessions = Number(
        this.database.run(
          `DELETE FROM sessions WHERE rowid IN (
             SELECT s.rowid FROM sessions s
             WHERE (
               (s.opt_in = 0 AND s.updated_ms <= ?)
               OR (s.lease_expires_ms <= ?)
             )
             AND NOT EXISTS (
               SELECT 1 FROM messages m
               WHERE m.source_session_id = s.session_id OR m.target_session_id = s.session_id
             )
             AND NOT EXISTS (SELECT 1 FROM events e WHERE e.target_session_id = s.session_id)
             AND NOT EXISTS (
               SELECT 1 FROM enqueue_rate r WHERE r.source_session_id = s.session_id
             )
             ORDER BY s.updated_ms ASC, s.rowid ASC LIMIT ?
           )`,
          now - this.limits.inactiveSessionRetentionMs,
          now - this.limits.inactiveSessionRetentionMs,
          batch,
        ).changes,
      );
      return {
        expiredMessages,
        purgedMessages,
        purgedEvents,
        purgedRateRows: enqueueRates + registrationRates,
        purgedSessions,
      };
    });
  }

  storageStats(): StorageStats {
    const row = this.database
      .query<StorageStats, []>(
        `SELECT
           (SELECT COUNT(*) FROM sessions) AS sessions,
           (SELECT COUNT(*) FROM sessions WHERE opt_in = 1 AND lease_expires_ms > ${this.clock.now()})
             AS activeSessions,
           (SELECT COUNT(*) FROM sessions WHERE displaced = 1) AS displacedSessions,
           (SELECT COUNT(*) FROM messages) AS messages,
           (SELECT COUNT(*) FROM events) AS events,
           (SELECT COUNT(*) FROM enqueue_rate) AS enqueueRateRows,
           (SELECT COUNT(*) FROM registration_rate) AS registrationRateRows,
           (SELECT COUNT(*) FROM messages WHERE state = 'PENDING' AND body IS NOT NULL)
             AS pendingBodies,
           (SELECT COUNT(*) FROM messages WHERE state != 'PENDING' AND body IS NOT NULL)
             AS terminalBodies,
           (SELECT COUNT(*) FROM messages WHERE state = 'EXPIRED') AS expiredMessages`,
      )
      .get();
    if (!row) throw new Error("Broker storage statistics are unavailable.");
    return row;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      assertSecureDatabaseFiles(this.parent);
      this.database.run("PRAGMA wal_checkpoint(TRUNCATE)");
      assertSecureDatabaseFiles(this.parent);
    } finally {
      this.database.close(false);
      this.parent.close();
    }
  }

  private canonicalSessionId(
    principal: AuthenticatedClientPrincipal,
    hostSessionId: string,
  ): string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update("opencode-agentbus/canonical-session/v1\0");
    hasher.update(this.brokerId);
    hasher.update("\0");
    hasher.update(principal.principalId);
    hasher.update("\0");
    hasher.update(hostSessionId);
    return hasher.digest("hex");
  }

  private identity(serverId: string, sessionId: string): SessionIdentity {
    return {
      broker: { brokerId: this.brokerId, serverId },
      sessionId,
    } as SessionIdentity;
  }

  private assertClaimScope(principal: AuthenticatedClientPrincipal, claim: SessionIdentity): void {
    if (claim.broker.brokerId !== this.brokerId || claim.broker.serverId !== principal.serverId) {
      throw new BrokerOperationError("FORBIDDEN");
    }
  }

  private requireOwnedSession(
    principal: AuthenticatedClientPrincipal,
    claim: SessionIdentity,
    requireActive: boolean,
    absentCode: "SESSION_NOT_REGISTERED" | "TARGET_NOT_REGISTERED",
  ): SessionRow {
    this.assertClaimScope(principal, claim);
    const row = this.database
      .query<SessionRow, [string]>(
        `SELECT principal_id, host_session_id, session_id, metadata_json, metadata_search,
                opt_in, lease_expires_ms, displaced, last_foreground_ms, created_ms, updated_ms
         FROM sessions WHERE session_id = ?`,
      )
      .get(claim.sessionId);
    if (row && row.principal_id !== principal.principalId) {
      throw new BrokerOperationError("FORBIDDEN");
    }
    if (!row || (requireActive && (row.opt_in !== 1 || row.lease_expires_ms <= this.clock.now()))) {
      throw new BrokerOperationError(absentCode);
    }
    return row;
  }

  private requireRecoverableSession(
    principal: AuthenticatedClientPrincipal,
    claim: SessionIdentity,
    absentCode: "SESSION_NOT_REGISTERED" | "TARGET_NOT_REGISTERED",
  ): SessionRow {
    const row = this.requireOwnedSession(principal, claim, false, absentCode);
    const active = row.opt_in === 1 && row.lease_expires_ms > this.clock.now();
    if (!active && row.displaced !== 1) throw new BrokerOperationError(absentCode);
    return row;
  }

  private activeSessionCount(principalId: string, now: number): number {
    return (
      this.database
        .query<CountRow, [string, number]>(
          `SELECT COUNT(*) AS count FROM sessions
           WHERE principal_id = ? AND opt_in = 1 AND lease_expires_ms > ?`,
        )
        .get(principalId, now)?.count ?? 0
    );
  }

  private assertForegroundClaim(
    principal: AuthenticatedClientPrincipal,
    foreground: ForegroundSession,
    claim: SessionIdentity | undefined,
  ): string {
    const sessionId = this.canonicalSessionId(principal, foreground.hostSessionId);
    if (claim) {
      this.assertClaimScope(principal, claim);
      if (claim.sessionId !== sessionId) throw new BrokerOperationError("FORBIDDEN");
    }
    return sessionId;
  }

  private admitForegroundInTransaction(
    principal: AuthenticatedClientPrincipal,
    foreground: ForegroundSession,
    claim: SessionIdentity | undefined,
    protectedSessionIds: ReadonlySet<string>,
    now: number,
  ): { readonly row: SessionRow; readonly existed: boolean } {
    const sessionId = this.assertForegroundClaim(principal, foreground, claim);
    const existing = this.database
      .query<SessionRow, [string, string]>(
        `SELECT principal_id, host_session_id, session_id, metadata_json, metadata_search,
                opt_in, lease_expires_ms, displaced, last_foreground_ms, created_ms, updated_ms
         FROM sessions WHERE principal_id = ? AND host_session_id = ?`,
      )
      .get(principal.principalId, foreground.hostSessionId);
    if (existing && existing.session_id !== sessionId) {
      throw new Error("Broker canonical session identity conflicts with persisted state.");
    }
    if (!existing) {
      this.ensureDurableForegroundCapacity(principal, protectedSessionIds, now);
      this.database.run(
        `INSERT INTO sessions(
           principal_id, host_session_id, session_id, metadata_json, metadata_search,
           opt_in, lease_expires_ms, created_ms, updated_ms, displaced, last_foreground_ms
         ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 1, NULL)`,
        principal.principalId,
        foreground.hostSessionId,
        sessionId,
        canonicalMetadataJson(foreground.metadata),
        metadataSearchText(foreground.metadata),
        now + this.limits.sessionLeaseSeconds * 1_000,
        now,
        now,
      );
    } else {
      this.database.run(
        `UPDATE sessions SET metadata_json = ?, metadata_search = ?, updated_ms = ?
         WHERE principal_id = ? AND session_id = ?`,
        canonicalMetadataJson(foreground.metadata),
        metadataSearchText(foreground.metadata),
        now,
        principal.principalId,
        sessionId,
      );
    }

    const beforeAdmission = this.requireOwnedSession(
      principal,
      this.identity(principal.serverId, sessionId),
      false,
      "SESSION_NOT_REGISTERED",
    );
    if (beforeAdmission.opt_in !== 1 || beforeAdmission.lease_expires_ms <= now) {
      this.evictForAdmission(principal, new Set([...protectedSessionIds, sessionId]), now);
    }
    const leaseExpires = now + this.limits.sessionLeaseSeconds * 1_000;
    this.database.run(
      `UPDATE sessions
       SET opt_in = 1, displaced = 0, lease_expires_ms = ?, last_foreground_ms = ?, updated_ms = ?
       WHERE principal_id = ? AND session_id = ?`,
      leaseExpires,
      now,
      now,
      principal.principalId,
      sessionId,
    );
    return {
      row: this.requireOwnedSession(
        principal,
        this.identity(principal.serverId, sessionId),
        true,
        "SESSION_NOT_REGISTERED",
      ),
      existed: existing !== null,
    };
  }

  private admitDisplacedDependency(
    principal: AuthenticatedClientPrincipal,
    claim: SessionIdentity,
    protectedSessionIds: ReadonlySet<string>,
    now: number,
    absentCode: "SESSION_NOT_REGISTERED" | "TARGET_NOT_REGISTERED",
  ): SessionRow {
    const existing = this.requireOwnedSession(principal, claim, false, absentCode);
    if (existing.opt_in === 1 && existing.lease_expires_ms > now) return existing;
    if (existing.displaced !== 1) throw new BrokerOperationError(absentCode);
    this.evictForAdmission(principal, protectedSessionIds, now);
    this.database.run(
      `UPDATE sessions SET opt_in = 1, displaced = 0, lease_expires_ms = ?, updated_ms = ?
       WHERE principal_id = ? AND session_id = ?`,
      now + this.limits.sessionLeaseSeconds * 1_000,
      now,
      principal.principalId,
      claim.sessionId,
    );
    return this.requireOwnedSession(principal, claim, true, absentCode);
  }

  private evictForAdmission(
    principal: AuthenticatedClientPrincipal,
    protectedSessionIds: ReadonlySet<string>,
    now: number,
  ): void {
    if (
      this.activeSessionCount(principal.principalId, now) <
      this.limits.maxActiveSessionsPerPrincipal
    ) {
      return;
    }
    const candidates = this.database
      .query<SessionRow, [string, number]>(
        `SELECT principal_id, host_session_id, session_id, metadata_json, metadata_search,
                opt_in, lease_expires_ms, displaced, last_foreground_ms, created_ms, updated_ms
         FROM sessions
         WHERE principal_id = ? AND opt_in = 1 AND lease_expires_ms > ?
         ORDER BY CASE WHEN last_foreground_ms IS NULL THEN 0 ELSE 1 END ASC,
                  CASE WHEN last_foreground_ms IS NULL THEN created_ms ELSE last_foreground_ms END ASC,
                  created_ms ASC,
                  session_id ASC`,
      )
      .all(principal.principalId, now);
    const candidate = candidates.find((row) => !protectedSessionIds.has(row.session_id));
    if (!candidate) throw new BrokerOperationError("RATE_LIMITED", { retryAfterMs: 100 });
    this.database.run(
      `UPDATE sessions SET opt_in = 0, displaced = 1, updated_ms = ?
       WHERE principal_id = ? AND session_id = ?`,
      now,
      principal.principalId,
      candidate.session_id,
    );
  }

  private ensureDurableForegroundCapacity(
    principal: AuthenticatedClientPrincipal,
    protectedSessionIds: ReadonlySet<string>,
    now: number,
  ): void {
    const principalSessions =
      this.database
        .query<CountRow, [string]>("SELECT COUNT(*) AS count FROM sessions WHERE principal_id = ?")
        .get(principal.principalId)?.count ?? 0;
    if (principalSessions >= this.limits.maxSessionsPerPrincipal) {
      this.reclaimStateFreeBackgroundSession(principal.principalId, protectedSessionIds, now);
    }
    const globalSessions =
      this.database.query<CountRow, []>("SELECT COUNT(*) AS count FROM sessions").get()?.count ?? 0;
    if (globalSessions >= this.limits.maxSessionsGlobal) {
      this.reclaimStateFreeBackgroundSession(undefined, protectedSessionIds, now);
    }
  }

  private reclaimStateFreeBackgroundSession(
    principalId: string | undefined,
    protectedSessionIds: ReadonlySet<string>,
    now: number,
  ): void {
    const candidates =
      principalId === undefined
        ? this.database
            .query<SessionRow, [number]>(
              `SELECT principal_id, host_session_id, session_id, metadata_json, metadata_search,
                      opt_in, lease_expires_ms, displaced, last_foreground_ms, created_ms, updated_ms
               FROM sessions s
               WHERE last_foreground_ms IS NULL AND (opt_in = 0 OR lease_expires_ms <= ?)
                 AND NOT EXISTS (
                   SELECT 1 FROM messages m
                   WHERE m.source_session_id = s.session_id OR m.target_session_id = s.session_id
                 )
                 AND NOT EXISTS (SELECT 1 FROM events e WHERE e.target_session_id = s.session_id)
                 AND NOT EXISTS (
                   SELECT 1 FROM enqueue_rate r WHERE r.source_session_id = s.session_id
                 )
               ORDER BY created_ms ASC,
                        session_id ASC`,
            )
            .all(now)
        : this.database
            .query<SessionRow, [string, number]>(
              `SELECT principal_id, host_session_id, session_id, metadata_json, metadata_search,
                      opt_in, lease_expires_ms, displaced, last_foreground_ms, created_ms, updated_ms
               FROM sessions s
               WHERE principal_id = ? AND last_foreground_ms IS NULL
                 AND (opt_in = 0 OR lease_expires_ms <= ?)
                 AND NOT EXISTS (
                   SELECT 1 FROM messages m
                   WHERE m.source_session_id = s.session_id OR m.target_session_id = s.session_id
                 )
                 AND NOT EXISTS (SELECT 1 FROM events e WHERE e.target_session_id = s.session_id)
                 AND NOT EXISTS (
                   SELECT 1 FROM enqueue_rate r WHERE r.source_session_id = s.session_id
                 )
               ORDER BY created_ms ASC,
                        session_id ASC`,
            )
            .all(principalId, now);
    const candidate = candidates.find((row) => !protectedSessionIds.has(row.session_id));
    if (!candidate) throw new BrokerOperationError("RATE_LIMITED", { retryAfterMs: 100 });
    this.database.run("DELETE FROM sessions WHERE session_id = ?", candidate.session_id);
  }

  private enqueueResolved(
    principal: AuthenticatedClientPrincipal,
    source: SessionRow,
    target: SessionRow,
    body: string,
    ttlSeconds: number,
    correlationId: string,
    now: number,
    replyToMessageId?: string,
  ): { receipt: EnqueueMessageReceipt; event: PendingMessageEvent } {
    const expires = now + ttlSeconds * 1_000;
    const bodyHash = bodySha256(body);
    const bodyBytes = Buffer.byteLength(body, "utf8");
    const messageId = Buffer.from(this.random.bytes(32)).toString("hex");
    this.enforceEnqueueRateLimits(principal, source.session_id, now);
    this.enforceDurableMessageLimits(principal, source.session_id, now);
    this.enforcePendingLimits(principal, target.session_id, now);

    this.database.run(
      `INSERT INTO messages(
         message_id, source_session_id, target_session_id, target_principal_id,
         body_hash, body_bytes, body, state, enqueued_ms, expires_ms, reply_to_message_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
      messageId,
      source.session_id,
      target.session_id,
      target.principal_id,
      bodyHash,
      bodyBytes,
      body,
      now,
      expires,
      replyToMessageId ?? null,
    );
    this.database.run(
      "INSERT INTO enqueue_rate(principal_id, source_session_id, occurred_ms) VALUES (?, ?, ?)",
      principal.principalId,
      source.session_id,
      now,
    );

    const header = this.headerFromRow(
      {
        message_id: messageId,
        reply_to_message_id: replyToMessageId ?? null,
        source_session_id: source.session_id,
        target_session_id: target.session_id,
        body_hash: bodyHash,
        body_bytes: bodyBytes,
        state: "PENDING",
        enqueued_ms: now,
        expires_ms: expires,
      },
      principal.serverId,
    );
    const event = this.appendEvent(principal, target.session_id, correlationId, header, now);
    return {
      receipt: EnqueueMessageReceiptSchema.parse({
        messageId,
        state: "PENDING",
        bodyHash,
        bodyBytes,
        expiresAt: iso(expires),
      }),
      event,
    };
  }

  private enforceRegistrationRate(principal: AuthenticatedClientPrincipal, now: number): void {
    const cutoff = now - 60_000;
    const count = this.database
      .query<CountRow, [string, number]>(
        `SELECT COUNT(*) AS count FROM registration_rate
         WHERE principal_id = ? AND occurred_ms > ?`,
      )
      .get(principal.principalId, cutoff)?.count;
    if ((count ?? 0) < this.limits.registrationsPerPrincipalPerMinute) return;
    const oldest = this.database
      .query<RateRow, [string, number]>(
        `SELECT MIN(occurred_ms) AS oldest FROM registration_rate
         WHERE principal_id = ? AND occurred_ms > ?`,
      )
      .get(principal.principalId, cutoff)?.oldest;
    const retryAfterMs = Math.max(100, Math.min(60_000, (oldest ?? now) + 60_000 - now));
    throw new BrokerOperationError("RATE_LIMITED", { retryAfterMs });
  }

  private enforceEnqueueRateLimits(
    principal: AuthenticatedClientPrincipal,
    sourceSessionId: string,
    now: number,
  ): void {
    const cutoff = now - 60_000;
    const principalRate = this.database
      .query<CountRow, [string, number]>(
        "SELECT COUNT(*) AS count FROM enqueue_rate WHERE principal_id = ? AND occurred_ms > ?",
      )
      .get(principal.principalId, cutoff)?.count;
    const sessionRate = this.database
      .query<CountRow, [string, number]>(
        "SELECT COUNT(*) AS count FROM enqueue_rate WHERE source_session_id = ? AND occurred_ms > ?",
      )
      .get(sourceSessionId, cutoff)?.count;
    if (
      (principalRate ?? 0) >= this.limits.enqueuePerPrincipalPerMinute ||
      (sessionRate ?? 0) >= this.limits.enqueuePerSessionPerMinute
    ) {
      const oldest = this.database
        .query<RateRow, [string, string, number]>(
          `SELECT MIN(occurred_ms) AS oldest FROM enqueue_rate
           WHERE principal_id = ? AND source_session_id = ? AND occurred_ms > ?`,
        )
        .get(principal.principalId, sourceSessionId, cutoff)?.oldest;
      const retryAfterMs = Math.max(100, Math.min(60_000, (oldest ?? now) + 60_000 - now));
      throw new BrokerOperationError("RATE_LIMITED", { retryAfterMs });
    }
  }

  private enforcePendingLimits(
    principal: AuthenticatedClientPrincipal,
    targetSessionId: string,
    now: number,
  ): void {
    const principalPending = this.database
      .query<CountRow, [string, number]>(
        `SELECT COUNT(*) AS count FROM messages
         WHERE target_principal_id = ? AND state = 'PENDING' AND expires_ms > ?`,
      )
      .get(principal.principalId, now)?.count;
    const sessionPending = this.database
      .query<CountRow, [string, number]>(
        `SELECT COUNT(*) AS count FROM messages
         WHERE target_session_id = ? AND state = 'PENDING' AND expires_ms > ?`,
      )
      .get(targetSessionId, now)?.count;
    if (
      (principalPending ?? 0) >= this.limits.maxPendingPerPrincipal ||
      (sessionPending ?? 0) >= this.limits.maxPendingPerSession
    ) {
      const retries: number[] = [];
      if ((principalPending ?? 0) >= this.limits.maxPendingPerPrincipal) {
        const oldest = this.database
          .query<NullableTimestampRow, [string, number]>(
            `SELECT MIN(expires_ms) AS oldest FROM messages
             WHERE target_principal_id = ? AND state = 'PENDING' AND expires_ms > ?`,
          )
          .get(principal.principalId, now)?.oldest;
        retries.push(Math.max(100, Math.min(60_000, (oldest ?? now) - now)));
      }
      if ((sessionPending ?? 0) >= this.limits.maxPendingPerSession) {
        const oldest = this.database
          .query<NullableTimestampRow, [string, number]>(
            `SELECT MIN(expires_ms) AS oldest FROM messages
             WHERE target_session_id = ? AND state = 'PENDING' AND expires_ms > ?`,
          )
          .get(targetSessionId, now)?.oldest;
        retries.push(Math.max(100, Math.min(60_000, (oldest ?? now) - now)));
      }
      throw new BrokerOperationError("RATE_LIMITED", { retryAfterMs: Math.max(...retries) });
    }
  }

  private enforceDurableMessageLimits(
    principal: AuthenticatedClientPrincipal,
    sourceSessionId: string,
    now: number,
  ): void {
    let counts = this.messageQuotaCounts(principal.principalId, sourceSessionId);
    if (counts.source_count >= this.limits.maxMessagesPerSourceSession) {
      this.reclaimTerminalMessages(
        "source",
        sourceSessionId,
        counts.source_count - this.limits.maxMessagesPerSourceSession + 1,
        now,
      );
      counts = this.messageQuotaCounts(principal.principalId, sourceSessionId);
    }
    if (counts.principal_count >= this.limits.maxMessagesPerPrincipal) {
      this.reclaimTerminalMessages(
        "principal",
        principal.principalId,
        counts.principal_count - this.limits.maxMessagesPerPrincipal + 1,
        now,
      );
      counts = this.messageQuotaCounts(principal.principalId, sourceSessionId);
    }
    if (counts.global_count >= this.limits.maxMessagesGlobal) {
      this.reclaimTerminalMessages(
        "global",
        undefined,
        counts.global_count - this.limits.maxMessagesGlobal + 1,
        now,
      );
      counts = this.messageQuotaCounts(principal.principalId, sourceSessionId);
    }

    const retries: number[] = [];
    if (counts.source_count >= this.limits.maxMessagesPerSourceSession) {
      retries.push(
        this.messageQuotaRetryAfter(
          "source",
          sourceSessionId,
          counts.source_count - this.limits.maxMessagesPerSourceSession + 1,
          now,
        ),
      );
    }
    if (counts.principal_count >= this.limits.maxMessagesPerPrincipal) {
      retries.push(
        this.messageQuotaRetryAfter(
          "principal",
          principal.principalId,
          counts.principal_count - this.limits.maxMessagesPerPrincipal + 1,
          now,
        ),
      );
    }
    if (counts.global_count >= this.limits.maxMessagesGlobal) {
      retries.push(
        this.messageQuotaRetryAfter(
          "global",
          undefined,
          counts.global_count - this.limits.maxMessagesGlobal + 1,
          now,
        ),
      );
    }
    if (retries.length > 0) {
      throw new BrokerOperationError("RATE_LIMITED", {
        retryAfterMs: Math.max(...retries),
      });
    }
  }

  private messageQuotaCounts(principalId: string, sourceSessionId: string): MessageQuotaCounts {
    const counts = this.database
      .query<MessageQuotaCounts, [string, string]>(
        `SELECT
           COALESCE(SUM(CASE WHEN source_session_id = ? THEN 1 ELSE 0 END), 0) AS source_count,
           COALESCE(SUM(CASE WHEN target_principal_id = ? THEN 1 ELSE 0 END), 0)
             AS principal_count,
           COUNT(*) AS global_count
         FROM messages`,
      )
      .get(sourceSessionId, principalId);
    return counts ?? { source_count: 0, principal_count: 0, global_count: 0 };
  }

  private reclaimTerminalMessages(
    scope: MessageQuotaScope,
    scopeId: string | undefined,
    requested: number,
    now: number,
  ): void {
    const limit = Math.min(this.limits.maintenanceBatchSize, requested);
    const cutoff = now - this.limits.terminalMessageRetentionMs;
    if (scope === "source") {
      if (scopeId === undefined) throw new Error("Source quota scope is unavailable.");
      this.database.run(
        `DELETE FROM messages WHERE message_id IN (
           SELECT message_id FROM messages
           WHERE source_session_id = ? AND state != 'PENDING' AND body IS NULL
             AND CASE state
               WHEN 'DELIVERED' THEN delivered_ms
               WHEN 'REJECTED' THEN rejected_ms
               ELSE expires_ms
             END <= ?
           ORDER BY CASE state
             WHEN 'DELIVERED' THEN delivered_ms
             WHEN 'REJECTED' THEN rejected_ms
             ELSE expires_ms
           END ASC, message_id ASC
           LIMIT ?
         )`,
        scopeId,
        cutoff,
        limit,
      );
    } else if (scope === "principal") {
      if (scopeId === undefined) throw new Error("Principal quota scope is unavailable.");
      this.database.run(
        `DELETE FROM messages WHERE message_id IN (
           SELECT message_id FROM messages
           WHERE target_principal_id = ? AND state != 'PENDING' AND body IS NULL
             AND CASE state
               WHEN 'DELIVERED' THEN delivered_ms
               WHEN 'REJECTED' THEN rejected_ms
               ELSE expires_ms
             END <= ?
           ORDER BY CASE state
             WHEN 'DELIVERED' THEN delivered_ms
             WHEN 'REJECTED' THEN rejected_ms
             ELSE expires_ms
           END ASC, message_id ASC
           LIMIT ?
         )`,
        scopeId,
        cutoff,
        limit,
      );
    } else {
      this.database.run(
        `DELETE FROM messages WHERE message_id IN (
           SELECT message_id FROM messages
           WHERE state != 'PENDING' AND body IS NULL
             AND CASE state
               WHEN 'DELIVERED' THEN delivered_ms
               WHEN 'REJECTED' THEN rejected_ms
               ELSE expires_ms
             END <= ?
           ORDER BY CASE state
             WHEN 'DELIVERED' THEN delivered_ms
             WHEN 'REJECTED' THEN rejected_ms
             ELSE expires_ms
           END ASC, message_id ASC
           LIMIT ?
         )`,
        cutoff,
        limit,
      );
    }
  }

  private messageQuotaRetryAfter(
    scope: MessageQuotaScope,
    scopeId: string | undefined,
    required: number,
    now: number,
  ): number {
    const offset = required - 1;
    let row: NullableTimestampRow | null;
    if (scope === "source") {
      if (scopeId === undefined) throw new Error("Source quota scope is unavailable.");
      row = this.database
        .query<NullableTimestampRow, [number, string, number]>(
          `SELECT CASE state
             WHEN 'PENDING' THEN expires_ms
             WHEN 'DELIVERED' THEN delivered_ms
             WHEN 'REJECTED' THEN rejected_ms
             ELSE expires_ms
           END + ? AS oldest
           FROM messages
           WHERE source_session_id = ? AND (state = 'PENDING' OR body IS NULL)
             AND CASE state
               WHEN 'PENDING' THEN expires_ms
               WHEN 'DELIVERED' THEN delivered_ms
               WHEN 'REJECTED' THEN rejected_ms
               ELSE expires_ms
             END IS NOT NULL
           ORDER BY oldest ASC, message_id ASC LIMIT 1 OFFSET ?`,
        )
        .get(this.limits.terminalMessageRetentionMs, scopeId, offset);
    } else if (scope === "principal") {
      if (scopeId === undefined) throw new Error("Principal quota scope is unavailable.");
      row = this.database
        .query<NullableTimestampRow, [number, string, number]>(
          `SELECT CASE state
             WHEN 'PENDING' THEN expires_ms
             WHEN 'DELIVERED' THEN delivered_ms
             WHEN 'REJECTED' THEN rejected_ms
             ELSE expires_ms
           END + ? AS oldest
           FROM messages
           WHERE target_principal_id = ? AND (state = 'PENDING' OR body IS NULL)
             AND CASE state
               WHEN 'PENDING' THEN expires_ms
               WHEN 'DELIVERED' THEN delivered_ms
               WHEN 'REJECTED' THEN rejected_ms
               ELSE expires_ms
             END IS NOT NULL
           ORDER BY oldest ASC, message_id ASC LIMIT 1 OFFSET ?`,
        )
        .get(this.limits.terminalMessageRetentionMs, scopeId, offset);
    } else {
      row = this.database
        .query<NullableTimestampRow, [number, number]>(
          `SELECT CASE state
             WHEN 'PENDING' THEN expires_ms
             WHEN 'DELIVERED' THEN delivered_ms
             WHEN 'REJECTED' THEN rejected_ms
             ELSE expires_ms
           END + ? AS oldest
           FROM messages
           WHERE (state = 'PENDING' OR body IS NULL)
             AND CASE state
               WHEN 'PENDING' THEN expires_ms
               WHEN 'DELIVERED' THEN delivered_ms
               WHEN 'REJECTED' THEN rejected_ms
               ELSE expires_ms
             END IS NOT NULL
           ORDER BY oldest ASC, message_id ASC LIMIT 1 OFFSET ?`,
        )
        .get(this.limits.terminalMessageRetentionMs, offset);
    }
    if (row?.oldest === null || row?.oldest === undefined) return 60_000;
    return Math.max(100, Math.min(60_000, row.oldest - now));
  }

  private headerFromRow(row: MessageHeaderRow, serverId: string): PendingMessageHeader {
    return {
      messageId: row.message_id,
      ...(row.reply_to_message_id === null ? {} : { replyToMessageId: row.reply_to_message_id }),
      source: this.identity(serverId, row.source_session_id),
      target: this.identity(serverId, row.target_session_id),
      bodyHash: row.body_hash,
      bodyBytes: row.body_bytes,
      state: "PENDING",
      enqueuedAt: iso(row.enqueued_ms),
      expiresAt: iso(row.expires_ms),
    } as PendingMessageHeader;
  }

  private appendEvent(
    principal: AuthenticatedClientPrincipal,
    targetSessionId: string,
    correlationId: string,
    header: PendingMessageHeader,
    now: number,
  ): PendingMessageEvent {
    this.database.run(
      `INSERT INTO principal_sequences(principal_id, sequence) VALUES (?, 0)
       ON CONFLICT(principal_id) DO NOTHING`,
      principal.principalId,
    );
    this.database.run(
      "UPDATE principal_sequences SET sequence = sequence + 1 WHERE principal_id = ?",
      principal.principalId,
    );
    const sequence = this.database
      .query<SequenceRow, [string]>(
        "SELECT sequence FROM principal_sequences WHERE principal_id = ?",
      )
      .get(principal.principalId)?.sequence;
    if (!sequence) throw new Error("Event sequence was not allocated.");
    const event = PendingMessageEventSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      event: "agentbus.pending",
      eventId: String(sequence),
      correlationId,
      target: header.target,
      header,
    });
    this.database.run(
      `INSERT INTO events(principal_id, sequence, target_session_id, event_json, created_ms)
       VALUES (?, ?, ?, ?, ?)`,
      principal.principalId,
      sequence,
      targetSessionId,
      JSON.stringify(event),
      now,
    );
    this.database.run(
      "DELETE FROM events WHERE principal_id = ? AND sequence <= ?",
      principal.principalId,
      Math.max(0, sequence - this.limits.eventReplayWindow),
    );
    return event;
  }

  private transaction<T>(operation: () => T): T {
    this.database.run("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = operation();
      this.database.run("COMMIT");
    } catch (error) {
      this.database.run("ROLLBACK");
      assertSecureDatabaseFiles(this.parent);
      throw error;
    }
    assertSecureDatabaseFiles(this.parent);
    return result;
  }
}

type ConsumedMessageResultLike = {
  messageId: string;
  replyToMessageId?: string;
  source: SessionIdentity;
  target: SessionIdentity;
  body: string;
  bodyHash: string;
  bodyBytes: number;
  state: "DELIVERED";
  deliveredAt: string;
};

export function principalsEqual(
  left: AuthenticatedClientPrincipal,
  right: AuthenticatedClientPrincipal,
): boolean {
  return samePrincipal(left, right);
}

export const DEFAULT_STORE_LIMITS: StoreLimits = Object.freeze({
  ...deriveSessionLimitDefaults(DEFAULT_ACTIVE_SESSIONS_PER_PRINCIPAL),
  enqueuePerPrincipalPerMinute: 120,
  enqueuePerSessionPerMinute: 60,
  maxPendingPerPrincipal: 2_048,
  maxPendingPerSession: 256,
  maxMessagesPerSourceSession: 1_024,
  maxMessagesPerPrincipal: 8_192,
  maxMessagesGlobal: 32_768,
  eventReplayWindow: 256,
  sessionLeaseSeconds: 120,
  maintenanceBatchSize: 256,
  terminalMessageRetentionMs: 24 * 60 * 60 * 1_000,
  eventRetentionMs: 24 * 60 * 60 * 1_000,
  inactiveSessionRetentionMs: 7 * 24 * 60 * 60 * 1_000,
  rateRetentionMs: 2 * 60 * 1_000,
});
