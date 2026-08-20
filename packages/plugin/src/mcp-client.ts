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
import {
  ApplicationResponseEnvelopeSchema,
  METHODS,
  mcpJsonRpcResponseMatchesRequest,
  toMcpJsonRpcRequest,
  toMcpJsonRpcSuccessResponse,
} from "@opencode-agentbus/protocol";
import type {
  ApplicationOperationRequest,
  ApplicationResponseEnvelope,
  BrokerServerIdentity,
  CredentialFile,
  Method,
  TrustedConnectionConfig,
} from "@opencode-agentbus/protocol";

import { type PluginFetch, authenticateBrokerListener } from "./auth-challenge";
import { SAFE_MODEL_ERRORS, SafeModelError } from "./errors";

const APPLICATION_METHODS = new Set<string>(Object.values(METHODS));
const MAX_PENDING_AUTHENTICATED_FETCHES = 64;

type AgentBusMcpRequest = Request & {
  readonly method: Method;
  readonly params: ApplicationOperationRequest;
};
type AgentBusMcpResult = Result & ApplicationResponseEnvelope;

export interface BrokerChannel {
  connect(): Promise<BrokerServerIdentity>;
  request(request: ApplicationOperationRequest): Promise<unknown>;
  close(): Promise<void>;
}

export interface BrokerChannelFactoryInput {
  readonly config: TrustedConnectionConfig;
  readonly credential: CredentialFile;
  readonly onLoss: () => void;
}

export type BrokerChannelFactory = (input: BrokerChannelFactoryInput) => BrokerChannel;

function objectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function responseId(message: JSONRPCMessage): string | number | undefined {
  if (!objectValue(message) || !("id" in message)) return undefined;
  return typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined;
}

function protocolFailure(id: string | number): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32603, message: SAFE_MODEL_ERRORS.INVALID_RESPONSE },
  };
}

/**
 * The SDK owns initialization, notifications, and session handling. This adapter only maps the
 * SDK's internal numeric request ID to the protocol's required application request ID on the wire.
 */
export class CorrelatedMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  private readonly correlations = new Map<
    string,
    { readonly sdkId: string | number; readonly request: ApplicationOperationRequest }
  >();

  constructor(
    private readonly inner: Transport,
    private readonly observeLoss: () => void = () => undefined,
  ) {}

  async start(): Promise<void> {
    this.inner.onclose = () => {
      this.observeLoss();
      this.onclose?.();
    };
    this.inner.onerror = () => {
      this.observeLoss();
      this.onerror?.(new Error(SAFE_MODEL_ERRORS.UNAVAILABLE));
    };
    this.inner.onmessage = (message, extra) => this.receive(message, extra);
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const messageRecord = message as unknown as Record<string, unknown>;
    if (
      objectValue(messageRecord) &&
      typeof messageRecord.method === "string" &&
      APPLICATION_METHODS.has(messageRecord.method) &&
      "id" in messageRecord
    ) {
      const request = messageRecord.params;
      const parsedRequest = toMcpJsonRpcRequest(request as ApplicationOperationRequest);
      const sdkId = responseId(message);
      if (sdkId === undefined) throw new SafeModelError(SAFE_MODEL_ERRORS.INVALID_REQUEST);
      this.correlations.set(parsedRequest.id, { sdkId, request: parsedRequest.params });
      try {
        await this.inner.send(parsedRequest, options);
      } catch {
        this.correlations.delete(parsedRequest.id);
        throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
      }
      return;
    }
    await this.inner.send(message, options);
  }

  async close(): Promise<void> {
    this.correlations.clear();
    await this.inner.close();
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  private receive(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
    const id = responseId(message);
    if (typeof id !== "string") {
      this.onmessage?.(message, extra);
      return;
    }
    const correlation = this.correlations.get(id);
    if (!correlation) {
      this.onmessage?.(message, extra);
      return;
    }
    this.correlations.delete(id);

    if (objectValue(message) && "result" in message) {
      if (!mcpJsonRpcResponseMatchesRequest(correlation.request, message)) {
        this.onmessage?.(protocolFailure(correlation.sdkId), extra);
        return;
      }
      this.onmessage?.({ ...message, id: correlation.sdkId } as JSONRPCMessage, extra);
      return;
    }
    if (objectValue(message) && "error" in message) {
      this.onmessage?.(protocolFailure(correlation.sdkId), extra);
    }
  }
}

export interface SdkBrokerChannelInput extends BrokerChannelFactoryInput {
  readonly fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
}

export class SdkBrokerChannel implements BrokerChannel {
  private readonly activeFetchControllers = new Set<AbortController>();
  private client: Client<AgentBusMcpRequest, Notification, AgentBusMcpResult> | undefined;
  private httpTransport: StreamableHTTPClientTransport | undefined;
  private pinnedBroker: BrokerServerIdentity | undefined;
  private fetchQueue: Promise<void> = Promise.resolve();
  private pendingAuthenticatedFetches = 0;
  private connected = false;
  private terminationAllowed = false;
  private closing = false;
  private closed = false;

  constructor(private readonly input: SdkBrokerChannelInput) {}

  async connect(): Promise<BrokerServerIdentity> {
    try {
      if (this.closed || this.client) throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
      const client = new Client<AgentBusMcpRequest, Notification, AgentBusMcpResult>(
        { name: "opencode-agentbus-plugin", version: "0.1.0" },
        { capabilities: {} },
      );
      const endpoint = new globalThis.URL(
        `${this.input.config.endpoint}/mcp`,
      ) as unknown as ConstructorParameters<typeof StreamableHTTPClientTransport>[0];
      const inner = new StreamableHTTPClientTransport(endpoint, {
        requestInit: {
          headers: { Authorization: `Bearer ${this.input.credential.token}` },
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
        },
        fetch: this.fetchWithChallenge,
      });
      const transport = new CorrelatedMcpTransport(inner as unknown as Transport, () => {
        if (!this.closing) this.input.onLoss();
      });
      this.client = client;
      this.httpTransport = inner;
      await client.connect(transport, { timeout: this.input.config.timeoutMs });
      await this.fetchQueue;
      if (this.closed) throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
      const pinnedBroker = this.pinnedBroker;
      if (!pinnedBroker) throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
      this.connected = true;
      return pinnedBroker;
    } catch {
      this.closing = true;
      for (const controller of this.activeFetchControllers) controller.abort();
      this.terminationAllowed = true;
      await this.httpTransport?.terminateSession().catch(() => undefined);
      this.terminationAllowed = false;
      await this.client?.close().catch(() => undefined);
      for (const controller of this.activeFetchControllers) controller.abort();
      this.closed = true;
      throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
    }
  }

  async request(request: ApplicationOperationRequest): Promise<ApplicationResponseEnvelope> {
    try {
      const client = this.client;
      if (!client || this.closed) throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
      const response = await client.request(
        { method: request.method, params: request },
        ApplicationResponseEnvelopeSchema,
        { timeout: this.input.config.timeoutMs },
      );
      toMcpJsonRpcSuccessResponse(request, response);
      return response;
    } catch (error) {
      if (error instanceof SafeModelError) throw error;
      throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
    }
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    for (const controller of this.activeFetchControllers) controller.abort();
    if (this.connected) {
      this.terminationAllowed = true;
      await this.httpTransport?.terminateSession().catch(() => undefined);
      this.terminationAllowed = false;
    }
    await this.client?.close().catch(() => undefined);
    for (const controller of this.activeFetchControllers) controller.abort();
    this.connected = false;
    this.closed = true;
  }

  private readonly fetchWithChallenge: PluginFetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("authorization")) {
      return (this.input.fetch ?? fetch)(url, init);
    }
    if (this.pendingAuthenticatedFetches >= MAX_PENDING_AUTHENTICATED_FETCHES) {
      throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
    }
    this.pendingAuthenticatedFetches += 1;
    const work = this.fetchQueue
      .catch(() => undefined)
      .then(() => this.performAuthenticatedFetch(url, init));
    this.fetchQueue = work.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await work;
    } finally {
      this.pendingAuthenticatedFetches -= 1;
    }
  };

  private async performAuthenticatedFetch(
    url: string | URL,
    init: RequestInit | undefined,
  ): Promise<Response> {
    const headers = new Headers(init?.headers);
    const isTermination = init?.method === "DELETE" && this.terminationAllowed;
    if (this.closed || (this.closing && !isTermination)) {
      throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
    }

    const controller = new AbortController();
    const upstreamSignal = init?.signal;
    const abort = () => controller.abort();
    if (upstreamSignal?.aborted) controller.abort();
    else upstreamSignal?.addEventListener("abort", abort, { once: true });
    this.activeFetchControllers.add(controller);
    try {
      const verifiedBroker = await authenticateBrokerListener({
        config: this.input.config,
        controller,
        credential: this.input.credential,
        fetchImplementation: this.input.fetch ?? fetch,
      });
      const pinnedBroker = this.pinnedBroker;
      if (pinnedBroker) {
        if (
          pinnedBroker.brokerId !== verifiedBroker.brokerId ||
          pinnedBroker.serverId !== verifiedBroker.serverId
        ) {
          throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
        }
      } else {
        this.pinnedBroker = verifiedBroker;
      }
      if (controller.signal.aborted || this.closed || (this.closing && !isTermination)) {
        throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
      }
      return await (this.input.fetch ?? fetch)(url, {
        ...init,
        headers,
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    } catch {
      throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
    } finally {
      upstreamSignal?.removeEventListener("abort", abort);
      this.activeFetchControllers.delete(controller);
    }
  }
}

export const defaultBrokerChannelFactory: BrokerChannelFactory = (input) =>
  new SdkBrokerChannel(input);
