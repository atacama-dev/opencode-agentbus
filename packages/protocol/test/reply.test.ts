import { describe, expect, test } from "bun:test";

import {
  AuthenticatedClientPrincipalSchema,
  AuthenticatedReplyOperationInputSchema,
  ConsumedMessageResultSchema,
  ERROR_MESSAGES,
  HTTP_STATUS_BY_ERROR_CODE,
  METHODS,
  MessageIdSchema,
  OPERATION_OWNERSHIP_CLAIMS,
  PROTOCOL_VERSION,
  PendingMessageEventSchema,
  PendingMessageHeaderSchema,
  PeerMessagePresentationSchema,
  PrincipalSessionBindingSchema,
  ReplyMessageReceiptSchema,
  ReplyMessageRequestSchema,
  ReplyMessageSuccessEnvelopeSchema,
  SessionIdentitySchema,
  bodySha256,
  createErrorEnvelope,
  mcpJsonRpcResponseMatchesRequest,
  toMcpJsonRpcRequest,
  toMcpJsonRpcSuccessResponse,
} from "../src/index";

const principal = AuthenticatedClientPrincipalSchema.parse({
  principalId: "principal_01",
  serverId: "server_01",
});

function session(sessionId: string) {
  return SessionIdentitySchema.parse({
    broker: { brokerId: "broker_01", serverId: principal.serverId },
    sessionId,
  });
}

const source = session("session_replying_recipient");
const originalSource = session("session_original_source");
const originalMessageId = MessageIdSchema.parse("message_original");
const body = "reply body";
const request = ReplyMessageRequestSchema.parse({
  protocolVersion: PROTOCOL_VERSION,
  requestId: "request_reply",
  method: METHODS.REPLY_MESSAGE,
  params: { source, messageId: originalMessageId, body, ttlSeconds: 60 },
});

function header(replyToMessageId?: typeof originalMessageId) {
  return {
    messageId: "message_reply",
    source,
    target: originalSource,
    bodyHash: bodySha256(body),
    bodyBytes: Buffer.byteLength(body, "utf8"),
    state: "PENDING" as const,
    enqueuedAt: "2026-08-20T10:00:00.000Z",
    expiresAt: "2026-08-20T11:00:00.000Z",
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
  };
}

describe("reply protocol contract", () => {
  test("uses protocol version 2 for the authenticated source-owned reply method", () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(METHODS.REPLY_MESSAGE).toBe("agentbus.message.reply");
    expect(OPERATION_OWNERSHIP_CLAIMS[METHODS.REPLY_MESSAGE]).toBe("params.source");
    expect(request.params).toEqual({
      source,
      messageId: originalMessageId,
      body,
      ttlSeconds: 60,
    });
    expect(
      ReplyMessageRequestSchema.safeParse({
        ...request,
        params: { ...request.params, target: originalSource },
      }).success,
    ).toBe(false);

    const binding = PrincipalSessionBindingSchema.parse({
      ownerPrincipalId: principal.principalId,
      hostSessionId: "host_replying_recipient",
      identity: source,
    });
    expect(
      AuthenticatedReplyOperationInputSchema.safeParse({ principal, binding, request }).success,
    ).toBe(true);
    expect(
      AuthenticatedReplyOperationInputSchema.safeParse({
        principal,
        binding,
        request: {
          ...request,
          params: { ...request.params, source: session("session_forged") },
        },
      }).success,
    ).toBe(false);
  });

  test("uses the same strict body, UTF-8, size, and TTL validation as enqueue", () => {
    for (const params of [
      { ...request.params, body: "" },
      { ...request.params, body: "bad \ud800" },
      { ...request.params, ttlSeconds: 9 },
      { ...request.params, ttlSeconds: 86_401 },
      { ...request.params, messageId: "not an opaque id" },
    ]) {
      expect(ReplyMessageRequestSchema.safeParse({ ...request, params }).success).toBe(false);
    }
  });

  test("defines a strict body-free receipt that distinguishes parent and fresh message IDs", () => {
    const receipt = ReplyMessageReceiptSchema.parse({
      messageId: "message_fresh_reply",
      replyToMessageId: originalMessageId,
      state: "PENDING",
      bodyHash: bodySha256(body),
      bodyBytes: Buffer.byteLength(body, "utf8"),
      expiresAt: "2026-08-20T11:00:00.000Z",
    });
    expect(receipt.messageId).not.toBe(receipt.replyToMessageId);
    expect(Object.hasOwn(receipt, "body")).toBe(false);
    expect(ReplyMessageReceiptSchema.safeParse({ ...receipt, body }).success).toBe(false);
    expect(
      ReplyMessageReceiptSchema.safeParse({ ...receipt, replyToMessageId: null }).success,
    ).toBe(false);
  });

  test("carries optional linkage only for replies across pending, event, and delivered schemas", () => {
    const normal = PendingMessageHeaderSchema.parse(header());
    const reply = PendingMessageHeaderSchema.parse(header(originalMessageId));
    expect(Object.hasOwn(normal, "replyToMessageId")).toBe(false);
    expect(reply.replyToMessageId).toBe(originalMessageId);
    expect(
      PendingMessageHeaderSchema.safeParse({ ...header(), replyToMessageId: null }).success,
    ).toBe(false);
    expect(
      PendingMessageHeaderSchema.safeParse({ ...header(), replyToMessageId: "bad id" }).success,
    ).toBe(false);

    const event = PendingMessageEventSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      event: "agentbus.pending",
      eventId: "1",
      correlationId: request.requestId,
      target: originalSource,
      header: reply,
    });
    expect(event.header.replyToMessageId).toBe(originalMessageId);

    const { enqueuedAt: _enqueuedAt, expiresAt: _expiresAt, ...deliveredHeader } = reply;
    const delivered = PeerMessagePresentationSchema.parse({
      ...deliveredHeader,
      type: "peer_message",
      trust: "untrusted",
      body,
      state: "DELIVERED",
      deliveredAt: "2026-08-20T10:01:00.000Z",
    });
    expect(delivered.replyToMessageId).toBe(originalMessageId);
    const { replyToMessageId: _replyToMessageId, ...normalDelivered } = delivered;
    expect(
      Object.hasOwn(PeerMessagePresentationSchema.parse(normalDelivered), "replyToMessageId"),
    ).toBe(false);

    const selfLinkedHeader = {
      ...header(originalMessageId),
      messageId: originalMessageId,
    };
    expect(PendingMessageHeaderSchema.safeParse(selfLinkedHeader).success).toBe(false);
    expect(
      PendingMessageEventSchema.safeParse({
        ...event,
        header: selfLinkedHeader,
      }).success,
    ).toBe(false);
    const selfLinkedDelivered = {
      ...delivered,
      messageId: originalMessageId,
      replyToMessageId: originalMessageId,
    };
    expect(PeerMessagePresentationSchema.safeParse(selfLinkedDelivered).success).toBe(false);
    const { type: _type, trust: _trust, ...consumed } = selfLinkedDelivered;
    expect(ConsumedMessageResultSchema.safeParse(consumed).success).toBe(false);
  });

  test("correlates reply requests and responses through the custom MCP mapping", () => {
    const response = ReplyMessageSuccessEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      result: {
        messageId: "message_fresh_reply",
        replyToMessageId: originalMessageId,
        state: "PENDING",
        bodyHash: bodySha256(body),
        bodyBytes: Buffer.byteLength(body, "utf8"),
        expiresAt: "2026-08-20T11:00:00.000Z",
      },
    });
    const wireRequest = toMcpJsonRpcRequest(request);
    const wireResponse = toMcpJsonRpcSuccessResponse(request, response);
    expect(wireRequest.method).toBe(METHODS.REPLY_MESSAGE);
    expect(mcpJsonRpcResponseMatchesRequest(request, wireResponse)).toBe(true);
    expect(
      mcpJsonRpcResponseMatchesRequest(request, {
        ...wireResponse,
        result: { ...response, requestId: "request_other" },
      }),
    ).toBe(false);
  });

  test("provides one canonical non-sensitive conflict for owned non-delivered originals", () => {
    expect(ERROR_MESSAGES.MESSAGE_NOT_REPLYABLE).toBe("The message cannot be replied to.");
    expect(HTTP_STATUS_BY_ERROR_CODE.MESSAGE_NOT_REPLYABLE).toBe(409);
    expect(createErrorEnvelope("request_reply_error", "MESSAGE_NOT_REPLYABLE")).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "request_reply_error",
      ok: false,
      error: {
        code: "MESSAGE_NOT_REPLYABLE",
        message: "The message cannot be replied to.",
      },
    });
  });
});
