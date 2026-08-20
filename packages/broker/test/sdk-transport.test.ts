import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import {
  ApplicationResponseEnvelopeSchema,
  CredentialFileSchema,
  METHODS,
  PROTOCOL_VERSION,
  mcpJsonRpcResponseMatchesRequest,
  toMcpJsonRpcRequest,
  type ApplicationOperationRequest,
  type ApplicationResponseEnvelope,
  type Method,
} from "@opencode-agentbus/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
  Notification,
  Request,
  Result,
} from "@modelcontextprotocol/sdk/types.js";
import { BrokerDaemon } from "../src/server";
import { createHarness, requestId, type Harness } from "./helpers";

type AgentBusRequest = Request & {
  readonly method: Method;
  readonly params: ApplicationOperationRequest;
};
type AgentBusResult = Result & ApplicationResponseEnvelope;

function messageId(message: JSONRPCMessage): string | number | undefined {
  if (typeof message !== "object" || message === null || !("id" in message)) return undefined;
  return typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined;
}

class CorrelatedSdkTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  private readonly correlations = new Map<
    string,
    { readonly sdkId: string | number; readonly request: ApplicationOperationRequest }
  >();

  constructor(readonly inner: StreamableHTTPClientTransport) {}

  async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message) => this.receive(message);
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if (
      typeof message === "object" &&
      message !== null &&
      "method" in message &&
      Object.values(METHODS).includes(message.method as Method) &&
      "params" in message
    ) {
      const request = message.params as ApplicationOperationRequest;
      const wire = toMcpJsonRpcRequest(request);
      const sdkId = messageId(message);
      if (sdkId === undefined) throw new Error("SDK request ID is unavailable.");
      this.correlations.set(wire.id, { sdkId, request });
      await this.inner.send(wire, options);
      return;
    }
    await this.inner.send(message, options);
  }

  async close(): Promise<void> {
    this.correlations.clear();
    await this.inner.close();
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion(version);
  }

  private receive(message: JSONRPCMessage): void {
    const id = messageId(message);
    if (typeof id !== "string") {
      this.onmessage?.(message);
      return;
    }
    const correlation = this.correlations.get(id);
    if (!correlation) {
      this.onmessage?.(message);
      return;
    }
    this.correlations.delete(id);
    if (!("result" in message) || !mcpJsonRpcResponseMatchesRequest(correlation.request, message)) {
      this.onmessage?.({
        jsonrpc: "2.0",
        id: correlation.sdkId,
        error: { code: -32603, message: "Invalid broker response." },
      });
      return;
    }
    this.onmessage?.({ ...message, id: correlation.sdkId } as JSONRPCMessage);
  }
}

describe("real MCP SDK transport", () => {
  let harness: Harness | undefined;
  let daemon: BrokerDaemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    harness?.close();
    daemon = undefined;
    harness = undefined;
  });

  test("initializes, correlates a custom request, and terminates with authenticated SDK DELETE", async () => {
    harness = createHarness();
    daemon = new BrokerDaemon({ service: harness.service, hostname: "127.0.0.1", port: 0 });
    const endpoint = await daemon.start();
    const credential = CredentialFileSchema.parse(
      JSON.parse(readFileSync(harness.credentialFilePath, "utf8")),
    );
    const inner = new StreamableHTTPClientTransport(
      new URL(`${endpoint}/mcp`) as unknown as ConstructorParameters<
        typeof StreamableHTTPClientTransport
      >[0],
      {
        requestInit: {
          headers: { Authorization: `Bearer ${credential.token}` },
          redirect: "error",
        },
      },
    );
    const transport = new CorrelatedSdkTransport(inner);
    const client = new Client<AgentBusRequest, Notification, AgentBusResult>(
      { name: "broker-real-transport-test", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    expect(inner.sessionId).toBeDefined();
    expect(daemon.connectionCounts().mcp).toBe(1);

    const request = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId("real-sdk"),
      method: METHODS.HANDSHAKE,
      params: { supportedProtocolVersions: [PROTOCOL_VERSION] },
    } as const;
    const response = await client.request(
      { method: request.method, params: request },
      ApplicationResponseEnvelopeSchema,
    );
    expect(response.ok).toBe(true);
    expect(response.requestId).toBe(request.requestId);

    await inner.terminateSession();
    expect(daemon.connectionCounts().mcp).toBe(0);
    await client.close();
  });
});
