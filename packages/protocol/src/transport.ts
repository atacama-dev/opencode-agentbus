import { z } from "zod";

import {
  DEFAULT_MESSAGE_TTL_SECONDS,
  DEFAULT_PENDING_LIST_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  ERROR_MESSAGES,
  MAX_MESSAGE_TTL_SECONDS,
  MAX_PENDING_LIST_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_SUPPORTED_PROTOCOL_VERSIONS,
  METHODS,
  MIN_MESSAGE_TTL_SECONDS,
  MIN_SEARCH_LIMIT,
  PENDING_MESSAGE_EVENT_TYPE,
  PROTOCOL_VERSION,
  TRANSPORT_CONTRACT,
} from "./constants";
import type { ErrorCode } from "./constants";
import { sessionFingerprint } from "./crypto";
import {
  AuthenticatedClientPrincipalSchema,
  BodyHashSchema,
  BrokerDaemonIdentitySchema,
  BrokerIdSchema,
  BrokerServerIdentitySchema,
  CanonicalSearchQuerySchema,
  ConsumedMessageResultSchema,
  DeregisterSessionResultSchema,
  EnqueueMessageReceiptSchema,
  ErrorEnvelopeSchema,
  EventIdSchema,
  HostSessionIdSchema,
  MessageBodySchema,
  MessageIdSchema,
  PendingMessageHeaderSchema,
  PrincipalSessionBindingSchema,
  RegistrationResultSchema,
  RegistrySearchMatchSchema,
  RejectMessageResultSchema,
  RequestIdSchema,
  SafeErrorDetailsSchema,
  SearchQueryHashSchema,
  SessionHeartbeatResultSchema,
  SessionIdentitySchema,
  SessionMetadataSchema,
} from "./schemas";
import type {
  AuthenticatedClientPrincipal,
  ErrorEnvelope,
  PrincipalSessionBinding,
  SafeErrorDetails,
  SessionIdentity,
} from "./schemas";

function versionedRequestSchema<MethodName extends string, Params extends z.ZodTypeAny>(
  method: MethodName,
  params: Params,
) {
  return z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      requestId: RequestIdSchema,
      method: z.literal(method),
      params,
    })
    .strict()
    .readonly();
}

function successEnvelopeSchema<Result extends z.ZodTypeAny>(result: Result) {
  return z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      requestId: RequestIdSchema,
      ok: z.literal(true),
      result,
    })
    .strict()
    .readonly();
}

export const HandshakeRequestSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: RequestIdSchema,
    method: z.literal(METHODS.HANDSHAKE),
    params: z
      .object({
        supportedProtocolVersions: z
          .array(z.number().int().positive())
          .min(1)
          .max(MAX_SUPPORTED_PROTOCOL_VERSIONS)
          .readonly(),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();
export type HandshakeRequest = z.infer<typeof HandshakeRequestSchema>;

export const HandshakeResultSchema = z
  .object({
    selectedProtocolVersion: z.literal(PROTOCOL_VERSION),
    broker: BrokerServerIdentitySchema,
    mcp: z
      .object({
        transport: z.literal(TRANSPORT_CONTRACT.mcp.transport),
        bind: z.literal(TRANSPORT_CONTRACT.mcp.bind),
        path: z.literal(TRANSPORT_CONTRACT.mcp.path),
        authentication: z.literal(TRANSPORT_CONTRACT.mcp.authentication),
        exposure: z.literal(TRANSPORT_CONTRACT.mcp.exposure),
      })
      .strict()
      .readonly(),
    events: z
      .object({
        transport: z.literal(TRANSPORT_CONTRACT.events.transport),
        bind: z.literal(TRANSPORT_CONTRACT.events.bind),
        path: z.literal(TRANSPORT_CONTRACT.events.path),
        authentication: z.literal(TRANSPORT_CONTRACT.events.authentication),
        content: z.literal(TRANSPORT_CONTRACT.events.content),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();
export type HandshakeResult = z.infer<typeof HandshakeResultSchema>;

export const HandshakeSuccessEnvelopeSchema = successEnvelopeSchema(HandshakeResultSchema);
export const HandshakeResponseSchema = z.union([
  HandshakeSuccessEnvelopeSchema,
  ErrorEnvelopeSchema,
]);
export type HandshakeResponse = z.infer<typeof HandshakeResponseSchema>;

const RegisterSessionParamsSchema = z
  .object({
    hostSessionId: HostSessionIdSchema,
    optIn: z.literal(true),
    metadata: SessionMetadataSchema,
  })
  .strict()
  .readonly();
export const RegisterSessionRequestSchema = versionedRequestSchema(
  METHODS.REGISTER_SESSION,
  RegisterSessionParamsSchema,
);
export type RegisterSessionRequest = z.infer<typeof RegisterSessionRequestSchema>;
export const RegisterSessionSuccessEnvelopeSchema = successEnvelopeSchema(RegistrationResultSchema);
export const RegisterSessionResponseSchema = z.union([
  RegisterSessionSuccessEnvelopeSchema,
  ErrorEnvelopeSchema,
]);
export type RegisterSessionResponse = z.infer<typeof RegisterSessionResponseSchema>;

const SessionClaimParamsSchema = z.object({ session: SessionIdentitySchema }).strict().readonly();

export const HeartbeatSessionRequestSchema = versionedRequestSchema(
  METHODS.HEARTBEAT_SESSION,
  SessionClaimParamsSchema,
);
export type HeartbeatSessionRequest = z.infer<typeof HeartbeatSessionRequestSchema>;
export const HeartbeatSessionSuccessEnvelopeSchema = successEnvelopeSchema(
  SessionHeartbeatResultSchema,
);
export const HeartbeatSessionResponseSchema = z.union([
  HeartbeatSessionSuccessEnvelopeSchema,
  ErrorEnvelopeSchema,
]);
export type HeartbeatSessionResponse = z.infer<typeof HeartbeatSessionResponseSchema>;

export const DeregisterSessionRequestSchema = versionedRequestSchema(
  METHODS.DEREGISTER_SESSION,
  SessionClaimParamsSchema,
);
export type DeregisterSessionRequest = z.infer<typeof DeregisterSessionRequestSchema>;
export const DeregisterSessionSuccessEnvelopeSchema = successEnvelopeSchema(
  DeregisterSessionResultSchema,
);
export const DeregisterSessionResponseSchema = z.union([
  DeregisterSessionSuccessEnvelopeSchema,
  ErrorEnvelopeSchema,
]);
export type DeregisterSessionResponse = z.infer<typeof DeregisterSessionResponseSchema>;

const EnqueueMessageParamsSchema = z
  .object({
    source: SessionIdentitySchema,
    target: SessionIdentitySchema,
    body: MessageBodySchema,
    ttlSeconds: z
      .number()
      .int()
      .min(MIN_MESSAGE_TTL_SECONDS)
      .max(MAX_MESSAGE_TTL_SECONDS)
      .default(DEFAULT_MESSAGE_TTL_SECONDS),
  })
  .strict()
  .superRefine((params, context) => {
    if (
      params.source.broker.brokerId !== params.target.broker.brokerId ||
      params.source.broker.serverId !== params.target.broker.serverId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: "source and target must belong to the same broker and server",
      });
    }
  })
  .readonly();

export const EnqueueMessageRequestSchema = versionedRequestSchema(
  METHODS.ENQUEUE_MESSAGE,
  EnqueueMessageParamsSchema,
);
export type EnqueueMessageRequest = z.infer<typeof EnqueueMessageRequestSchema>;
export const EnqueueMessageSuccessEnvelopeSchema = successEnvelopeSchema(
  EnqueueMessageReceiptSchema,
);
export const EnqueueMessageResponseSchema = z.union([
  EnqueueMessageSuccessEnvelopeSchema,
  ErrorEnvelopeSchema,
]);
export type EnqueueMessageResponse = z.infer<typeof EnqueueMessageResponseSchema>;

const TargetClaimParamsSchema = z.object({ target: SessionIdentitySchema }).strict().readonly();

export const PeekNextMessageRequestSchema = versionedRequestSchema(
  METHODS.PEEK_NEXT_MESSAGE,
  TargetClaimParamsSchema,
);
export type PeekNextMessageRequest = z.infer<typeof PeekNextMessageRequestSchema>;

export const PeekNextMessageResultSchema = z
  .object({ header: PendingMessageHeaderSchema.nullable() })
  .strict()
  .readonly();
export type PeekNextMessageResult = z.infer<typeof PeekNextMessageResultSchema>;
export const PeekNextMessageSuccessEnvelopeSchema = successEnvelopeSchema(
  PeekNextMessageResultSchema,
);
export const PeekNextMessageResponseSchema = z.union([
  PeekNextMessageSuccessEnvelopeSchema,
  ErrorEnvelopeSchema,
]);
export type PeekNextMessageResponse = z.infer<typeof PeekNextMessageResponseSchema>;

const ListPendingMessagesParamsSchema = z
  .object({
    target: SessionIdentitySchema,
    limit: z.number().int().min(1).max(MAX_PENDING_LIST_LIMIT).default(DEFAULT_PENDING_LIST_LIMIT),
  })
  .strict()
  .readonly();
export const ListPendingMessagesRequestSchema = versionedRequestSchema(
  METHODS.LIST_PENDING_MESSAGES,
  ListPendingMessagesParamsSchema,
);
export type ListPendingMessagesRequest = z.infer<typeof ListPendingMessagesRequestSchema>;

export const ListPendingMessagesResultSchema = z
  .object({
    target: SessionIdentitySchema,
    requestedLimit: z.number().int().min(1).max(MAX_PENDING_LIST_LIMIT),
    headers: z.array(PendingMessageHeaderSchema).max(MAX_PENDING_LIST_LIMIT).readonly(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.headers.length > result.requestedLimit) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["headers"],
        message: "pending result exceeds the requested limit",
      });
    }
    for (let index = 0; index < result.headers.length; index += 1) {
      const current = result.headers[index];
      if (!current) continue;
      if (!sameSession(current.target, result.target)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["headers", index, "target"],
          message: "pending header target does not match the result target",
        });
      }
      const previous = result.headers[index - 1];
      if (previous && compareHeaderOrder(previous, current) >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["headers", index],
          message: "pending headers must be unique and in canonical order",
        });
      }
    }
  })
  .readonly();
export type ListPendingMessagesResult = z.infer<typeof ListPendingMessagesResultSchema>;
export const ListPendingMessagesSuccessEnvelopeSchema = successEnvelopeSchema(
  ListPendingMessagesResultSchema,
);
export const ListPendingMessagesResponseSchema = z.union([
  ListPendingMessagesSuccessEnvelopeSchema,
  ErrorEnvelopeSchema,
]);
export type ListPendingMessagesResponse = z.infer<typeof ListPendingMessagesResponseSchema>;

const ExpectedMessageParamsSchema = z
  .object({
    messageId: MessageIdSchema,
    target: SessionIdentitySchema,
    expectedBodyHash: BodyHashSchema,
  })
  .strict()
  .readonly();

export const ConsumeMessageRequestSchema = versionedRequestSchema(
  METHODS.CONSUME_MESSAGE,
  ExpectedMessageParamsSchema,
);
export type ConsumeMessageRequest = z.infer<typeof ConsumeMessageRequestSchema>;
export const ConsumeMessageSuccessEnvelopeSchema = successEnvelopeSchema(
  ConsumedMessageResultSchema,
);
export const ConsumeMessageResponseSchema = z.union([
  ConsumeMessageSuccessEnvelopeSchema,
  ErrorEnvelopeSchema,
]);
export type ConsumeMessageResponse = z.infer<typeof ConsumeMessageResponseSchema>;

export const RejectMessageRequestSchema = versionedRequestSchema(
  METHODS.REJECT_MESSAGE,
  ExpectedMessageParamsSchema,
);
export type RejectMessageRequest = z.infer<typeof RejectMessageRequestSchema>;
export const RejectMessageSuccessEnvelopeSchema = successEnvelopeSchema(RejectMessageResultSchema);
export const RejectMessageResponseSchema = z.union([
  RejectMessageSuccessEnvelopeSchema,
  ErrorEnvelopeSchema,
]);
export type RejectMessageResponse = z.infer<typeof RejectMessageResponseSchema>;

const SearchSessionsParamsSchema = z
  .object({
    requester: SessionIdentitySchema,
    scope: BrokerServerIdentitySchema,
    query: CanonicalSearchQuerySchema,
    limit: z
      .number()
      .int()
      .min(MIN_SEARCH_LIMIT)
      .max(MAX_SEARCH_LIMIT)
      .default(DEFAULT_SEARCH_LIMIT),
  })
  .strict()
  .superRefine((params, context) => {
    if (
      params.requester.broker.brokerId !== params.scope.brokerId ||
      params.requester.broker.serverId !== params.scope.serverId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope"],
        message: "search scope must match the requester's broker and server",
      });
    }
  })
  .readonly();

export const SearchSessionsRequestSchema = versionedRequestSchema(
  METHODS.SEARCH_SESSIONS,
  SearchSessionsParamsSchema,
);
export type SearchSessionsRequest = z.infer<typeof SearchSessionsRequestSchema>;

export const SearchSessionsResultSchema = z
  .object({
    scope: BrokerServerIdentitySchema,
    queryHash: SearchQueryHashSchema,
    requestedLimit: z.number().int().min(MIN_SEARCH_LIMIT).max(MAX_SEARCH_LIMIT),
    matches: z.array(RegistrySearchMatchSchema).max(MAX_SEARCH_LIMIT).readonly(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.matches.length > result.requestedLimit) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["matches"],
        message: "search result exceeds the requested limit",
      });
    }
    result.matches.forEach((match, index) => {
      if (
        match.session.broker.brokerId !== result.scope.brokerId ||
        match.session.broker.serverId !== result.scope.serverId
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["matches", index, "session"],
          message: "search match is outside the requested registry scope",
        });
      }
      if (match.fingerprint !== sessionFingerprint(match.session)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["matches", index, "fingerprint"],
          message: "search match fingerprint does not match its session",
        });
      }
    });
  })
  .readonly();

export type SearchSessionsResult = z.infer<typeof SearchSessionsResultSchema>;
export const SearchSessionsSuccessEnvelopeSchema = successEnvelopeSchema(
  SearchSessionsResultSchema,
);
export const SearchSessionsResponseSchema = z.union([
  SearchSessionsSuccessEnvelopeSchema,
  ErrorEnvelopeSchema,
]);
export type SearchSessionsResponse = z.infer<typeof SearchSessionsResponseSchema>;

// Standard MCP initialize/initialized and MCP-Session-Id handling stay in the official SDK.
// Only post-initialization custom JSON-RPC requests use these application method mappings.
export const ApplicationOperationRequestSchema = z.union([
  HandshakeRequestSchema,
  RegisterSessionRequestSchema,
  HeartbeatSessionRequestSchema,
  DeregisterSessionRequestSchema,
  EnqueueMessageRequestSchema,
  PeekNextMessageRequestSchema,
  ListPendingMessagesRequestSchema,
  ConsumeMessageRequestSchema,
  RejectMessageRequestSchema,
  SearchSessionsRequestSchema,
]);
export type ApplicationOperationRequest = z.infer<typeof ApplicationOperationRequestSchema>;

export const ApplicationResponseEnvelopeSchema = z.union([
  HandshakeSuccessEnvelopeSchema,
  RegisterSessionSuccessEnvelopeSchema,
  HeartbeatSessionSuccessEnvelopeSchema,
  DeregisterSessionSuccessEnvelopeSchema,
  EnqueueMessageSuccessEnvelopeSchema,
  PeekNextMessageSuccessEnvelopeSchema,
  ListPendingMessagesSuccessEnvelopeSchema,
  ConsumeMessageSuccessEnvelopeSchema,
  RejectMessageSuccessEnvelopeSchema,
  SearchSessionsSuccessEnvelopeSchema,
  ErrorEnvelopeSchema,
]);
export type ApplicationResponseEnvelope = z.infer<typeof ApplicationResponseEnvelopeSchema>;

export const McpJsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: RequestIdSchema,
    method: z.enum(Object.values(METHODS) as [string, ...string[]]),
    params: ApplicationOperationRequestSchema,
  })
  .strict()
  .superRefine((wire, context) => {
    if (wire.id !== wire.params.requestId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["id"],
        message: "JSON-RPC id must equal the application requestId",
      });
    }
    if (wire.method !== wire.params.method) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["method"],
        message: "JSON-RPC method must equal the application envelope method",
      });
    }
  })
  .readonly();
export type McpJsonRpcRequest = z.infer<typeof McpJsonRpcRequestSchema>;

export const McpJsonRpcSuccessResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: RequestIdSchema,
    result: ApplicationResponseEnvelopeSchema,
  })
  .strict()
  .superRefine((wire, context) => {
    if (wire.id !== wire.result.requestId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["id"],
        message: "JSON-RPC id must equal the application response requestId",
      });
    }
  })
  .readonly();
export type McpJsonRpcSuccessResponse = z.infer<typeof McpJsonRpcSuccessResponseSchema>;

function responseSchemaForMethod(method: string): z.ZodTypeAny {
  switch (method) {
    case METHODS.HANDSHAKE:
      return HandshakeResponseSchema;
    case METHODS.REGISTER_SESSION:
      return RegisterSessionResponseSchema;
    case METHODS.HEARTBEAT_SESSION:
      return HeartbeatSessionResponseSchema;
    case METHODS.DEREGISTER_SESSION:
      return DeregisterSessionResponseSchema;
    case METHODS.ENQUEUE_MESSAGE:
      return EnqueueMessageResponseSchema;
    case METHODS.PEEK_NEXT_MESSAGE:
      return PeekNextMessageResponseSchema;
    case METHODS.LIST_PENDING_MESSAGES:
      return ListPendingMessagesResponseSchema;
    case METHODS.CONSUME_MESSAGE:
      return ConsumeMessageResponseSchema;
    case METHODS.REJECT_MESSAGE:
      return RejectMessageResponseSchema;
    case METHODS.SEARCH_SESSIONS:
      return SearchSessionsResponseSchema;
    default:
      throw new TypeError("Unavailable custom MCP method.");
  }
}

export function toMcpJsonRpcRequest(request: ApplicationOperationRequest): McpJsonRpcRequest {
  return McpJsonRpcRequestSchema.parse({
    jsonrpc: "2.0",
    id: request.requestId,
    method: request.method,
    params: request,
  });
}

export function mcpJsonRpcResponseMatchesRequest(
  request: ApplicationOperationRequest,
  candidate: unknown,
): candidate is McpJsonRpcSuccessResponse {
  const wire = McpJsonRpcSuccessResponseSchema.safeParse(candidate);
  return (
    wire.success &&
    wire.data.id === request.requestId &&
    wire.data.result.requestId === request.requestId &&
    responseSchemaForMethod(request.method).safeParse(wire.data.result).success
  );
}

export function toMcpJsonRpcSuccessResponse(
  request: ApplicationOperationRequest,
  response: ApplicationResponseEnvelope,
): McpJsonRpcSuccessResponse {
  const candidate = {
    jsonrpc: "2.0" as const,
    id: request.requestId,
    result: response,
  };
  if (!mcpJsonRpcResponseMatchesRequest(request, candidate)) {
    throw new TypeError("Application response does not correlate to the custom MCP request.");
  }
  return candidate;
}

export const PendingMessageEventSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    event: z.literal(PENDING_MESSAGE_EVENT_TYPE),
    eventId: EventIdSchema,
    correlationId: RequestIdSchema,
    target: SessionIdentitySchema,
    header: PendingMessageHeaderSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (!sameSession(event.target, event.header.target)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["header", "target"],
        message: "event target does not match pending header target",
      });
    }
  })
  .readonly();
export type PendingMessageEvent = z.infer<typeof PendingMessageEventSchema>;

function sameSession(left: SessionIdentity, right: SessionIdentity): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.broker.brokerId === right.broker.brokerId &&
    left.broker.serverId === right.broker.serverId
  );
}

function compareHeaderOrder(
  left: z.infer<typeof PendingMessageHeaderSchema>,
  right: z.infer<typeof PendingMessageHeaderSchema>,
): number {
  const time = Date.parse(left.enqueuedAt) - Date.parse(right.enqueuedAt);
  return time !== 0 ? time : left.messageId.localeCompare(right.messageId);
}

function enforcePrincipalBinding(
  principal: AuthenticatedClientPrincipal,
  binding: PrincipalSessionBinding,
  claim: SessionIdentity,
  context: z.RefinementCtx,
): void {
  if (
    principal.principalId !== binding.ownerPrincipalId ||
    principal.serverId !== binding.identity.broker.serverId ||
    !sameSession(binding.identity, claim)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "authenticated principal binding does not own the claimed session",
    });
  }
}

export const AuthenticatedHandshakeOperationInputSchema = z
  .object({
    principal: AuthenticatedClientPrincipalSchema,
    daemon: BrokerDaemonIdentitySchema,
    request: HandshakeRequestSchema,
  })
  .strict()
  .readonly();
export type AuthenticatedHandshakeOperationInput = z.infer<
  typeof AuthenticatedHandshakeOperationInputSchema
>;

export const AuthenticatedRegisterOperationInputSchema = z
  .object({
    principal: AuthenticatedClientPrincipalSchema,
    daemon: BrokerDaemonIdentitySchema,
    request: RegisterSessionRequestSchema,
  })
  .strict()
  .readonly();
export type AuthenticatedRegisterOperationInput = z.infer<
  typeof AuthenticatedRegisterOperationInputSchema
>;

export const AuthenticatedHeartbeatOperationInputSchema = z
  .object({
    principal: AuthenticatedClientPrincipalSchema,
    binding: PrincipalSessionBindingSchema,
    request: HeartbeatSessionRequestSchema,
  })
  .strict()
  .superRefine((input, context) =>
    enforcePrincipalBinding(input.principal, input.binding, input.request.params.session, context),
  )
  .readonly();
export type AuthenticatedHeartbeatOperationInput = z.infer<
  typeof AuthenticatedHeartbeatOperationInputSchema
>;

export const AuthenticatedDeregisterOperationInputSchema = z
  .object({
    principal: AuthenticatedClientPrincipalSchema,
    binding: PrincipalSessionBindingSchema,
    request: DeregisterSessionRequestSchema,
  })
  .strict()
  .superRefine((input, context) =>
    enforcePrincipalBinding(input.principal, input.binding, input.request.params.session, context),
  )
  .readonly();
export type AuthenticatedDeregisterOperationInput = z.infer<
  typeof AuthenticatedDeregisterOperationInputSchema
>;

export const AuthenticatedEnqueueOperationInputSchema = z
  .object({
    principal: AuthenticatedClientPrincipalSchema,
    binding: PrincipalSessionBindingSchema,
    request: EnqueueMessageRequestSchema,
  })
  .strict()
  .superRefine((input, context) =>
    enforcePrincipalBinding(input.principal, input.binding, input.request.params.source, context),
  )
  .readonly();
export type AuthenticatedEnqueueOperationInput = z.infer<
  typeof AuthenticatedEnqueueOperationInputSchema
>;

export const AuthenticatedPeekOperationInputSchema = z
  .object({
    principal: AuthenticatedClientPrincipalSchema,
    binding: PrincipalSessionBindingSchema,
    request: PeekNextMessageRequestSchema,
  })
  .strict()
  .superRefine((input, context) =>
    enforcePrincipalBinding(input.principal, input.binding, input.request.params.target, context),
  )
  .readonly();
export type AuthenticatedPeekOperationInput = z.infer<typeof AuthenticatedPeekOperationInputSchema>;

export const AuthenticatedListPendingOperationInputSchema = z
  .object({
    principal: AuthenticatedClientPrincipalSchema,
    binding: PrincipalSessionBindingSchema,
    request: ListPendingMessagesRequestSchema,
  })
  .strict()
  .superRefine((input, context) =>
    enforcePrincipalBinding(input.principal, input.binding, input.request.params.target, context),
  )
  .readonly();
export type AuthenticatedListPendingOperationInput = z.infer<
  typeof AuthenticatedListPendingOperationInputSchema
>;

export const AuthenticatedConsumeOperationInputSchema = z
  .object({
    principal: AuthenticatedClientPrincipalSchema,
    binding: PrincipalSessionBindingSchema,
    request: ConsumeMessageRequestSchema,
  })
  .strict()
  .superRefine((input, context) =>
    enforcePrincipalBinding(input.principal, input.binding, input.request.params.target, context),
  )
  .readonly();
export type AuthenticatedConsumeOperationInput = z.infer<
  typeof AuthenticatedConsumeOperationInputSchema
>;

export const AuthenticatedRejectOperationInputSchema = z
  .object({
    principal: AuthenticatedClientPrincipalSchema,
    binding: PrincipalSessionBindingSchema,
    request: RejectMessageRequestSchema,
  })
  .strict()
  .superRefine((input, context) =>
    enforcePrincipalBinding(input.principal, input.binding, input.request.params.target, context),
  )
  .readonly();
export type AuthenticatedRejectOperationInput = z.infer<
  typeof AuthenticatedRejectOperationInputSchema
>;

export const AuthenticatedSearchOperationInputSchema = z
  .object({
    principal: AuthenticatedClientPrincipalSchema,
    binding: PrincipalSessionBindingSchema,
    request: SearchSessionsRequestSchema,
  })
  .strict()
  .superRefine((input, context) =>
    enforcePrincipalBinding(
      input.principal,
      input.binding,
      input.request.params.requester,
      context,
    ),
  )
  .readonly();
export type AuthenticatedSearchOperationInput = z.infer<
  typeof AuthenticatedSearchOperationInputSchema
>;

export function createErrorEnvelope(
  requestId: string,
  code: ErrorCode,
  details?: SafeErrorDetails,
): ErrorEnvelope {
  const error =
    details === undefined
      ? { code, message: ERROR_MESSAGES[code] }
      : { code, message: ERROR_MESSAGES[code], details };
  return ErrorEnvelopeSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    ok: false,
    error,
  });
}

export class ProtocolTransportError extends Error {
  readonly code: ErrorCode;
  readonly details: SafeErrorDetails | undefined;

  constructor(code: ErrorCode, details?: SafeErrorDetails) {
    super(ERROR_MESSAGES[code]);
    this.name = "ProtocolTransportError";
    this.code = code;
    this.details = details;
  }
}

export function mapTransportError(error: unknown, requestId: string): ErrorEnvelope {
  if (error instanceof ProtocolTransportError) {
    return createErrorEnvelope(requestId, error.code, error.details);
  }
  return createErrorEnvelope(requestId, "INTERNAL_ERROR");
}

export function negotiateProtocolVersion(
  request: HandshakeRequest,
  brokerId: string,
  principal: AuthenticatedClientPrincipal,
): HandshakeResponse {
  if (!request.params.supportedProtocolVersions.includes(PROTOCOL_VERSION)) {
    return createErrorEnvelope(request.requestId, "UNSUPPORTED_PROTOCOL_VERSION");
  }
  return HandshakeSuccessEnvelopeSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    requestId: request.requestId,
    ok: true,
    result: {
      selectedProtocolVersion: PROTOCOL_VERSION,
      broker: { brokerId: BrokerIdSchema.parse(brokerId), serverId: principal.serverId },
      mcp: TRANSPORT_CONTRACT.mcp,
      events: TRANSPORT_CONTRACT.events,
    },
  });
}
