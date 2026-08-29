import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import {
  CredentialFileSchema,
  METHODS,
  PROTOCOL_VERSION,
  type CredentialFile,
  type EnqueueMessageReceipt,
  type RegistrationResult,
} from "@opencode-agentbus/protocol";
import { BrokerDaemon, validateListenHost } from "../src/server";
import {
  createHarness,
  enqueueRequest,
  expectSuccess,
  registerRequest,
  requestId,
  type Harness,
} from "./helpers";

interface McpSession {
  readonly sessionId: string;
  readonly protocolVersion: string;
}

async function post(
  endpoint: string,
  credential: CredentialFile,
  body: string,
  session?: McpSession,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${credential.token}`,
    "Content-Type": "application/json",
  };
  if (session) {
    headers["MCP-Session-Id"] = session.sessionId;
    headers["MCP-Protocol-Version"] = session.protocolVersion;
  }
  return fetch(`${endpoint}/mcp`, { method: "POST", headers, body, redirect: "error" });
}

async function initialize(endpoint: string, credential: CredentialFile): Promise<McpSession> {
  const response = await post(
    endpoint,
    credential,
    JSON.stringify({
      jsonrpc: "2.0",
      id: "initialize-1",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "broker-test", version: "1.0.0" },
      },
    }),
  );
  const wire = (await response.json()) as {
    result: { protocolVersion: string };
  };
  const sessionId = response.headers.get("MCP-Session-Id");
  if (!sessionId) throw new Error("Missing MCP session header.");
  const session = { sessionId, protocolVersion: wire.result.protocolVersion };
  const initialized = await post(
    endpoint,
    credential,
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    session,
  );
  expect(initialized.status).toBe(202);
  return session;
}

async function customRequest(
  endpoint: string,
  credential: CredentialFile,
  session: McpSession,
  applicationRequest: object,
): Promise<{ response: Response; wire: Record<string, unknown> }> {
  const request = applicationRequest as { requestId: string; method: string };
  const response = await post(
    endpoint,
    credential,
    JSON.stringify({
      jsonrpc: "2.0",
      id: request.requestId,
      method: request.method,
      params: applicationRequest,
    }),
    session,
  );
  return { response, wire: (await response.json()) as Record<string, unknown> };
}

async function completeApplicationHandshake(
  endpoint: string,
  credential: CredentialFile,
): Promise<McpSession> {
  const session = await initialize(endpoint, credential);
  const handshake = await customRequest(endpoint, credential, session, {
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId("event-handshake"),
    method: METHODS.HANDSHAKE,
    params: { supportedProtocolVersions: [PROTOCOL_VERSION] },
  });
  if ((handshake.wire.result as { ok?: boolean }).ok !== true) {
    throw new Error("Application handshake failed.");
  }
  return session;
}

function initializeBody(id: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "broker-test", version: "1.0.0" },
    },
  });
}

function eventRequest(endpoint: string, credential: CredentialFile): Request {
  const host = new URL(endpoint).host;
  return new Request(`${endpoint}/events`, {
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${credential.token}`,
      Host: host,
      "Last-Event-ID": "0",
    },
  });
}

describe("local MCP daemon", () => {
  let harness: Harness | undefined;
  let daemon: BrokerDaemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    harness?.close();
    harness = undefined;
  });

  test("bind configuration accepts only literal loopback", () => {
    expect(validateListenHost("127.0.0.1")).toBe("127.0.0.1");
    expect(validateListenHost("::1")).toBe("::1");
    expect(() => validateListenHost("localhost")).toThrow();
    expect(() => validateListenHost("0.0.0.0")).toThrow();
    expect(() => validateListenHost("192.0.2.1")).toThrow();
  });

  test("authenticates before JSON parsing or custom dispatch", async () => {
    harness = createHarness();
    daemon = new BrokerDaemon({ service: harness.service, hostname: "127.0.0.1", port: 0 });
    const endpoint = await daemon.start();

    const response = await fetch(`${endpoint}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer definitely-wrong",
        "Content-Type": "application/json",
      },
      body: "{ malformed and must not be parsed",
      redirect: "error",
    });
    const wire = JSON.stringify(await response.json());

    expect(response.status).toBe(401);
    expect(wire).toContain("Authentication is required");
    expect(wire).not.toContain("Parse error");
  });

  test("uses SDK initialize/session headers, no tools, and correlated custom envelopes", async () => {
    harness = createHarness();
    daemon = new BrokerDaemon({ service: harness.service, hostname: "127.0.0.1", port: 0 });
    const endpoint = await daemon.start();
    const credential = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    const session = await initialize(endpoint, credential);

    const handshakeRequest = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId("handshake"),
      method: METHODS.HANDSHAKE,
      params: { supportedProtocolVersions: [PROTOCOL_VERSION] },
    } as const;
    const handshake = await customRequest(endpoint, credential, session, handshakeRequest);
    const result = handshake.wire.result as {
      requestId: string;
      ok: boolean;
      result: { broker: { brokerId: string; serverId: string } };
    };

    expect(handshake.response.headers.get("Content-Type")).toContain("application/json");
    expect(handshake.wire.id).toBe(handshakeRequest.requestId);
    expect(result.requestId).toBe(handshakeRequest.requestId);
    expect(result.ok).toBe(true);
    expect(result.result.broker.brokerId).toBe(harness.service.brokerId);
    expect(result.result.broker.serverId).toBe(harness.service.principal.serverId);

    const tools = await post(
      endpoint,
      credential,
      JSON.stringify({ jsonrpc: "2.0", id: "tools-1", method: "tools/list", params: {} }),
      session,
    );
    const toolWire = (await tools.json()) as { error: { code: number } };
    expect(toolWire.error.code).toBe(-32601);
  });

  test("rejects pre-initialized calls, wire mismatches, and unsupported protocol handshakes safely", async () => {
    harness = createHarness();
    daemon = new BrokerDaemon({ service: harness.service, hostname: "127.0.0.1", port: 0 });
    const endpoint = await daemon.start();
    const credential = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    const session = await initialize(endpoint, credential);

    const mismatch = await post(
      endpoint,
      credential,
      JSON.stringify({
        jsonrpc: "2.0",
        id: "outer-id",
        method: METHODS.HANDSHAKE,
        params: {
          protocolVersion: PROTOCOL_VERSION,
          requestId: "inner-id",
          method: METHODS.HANDSHAKE,
          params: { supportedProtocolVersions: [PROTOCOL_VERSION] },
        },
      }),
      session,
    );
    const mismatchWire = (await mismatch.json()) as { error: { code: number; message: string } };
    expect(mismatchWire.error.code).toBe(-32600);
    expect(mismatchWire.error.message).not.toContain("outer-id");

    const unsupported = await customRequest(endpoint, credential, session, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId("unsupported"),
      method: METHODS.HANDSHAKE,
      params: { supportedProtocolVersions: [99] },
    });
    expect(JSON.stringify(unsupported.wire)).toContain("UNSUPPORTED_PROTOCOL_VERSION");
  });

  test("rejects a version-1 client and all operations until a version-2 handshake succeeds", async () => {
    harness = createHarness();
    daemon = new BrokerDaemon({ service: harness.service, hostname: "127.0.0.1", port: 0 });
    const endpoint = await daemon.start();
    const credential = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    const session = await initialize(endpoint, credential);

    const legacyHandshake = await customRequest(endpoint, credential, session, {
      protocolVersion: 1,
      requestId: requestId("legacy-handshake"),
      method: METHODS.HANDSHAKE,
      params: { supportedProtocolVersions: [1] },
    });
    expect(JSON.stringify(legacyHandshake.wire)).toContain("INVALID_REQUEST");
    expect(harness.service.storageStatsForTesting().sessions).toBe(0);

    const eventsBeforeHandshake = await daemon.handleRequest(eventRequest(endpoint, credential));
    expect(eventsBeforeHandshake.status).toBe(409);
    expect(daemon.connectionCounts().sse).toBe(0);

    const beforeHandshake = await customRequest(
      endpoint,
      credential,
      session,
      registerRequest("must-not-register-before-v2-handshake"),
    );
    expect(beforeHandshake.wire.error).toBeDefined();
    expect(harness.service.storageStatsForTesting().sessions).toBe(0);

    const handshake = await customRequest(endpoint, credential, session, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId("v2-handshake"),
      method: METHODS.HANDSHAKE,
      params: { supportedProtocolVersions: [PROTOCOL_VERSION] },
    });
    expect((handshake.wire.result as { ok?: boolean }).ok).toBe(true);
    const eventsAfterHandshake = await daemon.handleRequest(eventRequest(endpoint, credential));
    expect(eventsAfterHandshake.status).toBe(200);
    await eventsAfterHandshake.body?.cancel();
    const registered = await customRequest(
      endpoint,
      credential,
      session,
      registerRequest("register-after-v2-handshake"),
    );
    expect((registered.wire.result as { ok?: boolean }).ok).toBe(true);
    expect(harness.service.storageStatsForTesting().sessions).toBe(1);
  });

  test("rotating credentials invalidates existing MCP sessions", async () => {
    harness = createHarness();
    daemon = new BrokerDaemon({ service: harness.service, hostname: "127.0.0.1", port: 0 });
    const endpoint = await daemon.start();
    const oldCredential = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    const session = await initialize(endpoint, oldCredential);
    const newCredential = await daemon.rotateCredential();

    const oldResponse = await post(
      endpoint,
      oldCredential,
      JSON.stringify({ jsonrpc: "2.0", id: "ping-old", method: "ping", params: {} }),
      session,
    );
    expect(oldResponse.status).toBe(401);

    const newSession = await initialize(endpoint, newCredential);
    expect(newSession.sessionId).not.toBe(session.sessionId);
  });

  test("terminates authenticated MCP sessions with DELETE and permits clean reconnect", async () => {
    harness = createHarness();
    daemon = new BrokerDaemon({ service: harness.service, hostname: "127.0.0.1", port: 0 });
    const endpoint = await daemon.start();
    const credential = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    const session = await initialize(endpoint, credential);
    expect(daemon.connectionCounts()).toEqual({ mcp: 1, sse: 0 });

    const terminated = await fetch(`${endpoint}/mcp`, {
      method: "DELETE",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${credential.token}`,
        "MCP-Protocol-Version": session.protocolVersion,
        "MCP-Session-Id": session.sessionId,
      },
      redirect: "error",
    });
    expect(terminated.status).toBe(200);
    expect(daemon.connectionCounts()).toEqual({ mcp: 0, sse: 0 });

    const stale = await post(
      endpoint,
      credential,
      JSON.stringify({ jsonrpc: "2.0", id: "stale", method: "ping", params: {} }),
      session,
    );
    expect(stale.status).toBe(404);
    const reconnected = await initialize(endpoint, credential);
    expect(reconnected.sessionId).not.toBe(session.sessionId);
    expect(daemon.connectionCounts().mcp).toBe(1);
  });

  test("caps MCP sessions per principal and reaps idle sessions", async () => {
    harness = createHarness();
    daemon = new BrokerDaemon({
      service: harness.service,
      hostname: "127.0.0.1",
      port: 0,
      clock: harness.clock,
      maxMcpSessionsPerPrincipal: 1,
      mcpSessionIdleMs: 1_000,
    });
    const endpoint = await daemon.start();
    const credential = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    const session = await initialize(endpoint, credential);

    const capped = await post(endpoint, credential, initializeBody("initialize-capped"));
    expect(capped.status).toBe(429);
    expect(JSON.stringify(await capped.json())).not.toContain("1");
    expect(daemon.connectionCounts().mcp).toBe(1);

    harness.clock.advance(1_000);
    await daemon.reapIdleSessions();
    expect(daemon.connectionCounts().mcp).toBe(0);
    const stale = await post(
      endpoint,
      credential,
      JSON.stringify({ jsonrpc: "2.0", id: "idle", method: "ping", params: {} }),
      session,
    );
    expect(stale.status).toBe(404);
    expect((await initialize(endpoint, credential)).sessionId).not.toBe(session.sessionId);
  });

  test("caps SSE streams and always cleans up cancellation", async () => {
    harness = createHarness();
    daemon = new BrokerDaemon({
      service: harness.service,
      hostname: "127.0.0.1",
      port: 0,
      maxSseConnectionsPerPrincipal: 1,
    });
    const endpoint = await daemon.start();
    const credential = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    await completeApplicationHandshake(endpoint, credential);

    const first = await daemon.handleRequest(eventRequest(endpoint, credential));
    expect(first.status).toBe(200);
    expect(daemon.connectionCounts().sse).toBe(1);
    const capped = await daemon.handleRequest(eventRequest(endpoint, credential));
    expect(capped.status).toBe(429);
    await first.body?.cancel();
    expect(daemon.connectionCounts().sse).toBe(0);

    const replacement = await daemon.handleRequest(eventRequest(endpoint, credential));
    expect(replacement.status).toBe(200);
    await replacement.body?.cancel();
    expect(daemon.connectionCounts().sse).toBe(0);
  });

  test("closes slow SSE consumers when bounded buffering fills", async () => {
    harness = createHarness();
    daemon = new BrokerDaemon({
      service: harness.service,
      hostname: "127.0.0.1",
      port: 0,
      maxSseBufferedBytes: 700,
      eventHeartbeatMs: 60_000,
    });
    const endpoint = await daemon.start();
    const credential = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    await completeApplicationHandshake(endpoint, credential);
    const source = expectSuccess<RegistrationResult>(
      harness.service.dispatch(harness.service.principal, registerRequest("slow-source")),
    );
    const target = expectSuccess<RegistrationResult>(
      harness.service.dispatch(harness.service.principal, registerRequest("slow-target")),
    );
    const response = await daemon.handleRequest(eventRequest(endpoint, credential));
    expect(response.status).toBe(200);
    expect(daemon.connectionCounts().sse).toBe(1);

    for (let index = 0; index < 8 && daemon.connectionCounts().sse > 0; index += 1) {
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          enqueueRequest(source.identity, target.identity, `bounded-${index}`),
        ),
      );
    }
    expect(daemon.connectionCounts().sse).toBe(0);
    const reader = response.body?.getReader();
    while (!(await reader?.read())?.done) {
      // Drain the already-bounded frames until the closed stream ends.
    }
    await reader?.cancel();
  });

  test("serves metadata-only SSE replay, stale cursor conflicts, ownership, and heartbeats", async () => {
    harness = createHarness({ limits: { eventReplayWindow: 2 } });
    daemon = new BrokerDaemon({
      service: harness.service,
      hostname: "127.0.0.1",
      port: 0,
      eventHeartbeatMs: 10,
    });
    const endpoint = await daemon.start();
    const credential = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    const sourceSession = await initialize(endpoint, credential);
    await customRequest(endpoint, credential, sourceSession, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId("source-handshake"),
      method: METHODS.HANDSHAKE,
      params: { supportedProtocolVersions: [PROTOCOL_VERSION] },
    });
    const sourceWire = await customRequest(
      endpoint,
      credential,
      sourceSession,
      registerRequest("source"),
    );
    const session = {
      // A second connection is intentional: principal-wide events are independent of MCP sessions.
      ...(await initialize(endpoint, credential)),
    };
    await customRequest(endpoint, credential, session, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId("target-handshake"),
      method: METHODS.HANDSHAKE,
      params: { supportedProtocolVersions: [PROTOCOL_VERSION] },
    });
    const targetWire = await customRequest(
      endpoint,
      credential,
      session,
      registerRequest("target"),
    );
    const source = (sourceWire.wire.result as { result: RegistrationResult }).result;
    const target = (targetWire.wire.result as { result: RegistrationResult }).result;

    const liveResponse = await fetch(`${endpoint}/events`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${credential.token}`,
        "Last-Event-ID": "0",
      },
      redirect: "error",
    });
    expect(liveResponse.status).toBe(200);
    await customRequest(
      endpoint,
      credential,
      session,
      enqueueRequest(source.identity, target.identity, "first-live-body"),
    );
    const liveReader = liveResponse.body?.getReader();
    let liveText = "";
    for (
      let attempt = 0;
      attempt < 10 && !liveText.includes("event: agentbus.pending");
      attempt += 1
    ) {
      const liveChunk = await liveReader?.read();
      liveText += new TextDecoder().decode(liveChunk?.value);
    }
    await liveReader?.cancel();
    expect(liveText).toContain("id: 1\nevent: agentbus.pending");
    expect(liveText).not.toContain("first-live-body");

    const bodies = ["SSE_BODY_SECRET", "second", "third"];
    for (const body of bodies) {
      await customRequest(
        endpoint,
        credential,
        session,
        enqueueRequest(source.identity, target.identity, body),
      );
    }
    const retained = harness.service.retainedEventsForTesting(harness.service.principal);
    expect(retained).toHaveLength(2);

    const replayResponse = await fetch(`${endpoint}/events`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${credential.token}`,
        "Last-Event-ID": retained[0]?.eventId ?? "1",
      },
      redirect: "error",
    });
    const reader = replayResponse.body?.getReader();
    const chunk = await reader?.read();
    await reader?.cancel();
    const replayText = new TextDecoder().decode(chunk?.value);
    expect(replayResponse.status).toBe(200);
    expect(replayResponse.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
    expect(replayText).toContain("event: agentbus.pending");
    expect(replayText).not.toContain("SSE_BODY_SECRET");
    expect(replayText).not.toMatch(/"body"\s*:/);

    const staleResponse = await fetch(`${endpoint}/events`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${credential.token}`,
        "Last-Event-ID": String(Number(retained[0]?.eventId ?? "3") - 1),
      },
      redirect: "error",
    });
    expect(staleResponse.status).toBe(409);
    expect(JSON.stringify(await staleResponse.json())).toContain("EVENT_CURSOR_EXPIRED");

    const missingCursorResponse = await fetch(`${endpoint}/events`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${credential.token}`,
      },
      redirect: "error",
    });
    expect(missingCursorResponse.status).toBe(409);
    expect(JSON.stringify(await missingCursorResponse.json())).toContain("EVENT_CURSOR_EXPIRED");

    const heartbeatResponse = await fetch(`${endpoint}/events`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${credential.token}`,
        "Last-Event-ID": retained.at(-1)?.eventId ?? "0",
      },
      redirect: "error",
    });
    const heartbeatReader = heartbeatResponse.body?.getReader();
    const heartbeatChunk = await heartbeatReader?.read();
    await heartbeatReader?.cancel();
    expect(new TextDecoder().decode(heartbeatChunk?.value)).toBe(": heartbeat\n\n");
  });

  test("never logs secrets, request bodies, query strings, paths, or raw errors", async () => {
    const entries: string[] = [];
    harness = createHarness({
      logger: {
        info: (message) => entries.push(message),
        warn: (message) => entries.push(message),
        error: (message) => entries.push(message),
      },
    });
    daemon = new BrokerDaemon({
      service: harness.service,
      hostname: "127.0.0.1",
      port: 0,
    });
    const endpoint = await daemon.start();
    const credential = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    await fetch(`${endpoint}/mcp?SECRET_QUERY=1`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credential.token}` },
      body: "SECRET_BODY",
      redirect: "error",
    });

    const logs = entries.join("\n");
    expect(logs).not.toContain(credential.token);
    expect(logs).not.toContain("SECRET_QUERY");
    expect(logs).not.toContain("SECRET_BODY");
    expect(logs).not.toContain(harness.credentialFilePath);
    expect(logs).not.toContain("SyntaxError");
  });
});
