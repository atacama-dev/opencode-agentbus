import { describe, expect, test } from "bun:test";

import {
  BROKER_LIFECYCLE_CONTRACT,
  AuthenticatedClientPrincipalSchema,
  CREDENTIAL_FILE_MODE,
  CREDENTIAL_PROVISIONING_CONTRACT,
  CONNECTION_SECURITY_CONTRACT,
  CredentialFileSchema,
  DEFAULT_BROKER_ENDPOINT,
  EnqueueMessageRequestSchema,
  EnqueueMessageSuccessEnvelopeSchema,
  EVENT_STREAM_REPLAY_CONTRACT,
  EventStreamSubscriptionSchema,
  LoopbackBrokerEndpointSchema,
  MCP_CUSTOM_METHOD_CONTRACT,
  MCP_HTTP_CONTRACT,
  MCP_INITIALIZATION_CONTRACT,
  MCP_JSON_RPC_ERROR_USES,
  METHODS,
  McpJsonRpcRequestSchema,
  McpJsonRpcSuccessResponseSchema,
  PENDING_MESSAGE_EVENT_TYPE,
  PROTOCOL_VERSION,
  PendingMessageEventSchema,
  PrincipalSessionBindingSchema,
  SSE_HTTP_CONTRACT,
  SessionIdentitySchema,
  TOKEN_ROTATION_CONTRACT,
  TrustedConnectionConfigSchema,
  bodySha256,
  compareEventIds,
  createErrorEnvelope,
  eventsAfterCursor,
  formatPendingMessageSseEvent,
  formatSseComment,
  generateBearerToken,
  generateBrokerId,
  generatePrincipalId,
  mcpJsonRpcResponseMatchesRequest,
  pendingEventMatchesPrincipalBindings,
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

const source = session("session_source");
const target = session("session_target");
const request = EnqueueMessageRequestSchema.parse({
  protocolVersion: PROTOCOL_VERSION,
  requestId: "request_01",
  method: METHODS.ENQUEUE_MESSAGE,
  params: { source, target, body: "hello", ttlSeconds: 60 },
});

describe("exact MCP Streamable HTTP mapping", () => {
  test("freezes SDK initialization, content type, session, and custom-method semantics", () => {
    expect(MCP_INITIALIZATION_CONTRACT).toEqual({
      initializeRequestMethod: "initialize",
      initializedNotificationMethod: "notifications/initialized",
      sessionHeader: "MCP-Session-Id",
      sessionManagedBy: "@modelcontextprotocol/sdk@1.30.0",
    });
    expect(MCP_HTTP_CONTRACT).toEqual({
      method: "POST",
      path: "/mcp",
      contentType: "application/json",
      accept: "application/json, text/event-stream",
      authentication: "bearer_client_principal",
      redirects: "forbidden",
    });
    expect(MCP_JSON_RPC_ERROR_USES).toEqual([
      "authentication_failure",
      "malformed_json_rpc",
      "mcp_initialization_or_session_failure",
      "unavailable_method",
    ]);
    expect(MCP_CUSTOM_METHOD_CONTRACT).toEqual({
      kind: "custom_json_rpc_request_methods",
      mcpToolRegistration: "none",
      openCodeRawMcpExposure: "forbidden",
      caller: "plugin_programmatic_sdk_client_only",
    });
  });

  test("maps the full operation envelope into exact JSON-RPC id, method, and params", () => {
    const wire = toMcpJsonRpcRequest(request);
    expect(wire).toEqual({
      jsonrpc: "2.0",
      id: request.requestId,
      method: METHODS.ENQUEUE_MESSAGE,
      params: request,
    });
    expect(McpJsonRpcRequestSchema.safeParse(wire).success).toBe(true);
    expect(McpJsonRpcRequestSchema.safeParse({ ...wire, id: "request_other" }).success).toBe(false);
    expect(
      McpJsonRpcRequestSchema.safeParse({ ...wire, method: METHODS.CONSUME_MESSAGE }).success,
    ).toBe(false);
    expect(
      McpJsonRpcRequestSchema.safeParse({
        ...wire,
        params: { ...request, method: METHODS.CONSUME_MESSAGE },
      }).success,
    ).toBe(false);
    expect({
      url: `${DEFAULT_BROKER_ENDPOINT}${MCP_HTTP_CONTRACT.path}`,
      method: MCP_HTTP_CONTRACT.method,
      headers: {
        Accept: MCP_HTTP_CONTRACT.accept,
        "Content-Type": MCP_HTTP_CONTRACT.contentType,
        Authorization: "Bearer <out-of-band-credential>",
        "MCP-Session-Id": "<sdk-managed>",
      },
      body: wire,
    }).toEqual({
      url: "http://127.0.0.1:4097/mcp",
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Authorization: "Bearer <out-of-band-credential>",
        "MCP-Session-Id": "<sdk-managed>",
      },
      body: {
        jsonrpc: "2.0",
        id: request.requestId,
        method: "agentbus.message.enqueue",
        params: request,
      },
    });
  });

  test("carries application success and canonical errors inside JSON-RPC success result", () => {
    const applicationSuccess = EnqueueMessageSuccessEnvelopeSchema.parse({
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
      result: {
        messageId: "message_01",
        state: "PENDING",
        bodyHash: bodySha256("hello"),
        bodyBytes: 5,
        expiresAt: "2026-08-20T11:00:00.000Z",
      },
    });
    const successWire = toMcpJsonRpcSuccessResponse(request, applicationSuccess);
    expect(successWire).toEqual({
      jsonrpc: "2.0",
      id: request.requestId,
      result: applicationSuccess,
    });
    expect(McpJsonRpcSuccessResponseSchema.safeParse(successWire).success).toBe(true);
    expect(mcpJsonRpcResponseMatchesRequest(request, successWire)).toBe(true);
    expect({
      status: 200,
      headers: { "Content-Type": MCP_HTTP_CONTRACT.contentType },
      body: successWire,
    }).toEqual({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        jsonrpc: "2.0",
        id: request.requestId,
        result: applicationSuccess,
      },
    });

    const applicationError = createErrorEnvelope(request.requestId, "MESSAGE_TOO_LARGE");
    const errorWire = toMcpJsonRpcSuccessResponse(request, applicationError);
    expect(errorWire.result).toEqual(applicationError);
    expect("error" in errorWire).toBe(false);
    expect(mcpJsonRpcResponseMatchesRequest(request, { ...errorWire, id: "request_other" })).toBe(
      false,
    );
  });
});

describe("principal-wide SSE topology and replay", () => {
  const otherTarget = session("session_other_target");
  const bindings = [target, otherTarget].map((identity, index) =>
    PrincipalSessionBindingSchema.parse({
      ownerPrincipalId: principal.principalId,
      hostSessionId: `host_session_${index}`,
      identity,
    }),
  );
  const event = PendingMessageEventSchema.parse({
    protocolVersion: 1,
    event: PENDING_MESSAGE_EVENT_TYPE,
    eventId: "42",
    correlationId: "request_01",
    target: otherTarget,
    header: {
      messageId: "message_01",
      source,
      target: otherTarget,
      bodyHash: bodySha256("hello"),
      bodyBytes: 5,
      state: "PENDING",
      enqueuedAt: "2026-08-20T10:00:00.000Z",
      expiresAt: "2026-08-20T11:00:00.000Z",
    },
  });

  test("freezes GET/event-stream headers and one sequence per principal", () => {
    expect(SSE_HTTP_CONTRACT).toEqual({
      method: "GET",
      path: "/events",
      accept: "text/event-stream",
      contentType: "text/event-stream; charset=utf-8",
      authentication: "bearer_client_principal",
      cursorHeader: "Last-Event-ID",
    });
    expect(EVENT_STREAM_REPLAY_CONTRACT.sequenceScope).toBe("authenticated_principal");
    expect(EVENT_STREAM_REPLAY_CONTRACT.cursorExpiredHttpStatus).toBe(409);
    expect(EVENT_STREAM_REPLAY_CONTRACT.staleCursorRecovery).toBe(
      "list_pending_then_reconnect_without_cursor",
    );
    expect(EVENT_STREAM_REPLAY_CONTRACT.authoritativeRecovery).toEqual([
      METHODS.LIST_PENDING_MESSAGES,
      METHODS.PEEK_NEXT_MESSAGE,
    ]);
    expect(compareEventIds("41", "42")).toBeLessThan(0);
    const previous = PendingMessageEventSchema.parse({ ...event, eventId: "41" });
    expect(eventsAfterCursor([previous, event], "41").map((item) => String(item.eventId))).toEqual([
      "42",
    ]);
  });

  test("formats exact one-line metadata-only SSE frames and data-free comments", () => {
    const frame = formatPendingMessageSseEvent(event);
    expect(frame).toBe(`id: 42\nevent: agentbus.pending\ndata: ${JSON.stringify(event)}\n\n`);
    expect(frame).not.toContain("hello");
    expect(frame.split("\n")[2]).toStartWith("data: {");
    expect(formatSseComment("heartbeat")).toBe(": heartbeat\n\n");
    expect(() => formatSseComment("bad\ncomment")).toThrow();
  });

  test("requires recovery before a cursorless live connection and bounds cursor replay", () => {
    expect(
      EventStreamSubscriptionSchema.safeParse({
        principal,
        authoritativeRecoveryCompleted: false,
      }).success,
    ).toBe(false);
    expect(
      EventStreamSubscriptionSchema.safeParse({
        principal,
        authoritativeRecoveryCompleted: true,
      }).success,
    ).toBe(true);
    expect(
      EventStreamSubscriptionSchema.safeParse({
        principal,
        lastEventId: "41",
        authoritativeRecoveryCompleted: false,
      }).success,
    ).toBe(true);
    expect(createErrorEnvelope("request_cursor", "EVENT_CURSOR_EXPIRED").error.code).toBe(
      "EVENT_CURSOR_EXPIRED",
    );
  });

  test("delivers hints only for sessions owned by the stream principal", () => {
    expect(pendingEventMatchesPrincipalBindings(event, principal, bindings)).toBe(true);
    const firstBinding = bindings[0];
    if (!firstBinding) throw new Error("Missing event binding fixture.");
    expect(pendingEventMatchesPrincipalBindings(event, principal, [firstBinding])).toBe(false);
    expect(
      pendingEventMatchesPrincipalBindings(
        event,
        AuthenticatedClientPrincipalSchema.parse({
          ...principal,
          principalId: "other_principal",
        }),
        bindings,
      ),
    ).toBe(false);
  });
});

describe("loopback connection and bearer provisioning", () => {
  test("accepts only literal loopback HTTP broker endpoints", () => {
    expect(LoopbackBrokerEndpointSchema.parse(DEFAULT_BROKER_ENDPOINT) as string).toBe(
      "http://127.0.0.1:4097",
    );
    expect(LoopbackBrokerEndpointSchema.safeParse("http://[::1]:4097").success).toBe(true);
    for (const endpoint of [
      "http://localhost:4097",
      "http://127.0.0.2:4097",
      "https://127.0.0.1:4097",
      "http://user:pass@127.0.0.1:4097",
      "http://127.0.0.1:4097/path",
      "http://127.0.0.1:4097/",
      "http://127.0.0.1:4097/?query=yes",
      "http://127.0.0.1:4097/#fragment",
    ]) {
      expect(LoopbackBrokerEndpointSchema.safeParse(endpoint).success).toBe(false);
    }
  });

  test("validates trusted connection options without exposing credential contents", () => {
    expect(
      TrustedConnectionConfigSchema.safeParse({
        endpoint: DEFAULT_BROKER_ENDPOINT,
        timeoutMs: 5_000,
        credentialFilePath: "/home/user/.config/opencode-agentbus/credential.json",
      }).success,
    ).toBe(true);
    expect(
      TrustedConnectionConfigSchema.safeParse({
        endpoint: DEFAULT_BROKER_ENDPOINT,
        timeoutMs: 5_000,
        credentialFilePath: "relative/credential.json",
      }).success,
    ).toBe(false);
    expect(CONNECTION_SECURITY_CONTRACT).toEqual({
      allowedHosts: ["127.0.0.1", "::1"],
      protocol: "http_only_mvp",
      dns: "forbidden",
      tls: "forbidden_mvp",
      redirects: "forbidden",
      userinfoQueryFragment: "forbidden",
    });
  });

  test("provisions 256-bit bearer credentials as secret out-of-band state", () => {
    const token = generateBearerToken();
    const brokerId = generateBrokerId();
    const principalId = generatePrincipalId();
    const credential = CredentialFileSchema.parse({
      version: 1,
      principalId: "principal_unique_01",
      serverId: "server_01",
      token,
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(brokerId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(principalId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(CREDENTIAL_FILE_MODE).toBe(0o600);
    expect(CREDENTIAL_PROVISIONING_CONTRACT.principalUniqueness).toBe(
      "globally_unique_per_credential_file_and_plugin_installation",
    );
    expect(JSON.stringify(request)).not.toContain(credential.token);
    expect(JSON.stringify(request)).not.toContain("credential.json");
    expect(JSON.stringify(createErrorEnvelope("request_01", "INTERNAL_ERROR"))).not.toContain(
      credential.token,
    );
  });

  test("freezes daemon lifecycle and rotation reconnect requirements", () => {
    expect(BROKER_LIFECYCLE_CONTRACT.pluginProcessManagement).toBe("never_spawn_or_kill");
    expect(TOKEN_ROTATION_CONTRACT).toEqual({
      action: "replace_token_and_invalidate_existing_connections",
      requiredRecovery: ["reconnect", "mcp_reinitialize", "reregister_sessions"],
    });
  });
});
