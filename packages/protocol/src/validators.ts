import {
  MAX_SESSION_LEASE_SECONDS,
  MIN_SESSION_LEASE_SECONDS,
  PROTOCOL_VERSION,
} from "./constants";
import { hashNormalizedSearchQuery, sessionFingerprint } from "./crypto";
import { PeerMessagePresentationSchema, RegistrationResultSchema } from "./schemas";
import type {
  ConsumedMessageResult,
  PeerMessagePresentation,
  PendingMessageHeader,
  PrincipalSessionBinding,
  SessionIdentity,
} from "./schemas";
import type {
  AuthenticatedRegisterOperationInput,
  ConsumeMessageRequest,
  ListPendingMessagesRequest,
  ListPendingMessagesResult,
  PendingMessageEvent,
  RejectMessageRequest,
  SearchSessionsRequest,
  SearchSessionsResult,
} from "./transport";

export function sameSessionIdentity(left: SessionIdentity, right: SessionIdentity): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.broker.brokerId === right.broker.brokerId &&
    left.broker.serverId === right.broker.serverId
  );
}

export function comparePendingHeaders(
  left: PendingMessageHeader,
  right: PendingMessageHeader,
): number {
  const timeComparison = Date.parse(left.enqueuedAt) - Date.parse(right.enqueuedAt);
  return timeComparison !== 0 ? timeComparison : left.messageId.localeCompare(right.messageId);
}

export function isExpiredAt(expiresAt: string, now: string): boolean {
  const expirationTime = Date.parse(expiresAt);
  const currentTime = Date.parse(now);
  if (!Number.isFinite(expirationTime) || !Number.isFinite(currentTime)) {
    throw new TypeError("Expiry comparison requires valid ISO timestamps.");
  }
  return currentTime >= expirationTime;
}

export function consumeRequestMatchesHeader(
  header: PendingMessageHeader,
  request: ConsumeMessageRequest,
): boolean {
  return (
    request.protocolVersion === PROTOCOL_VERSION &&
    request.params.messageId === header.messageId &&
    sameSessionIdentity(request.params.target, header.target) &&
    request.params.expectedBodyHash === header.bodyHash
  );
}

export function rejectRequestMatchesHeader(
  header: PendingMessageHeader,
  request: RejectMessageRequest,
): boolean {
  return (
    request.protocolVersion === PROTOCOL_VERSION &&
    request.params.messageId === header.messageId &&
    sameSessionIdentity(request.params.target, header.target) &&
    request.params.expectedBodyHash === header.bodyHash
  );
}

export function consumedResultMatchesHeader(
  header: PendingMessageHeader,
  result: ConsumedMessageResult,
): boolean {
  return (
    result.messageId === header.messageId &&
    sameSessionIdentity(result.source, header.source) &&
    sameSessionIdentity(result.target, header.target) &&
    result.bodyHash === header.bodyHash &&
    result.bodyBytes === header.bodyBytes
  );
}

export function toPeerMessagePresentation(result: ConsumedMessageResult): PeerMessagePresentation {
  return PeerMessagePresentationSchema.parse({
    ...result,
    type: "peer_message",
    trust: "untrusted",
  });
}

export function pendingEventMatchesTargetBinding(
  event: PendingMessageEvent,
  binding: PrincipalSessionBinding,
): boolean {
  return (
    sameSessionIdentity(event.target, binding.identity) &&
    sameSessionIdentity(event.header.target, binding.identity)
  );
}

export function registrationResultMatchesInput(
  input: AuthenticatedRegisterOperationInput,
  candidate: unknown,
  previous?: unknown,
): boolean {
  const parsed = RegistrationResultSchema.safeParse(candidate);
  if (!parsed.success) return false;
  const result = parsed.data;
  const request = input.request.params;
  if (
    result.hostSessionId !== request.hostSessionId ||
    result.identity.broker.brokerId !== input.daemon.brokerId ||
    result.identity.broker.serverId !== input.principal.serverId ||
    result.fingerprint !== sessionFingerprint(result.identity) ||
    result.leaseSeconds < MIN_SESSION_LEASE_SECONDS ||
    result.leaseSeconds > MAX_SESSION_LEASE_SECONDS ||
    JSON.stringify(result.metadata) !== JSON.stringify(request.metadata)
  ) {
    return false;
  }
  if (previous === undefined) return true;
  const parsedPrevious = RegistrationResultSchema.safeParse(previous);
  return (
    parsedPrevious.success && sameSessionIdentity(parsedPrevious.data.identity, result.identity)
  );
}

export function listPendingResultMatchesRequest(
  request: ListPendingMessagesRequest,
  result: ListPendingMessagesResult,
): boolean {
  return (
    sameSessionIdentity(request.params.target, result.target) &&
    request.params.limit === result.requestedLimit &&
    result.headers.length <= request.params.limit &&
    result.headers.every((header) => sameSessionIdentity(header.target, request.params.target)) &&
    result.headers.every((header, index) => {
      const previous = result.headers[index - 1];
      return previous === undefined || comparePendingHeaders(previous, header) < 0;
    })
  );
}

export function searchResultMatchesRequest(
  request: SearchSessionsRequest,
  result: SearchSessionsResult,
): boolean {
  if (
    result.scope.brokerId !== request.params.scope.brokerId ||
    result.scope.serverId !== request.params.scope.serverId ||
    result.queryHash !== hashNormalizedSearchQuery(request.params.query) ||
    result.requestedLimit !== request.params.limit ||
    result.matches.length > request.params.limit
  ) {
    return false;
  }
  return result.matches.every(
    (match) =>
      match.fingerprint === sessionFingerprint(match.session) &&
      match.session.broker.brokerId === request.params.scope.brokerId &&
      match.session.broker.serverId === request.params.scope.serverId,
  );
}

export function responseCorrelatesToRequest(
  request: { protocolVersion?: number; requestId: string },
  response: { protocolVersion: number; requestId: string },
): boolean {
  return (
    response.protocolVersion === PROTOCOL_VERSION &&
    response.requestId === request.requestId &&
    (request.protocolVersion === undefined || request.protocolVersion === response.protocolVersion)
  );
}
