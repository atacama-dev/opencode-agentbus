import { createHash } from "node:crypto";

import { z } from "zod";

import {
  BODY_HASH_PATTERN,
  DEFAULT_SESSION_LEASE_SECONDS,
  ERROR_CODES,
  ERROR_MESSAGES,
  HASH_PATTERN,
  MAX_ERROR_MESSAGE_BYTES,
  MAX_ID_BYTES,
  MAX_LABEL_BYTES,
  MAX_LABELS,
  MAX_MESSAGE_BYTES,
  MAX_METADATA_BYTES,
  MAX_QUERY_BYTES,
  MAX_SEARCH_LIMIT,
  MAX_SESSION_LEASE_SECONDS,
  MAX_TITLE_BYTES,
  MESSAGE_STATES,
  MIN_ID_BYTES,
  MIN_RETRY_AFTER_MS,
  MAX_RETRY_AFTER_MS,
  MIN_SESSION_LEASE_SECONDS,
  SAFE_ID_PATTERN,
} from "./constants";
import { isWellFormedUnicode, utf8Bytes } from "./unicode";

const UNSAFE_TEXT_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

function boundedUtf8String(maxBytes: number, kind: string) {
  return z
    .string()
    .min(1)
    .refine(isWellFormedUnicode, `${kind} must be well-formed Unicode`)
    .refine(
      (value) => isWellFormedUnicode(value) && utf8Bytes(value) <= maxBytes,
      `${kind} exceeds ${maxBytes} UTF-8 bytes`,
    );
}

function safeDisplayString(maxBytes: number, kind: string) {
  return boundedUtf8String(maxBytes, kind)
    .refine((value) => value === value.trim(), `${kind} must not have surrounding whitespace`)
    .refine((value) => !UNSAFE_TEXT_PATTERN.test(value), `${kind} contains unsafe characters`);
}

const SafeOpaqueIdSchema = z
  .string()
  .min(MIN_ID_BYTES)
  .max(MAX_ID_BYTES)
  .regex(SAFE_ID_PATTERN, "ID must use only ASCII letters, digits, underscore, or hyphen");

export const BrokerIdSchema = SafeOpaqueIdSchema.brand<"BrokerId">();
export type BrokerId = z.infer<typeof BrokerIdSchema>;

export const ServerIdSchema = SafeOpaqueIdSchema.brand<"ServerId">();
export type ServerId = z.infer<typeof ServerIdSchema>;

export const SessionIdSchema = SafeOpaqueIdSchema.brand<"SessionId">();
export type SessionId = z.infer<typeof SessionIdSchema>;

export const HostSessionIdSchema = SafeOpaqueIdSchema.brand<"HostSessionId">();
export type HostSessionId = z.infer<typeof HostSessionIdSchema>;

export const MessageIdSchema = SafeOpaqueIdSchema.brand<"MessageId">();
export type MessageId = z.infer<typeof MessageIdSchema>;

export const RequestIdSchema = SafeOpaqueIdSchema.brand<"RequestId">();
export type RequestId = z.infer<typeof RequestIdSchema>;

export const EventIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/, "event ID must be a positive decimal sequence")
  .brand<"EventId">();
export type EventId = z.infer<typeof EventIdSchema>;

export const PrincipalIdSchema = SafeOpaqueIdSchema.brand<"PrincipalId">();
export type PrincipalId = z.infer<typeof PrincipalIdSchema>;

export const BrokerDaemonIdentitySchema = z
  .object({ brokerId: BrokerIdSchema })
  .strict()
  .readonly();
export type BrokerDaemonIdentity = z.infer<typeof BrokerDaemonIdentitySchema>;

export const BrokerServerIdentitySchema = z
  .object({
    brokerId: BrokerIdSchema,
    serverId: ServerIdSchema,
  })
  .strict()
  .readonly();
export type BrokerServerIdentity = z.infer<typeof BrokerServerIdentitySchema>;

export const SessionIdentitySchema = z
  .object({
    broker: BrokerServerIdentitySchema,
    sessionId: SessionIdSchema,
  })
  .strict()
  .readonly();
export type SessionIdentity = z.infer<typeof SessionIdentitySchema>;

export const AuthenticatedClientPrincipalSchema = z
  .object({
    principalId: PrincipalIdSchema,
    serverId: ServerIdSchema,
  })
  .strict()
  .readonly();
export type AuthenticatedClientPrincipal = z.infer<typeof AuthenticatedClientPrincipalSchema>;

export const PrincipalSessionBindingSchema = z
  .object({
    ownerPrincipalId: PrincipalIdSchema,
    hostSessionId: HostSessionIdSchema,
    identity: SessionIdentitySchema,
  })
  .strict()
  .readonly();
export type PrincipalSessionBinding = z.infer<typeof PrincipalSessionBindingSchema>;

const TitleSchema = safeDisplayString(MAX_TITLE_BYTES, "title");
const LabelSchema = safeDisplayString(MAX_LABEL_BYTES, "label");

export const SessionMetadataSchema = z
  .object({
    title: TitleSchema.optional(),
    labels: z.array(LabelSchema).max(MAX_LABELS).readonly().optional(),
  })
  .strict()
  .superRefine((metadata, context) => {
    if (utf8Bytes(JSON.stringify(metadata)) > MAX_METADATA_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `metadata exceeds ${MAX_METADATA_BYTES} UTF-8 bytes`,
      });
    }
  })
  .readonly();
export type SessionMetadata = z.infer<typeof SessionMetadataSchema>;

export const BodyHashSchema = z.string().regex(BODY_HASH_PATTERN).brand<"BodyHash">();
export type BodyHash = z.infer<typeof BodyHashSchema>;

export const SessionFingerprintSchema = z
  .string()
  .regex(HASH_PATTERN)
  .brand<"SessionFingerprint">();
export type SessionFingerprint = z.infer<typeof SessionFingerprintSchema>;

export const ScopeFingerprintSchema = z.string().regex(HASH_PATTERN).brand<"ScopeFingerprint">();
export type ScopeFingerprint = z.infer<typeof ScopeFingerprintSchema>;

export const SearchQueryHashSchema = z.string().regex(HASH_PATTERN).brand<"SearchQueryHash">();
export type SearchQueryHash = z.infer<typeof SearchQueryHashSchema>;

export function canonicalizeSearchQueryUnchecked(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export const CanonicalSearchQuerySchema = z
  .string()
  .refine(isWellFormedUnicode, "canonical query must be well-formed Unicode")
  .refine((value) => value === canonicalizeSearchQueryUnchecked(value), "query is not canonical")
  .refine((value) => value.length > 0, "canonical query must not be empty")
  .refine((value) => !UNSAFE_TEXT_PATTERN.test(value), "canonical query contains unsafe characters")
  .refine(
    (value) => isWellFormedUnicode(value) && utf8Bytes(value) <= MAX_QUERY_BYTES,
    `canonical query exceeds ${MAX_QUERY_BYTES} UTF-8 bytes`,
  )
  .brand<"CanonicalSearchQuery">();
export type CanonicalSearchQuery = z.infer<typeof CanonicalSearchQuerySchema>;

export const MessageStateSchema = z.enum(MESSAGE_STATES);
export type MessageState = z.infer<typeof MessageStateSchema>;

export const MessageBodySchema = boundedUtf8String(MAX_MESSAGE_BYTES, "message body");
export const TimestampSchema = z.string().datetime({ offset: true });
export const BodyBytesSchema = z.number().int().min(1).max(MAX_MESSAGE_BYTES);
export const SessionLeaseSecondsSchema = z
  .number()
  .int()
  .min(MIN_SESSION_LEASE_SECONDS)
  .max(MAX_SESSION_LEASE_SECONDS)
  .default(DEFAULT_SESSION_LEASE_SECONDS);

function enforceSameBrokerScope(
  envelope: { source: SessionIdentity; target: SessionIdentity },
  context: z.RefinementCtx,
): void {
  if (
    envelope.source.broker.brokerId !== envelope.target.broker.brokerId ||
    envelope.source.broker.serverId !== envelope.target.broker.serverId
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target"],
      message: "source and target must belong to the same broker and server",
    });
  }
}

export const EnqueueMessageReceiptSchema = z
  .object({
    messageId: MessageIdSchema,
    state: z.literal("PENDING"),
    bodyHash: BodyHashSchema,
    bodyBytes: BodyBytesSchema,
    expiresAt: TimestampSchema,
  })
  .strict()
  .readonly();
export type EnqueueMessageReceipt = z.infer<typeof EnqueueMessageReceiptSchema>;

export const PendingMessageHeaderSchema = z
  .object({
    messageId: MessageIdSchema,
    source: SessionIdentitySchema,
    target: SessionIdentitySchema,
    bodyHash: BodyHashSchema,
    bodyBytes: BodyBytesSchema,
    state: z.literal("PENDING"),
    enqueuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict()
  .superRefine((header, context) => {
    enforceSameBrokerScope(header, context);
    if (Date.parse(header.expiresAt) <= Date.parse(header.enqueuedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "pending message expiry must be after enqueue time",
      });
    }
  })
  .readonly();
export type PendingMessageHeader = z.infer<typeof PendingMessageHeaderSchema>;

export const ReceivePermissionMetadataSchema = z
  .object({
    messageId: MessageIdSchema,
    targetFingerprint: SessionFingerprintSchema,
    sourceFingerprint: SessionFingerprintSchema,
    bodyHash: BodyHashSchema,
    bodyBytes: BodyBytesSchema,
  })
  .strict()
  .readonly();
export type ReceivePermissionMetadata = z.infer<typeof ReceivePermissionMetadataSchema>;

const ConsumedMessageShape = {
  messageId: MessageIdSchema,
  source: SessionIdentitySchema,
  target: SessionIdentitySchema,
  body: MessageBodySchema,
  bodyHash: BodyHashSchema,
  bodyBytes: BodyBytesSchema,
  state: z.literal("DELIVERED"),
  deliveredAt: TimestampSchema,
};

function enforceConsumedBodyIntegrity(
  message: {
    source: SessionIdentity;
    target: SessionIdentity;
    body: string;
    bodyHash: string;
    bodyBytes: number;
  },
  context: z.RefinementCtx,
): void {
  enforceSameBrokerScope(message, context);
  if (utf8Bytes(message.body) !== message.bodyBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["bodyBytes"],
      message: "bodyBytes does not match the UTF-8 body length",
    });
  }
  const actualHash = createHash("sha256").update(message.body, "utf8").digest("hex");
  if (actualHash !== message.bodyHash) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["bodyHash"],
      message: "bodyHash does not match the body",
    });
  }
}

export const ConsumedMessageResultSchema = z
  .object(ConsumedMessageShape)
  .strict()
  .superRefine(enforceConsumedBodyIntegrity)
  .readonly();
export type ConsumedMessageResult = z.infer<typeof ConsumedMessageResultSchema>;

export const PeerMessagePresentationSchema = z
  .object({
    ...ConsumedMessageShape,
    type: z.literal("peer_message"),
    trust: z.literal("untrusted"),
  })
  .strict()
  .superRefine(enforceConsumedBodyIntegrity)
  .readonly();
export type PeerMessagePresentation = z.infer<typeof PeerMessagePresentationSchema>;

export const ConsumedPeerMessageSchema = PeerMessagePresentationSchema;
export type ConsumedPeerMessage = PeerMessagePresentation;

export const RegistrationResultSchema = z
  .object({
    hostSessionId: HostSessionIdSchema,
    identity: SessionIdentitySchema,
    fingerprint: SessionFingerprintSchema,
    metadata: SessionMetadataSchema,
    registration: z.enum(["created", "refreshed"]),
    leaseSeconds: SessionLeaseSecondsSchema,
    leaseExpiresAt: TimestampSchema,
  })
  .strict()
  .readonly();
export type RegistrationResult = z.infer<typeof RegistrationResultSchema>;

export const SessionHeartbeatResultSchema = z
  .object({
    identity: SessionIdentitySchema,
    leaseSeconds: SessionLeaseSecondsSchema,
    leaseExpiresAt: TimestampSchema,
  })
  .strict()
  .readonly();
export type SessionHeartbeatResult = z.infer<typeof SessionHeartbeatResultSchema>;

export const DeregisterSessionResultSchema = z
  .object({
    identity: SessionIdentitySchema,
    disposition: z.enum(["deregistered", "already_absent"]),
  })
  .strict()
  .readonly();
export type DeregisterSessionResult = z.infer<typeof DeregisterSessionResultSchema>;

export const RejectMessageResultSchema = z
  .object({
    messageId: MessageIdSchema,
    target: SessionIdentitySchema,
    bodyHash: BodyHashSchema,
    state: z.literal("REJECTED"),
    disposition: z.enum(["rejected", "already_rejected"]),
    rejectedAt: TimestampSchema,
  })
  .strict()
  .readonly();
export type RejectMessageResult = z.infer<typeof RejectMessageResultSchema>;

export const RegistrySearchMatchSchema = z
  .object({
    session: SessionIdentitySchema,
    fingerprint: SessionFingerprintSchema,
    metadata: SessionMetadataSchema,
  })
  .strict()
  .readonly();
export type RegistrySearchMatch = z.infer<typeof RegistrySearchMatchSchema>;

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const SafeErrorDetailsSchema = z
  .object({
    retryAfterMs: z.number().int().min(MIN_RETRY_AFTER_MS).max(MAX_RETRY_AFTER_MS).optional(),
    currentState: MessageStateSchema.optional(),
  })
  .strict()
  .readonly();
export type SafeErrorDetails = z.infer<typeof SafeErrorDetailsSchema>;

const ErrorMessageSchema = safeDisplayString(MAX_ERROR_MESSAGE_BYTES, "error message");

export const ErrorEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: RequestIdSchema,
    ok: z.literal(false),
    error: z
      .object({
        code: ErrorCodeSchema,
        message: ErrorMessageSchema,
        details: SafeErrorDetailsSchema.optional(),
      })
      .strict()
      .superRefine((error, context) => {
        if (error.message !== ERROR_MESSAGES[error.code]) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["message"],
            message: "error message must be the canonical message for its code",
          });
        }
        if (error.details?.retryAfterMs !== undefined && error.code !== "RATE_LIMITED") {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["details", "retryAfterMs"],
            message: "retryAfterMs is allowed only for rate limiting",
          });
        }
      })
      .readonly(),
  })
  .strict()
  .readonly();
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
