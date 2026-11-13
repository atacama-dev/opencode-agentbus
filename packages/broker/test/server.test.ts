import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { afterEach, describe, expect, test } from "bun:test";
import {
  AuthenticatedClientPrincipalSchema,
  CredentialFileSchema,
  METHODS,
  PROTOCOL_VERSION,
  type AuthenticatedClientPrincipal,
  type CredentialFile,
  type EnqueueMessageReceipt,
  type RegistrationResult,
} from "@opencode-agentbus/protocol";
import { BROKER_DAEMON_CAPACITY_POLICY, BrokerDaemon, validateListenHost } from "../src/server";
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

test("MCP HTTP boundary rejects oversized, inconsistent and batched bodies before dispatch", async () => {
  const harness = createHarness();
  const daemon = new BrokerDaemon({ service: harness.service, hostname: "127.0.0.1", port: 0 });
  try {
    const endpoint = await daemon.start();
    const credential = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    const headers = {
      Authorization: `Bearer ${credential.token}`,
      Host: new URL(endpoint).host,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    const invalid = async (body: string, extra: Record<string, string> = {}) =>
      daemon.handleRequest(
        new Request(`${endpoint}/mcp`, { method: "POST", headers: { ...headers, ...extra }, body }),
      );
    const secret = "never-echo-token-or-body";
    const cases = [
      () => invalid("x".repeat(128 * 1024 + 1)),
      () => invalid(initializeBody(secret), { "Content-Length": "3" }),
      () => invalid(JSON.stringify([JSON.parse(initializeBody(secret))])),
      () => invalid(initializeBody(secret), { "Content-Length": String(128 * 1024 + 1) }),
    ];
    for (const send of cases) {
      const response = await send();
      expect([400, 413]).toContain(response.status);
      const text = await response.text();
      expect(text).not.toContain(secret);
      expect(text).not.toContain(credential.token);
      expect(daemon.connectionCounts().mcp).toBe(0);
    }
    let consumedChunks = 0;
    const chunked = new Request(`${endpoint}/mcp`, {
      method: "POST",
      headers,
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          consumedChunks += 1;
          controller.enqueue(new Uint8Array(64 * 1024));
        },
      }),
    });
    const chunkedResponse = await daemon.handleRequest(chunked);
    expect(chunkedResponse.status).toBe(413);
    // ReadableStream may prefetch one extra chunk before cancellation settles.
    expect(consumedChunks).toBeLessThanOrEqual(4);
    expect(daemon.connectionCounts().mcp).toBe(0);
    const unauthorized = await daemon.handleRequest(
      new Request(`${endpoint}/mcp`, {
        method: "POST",
        headers: { ...headers, Authorization: "Bearer invalid" },
        body: "x".repeat(128 * 1024 + 1),
      }),
    );
    expect(unauthorized.status).toBe(401);
    expect(daemon.connectionCounts().mcp).toBe(0);
    // Bun's socket-level cap may reject before the application authentication handler.
    const overSocket = await post(endpoint, credential, "x".repeat(128 * 1024 + 1));
    expect(overSocket.status).toBe(413);
    expect(daemon.connectionCounts().mcp).toBe(0);
    const healthy = await invalid(initializeBody("healthy"));
    expect(healthy.status).toBe(200);
    expect(healthy.headers.get("MCP-Session-Id")).toBeTruthy();
  } finally {
    await daemon.stop();
    harness.close();
  }
});

test("paused authenticated uploads reserve per-request capacity and protect existing sessions from reaping", async () => {
  const harness = createHarness();
  const daemon = new BrokerDaemon({
    service: harness.service,
    hostname: "127.0.0.1",
    port: 0,
    clock: harness.clock,
    maxMcpSessionsPerPrincipal: 1,
    maxMcpSessionsGlobal: 1,
    mcpSessionIdleMs: 1_000,
  });
  try {
    const endpoint = await daemon.start();
    const credential = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    const session = await initialize(endpoint, credential);
    const headers = {
      Authorization: `Bearer ${credential.token}`,
      Host: new URL(endpoint).host,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Session-Id": session.sessionId,
      "MCP-Protocol-Version": session.protocolVersion,
    };
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const paused = daemon.handleRequest(
      new Request(`${endpoint}/mcp`, {
        method: "POST",
        headers,
        body: new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
        }),
      }),
    );
    const rejected = await daemon.handleRequest(
      new Request(`${endpoint}/mcp`, {
        method: "POST",
        headers,
        body: initializeBody("blocked"),
      }),
    );
    expect(rejected.status).toBe(429);
    harness.clock.advance(1_000);
    expect(await daemon.reapIdleSessions()).toBe(0);
    expect(daemon.connectionCounts().mcp).toBe(1);
    controller?.enqueue(
      new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: "ping", method: "ping" })),
    );
    controller?.close();
    expect((await paused).status).toBe(200);
    expect(
      (
        await post(
          endpoint,
          credential,
          JSON.stringify({ jsonrpc: "2.0", id: "next", method: "ping" }),
          session,
        )
      ).status,
    ).toBe(200);
  } finally {
    await daemon.stop();
    harness.close();
  }
});

test("rotation cancels a paused authenticated upload without admitting the old credential", async () => {
  const harness = createHarness();
  const daemon = new BrokerDaemon({
    service: harness.service,
    hostname: "127.0.0.1",
    port: 0,
    maxMcpSessionsPerPrincipal: 1,
    maxMcpSessionsGlobal: 1,
  });
  try {
    const endpoint = await daemon.start();
    const old = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const paused = daemon.handleRequest(
      new Request(`${endpoint}/mcp`, {
        method: "POST",
        headers: {
          Host: new URL(endpoint).host,
          Authorization: `Bearer ${old.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
        }),
      }),
    );
    const replacement = await daemon.rotateCredential();
    try {
      controller?.enqueue(new TextEncoder().encode(initializeBody("old")));
      controller?.close();
    } catch {
      /* rotation cancels the reader */
    }
    expect((await paused).status).toBe(503);
    expect(daemon.connectionCounts().mcp).toBe(0);
    expect((await post(endpoint, old, initializeBody("old-again"))).status).toBe(401);
    expect((await post(endpoint, replacement, initializeBody("new"))).status).toBe(200);
  } finally {
    await daemon.stop();
    harness.close();
  }
});

test("rotation invalidates a paused request on an existing MCP session", async () => {
  const harness = createHarness();
  const daemon = new BrokerDaemon({ service: harness.service, port: 0 });
  try {
    const endpoint = await daemon.start();
    const old = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    const session = await initialize(endpoint, old);
    const abort = new AbortController();
    const paused = daemon.handleRequest(
      new Request(`${endpoint}/mcp`, {
        method: "POST",
        signal: abort.signal,
        headers: {
          Host: new URL(endpoint).host,
          Authorization: `Bearer ${old.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Session-Id": session.sessionId,
        },
        body: new ReadableStream<Uint8Array>({ start() {} }),
      }),
    );
    expect(daemon.uploadCountsForTesting().total).toBe(1);
    const replacement = await daemon.rotateCredential();
    expect((await paused).status).toBe(503);
    expect(daemon.uploadCountsForTesting().total).toBe(0);
    expect(daemon.connectionCounts().mcp).toBe(0);
    expect((await post(endpoint, replacement, initializeBody("new-session"))).status).toBe(200);
  } finally {
    await daemon.stop();
    harness.close();
  }
});

test("upload reservation has a global ceiling, and aborted reads release all slots", async () => {
  const harness = createHarness();
  const daemon = new BrokerDaemon({
    service: harness.service,
    port: 0,
    maxMcpSessionsPerPrincipal: 2,
    maxMcpSessionsGlobal: 2,
  });
  try {
    const endpoint = await daemon.start();
    const credential = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    const headers = {
      Host: new URL(endpoint).host,
      Authorization: `Bearer ${credential.token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    const controllers: AbortController[] = [];
    const pending = Array.from({ length: 2 }, (_, index) => {
      const controller = new AbortController();
      controllers.push(controller);
      return daemon.handleRequest(
        new Request(`${endpoint}/mcp`, {
          method: "POST",
          headers,
          signal: controller.signal,
          body: new ReadableStream<Uint8Array>({
            start() {},
            // A non-cooperative producer must not hold an admission slot after abort.
            ...(index === 0 ? { cancel: () => new Promise<void>(() => {}) } : {}),
          }),
        }),
      );
    });
    expect(daemon.uploadCountsForTesting()).toEqual({ total: 2, byPrincipal: [2] });
    const overflow = await daemon.handleRequest(
      new Request(`${endpoint}/mcp`, { method: "POST", headers, body: initializeBody("overflow") }),
    );
    expect(overflow.status).toBe(429);
    expect(daemon.uploadCountsForTesting().total).toBe(2);
    for (const controller of controllers) controller.abort();
    expect((await Promise.all(pending)).map((response) => response.status)).toEqual([408, 408]);
    expect(daemon.uploadCountsForTesting().total).toBe(0);
    expect((await post(endpoint, credential, initializeBody("healthy"))).status).toBe(200);
  } finally {
    await daemon.stop();
    harness.close();
  }
});

async function rawHttp(endpoint: string, wire: Uint8Array, halfClose = false): Promise<string> {
  const port = Number(new URL(endpoint).port);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Uint8Array[] = [];
    socket.setTimeout(2_000, () => socket.destroy(new Error("Raw fixture timeout")));
    socket.once("connect", () => {
      if (halfClose) socket.end(wire);
      else socket.write(wire);
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(Uint8Array.from(chunk));
      if (chunks.reduce((length, part) => length + part.length, 0) > 32 * 1024)
        socket.destroy(new Error("Unbounded raw response"));
    });
    socket.once("error", reject);
    socket.once("close", () => {
      const result = new Uint8Array(chunks.reduce((length, part) => length + part.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(new TextDecoder().decode(result));
    });
  });
}

test("raw loopback HTTP rejects chunked overflow, truncation and malformed framing without breaking SDK", async () => {
  const harness = createHarness();
  const daemon = new BrokerDaemon({ service: harness.service, port: 0 });
  try {
    const endpoint = await daemon.start();
    const credential = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    const prefix = `POST /mcp HTTP/1.1\r\nHost: ${new URL(endpoint).host}\r\nAuthorization: Bearer ${credential.token}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nConnection: close\r\n`;
    const secret = "never-echo-raw-body";
    const overflow = `${prefix}Transfer-Encoding: chunked\r\n\r\n${(64 * 1024).toString(16)}\r\n${"x".repeat(64 * 1024)}\r\n${(64 * 1024 + 1).toString(16)}\r\n${"x".repeat(64 * 1024 + 1)}\r\n0\r\n\r\n`;
    const truncated = `${prefix}Content-Length: 200\r\n\r\n${initializeBody(secret)}`;
    const wrongLength = `${prefix}Content-Length: 3\r\n\r\n${initializeBody(secret)}`;
    const invalidUtf8 = Uint8Array.from([
      ...new TextEncoder().encode(`${prefix}Content-Length: 2\r\n\r\n`),
      0xc3,
      0x28,
    ]);
    const malformedJson = `${prefix}Content-Length: 3\r\n\r\n{xx`;
    for (const [index, input] of [
      new TextEncoder().encode(overflow),
      new TextEncoder().encode(truncated),
      new TextEncoder().encode(wrongLength),
      invalidUtf8,
      new TextEncoder().encode(malformedJson),
    ].entries()) {
      const text = await rawHttp(endpoint, input, index === 1);
      for (
        let attempt = 0;
        attempt < 20 && daemon.uploadCountsForTesting().total > 0;
        attempt += 1
      ) {
        await Bun.sleep(10);
      }
      if (index === 0) expect(text).toMatch(/^HTTP\/1\.1 413 /);
      if (index === 1) expect(text).toBe(""); // Bun closes a truncated upload before an application response.
      if (index >= 2) expect(text).toMatch(/^HTTP\/1\.1 400 /);
      expect(text).not.toContain(credential.token);
      expect(text).not.toContain(secret);
      expect(daemon.uploadCountsForTesting().total).toBe(0);
      expect(daemon.connectionCounts().mcp).toBe(0);
    }
    const session = await initialize(endpoint, credential);
    expect(
      (
        await post(
          endpoint,
          credential,
          JSON.stringify({ jsonrpc: "2.0", id: "ping-healthy", method: "ping" }),
          session,
        )
      ).status,
    ).toBe(200);
  } finally {
    await daemon.stop();
    harness.close();
  }
});

test("raw paused upload cannot exceed the per-principal capacity and disconnect restores it", async () => {
  const harness = createHarness();
  const daemon = new BrokerDaemon({
    service: harness.service,
    port: 0,
    maxMcpSessionsPerPrincipal: 1,
    maxMcpSessionsGlobal: 1,
  });
  let socket: ReturnType<typeof connect> | undefined;
  try {
    const endpoint = await daemon.start();
    const credential = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    socket = connect({ host: "127.0.0.1", port: Number(new URL(endpoint).port) });
    await new Promise<void>((resolve, reject) => {
      socket?.once("connect", resolve);
      socket?.once("error", reject);
    });
    socket.write(
      `POST /mcp HTTP/1.1\r\nHost: ${new URL(endpoint).host}\r\nAuthorization: Bearer ${credential.token}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n`,
    );
    for (let attempt = 0; attempt < 30 && daemon.uploadCountsForTesting().total === 0; attempt += 1)
      await Bun.sleep(10);
    expect(daemon.uploadCountsForTesting().total).toBe(1);
    const capped = await post(endpoint, credential, initializeBody("capped"));
    expect(capped.status).toBe(429);
    expect(daemon.uploadCountsForTesting().total).toBe(1);
    socket.destroy();
    for (let attempt = 0; attempt < 30 && daemon.uploadCountsForTesting().total > 0; attempt += 1)
      await Bun.sleep(10);
    expect(daemon.uploadCountsForTesting().total).toBe(0);
    expect((await post(endpoint, credential, initializeBody("recovered"))).status).toBe(200);
  } finally {
    socket?.destroy();
    await daemon.stop();
    harness.close();
  }
});

test("credential rotation cancels an in-flight raw socket upload before old-token dispatch", async () => {
  const harness = createHarness();
  const daemon = new BrokerDaemon({ service: harness.service, port: 0 });
  let socket: ReturnType<typeof connect> | undefined;
  try {
    const endpoint = await daemon.start();
    const old = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    socket = connect({ host: "127.0.0.1", port: Number(new URL(endpoint).port) });
    await new Promise<void>((resolve, reject) => {
      socket?.once("connect", resolve);
      socket?.once("error", reject);
    });
    socket.write(
      `POST /mcp HTTP/1.1\r\nHost: ${new URL(endpoint).host}\r\nAuthorization: Bearer ${old.token}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n`,
    );
    for (let attempt = 0; attempt < 30 && daemon.uploadCountsForTesting().total === 0; attempt += 1)
      await Bun.sleep(10);
    expect(daemon.uploadCountsForTesting().total).toBe(1);
    const fresh = await daemon.rotateCredential();
    for (let attempt = 0; attempt < 30 && daemon.uploadCountsForTesting().total > 0; attempt += 1)
      await Bun.sleep(10);
    expect(daemon.uploadCountsForTesting().total).toBe(0);
    expect(daemon.connectionCounts().mcp).toBe(0);
    expect((await post(endpoint, old, initializeBody("old"))).status).toBe(401);
    expect((await post(endpoint, fresh, initializeBody("new"))).status).toBe(200);
  } finally {
    socket?.destroy();
    await daemon.stop();
    harness.close();
  }
});

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

function testPrincipal(index: number): AuthenticatedClientPrincipal {
  return AuthenticatedClientPrincipalSchema.parse({
    principalId: `capacity-principal-${index}`,
    serverId: `capacity-server-${index}`,
  });
}

function enableSyntheticCapacityPrincipals(harness: Harness): void {
  const original = harness.service.authenticate.bind(harness.service);
  harness.service.authenticate = (header) => {
    const match = /^Bearer capacity-principal-(\d+)$/.exec(header ?? "");
    return match ? testPrincipal(Number(match[1])) : original(header);
  };
}

interface PrivateMcpAdmission {
  handleMcp(request: Request, principal: AuthenticatedClientPrincipal): Promise<Response>;
}

interface PrivateEventAdmission {
  applicationHandshakeComplete: boolean;
  handleEvents(request: Request, principal: AuthenticatedClientPrincipal): Response;
}

async function initializeForPrincipal(
  daemon: BrokerDaemon,
  endpoint: string,
  principal: AuthenticatedClientPrincipal,
  id: string,
): Promise<{ readonly response: Response; readonly session?: McpSession }> {
  const response = await (daemon as unknown as PrivateMcpAdmission).handleMcp(
    new Request(`${endpoint}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Authorization: `Bearer ${principal.principalId}`,
      },
      body: initializeBody(id),
    }),
    principal,
  );
  const sessionId = response.headers.get("MCP-Session-Id");
  if (!sessionId) return { response };
  const wire = (await response.json()) as { result: { protocolVersion: string } };
  return {
    response,
    session: { sessionId, protocolVersion: wire.result.protocolVersion },
  };
}

async function terminateForPrincipal(
  daemon: BrokerDaemon,
  endpoint: string,
  principal: AuthenticatedClientPrincipal,
  session: McpSession,
): Promise<Response> {
  return (daemon as unknown as PrivateMcpAdmission).handleMcp(
    new Request(`${endpoint}/mcp`, {
      method: "DELETE",
      headers: {
        "MCP-Protocol-Version": session.protocolVersion,
        "MCP-Session-Id": session.sessionId,
        Authorization: `Bearer ${principal.principalId}`,
      },
    }),
    principal,
  );
}

function allowTestEventPrincipals(harness: Harness, daemon: BrokerDaemon): PrivateEventAdmission {
  const service = harness.service as unknown as {
    subscribeEvents(
      principal: AuthenticatedClientPrincipal,
      listener: (event: unknown) => void,
    ): () => void;
    replayEvents(
      principal: AuthenticatedClientPrincipal,
      cursor?: string,
    ): { readonly ok: true; readonly events: readonly [] };
  };
  service.subscribeEvents = () => () => undefined;
  service.replayEvents = () => ({ ok: true, events: [] });
  const admission = daemon as unknown as PrivateEventAdmission;
  admission.applicationHandshakeComplete = true;
  return admission;
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

  test("derives enough default transport capacity for more than eight workspace streams", async () => {
    harness = createHarness();
    daemon = new BrokerDaemon({
      service: harness.service,
      hostname: "127.0.0.1",
      port: 0,
    });
    const endpoint = await daemon.start();
    const credential = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    await completeApplicationHandshake(endpoint, credential);

    const streams: Response[] = [];
    for (let index = 0; index < 9; index += 1) {
      const stream = await daemon.handleRequest(eventRequest(endpoint, credential));
      expect(stream.status).toBe(200);
      streams.push(stream);
    }
    expect(daemon.connectionCounts().sse).toBe(9);
    for (const stream of streams) await stream.body?.cancel();
    expect(daemon.connectionCounts().sse).toBe(0);
  });

  test("accepts exactly 20 default MCP sessions per principal and releases capacity", async () => {
    harness = createHarness();
    enableSyntheticCapacityPrincipals(harness);
    daemon = new BrokerDaemon({ service: harness.service, hostname: "127.0.0.1", port: 0 });
    const endpoint = await daemon.start();
    const principal = testPrincipal(1);
    const sessions: McpSession[] = [];

    for (let index = 0; index < 20; index += 1) {
      const initialized = await initializeForPrincipal(
        daemon,
        endpoint,
        principal,
        `per-principal-${index}`,
      );
      expect(initialized.response.status).toBe(200);
      if (!initialized.session) throw new Error("Missing bounded MCP session.");
      sessions.push(initialized.session);
    }
    expect(daemon.connectionCounts().mcp).toBe(20);
    expect(
      (await initializeForPrincipal(daemon, endpoint, principal, "per-principal-capped")).response
        .status,
    ).toBe(429);

    const released = sessions.shift();
    if (!released) throw new Error("Missing MCP session to release.");
    expect((await terminateForPrincipal(daemon, endpoint, principal, released)).status).toBe(200);
    const replacement = await initializeForPrincipal(
      daemon,
      endpoint,
      principal,
      "per-principal-replacement",
    );
    expect(replacement.response.status).toBe(200);
    if (!replacement.session) throw new Error("Missing replacement MCP session.");
    sessions.push(replacement.session);
    for (const session of sessions) {
      expect((await terminateForPrincipal(daemon, endpoint, principal, session)).status).toBe(200);
    }
    expect(daemon.connectionCounts().mcp).toBe(0);
  });

  test("accepts exactly 40 default MCP sessions globally and releases capacity", async () => {
    harness = createHarness();
    enableSyntheticCapacityPrincipals(harness);
    daemon = new BrokerDaemon({ service: harness.service, hostname: "127.0.0.1", port: 0 });
    const endpoint = await daemon.start();
    const principals = [testPrincipal(1), testPrincipal(2)];
    const sessions: Array<{
      readonly principal: AuthenticatedClientPrincipal;
      readonly session: McpSession;
    }> = [];

    for (const principal of principals) {
      for (let index = 0; index < 20; index += 1) {
        const initialized = await initializeForPrincipal(
          daemon,
          endpoint,
          principal,
          `global-${principal.principalId}-${index}`,
        );
        expect(initialized.response.status).toBe(200);
        if (!initialized.session) throw new Error("Missing global MCP session.");
        sessions.push({ principal, session: initialized.session });
      }
    }
    expect(daemon.connectionCounts().mcp).toBe(40);
    const thirdPrincipal = testPrincipal(3);
    expect(
      (await initializeForPrincipal(daemon, endpoint, thirdPrincipal, "global-capped")).response
        .status,
    ).toBe(429);

    const released = sessions.shift();
    if (!released) throw new Error("Missing global MCP session to release.");
    expect(
      (await terminateForPrincipal(daemon, endpoint, released.principal, released.session)).status,
    ).toBe(200);
    const replacement = await initializeForPrincipal(
      daemon,
      endpoint,
      thirdPrincipal,
      "global-replacement",
    );
    expect(replacement.response.status).toBe(200);
    if (!replacement.session) throw new Error("Missing global replacement MCP session.");
    sessions.push({ principal: thirdPrincipal, session: replacement.session });
    for (const item of sessions) {
      expect(
        (await terminateForPrincipal(daemon, endpoint, item.principal, item.session)).status,
      ).toBe(200);
    }
    expect(daemon.connectionCounts().mcp).toBe(0);
  });

  test("accepts exactly 20 default SSE streams per principal and releases capacity", async () => {
    harness = createHarness();
    daemon = new BrokerDaemon({ service: harness.service, hostname: "127.0.0.1", port: 0 });
    const endpoint = await daemon.start();
    const admission = allowTestEventPrincipals(harness, daemon);
    const principal = testPrincipal(1);
    const credential = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    const streams: Response[] = [];

    for (let index = 0; index < 20; index += 1) {
      const stream = admission.handleEvents(eventRequest(endpoint, credential), principal);
      expect(stream.status).toBe(200);
      streams.push(stream);
    }
    expect(daemon.connectionCounts().sse).toBe(20);
    expect(admission.handleEvents(eventRequest(endpoint, credential), principal).status).toBe(429);

    await streams.shift()?.body?.cancel();
    const replacement = admission.handleEvents(eventRequest(endpoint, credential), principal);
    expect(replacement.status).toBe(200);
    streams.push(replacement);
    for (const stream of streams) await stream.body?.cancel();
    expect(daemon.connectionCounts().sse).toBe(0);
  });

  test("accepts exactly 40 default SSE streams globally and releases capacity", async () => {
    harness = createHarness();
    daemon = new BrokerDaemon({ service: harness.service, hostname: "127.0.0.1", port: 0 });
    const endpoint = await daemon.start();
    const admission = allowTestEventPrincipals(harness, daemon);
    const credential = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    const streams: Response[] = [];

    for (const principal of [testPrincipal(1), testPrincipal(2)]) {
      for (let index = 0; index < 20; index += 1) {
        const stream = admission.handleEvents(eventRequest(endpoint, credential), principal);
        expect(stream.status).toBe(200);
        streams.push(stream);
      }
    }
    expect(daemon.connectionCounts().sse).toBe(40);
    const thirdPrincipal = testPrincipal(3);
    expect(admission.handleEvents(eventRequest(endpoint, credential), thirdPrincipal).status).toBe(
      429,
    );

    await streams.shift()?.body?.cancel();
    const replacement = admission.handleEvents(eventRequest(endpoint, credential), thirdPrincipal);
    expect(replacement.status).toBe(200);
    streams.push(replacement);
    for (const stream of streams) await stream.body?.cancel();
    expect(daemon.connectionCounts().sse).toBe(0);
  });

  test("validates explicit transport overrides against finite hard and global ceilings", () => {
    harness = createHarness();
    const service = harness.service;
    for (const options of [
      {
        maxAuthChallengesPerMinute: BROKER_DAEMON_CAPACITY_POLICY.maxAuthChallengesPerMinute + 1,
      },
      {
        maxMcpSessionsPerPrincipal: BROKER_DAEMON_CAPACITY_POLICY.maxMcpSessionsPerPrincipal + 1,
      },
      { maxMcpSessionsGlobal: BROKER_DAEMON_CAPACITY_POLICY.maxMcpSessionsGlobal + 1 },
      {
        maxSseConnectionsPerPrincipal:
          BROKER_DAEMON_CAPACITY_POLICY.maxSseConnectionsPerPrincipal + 1,
      },
      { maxSseConnectionsGlobal: BROKER_DAEMON_CAPACITY_POLICY.maxSseConnectionsGlobal + 1 },
      { maxMcpSessionsPerPrincipal: 2, maxMcpSessionsGlobal: 1 },
      { maxSseConnectionsPerPrincipal: 2, maxSseConnectionsGlobal: 1 },
    ]) {
      expect(
        () =>
          new BrokerDaemon({
            service,
            hostname: "127.0.0.1",
            port: 0,
            ...options,
          }),
      ).toThrow();
    }
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
