import { describe, expect, test } from "bun:test";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  AUTH_CHALLENGE_CLIENT_NONCE_HEADER,
  AUTH_CHALLENGE_ENDPOINT,
  HandshakeRequestSchema,
  HandshakeSuccessEnvelopeSchema,
  METHODS,
  PROTOCOL_VERSION,
  generateAuthChallengeNonce,
  toMcpJsonRpcRequest,
  toMcpJsonRpcSuccessResponse,
} from "@opencode-agentbus/protocol";
import type { ApplicationOperationRequest } from "@opencode-agentbus/protocol";

import { SAFE_MODEL_ERRORS } from "../src/errors";
import { AuthenticatedPrincipalEventStream } from "../src/event-stream";
import { CorrelatedMcpTransport, SdkBrokerChannel } from "../src/mcp-client";
import { CONFIG, TOKEN_B, challengeResponse, credential, credentialSnapshot } from "./helpers";

class InnerTransport implements Transport {
  readonly sent: JSONRPCMessage[] = [];
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId = "mcp_session_01";

  async start(): Promise<void> {}
  async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);
  }
  async close(): Promise<void> {}
}

describe("custom JSON-RPC mapping over the official MCP transport", () => {
  test.each([
    ["invalid", (nonce: string) => ({ ...challengeResponse(nonce), proof: "0".repeat(64) })],
    [
      "missing",
      (nonce: string) => {
        const { proof: _proof, ...missing } = challengeResponse(nonce);
        return missing;
      },
    ],
    ["replayed", () => challengeResponse(generateAuthChallengeNonce())],
    ["wrong-server", (nonce: string) => challengeResponse(nonce, { serverId: "server_02" })],
  ])("rejects %s challenge proof before any bearer request", async (_kind, candidate) => {
    const requests: Array<{
      authorization: string | null;
      body: RequestInit["body"];
      method: string | undefined;
      url: string;
    }> = [];
    const channel = new SdkBrokerChannel({
      config: CONFIG,
      credential: credentialSnapshot().credential,
      onLoss: () => undefined,
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          authorization: headers.get("authorization"),
          body: init?.body,
          method: init?.method,
          url: String(url),
        });
        const nonce = headers.get(AUTH_CHALLENGE_CLIENT_NONCE_HEADER);
        if (!nonce) throw new Error("missing test nonce");
        return Response.json(candidate(nonce));
      },
    });

    await expect(channel.connect()).rejects.toThrow(SAFE_MODEL_ERRORS.UNAVAILABLE);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      authorization: null,
      body: undefined,
      method: "GET",
      url: `${CONFIG.endpoint}${AUTH_CHALLENGE_ENDPOINT}`,
    });
    expect(new URL(requests[0]?.url ?? "http://invalid").search).toBe("");
    expect(requests.filter((request) => request.authorization !== null)).toEqual([]);
    await channel.close();
  });

  test("disposal aborts an in-flight challenge without bearer disclosure or raw errors", async () => {
    let activeConnections = 0;
    let bearerRequests = 0;
    let started!: () => void;
    const challengeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const channel = new SdkBrokerChannel({
      config: CONFIG,
      credential: credential(),
      onLoss: () => undefined,
      fetch: async (_url, init) => {
        if (new Headers(init?.headers).has("authorization")) bearerRequests += 1;
        activeConnections += 1;
        started();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              activeConnections -= 1;
              reject(new Error("raw challenge endpoint token proof detail"));
            },
            { once: true },
          );
        });
      },
    });
    const connecting = channel.connect();
    await challengeStarted;

    await channel.close();
    await expect(connecting).rejects.toThrow(SAFE_MODEL_ERRORS.UNAVAILABLE);
    expect(activeConnections).toBe(0);
    expect(bearerRequests).toBe(0);
  });

  test("times out MCP challenge response headers before constructing bearer transport", async () => {
    let activeConnections = 0;
    let bearerRequests = 0;
    const channel = new SdkBrokerChannel({
      config: { ...CONFIG, timeoutMs: 100 },
      credential: credential(),
      onLoss: () => undefined,
      fetch: async (_url, init) => {
        if (new Headers(init?.headers).has("authorization")) bearerRequests += 1;
        activeConnections += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              activeConnections -= 1;
              reject(new Error("raw timeout listener detail"));
            },
            { once: true },
          );
        });
      },
    });

    await expect(channel.connect()).rejects.toThrow(SAFE_MODEL_ERRORS.UNAVAILABLE);
    expect(activeConnections).toBe(0);
    expect(bearerRequests).toBe(0);
    await channel.close();
  });

  test("uses distinct fresh MCP and SSE challenges and accepts broker rotation on reconnect", async () => {
    const requests: Array<{ authorization: string | null; path: string }> = [];
    const challengeNonces: string[] = [];
    let currentBrokerId = "broker_01";
    let currentToken = credential().token;
    let mcpSessionNumber = 0;
    const fetchMock = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(url).pathname;
      const headers = new Headers(init?.headers);
      requests.push({ authorization: headers.get("authorization"), path });
      if (path === AUTH_CHALLENGE_ENDPOINT) {
        const nonce = headers.get(AUTH_CHALLENGE_CLIENT_NONCE_HEADER);
        if (!nonce) throw new Error("missing test nonce");
        challengeNonces.push(nonce);
        return Response.json(
          challengeResponse(nonce, { brokerId: currentBrokerId, token: currentToken }),
        );
      }
      if (path === "/events") {
        return new Response("", { headers: { "Content-Type": "text/event-stream" } });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 200 });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") {
        mcpSessionNumber += 1;
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              serverInfo: { name: "agentbus-broker", version: "0.1.0" },
            },
          },
          { headers: { "MCP-Session-Id": `sdk_session_${mcpSessionNumber}` } },
        );
      }
      return new Response(null, { status: 202 });
    };

    const firstChannel = new SdkBrokerChannel({
      config: CONFIG,
      credential: credential(),
      onLoss: () => undefined,
      fetch: fetchMock,
    });
    const firstBroker = await firstChannel.connect();
    expect(String(firstBroker.brokerId)).toBe("broker_01");
    expect(String(firstBroker.serverId)).toBe("server_01");
    const disconnected = new Promise<void>((resolve) => {
      const stream = new AuthenticatedPrincipalEventStream(
        { config: CONFIG, credential: credential() },
        fetchMock,
      );
      void stream.start({
        onEvent: async () => undefined,
        onDisconnect: () => {
          void stream.close();
          resolve();
        },
      });
    });
    await disconnected;
    await firstChannel.close();

    currentBrokerId = "broker_02";
    currentToken = TOKEN_B;
    const secondChannel = new SdkBrokerChannel({
      config: CONFIG,
      credential: credential(TOKEN_B),
      onLoss: () => undefined,
      fetch: fetchMock,
    });
    const secondBroker = await secondChannel.connect();
    expect(String(secondBroker.brokerId)).toBe("broker_02");
    expect(String(secondBroker.serverId)).toBe("server_01");

    expect(challengeNonces.length).toBeGreaterThanOrEqual(6);
    expect(new Set(challengeNonces).size).toBe(challengeNonces.length);
    const challengeIndexes = requests.flatMap((request, index) =>
      request.path === AUTH_CHALLENGE_ENDPOINT ? [index] : [],
    );
    expect(challengeIndexes).toHaveLength(
      requests.filter((request) => request.authorization !== null).length,
    );
    for (const index of challengeIndexes) {
      expect(requests[index]?.authorization).toBeNull();
      expect(requests[index + 1]?.authorization).toStartWith("Bearer ");
    }
    expect(requests.filter((request) => request.path === "/events")).toHaveLength(1);
    await secondChannel.close();
  });

  test("pins the initialized listener and never discloses bearer credentials after a listener swap", async () => {
    let squatterActive = false;
    let squatterBearerRequests = 0;
    const fetchMock = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      if (new URL(url).pathname === AUTH_CHALLENGE_ENDPOINT) {
        const nonce = headers.get(AUTH_CHALLENGE_CLIENT_NONCE_HEADER);
        if (!nonce) throw new Error("missing test nonce");
        return Response.json(
          challengeResponse(nonce, { brokerId: squatterActive ? "broker_squatter" : "broker_01" }),
        );
      }
      if (squatterActive && headers.has("authorization")) squatterBearerRequests += 1;
      if (init?.method === "DELETE") return new Response(null, { status: 200 });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "initialize") {
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              serverInfo: { name: "agentbus-broker", version: "0.1.0" },
            },
          },
          { headers: { "MCP-Session-Id": "sdk_session_swap" } },
        );
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response(null, { status: 401 });
    };
    const channel = new SdkBrokerChannel({
      config: CONFIG,
      credential: credential(),
      onLoss: () => undefined,
      fetch: fetchMock,
    });
    await channel.connect();
    squatterActive = true;
    const request = HandshakeRequestSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "request_after_listener_swap",
      method: METHODS.HANDSHAKE,
      params: { supportedProtocolVersions: [PROTOCOL_VERSION] },
    });

    await expect(channel.request(request)).rejects.toThrow(SAFE_MODEL_ERRORS.UNAVAILABLE);
    expect(squatterBearerRequests).toBe(0);
    await channel.close();
    expect(squatterBearerRequests).toBe(0);
  });

  test("rewrites only custom operation IDs on the wire and restores SDK correlation IDs", async () => {
    const inner = new InnerTransport();
    const transport = new CorrelatedMcpTransport(inner);
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => received.push(message);
    await transport.start();
    const request = HandshakeRequestSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "application_request_01",
      method: METHODS.HANDSHAKE,
      params: { supportedProtocolVersions: [PROTOCOL_VERSION] },
    });
    await transport.send({
      jsonrpc: "2.0",
      id: 7,
      method: request.method,
      params: request,
    });

    expect(inner.sent).toEqual([toMcpJsonRpcRequest(request)]);
    const response = HandshakeSuccessEnvelopeSchema.parse({
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true as const,
      result: {
        selectedProtocolVersion: 1 as const,
        broker: { brokerId: "broker_01", serverId: "server_01" },
        mcp: {
          transport: "streamable_http" as const,
          bind: "loopback" as const,
          path: "/mcp" as const,
          authentication: "bearer_client_principal" as const,
          exposure: "programmatic_plugin_only" as const,
        },
        events: {
          transport: "sse" as const,
          bind: "loopback" as const,
          path: "/events" as const,
          authentication: "bearer_client_principal" as const,
          content: "metadata_only" as const,
        },
      },
    });
    inner.onmessage?.(toMcpJsonRpcSuccessResponse(request, response));
    expect(received).toEqual([{ jsonrpc: "2.0", id: 7, result: response }]);
  });

  test("uses SDK initialize/initialized and its MCP session header before custom requests", async () => {
    const requests: Array<{
      authorization: string | null;
      sessionId: string | null;
      method: string | undefined;
      body: Record<string, unknown> | undefined;
      nonce: string | null;
      url: string;
    }> = [];
    const fetchMock = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const body =
        init?.body === undefined
          ? undefined
          : (JSON.parse(String(init.body)) as Record<string, unknown>);
      const headers = new Headers(init?.headers);
      requests.push({
        authorization: headers.get("authorization"),
        sessionId: headers.get("mcp-session-id"),
        method: init?.method,
        body,
        nonce: headers.get(AUTH_CHALLENGE_CLIENT_NONCE_HEADER),
        url: String(url),
      });
      if (new URL(url).pathname === AUTH_CHALLENGE_ENDPOINT) {
        const nonce = headers.get(AUTH_CHALLENGE_CLIENT_NONCE_HEADER);
        if (!nonce) throw new Error("missing test nonce");
        return Response.json(challengeResponse(nonce));
      }
      if (init?.method === "DELETE") return new Response(null, { status: 200 });
      if (body?.method === "initialize") {
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              serverInfo: { name: "agentbus-broker", version: "0.1.0" },
            },
          },
          { headers: { "MCP-Session-Id": "sdk_session_01" } },
        );
      }
      if (body?.method === "notifications/initialized") return new Response(null, { status: 202 });
      const application = body?.params as ApplicationOperationRequest;
      const response = HandshakeSuccessEnvelopeSchema.parse({
        protocolVersion: 1,
        requestId: application.requestId,
        ok: true as const,
        result: {
          selectedProtocolVersion: 1 as const,
          broker: { brokerId: "broker_01", serverId: "server_01" },
          mcp: {
            transport: "streamable_http" as const,
            bind: "loopback" as const,
            path: "/mcp" as const,
            authentication: "bearer_client_principal" as const,
            exposure: "programmatic_plugin_only" as const,
          },
          events: {
            transport: "sse" as const,
            bind: "loopback" as const,
            path: "/events" as const,
            authentication: "bearer_client_principal" as const,
            content: "metadata_only" as const,
          },
        },
      });
      return Response.json(toMcpJsonRpcSuccessResponse(application, response));
    };
    const channel = new SdkBrokerChannel({
      config: CONFIG,
      credential: credentialSnapshot().credential,
      onLoss: () => undefined,
      fetch: fetchMock,
    });
    const verifiedBroker = await channel.connect();
    const application = HandshakeRequestSchema.parse({
      protocolVersion: 1,
      requestId: "request_custom",
      method: METHODS.HANDSHAKE,
      params: { supportedProtocolVersions: [1] },
    });
    await channel.request(application);
    await Promise.all([
      channel.request(
        HandshakeRequestSchema.parse({
          ...application,
          requestId: "request_concurrent_a",
        }),
      ),
      channel.request(
        HandshakeRequestSchema.parse({
          ...application,
          requestId: "request_concurrent_b",
        }),
      ),
    ]);

    const posts = requests.filter((request) => request.method === "POST");
    expect(requests[0]).toMatchObject({
      authorization: null,
      body: undefined,
      method: "GET",
      url: `${CONFIG.endpoint}${AUTH_CHALLENGE_ENDPOINT}`,
    });
    expect(String(verifiedBroker.brokerId)).toBe("broker_01");
    expect(String(verifiedBroker.serverId)).toBe("server_01");
    expect(posts.map((request) => request.body?.method)).toEqual([
      "initialize",
      "notifications/initialized",
      METHODS.HANDSHAKE,
      METHODS.HANDSHAKE,
      METHODS.HANDSHAKE,
    ]);
    expect(posts[0]?.body?.id).toBe(0);
    expect(posts[2]?.body).toEqual(toMcpJsonRpcRequest(application));
    expect(posts[2]?.sessionId).toBe("sdk_session_01");
    expect(posts[2]?.authorization).toStartWith("Bearer ");
    await channel.close();
    expect(requests.find((request) => request.method === "DELETE")).toMatchObject({
      method: "DELETE",
      sessionId: "sdk_session_01",
      body: undefined,
    });
    const challengeRequests = requests.filter(
      (request) => new URL(request.url).pathname === AUTH_CHALLENGE_ENDPOINT,
    );
    const bearerIndexes = requests.flatMap((request, index) =>
      request.authorization === null ? [] : [index],
    );
    expect(challengeRequests).toHaveLength(bearerIndexes.length);
    expect(new Set(challengeRequests.map((request) => request.nonce)).size).toBe(
      challengeRequests.length,
    );
    for (const index of bearerIndexes) {
      expect(new URL(requests[index - 1]?.url ?? "http://invalid").pathname).toBe(
        AUTH_CHALLENGE_ENDPOINT,
      );
      expect(requests[index - 1]?.authorization).toBeNull();
    }
  });
});
