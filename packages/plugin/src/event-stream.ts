import { PENDING_MESSAGE_EVENT_TYPE, PendingMessageEventSchema } from "@opencode-agentbus/protocol";
import type {
  CredentialFile,
  PendingMessageEvent,
  TrustedConnectionConfig,
} from "@opencode-agentbus/protocol";

import {
  type PluginFetch,
  authenticateBrokerListener,
  fetchResponseHeaders,
} from "./auth-challenge";

const MAX_SSE_LINE_BYTES = 16_384;
const MAX_SSE_FRAME_DATA_BYTES = 16_384;
const MAX_SSE_UNTERMINATED_BYTES = 16_384;
const MAX_SSE_CHUNK_PROCESSING_BYTES = 1_048_576;

class InvalidSseFrameError extends Error {}

export interface EventStreamDisconnect {
  readonly lastEventId?: string;
  readonly staleCursor: boolean;
  readonly requiresRecovery?: true;
}

export interface EventStreamStartInput {
  readonly lastEventId?: string;
  readonly onEvent: (event: PendingMessageEvent) => Promise<void>;
  readonly onDisconnect: (disconnect: EventStreamDisconnect) => void;
}

export interface PrincipalEventStream {
  start(input: EventStreamStartInput): Promise<void>;
  close(): Promise<void>;
}

export interface PrincipalEventStreamFactoryInput {
  readonly config: TrustedConnectionConfig;
  readonly credential: CredentialFile;
}

export type PrincipalEventStreamFactory = (
  input: PrincipalEventStreamFactoryInput,
) => PrincipalEventStream;

export class AuthenticatedPrincipalEventStream implements PrincipalEventStream {
  private readonly controller = new AbortController();
  private closed = false;

  constructor(
    private readonly input: PrincipalEventStreamFactoryInput,
    private readonly fetchImplementation: PluginFetch = fetch,
  ) {}

  async start(startInput: EventStreamStartInput): Promise<void> {
    let response: Response;
    try {
      await authenticateBrokerListener({
        config: this.input.config,
        controller: this.controller,
        credential: this.input.credential,
        fetchImplementation: this.fetchImplementation,
      });
      if (this.closed) return;
      const headers = new Headers({
        Accept: "text/event-stream",
        Authorization: `Bearer ${this.input.credential.token}`,
      });
      if (startInput.lastEventId !== undefined) {
        headers.set("Last-Event-ID", startInput.lastEventId);
      }
      response = await fetchResponseHeaders({
        controller: this.controller,
        fetchImplementation: this.fetchImplementation,
        init: {
          method: "GET",
          headers,
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
        },
        timeoutMs: this.input.config.timeoutMs,
        url: `${this.input.config.endpoint}/events`,
      });
    } catch {
      if (!this.closed) {
        startInput.onDisconnect({
          ...(startInput.lastEventId === undefined ? {} : { lastEventId: startInput.lastEventId }),
          staleCursor: false,
        });
      }
      return;
    }

    if (response.status === 409) {
      await response.body?.cancel().catch(() => undefined);
      if (!this.closed) {
        startInput.onDisconnect({
          ...(startInput.lastEventId === undefined ? {} : { lastEventId: startInput.lastEventId }),
          staleCursor: true,
          requiresRecovery: true,
        });
      }
      return;
    }
    if (!response.ok || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
      await response.body?.cancel().catch(() => undefined);
      if (!this.closed) {
        startInput.onDisconnect({
          ...(startInput.lastEventId === undefined ? {} : { lastEventId: startInput.lastEventId }),
          staleCursor: false,
        });
      }
      return;
    }

    void this.read(response, startInput);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.controller.abort();
  }

  private async read(response: Response, input: EventStreamStartInput): Promise<void> {
    let lastEventId = input.lastEventId;
    let requiresRecovery = false;
    let reachedEof = false;
    let reader:
      | Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel" | "releaseLock">
      | undefined;
    try {
      reader = response.body?.getReader();
      if (!reader) throw new Error("missing stream");
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffered = "";
      let frameId: string | undefined;
      let frameEvent: string | undefined;
      let frameData: string | undefined;
      let frameDataBytes = 0;

      const dispatch = async (): Promise<void> => {
        if (frameEvent === PENDING_MESSAGE_EVENT_TYPE) {
          if (frameId === undefined || frameData === undefined) throw new InvalidSseFrameError();
          let candidate: unknown;
          try {
            candidate = JSON.parse(frameData);
          } catch {
            throw new InvalidSseFrameError();
          }
          const parsed = PendingMessageEventSchema.safeParse(candidate);
          if (!parsed.success || parsed.data.eventId !== frameId) throw new InvalidSseFrameError();
          lastEventId = parsed.data.eventId;
          // Awaiting each callback applies backpressure, bounding queued event processing to one.
          await input.onEvent(parsed.data);
        }
        frameId = undefined;
        frameEvent = undefined;
        frameData = undefined;
        frameDataBytes = 0;
      };

      const consumeLine = async (line: string): Promise<void> => {
        if (Buffer.byteLength(line, "utf8") > MAX_SSE_LINE_BYTES) {
          throw new InvalidSseFrameError();
        }
        if (line.length === 0) {
          await dispatch();
        } else if (line.startsWith("id:")) {
          frameId = line.slice(3).trimStart();
        } else if (line.startsWith("event:")) {
          frameEvent = line.slice(6).trimStart();
        } else if (line.startsWith("data:")) {
          const data = line.slice(5).trimStart();
          frameDataBytes += Buffer.byteLength(data, "utf8") + (frameData === undefined ? 0 : 1);
          if (frameDataBytes > MAX_SSE_FRAME_DATA_BYTES) throw new InvalidSseFrameError();
          frameData = frameData === undefined ? data : `${frameData}\n${data}`;
        }
      };

      while (!this.closed) {
        const chunk = await reader.read();
        if (chunk.done) {
          reachedEof = true;
          break;
        }
        let decoded: string;
        try {
          decoded = decoder.decode(chunk.value, { stream: true });
        } catch {
          throw new InvalidSseFrameError();
        }
        if (Buffer.byteLength(decoded, "utf8") > MAX_SSE_CHUNK_PROCESSING_BYTES) {
          throw new InvalidSseFrameError();
        }
        buffered += decoded;
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const rawLine = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          await consumeLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
          newline = buffered.indexOf("\n");
        }
        if (Buffer.byteLength(buffered, "utf8") > MAX_SSE_UNTERMINATED_BYTES) {
          throw new InvalidSseFrameError();
        }
      }
    } catch (error) {
      requiresRecovery = error instanceof InvalidSseFrameError;
      // The disconnect callback below is intentionally body-free and error-free.
    } finally {
      if (reader) {
        if (!reachedEof) {
          try {
            await reader.cancel();
          } catch {
            // Cleanup failures are transport details and must not escape to reconnect handling.
          }
        }
        try {
          reader.releaseLock();
        } catch {
          // Cleanup failures are transport details and must not escape to reconnect handling.
        }
      }
    }
    if (!this.closed) {
      input.onDisconnect({
        ...(lastEventId === undefined ? {} : { lastEventId }),
        staleCursor: false,
        ...(requiresRecovery ? { requiresRecovery: true as const } : {}),
      });
    }
  }
}

export const defaultPrincipalEventStreamFactory: PrincipalEventStreamFactory = (input) =>
  new AuthenticatedPrincipalEventStream(input);
