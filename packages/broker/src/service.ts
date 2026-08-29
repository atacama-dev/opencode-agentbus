import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  ApplicationResponseEnvelopeSchema,
  AuthChallengeNonceSchema,
  AuthChallengeResponseSchema,
  DEFAULT_ACTIVE_SESSIONS_PER_PRINCIPAL,
  DEFAULT_SESSION_LEASE_SECONDS,
  DeregisterSessionRequestSchema,
  EnqueueMessageRequestSchema,
  ForegroundIdentityRequestSchema,
  HandshakeRequestSchema,
  HeartbeatSessionRequestSchema,
  ListPendingMessagesRequestSchema,
  MAX_ACTIVE_SESSIONS_PER_PRINCIPAL,
  MAX_EVENT_REPLAY_WINDOW,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGE_TTL_SECONDS,
  MAX_SESSION_LEASE_SECONDS,
  METHODS,
  MIN_MESSAGE_TTL_SECONDS,
  MIN_SESSION_LEASE_SECONDS,
  PeekNextMessageRequestSchema,
  PROTOCOL_VERSION,
  PrincipalIdSchema,
  RegisterSessionRequestSchema,
  RejectMessageRequestSchema,
  ReplyMessageRequestSchema,
  RequestIdSchema,
  SearchSessionsRequestSchema,
  ServerIdSchema,
  ConsumeMessageRequestSchema,
  createAuthChallengeProof,
  generateAuthChallengeNonce,
  createErrorEnvelope,
  isWellFormedUnicode,
  negotiateProtocolVersion,
  utf8Bytes,
  type ApplicationOperationRequest,
  type ApplicationResponseEnvelope,
  type AuthChallengeResponse,
  type AuthenticatedClientPrincipal,
  type CredentialFile,
  type ErrorCode,
  type ErrorEnvelope,
  type EventCursor,
  type Method,
  type PendingMessageEvent,
} from "@opencode-agentbus/protocol";
import type { z } from "zod";
import {
  loadOrCreateCredential,
  rotateCredentialFile,
  type CredentialRandomSource,
} from "./credentials";
import {
  BROKER_SESSION_LIMIT_POLICY,
  BrokerOperationError,
  BrokerStore,
  DEFAULT_STORE_LIMITS,
  deriveSessionLimitDefaults,
  principalsEqual,
  type MaintenanceResult,
  type StorageStats,
  type StoreLimits,
} from "./store";

export interface Clock {
  now(): number;
}

export interface RandomSource extends CredentialRandomSource {}

export interface BrokerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface BrokerLimits extends StoreLimits {}

export interface BrokerServiceOptions {
  readonly databasePath: string;
  readonly credentialFilePath: string;
  readonly clock?: Clock;
  readonly random?: RandomSource;
  readonly limits?: Partial<BrokerLimits>;
  readonly statementObserver?: (sql: string) => void;
  readonly logger?: BrokerLogger;
}

export interface EventReplaySuccess {
  readonly ok: true;
  readonly cursor: EventCursor;
  readonly events: readonly PendingMessageEvent[];
}

export interface EventReplayFailure {
  readonly ok: false;
  readonly error: ErrorEnvelope;
}

export type EventReplayResult = EventReplaySuccess | EventReplayFailure;

const systemClock: Clock = { now: () => Date.now() };
const systemRandom: RandomSource = {
  bytes(length) {
    return crypto.getRandomValues(new Uint8Array(length));
  },
};
const silentLogger: BrokerLogger = {
  info() {},
  warn() {},
  error() {},
};

const methodValues = new Set<string>(Object.values(METHODS));
const requestSchemas: Readonly<Record<Method, z.ZodTypeAny>> = {
  [METHODS.HANDSHAKE]: HandshakeRequestSchema,
  [METHODS.REGISTER_SESSION]: RegisterSessionRequestSchema,
  [METHODS.RESOLVE_FOREGROUND_SESSION]: ForegroundIdentityRequestSchema,
  [METHODS.HEARTBEAT_SESSION]: HeartbeatSessionRequestSchema,
  [METHODS.DEREGISTER_SESSION]: DeregisterSessionRequestSchema,
  [METHODS.ENQUEUE_MESSAGE]: EnqueueMessageRequestSchema,
  [METHODS.REPLY_MESSAGE]: ReplyMessageRequestSchema,
  [METHODS.PEEK_NEXT_MESSAGE]: PeekNextMessageRequestSchema,
  [METHODS.LIST_PENDING_MESSAGES]: ListPendingMessagesRequestSchema,
  [METHODS.CONSUME_MESSAGE]: ConsumeMessageRequestSchema,
  [METHODS.REJECT_MESSAGE]: RejectMessageRequestSchema,
  [METHODS.SEARCH_SESSIONS]: SearchSessionsRequestSchema,
};

export { BROKER_SESSION_LIMIT_POLICY };

export function resolveBrokerLimits(overrides: Partial<BrokerLimits> = {}): BrokerLimits {
  const maxActiveSessionsPerPrincipal =
    overrides.maxActiveSessionsPerPrincipal ??
    (overrides.maxSessionsPerPrincipal === undefined
      ? DEFAULT_ACTIVE_SESSIONS_PER_PRINCIPAL
      : Math.min(DEFAULT_ACTIVE_SESSIONS_PER_PRINCIPAL, overrides.maxSessionsPerPrincipal));
  const sessionDefaults = deriveSessionLimitDefaults(maxActiveSessionsPerPrincipal);
  const maxSessionsPerPrincipal =
    overrides.maxSessionsPerPrincipal ?? sessionDefaults.maxSessionsPerPrincipal;
  const limits: BrokerLimits = {
    ...DEFAULT_STORE_LIMITS,
    ...sessionDefaults,
    ...overrides,
    maxActiveSessionsPerPrincipal,
    maxSessionsPerPrincipal,
    maxSessionsGlobal:
      overrides.maxSessionsGlobal ??
      Math.max(sessionDefaults.maxSessionsGlobal, maxSessionsPerPrincipal),
    foregroundSessionReserve:
      overrides.foregroundSessionReserve ??
      Math.min(sessionDefaults.foregroundSessionReserve, Math.max(1, maxSessionsPerPrincipal - 1)),
    maxPendingPerPrincipal:
      overrides.maxPendingPerPrincipal ??
      Math.min(
        DEFAULT_STORE_LIMITS.maxPendingPerPrincipal,
        overrides.maxMessagesPerPrincipal ?? DEFAULT_STORE_LIMITS.maxMessagesPerPrincipal,
      ),
    maxMessagesPerSourceSession:
      overrides.maxMessagesPerSourceSession ??
      Math.min(
        DEFAULT_STORE_LIMITS.maxMessagesPerSourceSession,
        Math.max(
          1,
          (overrides.maxMessagesPerPrincipal ?? DEFAULT_STORE_LIMITS.maxMessagesPerPrincipal) - 1,
        ),
      ),
  };
  const positiveIntegers: readonly (keyof BrokerLimits)[] = [
    "maxActiveSessionsPerPrincipal",
    "maxSessionsPerPrincipal",
    "maxSessionsGlobal",
    "foregroundSessionReserve",
    "registrationsPerPrincipalPerMinute",
    "enqueuePerPrincipalPerMinute",
    "enqueuePerSessionPerMinute",
    "maxPendingPerPrincipal",
    "maxPendingPerSession",
    "maxMessagesPerSourceSession",
    "maxMessagesPerPrincipal",
    "maxMessagesGlobal",
    "eventReplayWindow",
    "sessionLeaseSeconds",
    "maintenanceBatchSize",
    "terminalMessageRetentionMs",
    "eventRetentionMs",
    "inactiveSessionRetentionMs",
    "rateRetentionMs",
  ];
  for (const key of positiveIntegers) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) {
      throw new TypeError("Broker limits must be positive integers.");
    }
  }
  if (limits.maxActiveSessionsPerPrincipal > MAX_ACTIVE_SESSIONS_PER_PRINCIPAL) {
    throw new TypeError("Active-session limit exceeds the protocol maximum.");
  }
  if (
    limits.maxSessionsPerPrincipal > BROKER_SESSION_LIMIT_POLICY.maxDurableSessionsPerPrincipal ||
    limits.maxSessionsGlobal > BROKER_SESSION_LIMIT_POLICY.maxDurableSessionsGlobal ||
    limits.foregroundSessionReserve > BROKER_SESSION_LIMIT_POLICY.maxForegroundSessionReserve ||
    limits.registrationsPerPrincipalPerMinute >
      BROKER_SESSION_LIMIT_POLICY.maxRegistrationsPerPrincipalPerMinute
  ) {
    throw new TypeError("Broker session quota exceeds its hard maximum.");
  }
  if (
    limits.maxActiveSessionsPerPrincipal > limits.maxSessionsPerPrincipal ||
    limits.foregroundSessionReserve >= limits.maxSessionsPerPrincipal ||
    limits.maxSessionsPerPrincipal > limits.maxSessionsGlobal ||
    limits.maxPendingPerPrincipal > limits.maxMessagesPerPrincipal ||
    limits.maxMessagesPerSourceSession > limits.maxMessagesPerPrincipal ||
    (limits.maxMessagesPerPrincipal > 1 &&
      limits.maxMessagesPerSourceSession >= limits.maxMessagesPerPrincipal) ||
    limits.maxMessagesPerPrincipal > limits.maxMessagesGlobal
  ) {
    throw new TypeError("Broker logical quotas are inconsistent.");
  }
  if (limits.eventReplayWindow > MAX_EVENT_REPLAY_WINDOW) {
    throw new TypeError("Event replay window exceeds the protocol maximum.");
  }
  if (
    limits.sessionLeaseSeconds < MIN_SESSION_LEASE_SECONDS ||
    limits.sessionLeaseSeconds > MAX_SESSION_LEASE_SECONDS
  ) {
    throw new TypeError("Session lease is outside the protocol range.");
  }
  if (limits.rateRetentionMs < 60_000) {
    throw new TypeError("Rate retention must cover the full rate-limit window.");
  }
  return limits;
}

function principalFromCredential(credential: CredentialFile): AuthenticatedClientPrincipal {
  return {
    principalId: PrincipalIdSchema.parse(credential.principalId),
    serverId: ServerIdSchema.parse(credential.serverId),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRequestId(candidate: unknown): string | undefined {
  if (!isRecord(candidate)) return undefined;
  const parsed = RequestIdSchema.safeParse(candidate.requestId);
  return parsed.success ? parsed.data : undefined;
}

function asMethod(candidate: unknown): Method | undefined {
  return typeof candidate === "string" && methodValues.has(candidate)
    ? (candidate as Method)
    : undefined;
}

function genericSuccess(requestId: string, result: unknown): ApplicationResponseEnvelope {
  return ApplicationResponseEnvelopeSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    ok: true,
    result,
  });
}

function foregroundSuccess(
  requestId: string,
  result: unknown,
  foregroundRecovery: unknown,
): ApplicationResponseEnvelope {
  return ApplicationResponseEnvelopeSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    ok: true,
    result,
    foregroundRecovery,
  });
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export class BrokerService {
  readonly brokerId;
  readonly limits: BrokerLimits;
  private credential: CredentialFile;
  private readonly store: BrokerStore;
  private readonly listeners = new Set<(event: PendingMessageEvent) => void>();
  private closed = false;

  private constructor(
    private readonly credentialFilePath: string,
    private readonly clock: Clock,
    private readonly random: RandomSource,
    limits: BrokerLimits,
    credential: CredentialFile,
    statementObserver: ((sql: string) => void) | undefined,
    private readonly logger: BrokerLogger,
    databasePath: string,
  ) {
    this.limits = limits;
    this.credential = credential;
    this.store = new BrokerStore(databasePath, clock, random, limits, statementObserver);
    this.brokerId = this.store.brokerId;
    this.store.ensurePrincipal(this.principal);
    this.store.maintenance();
  }

  static open(options: BrokerServiceOptions): BrokerService {
    const clock = options.clock ?? systemClock;
    const random = options.random ?? systemRandom;
    const credential = loadOrCreateCredential(options.credentialFilePath, random);
    return new BrokerService(
      options.credentialFilePath,
      clock,
      random,
      resolveBrokerLimits(options.limits),
      credential,
      options.statementObserver,
      options.logger ?? silentLogger,
      options.databasePath,
    );
  }

  get principal(): AuthenticatedClientPrincipal {
    return principalFromCredential(this.credential);
  }

  authenticate(authorization: string | null): AuthenticatedClientPrincipal | undefined {
    if (!authorization?.startsWith("Bearer ")) return undefined;
    const supplied = authorization.slice("Bearer ".length);
    if (supplied.length === 0 || supplied.includes(" ")) return undefined;
    const expectedHash = hashToken(this.credential.token);
    const suppliedHash = hashToken(supplied);
    return constantTimeEqual(expectedHash, suppliedHash) ? this.principal : undefined;
  }

  createAuthChallenge(clientNonceCandidate: string): AuthChallengeResponse {
    const clientNonce = AuthChallengeNonceSchema.parse(clientNonceCandidate);
    const serverNonce = generateAuthChallengeNonce();
    const proofInput = {
      protocolVersion: PROTOCOL_VERSION,
      brokerId: this.brokerId,
      serverId: this.credential.serverId,
      clientNonce,
      serverNonce,
    } as const;
    return AuthChallengeResponseSchema.parse({
      ...proofInput,
      proof: createAuthChallengeProof(this.credential.token, proofInput),
    });
  }

  dispatch(
    principal: AuthenticatedClientPrincipal,
    candidate: unknown,
  ): ApplicationResponseEnvelope {
    const requestId = safeRequestId(candidate);
    if (!requestId) {
      throw new BrokerOperationError("INVALID_REQUEST");
    }
    if (!principalsEqual(principal, this.principal)) {
      return createErrorEnvelope(requestId, "FORBIDDEN");
    }
    try {
      this.store.maintenance();
    } catch {
      this.logger.error("Broker maintenance failed.");
      return createErrorEnvelope(requestId, "INTERNAL_ERROR");
    }
    if (!isRecord(candidate)) return createErrorEnvelope(requestId, "INVALID_REQUEST");
    const method = asMethod(candidate.method);
    if (!method) return createErrorEnvelope(requestId, "INVALID_REQUEST");

    const earlyError = this.classifyRequestError(method, candidate);
    if (earlyError) return createErrorEnvelope(requestId, earlyError);
    const parsed = requestSchemas[method].safeParse(candidate);
    if (!parsed.success) return createErrorEnvelope(requestId, "INVALID_REQUEST");

    try {
      return this.execute(principal, parsed.data as ApplicationOperationRequest);
    } catch (error) {
      if (error instanceof BrokerOperationError) {
        return createErrorEnvelope(requestId, error.code, error.details);
      }
      this.logger.error("Broker operation failed.");
      return createErrorEnvelope(requestId, "INTERNAL_ERROR");
    }
  }

  replayEvents(principal: AuthenticatedClientPrincipal, cursor?: string): EventReplayResult {
    const correlationId = this.generatedRequestId();
    if (!principalsEqual(principal, this.principal) || !this.store.hasPrincipal(principal)) {
      return { ok: false, error: createErrorEnvelope(correlationId, "FORBIDDEN") };
    }
    if (cursor !== undefined && !/^(0|[1-9][0-9]{0,19})$/.test(cursor)) {
      return { ok: false, error: createErrorEnvelope(correlationId, "EVENT_CURSOR_EXPIRED") };
    }
    try {
      this.store.maintenance();
      return { ok: true, ...this.store.replayEvents(principal, cursor) };
    } catch (error) {
      if (error instanceof BrokerOperationError) {
        return { ok: false, error: createErrorEnvelope(correlationId, error.code, error.details) };
      }
      this.logger.error("Broker event replay failed.");
      return { ok: false, error: createErrorEnvelope(correlationId, "INTERNAL_ERROR") };
    }
  }

  retainedEventsForTesting(
    principal: AuthenticatedClientPrincipal,
  ): readonly PendingMessageEvent[] {
    if (!principalsEqual(principal, this.principal)) throw new BrokerOperationError("FORBIDDEN");
    return this.store.retainedEvents(principal);
  }

  subscribeEvents(
    principal: AuthenticatedClientPrincipal,
    listener: (event: PendingMessageEvent) => void,
  ): () => void {
    if (!principalsEqual(principal, this.principal)) throw new BrokerOperationError("FORBIDDEN");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  rotateCredential(): CredentialFile {
    const replacement = rotateCredentialFile(this.credentialFilePath, this.random);
    this.credential = replacement;
    this.store.ensurePrincipal(this.principal);
    return replacement;
  }

  maintenance(): MaintenanceResult {
    return this.store.maintenance();
  }

  storageStatsForTesting(): StorageStats {
    return this.store.storageStats();
  }

  schemaVersionForTesting(): number {
    return this.store.schemaVersion();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.store.close();
  }

  private classifyRequestError(
    method: Method,
    candidate: Record<string, unknown>,
  ): ErrorCode | undefined {
    if (candidate.protocolVersion !== PROTOCOL_VERSION) return "INVALID_REQUEST";
    if (
      (method !== METHODS.ENQUEUE_MESSAGE && method !== METHODS.REPLY_MESSAGE) ||
      !isRecord(candidate.params)
    ) {
      return undefined;
    }
    const body = candidate.params.body;
    if (typeof body === "string") {
      if (!isWellFormedUnicode(body)) return "INVALID_REQUEST";
      if (utf8Bytes(body) > MAX_MESSAGE_BYTES) return "MESSAGE_TOO_LARGE";
    }
    const ttl = candidate.params.ttlSeconds;
    if (
      ttl !== undefined &&
      (typeof ttl !== "number" ||
        !Number.isInteger(ttl) ||
        ttl < MIN_MESSAGE_TTL_SECONDS ||
        ttl > MAX_MESSAGE_TTL_SECONDS)
    ) {
      return "TTL_OUT_OF_RANGE";
    }
    return undefined;
  }

  private execute(
    principal: AuthenticatedClientPrincipal,
    request: ApplicationOperationRequest,
  ): ApplicationResponseEnvelope {
    switch (request.method) {
      case METHODS.HANDSHAKE:
        return negotiateProtocolVersion(request, this.brokerId, principal);
      case METHODS.REGISTER_SESSION:
        return genericSuccess(
          request.requestId,
          this.store.register(principal, request.params.hostSessionId, request.params.metadata),
        );
      case METHODS.RESOLVE_FOREGROUND_SESSION:
        return genericSuccess(
          request.requestId,
          this.store.resolveForegroundIdentity(principal, request.params),
        );
      case METHODS.HEARTBEAT_SESSION:
        return genericSuccess(
          request.requestId,
          this.store.heartbeat(principal, request.params.session),
        );
      case METHODS.DEREGISTER_SESSION:
        return genericSuccess(
          request.requestId,
          this.store.deregister(principal, request.params.session),
        );
      case METHODS.ENQUEUE_MESSAGE: {
        const stored = this.store.enqueue(
          principal,
          request.params.source,
          request.params.target,
          request.params.body,
          request.params.ttlSeconds,
          request.requestId,
          request.params.foreground,
        );
        this.publishPendingEvent(stored.event);
        return stored.foregroundRecovery
          ? foregroundSuccess(request.requestId, stored.receipt, stored.foregroundRecovery)
          : genericSuccess(request.requestId, stored.receipt);
      }
      case METHODS.REPLY_MESSAGE: {
        const stored = this.store.reply(
          principal,
          request.params.source,
          request.params.messageId,
          request.params.body,
          request.params.ttlSeconds,
          request.requestId,
          request.params.foreground,
        );
        this.publishPendingEvent(stored.event);
        return stored.foregroundRecovery
          ? foregroundSuccess(request.requestId, stored.receipt, stored.foregroundRecovery)
          : genericSuccess(request.requestId, stored.receipt);
      }
      case METHODS.PEEK_NEXT_MESSAGE:
        return genericSuccess(request.requestId, {
          header: this.store.peek(principal, request.params.target, request.params.foreground),
        });
      case METHODS.LIST_PENDING_MESSAGES:
        return genericSuccess(
          request.requestId,
          this.store.listPending(
            principal,
            request.params.target,
            request.params.limit,
            request.params.foreground,
          ),
        );
      case METHODS.CONSUME_MESSAGE:
        return genericSuccess(
          request.requestId,
          this.store.consume(
            principal,
            request.params.target,
            request.params.messageId,
            request.params.expectedBodyHash,
            request.params.foreground,
          ),
        );
      case METHODS.REJECT_MESSAGE:
        return genericSuccess(
          request.requestId,
          this.store.reject(
            principal,
            request.params.target,
            request.params.messageId,
            request.params.expectedBodyHash,
            request.params.foreground,
          ),
        );
      case METHODS.SEARCH_SESSIONS: {
        const stored = this.store.search(
          principal,
          request.params.requester,
          request.params.query,
          request.params.limit,
          request.params.foreground,
        );
        return stored.foregroundRecovery
          ? foregroundSuccess(request.requestId, stored.result, stored.foregroundRecovery)
          : genericSuccess(request.requestId, stored.result);
      }
    }
  }

  private publishPendingEvent(event: PendingMessageEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        this.logger.warn("Broker event subscriber failed.");
      }
    }
  }

  private generatedRequestId(): string {
    return RequestIdSchema.parse(Buffer.from(this.random.bytes(16)).toString("hex"));
  }
}

export const DEFAULT_BROKER_LIMITS: BrokerLimits = Object.freeze({
  ...DEFAULT_STORE_LIMITS,
  sessionLeaseSeconds: DEFAULT_SESSION_LEASE_SECONDS,
});
