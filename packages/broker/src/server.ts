import { Buffer } from "node:buffer";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  AUTH_CHALLENGE_CLIENT_NONCE_HEADER,
  AUTH_CHALLENGE_CONTENT_TYPE,
  AUTH_CHALLENGE_ENDPOINT,
  AuthChallengeRequestSchema,
  ERROR_MESSAGES,
  EVENT_STREAM_REPLAY_CONTRACT,
  MCP_HTTP_CONTRACT,
  MCP_INITIALIZATION_CONTRACT,
  METHODS,
  McpJsonRpcRequestSchema,
  PENDING_MESSAGE_EVENT_TYPE,
  RequestIdSchema,
  SSE_HTTP_CONTRACT,
  createErrorEnvelope,
  formatPendingMessageSseEvent,
  formatSseComment,
  type AuthenticatedClientPrincipal,
  type CredentialFile,
  type ErrorCode as ApplicationErrorCode,
  type Method,
  type PendingMessageEvent,
  type SafeErrorDetails,
} from "@opencode-agentbus/protocol";
import { z } from "zod";
import { principalsEqual } from "./store";
import type { BrokerService, Clock } from "./service";

const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 4097;
const DEFAULT_EVENT_HEARTBEAT_MS = 15_000;
const DEFAULT_MCP_SESSION_IDLE_MS = 5 * 60 * 1_000;
const DEFAULT_MCP_REAP_INTERVAL_MS = 30_000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 30_000;
const DEFAULT_MAX_MCP_SESSIONS_PER_PRINCIPAL = 32;
const DEFAULT_MAX_SSE_CONNECTIONS_PER_PRINCIPAL = 8;
const DEFAULT_MAX_SSE_BUFFERED_BYTES = 64 * 1_024;
const DEFAULT_MAX_AUTH_CHALLENGES_PER_MINUTE = 4_096;
const MAX_HTTP_BODY_BYTES = 128 * 1024;

interface McpContext {
  readonly principal: AuthenticatedClientPrincipal;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly server: Server;
  sessionId?: string;
  initialized: boolean;
  applicationHandshakeComplete: boolean;
  lastUsedMs: number;
  inFlight: number;
  closing: boolean;
}

interface EventConnection {
  readonly principal: AuthenticatedClientPrincipal;
  close(): void;
}

export interface BrokerDaemonOptions {
  readonly service: BrokerService;
  readonly hostname?: string;
  readonly port?: number;
  readonly eventHeartbeatMs?: number;
  readonly clock?: Clock;
  readonly maxMcpSessionsPerPrincipal?: number;
  readonly maxSseConnectionsPerPrincipal?: number;
  readonly maxSseBufferedBytes?: number;
  readonly mcpSessionIdleMs?: number;
  readonly mcpReapIntervalMs?: number;
  readonly maintenanceIntervalMs?: number;
  readonly maxAuthChallengesPerMinute?: number;
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function plainError(status: number): Response {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function challengeError(
  status: number,
  code: ApplicationErrorCode,
  details?: SafeErrorDetails,
  retryAfterMs?: number,
): Response {
  const requestId = RequestIdSchema.parse(
    `challenge-${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`,
  );
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "Content-Type": AUTH_CHALLENGE_CONTENT_TYPE,
    "X-Content-Type-Options": "nosniff",
  };
  if (retryAfterMs !== undefined) {
    headers["Retry-After"] = String(Math.max(1, Math.ceil(retryAfterMs / 1_000)));
  }
  return new Response(JSON.stringify(createErrorEnvelope(requestId, code, details)), {
    status,
    headers,
  });
}

function withSafeHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function customRequestSchema(method: Method) {
  return z
    .object({
      method: z.literal(method),
      params: z.record(z.unknown()),
    })
    .passthrough();
}

function randomSessionId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

export function validateListenHost(hostname: string): "127.0.0.1" | "::1" {
  if (hostname !== "127.0.0.1" && hostname !== "::1") {
    throw new TypeError("Broker hostname must be literal loopback.");
  }
  return hostname;
}

function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("Broker port is invalid.");
  }
  return port;
}

function validateHeartbeat(milliseconds: number): number {
  if (!Number.isInteger(milliseconds) || milliseconds < 1 || milliseconds > 60_000) {
    throw new TypeError("Event heartbeat interval is invalid.");
  }
  return milliseconds;
}

function validatePositiveInteger(value: number, kind: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${kind} is invalid.`);
  }
  return value;
}

export class BrokerDaemon {
  private readonly service: BrokerService;
  private readonly hostname: "127.0.0.1" | "::1";
  private readonly requestedPort: number;
  private readonly eventHeartbeatMs: number;
  private readonly clock: Clock;
  private readonly maxMcpSessionsPerPrincipal: number;
  private readonly maxSseConnectionsPerPrincipal: number;
  private readonly maxSseBufferedBytes: number;
  private readonly mcpSessionIdleMs: number;
  private readonly mcpReapIntervalMs: number;
  private readonly maintenanceIntervalMs: number;
  private readonly maxAuthChallengesPerMinute: number;
  private authChallengeTokens: number;
  private authChallengeLastRefillMs: number;
  private readonly mcpSessions = new Map<string, McpContext>();
  private readonly mcpContexts = new Set<McpContext>();
  private readonly eventConnections = new Set<EventConnection>();
  private applicationHandshakeComplete = false;
  private listener: ReturnType<typeof Bun.serve> | undefined;
  private reapTimer: ReturnType<typeof setInterval> | undefined;
  private maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;
  private rotating = false;

  constructor(options: BrokerDaemonOptions) {
    this.service = options.service;
    this.hostname = validateListenHost(options.hostname ?? DEFAULT_HOSTNAME);
    this.requestedPort = validatePort(options.port ?? DEFAULT_PORT);
    this.eventHeartbeatMs = validateHeartbeat(
      options.eventHeartbeatMs ?? DEFAULT_EVENT_HEARTBEAT_MS,
    );
    this.clock = options.clock ?? { now: () => Date.now() };
    this.maxMcpSessionsPerPrincipal = validatePositiveInteger(
      options.maxMcpSessionsPerPrincipal ?? DEFAULT_MAX_MCP_SESSIONS_PER_PRINCIPAL,
      "MCP session limit",
      256,
    );
    this.maxSseConnectionsPerPrincipal = validatePositiveInteger(
      options.maxSseConnectionsPerPrincipal ?? DEFAULT_MAX_SSE_CONNECTIONS_PER_PRINCIPAL,
      "SSE connection limit",
      256,
    );
    this.maxSseBufferedBytes = validatePositiveInteger(
      options.maxSseBufferedBytes ?? DEFAULT_MAX_SSE_BUFFERED_BYTES,
      "SSE buffer limit",
      1024 * 1_024,
    );
    this.mcpSessionIdleMs = validatePositiveInteger(
      options.mcpSessionIdleMs ?? DEFAULT_MCP_SESSION_IDLE_MS,
      "MCP idle timeout",
      24 * 60 * 60 * 1_000,
    );
    this.mcpReapIntervalMs = validatePositiveInteger(
      options.mcpReapIntervalMs ?? DEFAULT_MCP_REAP_INTERVAL_MS,
      "MCP reap interval",
      60 * 60 * 1_000,
    );
    this.maintenanceIntervalMs = validatePositiveInteger(
      options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS,
      "Maintenance interval",
      60 * 60 * 1_000,
    );
    this.maxAuthChallengesPerMinute = validatePositiveInteger(
      options.maxAuthChallengesPerMinute ?? DEFAULT_MAX_AUTH_CHALLENGES_PER_MINUTE,
      "Authentication challenge rate limit",
      10_000,
    );
    this.authChallengeTokens = this.maxAuthChallengesPerMinute;
    this.authChallengeLastRefillMs = this.clock.now();
  }

  async start(): Promise<string> {
    if (this.listener) throw new Error("Broker daemon is already listening.");
    if (this.stopping) throw new Error("Broker daemon cannot be restarted after shutdown.");
    this.listener = Bun.serve({
      hostname: this.hostname,
      port: this.requestedPort,
      idleTimeout: 30,
      maxRequestBodySize: MAX_HTTP_BODY_BYTES,
      fetch: (request) => this.handleRequest(request),
      error: () => plainError(500),
    });
    this.reapTimer = setInterval(() => {
      void this.reapIdleSessions();
    }, this.mcpReapIntervalMs);
    this.reapTimer.unref?.();
    this.maintenanceTimer = setInterval(() => {
      try {
        this.service.maintenance();
      } catch {
        // Periodic maintenance is best-effort; request paths continue to fail closed.
      }
    }, this.maintenanceIntervalMs);
    this.maintenanceTimer.unref?.();
    return this.endpoint;
  }

  get endpoint(): string {
    const port = this.listener?.port ?? this.requestedPort;
    const host = this.hostname === "::1" ? "[::1]" : this.hostname;
    return `http://${host}:${port}`;
  }

  async handleRequest(request: Request): Promise<Response> {
    if (this.stopping || this.rotating) return plainError(503);
    let pathname: string;
    let search: string;
    try {
      const parsedUrl = new URL(request.url);
      pathname = parsedUrl.pathname;
      search = parsedUrl.search;
    } catch {
      return plainError(400);
    }
    if (pathname === AUTH_CHALLENGE_ENDPOINT) {
      return this.handleAuthChallenge(request, pathname, search);
    }

    const principal = this.service.authenticate(request.headers.get("authorization"));
    if (!principal) {
      const response = jsonRpcError(401, -32001, ERROR_MESSAGES.UNAUTHENTICATED);
      response.headers.set("WWW-Authenticate", "Bearer");
      return response;
    }
    if (!this.validHost(request.headers.get("host")) || request.headers.has("origin")) {
      return plainError(403);
    }
    if (search.length > 0) return plainError(404);
    if (pathname === MCP_HTTP_CONTRACT.path) {
      return this.handleMcp(request, principal);
    }
    if (pathname === SSE_HTTP_CONTRACT.path) {
      return this.handleEvents(request, principal);
    }
    return plainError(404);
  }

  async rotateCredential(): Promise<CredentialFile> {
    if (this.rotating || this.stopping) throw new Error("Broker is not available for rotation.");
    this.rotating = true;
    try {
      await this.closeConnections();
      this.applicationHandshakeComplete = false;
      return this.service.rotateCredential();
    } finally {
      this.rotating = false;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.reapTimer) clearInterval(this.reapTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.reapTimer = undefined;
    this.maintenanceTimer = undefined;
    this.authChallengeTokens = this.maxAuthChallengesPerMinute;
    this.authChallengeLastRefillMs = this.clock.now();
    this.applicationHandshakeComplete = false;
    const listener = this.listener;
    this.listener = undefined;
    const stopped = listener?.stop(true);
    await this.closeConnections();
    await stopped;
    this.service.close();
  }

  connectionCounts(): { readonly mcp: number; readonly sse: number } {
    return { mcp: this.mcpContexts.size, sse: this.eventConnections.size };
  }

  authChallengeRateStateForTesting(): {
    readonly capacity: number;
    readonly availableTokens: number;
  } {
    this.refillAuthChallengeTokens();
    return {
      capacity: this.maxAuthChallengesPerMinute,
      availableTokens: this.authChallengeTokens,
    };
  }

  async reapIdleSessions(): Promise<number> {
    const cutoff = this.clock.now() - this.mcpSessionIdleMs;
    const expired = [...this.mcpContexts].filter(
      (context) => !context.closing && context.inFlight === 0 && context.lastUsedMs <= cutoff,
    );
    await Promise.allSettled(expired.map((context) => this.closeMcpContext(context)));
    return expired.length;
  }

  private validHost(host: string | null): boolean {
    if (!host) return false;
    const expectedHost =
      this.hostname === "::1"
        ? `[::1]:${this.listener?.port}`
        : `${this.hostname}:${this.listener?.port}`;
    return host === expectedHost;
  }

  private handleAuthChallenge(request: Request, pathname: string, search: string): Response {
    const retryAfterMs = this.takeAuthChallengeAttempt();
    if (retryAfterMs !== undefined) {
      const details = { retryAfterMs } as const;
      return challengeError(429, "RATE_LIMITED", details, retryAfterMs);
    }
    if (!this.validHost(request.headers.get("host")) || request.headers.has("origin")) {
      return challengeError(403, "FORBIDDEN");
    }

    const contentLength = request.headers.get("content-length");
    const hasBody =
      request.body !== null ||
      request.headers.has("transfer-encoding") ||
      (contentLength !== null && contentLength !== "0");
    const parsed = AuthChallengeRequestSchema.safeParse({
      method: request.method,
      path: pathname,
      query: search,
      authorization: request.headers.has("authorization")
        ? request.headers.get("authorization")
        : null,
      clientNonce: request.headers.get(AUTH_CHALLENGE_CLIENT_NONCE_HEADER),
      body: hasBody ? "present" : null,
    });
    if (!parsed.success) return challengeError(400, "INVALID_REQUEST");

    try {
      const response = this.service.createAuthChallenge(parsed.data.clientNonce);
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": AUTH_CHALLENGE_CONTENT_TYPE,
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return challengeError(500, "INTERNAL_ERROR");
    }
  }

  private takeAuthChallengeAttempt(): number | undefined {
    this.refillAuthChallengeTokens();
    if (this.authChallengeTokens < 1) {
      const millisecondsPerToken = 60_000 / this.maxAuthChallengesPerMinute;
      const retryAfterMs = Math.ceil((1 - this.authChallengeTokens) * millisecondsPerToken);
      return Math.max(100, Math.min(60_000, retryAfterMs));
    }
    this.authChallengeTokens -= 1;
    return undefined;
  }

  private refillAuthChallengeTokens(): void {
    const now = this.clock.now();
    const elapsedMs = now - this.authChallengeLastRefillMs;
    if (elapsedMs <= 0) return;
    this.authChallengeTokens = Math.min(
      this.maxAuthChallengesPerMinute,
      this.authChallengeTokens + (elapsedMs * this.maxAuthChallengesPerMinute) / 60_000,
    );
    this.authChallengeLastRefillMs = now;
  }

  private async handleMcp(
    request: Request,
    principal: AuthenticatedClientPrincipal,
  ): Promise<Response> {
    if (request.method !== MCP_HTTP_CONTRACT.method && request.method !== "DELETE") {
      return plainError(405);
    }
    if (request.method === MCP_HTTP_CONTRACT.method) {
      const length = request.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_HTTP_BODY_BYTES)) {
        return jsonRpcError(413, -32600, "Request body is too large.");
      }
    }

    await this.reapIdleSessions();
    const sessionId = request.headers.get(MCP_INITIALIZATION_CONTRACT.sessionHeader);
    let context: McpContext;
    let transient = false;
    if (sessionId) {
      const existing = this.mcpSessions.get(sessionId);
      if (!existing || !principalsEqual(existing.principal, principal)) {
        return jsonRpcError(404, -32001, "Session not found.");
      }
      context = existing;
    } else {
      if (request.method === "DELETE") {
        return jsonRpcError(400, -32600, "MCP session header is required.");
      }
      if (this.mcpCountForPrincipal(principal) >= this.maxMcpSessionsPerPrincipal) {
        return jsonRpcError(429, -32000, "Connection limit exceeded.");
      }
      transient = true;
      context = await this.createMcpContext(principal);
    }

    context.inFlight += 1;
    context.lastUsedMs = this.clock.now();
    try {
      const response = await context.transport.handleRequest(request);
      if (transient && context.transport.sessionId === undefined) {
        await this.closeMcpContext(context);
      }
      if (request.method === "DELETE") {
        await this.closeMcpContext(context);
      }
      return withSafeHeaders(response);
    } catch {
      if (transient) await this.closeMcpContext(context);
      return jsonRpcError(400, -32700, "Parse error.");
    } finally {
      context.inFlight = Math.max(0, context.inFlight - 1);
      if (!context.closing) context.lastUsedMs = this.clock.now();
    }
  }

  private async createMcpContext(principal: AuthenticatedClientPrincipal): Promise<McpContext> {
    const holder: { context?: McpContext } = {};
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomSessionId,
      enableJsonResponse: true,
      keepAliveMs: 0,
      onsessioninitialized: (sessionId) => {
        if (holder.context && !holder.context.closing) {
          holder.context.sessionId = sessionId;
          holder.context.lastUsedMs = this.clock.now();
          this.mcpSessions.set(sessionId, holder.context);
        }
      },
      onsessionclosed: (sessionId) => {
        this.mcpSessions.delete(sessionId);
      },
    });
    const server = new Server(
      { name: "opencode-agentbus-broker", version: "0.1.0" },
      { capabilities: {} },
    );
    const context: McpContext = {
      principal,
      transport,
      server,
      initialized: false,
      applicationHandshakeComplete: false,
      lastUsedMs: this.clock.now(),
      inFlight: 0,
      closing: false,
    };
    holder.context = context;
    server.onerror = () => {
      // SDK errors are intentionally not forwarded to logs because they may include request details.
    };
    server.oninitialized = () => {
      context.initialized = true;
      context.lastUsedMs = this.clock.now();
    };
    for (const method of Object.values(METHODS)) {
      server.setRequestHandler(customRequestSchema(method), (request, extra) => {
        if (!context.initialized) {
          throw new McpError(ErrorCode.InvalidRequest, "MCP initialization is incomplete.");
        }
        if (method !== METHODS.HANDSHAKE && !context.applicationHandshakeComplete) {
          throw new McpError(ErrorCode.InvalidRequest, "Agent Bus handshake is incomplete.");
        }
        const outerRequestId = RequestIdSchema.safeParse(extra.requestId);
        const applicationRequest = request.params;
        if (
          !outerRequestId.success ||
          applicationRequest.requestId !== outerRequestId.data ||
          applicationRequest.method !== method
        ) {
          throw new McpError(ErrorCode.InvalidRequest, "Invalid custom JSON-RPC correlation.");
        }
        const wire = McpJsonRpcRequestSchema.safeParse({
          jsonrpc: "2.0",
          id: outerRequestId.data,
          method,
          params: applicationRequest,
        });
        if (!wire.success) {
          // The service performs safe application validation; only framing/correlation fails here.
          const response = this.service.dispatch(principal, applicationRequest);
          if (!response.ok && response.error.code === "INVALID_REQUEST") return response;
          throw new McpError(ErrorCode.InvalidRequest, "Invalid custom JSON-RPC request.");
        }
        const response = this.service.dispatch(principal, wire.data.params);
        if (method === METHODS.HANDSHAKE && response.ok) {
          context.applicationHandshakeComplete = true;
          this.applicationHandshakeComplete = true;
        }
        return response;
      });
    }
    this.mcpContexts.add(context);
    try {
      await server.connect(transport);
      return context;
    } catch (error) {
      await this.closeMcpContext(context);
      throw error;
    }
  }

  private mcpCountForPrincipal(principal: AuthenticatedClientPrincipal): number {
    return [...this.mcpContexts].filter(
      (context) => !context.closing && principalsEqual(context.principal, principal),
    ).length;
  }

  private async closeMcpContext(context: McpContext): Promise<void> {
    if (context.closing) return;
    context.closing = true;
    if (context.sessionId) this.mcpSessions.delete(context.sessionId);
    this.mcpContexts.delete(context);
    await context.server.close().catch(() => undefined);
  }

  private handleEvents(request: Request, principal: AuthenticatedClientPrincipal): Response {
    if (request.method !== SSE_HTTP_CONTRACT.method) return plainError(405);
    if (!request.headers.get("accept")?.includes(SSE_HTTP_CONTRACT.accept)) {
      return plainError(406);
    }
    if (!this.applicationHandshakeComplete) return plainError(409);
    const principalConnections = [...this.eventConnections].filter((connection) =>
      principalsEqual(connection.principal, principal),
    ).length;
    if (principalConnections >= this.maxSseConnectionsPerPrincipal) return plainError(429);

    const pendingLiveEvents: PendingMessageEvent[] = [];
    let deliver: (event: PendingMessageEvent) => void = (event) => {
      pendingLiveEvents.push(event);
    };
    const unsubscribe = this.service.subscribeEvents(principal, (event) => deliver(event));
    const cursor = request.headers.get(SSE_HTTP_CONTRACT.cursorHeader) ?? undefined;
    const replay = this.service.replayEvents(principal, cursor ?? "");
    if (!replay.ok) {
      unsubscribe();
      return new Response(JSON.stringify(replay.error), {
        status: EVENT_STREAM_REPLAY_CONTRACT.cursorExpiredHttpStatus,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const encoder = new TextEncoder();
    const queued: Uint8Array[] = [];
    let queuedBytes = 0;
    let closed = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      queued.length = 0;
      queuedBytes = 0;
      unsubscribe();
      this.eventConnections.delete(connection);
      try {
        controller?.close();
      } catch {
        // The client may already have cancelled its stream.
      }
    };
    const connection: EventConnection = { principal, close };
    this.eventConnections.add(connection);

    const drain = () => {
      while (!closed && queued.length > 0 && (controller?.desiredSize ?? 0) > 0) {
        const frame = queued.shift();
        if (!frame) break;
        queuedBytes -= frame.byteLength;
        controller?.enqueue(frame);
      }
    };
    const send = (frame: string) => {
      if (closed) return;
      const bytes = encoder.encode(frame);
      if (queued.length === 0 && (controller?.desiredSize ?? 0) > 0) {
        controller?.enqueue(bytes);
        return;
      }
      if (queuedBytes + bytes.byteLength > this.maxSseBufferedBytes) {
        close();
        return;
      }
      queued.push(bytes);
      queuedBytes += bytes.byteLength;
    };

    const stream = new ReadableStream<Uint8Array>({
      start: (streamController) => {
        controller = streamController;
        const initialEventIds = new Set<string>();
        const sendInitial = (event: PendingMessageEvent) => {
          if (initialEventIds.has(event.eventId)) return;
          initialEventIds.add(event.eventId);
          send(formatPendingMessageSseEvent(event));
        };
        for (const event of replay.events) sendInitial(event);
        for (const event of pendingLiveEvents) sendInitial(event);
        pendingLiveEvents.length = 0;
        deliver = (event) => send(formatPendingMessageSseEvent(event));
        initialEventIds.clear();
        if (closed) return;
        heartbeat = setInterval(() => send(formatSseComment("heartbeat")), this.eventHeartbeatMs);
        heartbeat.unref?.();
      },
      pull: () => drain(),
      cancel: () => close(),
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": SSE_HTTP_CONTRACT.contentType,
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  private async closeConnections(): Promise<void> {
    for (const connection of [...this.eventConnections]) connection.close();
    const contexts = [...this.mcpContexts];
    this.mcpSessions.clear();
    await Promise.allSettled(contexts.map((context) => this.closeMcpContext(context)));
  }
}

export const BROKER_DEFAULTS = Object.freeze({
  hostname: DEFAULT_HOSTNAME,
  port: DEFAULT_PORT,
  pendingEventType: PENDING_MESSAGE_EVENT_TYPE,
});
