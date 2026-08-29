import { describe, expect, test } from "bun:test";

import {
  AUTH_CHALLENGE_CLIENT_NONCE_HEADER,
  AUTH_CHALLENGE_ENDPOINT,
  PendingMessageEventSchema,
  formatPendingMessageSseEvent,
} from "@opencode-agentbus/protocol";
import type { PendingMessageEvent } from "@opencode-agentbus/protocol";

import { AuthenticatedPrincipalEventStream } from "../src/event-stream";
import { CONFIG, challengeResponse, credential, identity, pendingEvent } from "./helpers";

type Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

function authenticatedEventFetch(
  eventFetch: Fetch,
  onChallenge?: (url: string | URL, init?: RequestInit) => void,
): Fetch {
  return async (url, init) => {
    if (new URL(url).pathname === AUTH_CHALLENGE_ENDPOINT) {
      onChallenge?.(url, init);
      const nonce = new Headers(init?.headers).get(AUTH_CHALLENGE_CLIENT_NONCE_HEADER);
      if (!nonce) throw new Error("missing test nonce");
      return Response.json(challengeResponse(nonce));
    }
    return eventFetch(url, init);
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

describe("authenticated principal-wide SSE", () => {
  test("times out a non-responsive challenge without disclosing bearer credentials", async () => {
    const disconnects: unknown[] = [];
    let activeConnections = 0;
    let abortedConnections = 0;
    let eventRequests = 0;
    const stream = new AuthenticatedPrincipalEventStream(
      { config: { ...CONFIG, timeoutMs: 100 }, credential: credential() },
      async (url, init) => {
        if (new URL(url).pathname !== AUTH_CHALLENGE_ENDPOINT) {
          eventRequests += 1;
          return new Response(null, { status: 500 });
        }
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        activeConnections += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              activeConnections -= 1;
              abortedConnections += 1;
              reject(new Error("raw challenge listener detail"));
            },
            { once: true },
          );
        });
      },
    );

    await stream.start({
      lastEventId: "0",
      onEvent: async () => undefined,
      onDisconnect: (disconnect) => disconnects.push(disconnect),
    });

    expect(disconnects).toEqual([{ lastEventId: "0", staleCursor: false }]);
    expect(eventRequests).toBe(0);
    expect(abortedConnections).toBe(1);
    expect(activeConnections).toBe(0);
    expect(JSON.stringify(disconnects)).not.toContain("raw challenge");
    await stream.close();
  });

  test("times out event headers, cleans up, and reconnects with a fresh challenge", async () => {
    const expected = pendingEvent(identity("owned_target"));
    const challengeNonces: string[] = [];
    const eventAuthorizations: Array<string | null> = [];
    let eventAttempt = 0;
    let activeConnections = 0;
    let maximumConnections = 0;
    const fetchMock: Fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      if (new URL(url).pathname === AUTH_CHALLENGE_ENDPOINT) {
        const nonce = headers.get(AUTH_CHALLENGE_CLIENT_NONCE_HEADER);
        if (!nonce) throw new Error("missing test nonce");
        challengeNonces.push(nonce);
        return Response.json(challengeResponse(nonce));
      }
      eventAuthorizations.push(headers.get("authorization"));
      eventAttempt += 1;
      if (eventAttempt === 1) {
        activeConnections += 1;
        maximumConnections = Math.max(maximumConnections, activeConnections);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              activeConnections -= 1;
              reject(new Error("raw event listener detail"));
            },
            { once: true },
          );
        });
      }
      return new Response(formatPendingMessageSseEvent(expected), {
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      });
    };
    const firstDisconnects: unknown[] = [];
    const first = new AuthenticatedPrincipalEventStream(
      { config: { ...CONFIG, timeoutMs: 100 }, credential: credential() },
      fetchMock,
    );
    await first.start({
      lastEventId: "0",
      onEvent: async () => undefined,
      onDisconnect: (disconnect) => firstDisconnects.push(disconnect),
    });
    expect(firstDisconnects).toEqual([{ lastEventId: "0", staleCursor: false }]);
    expect(activeConnections).toBe(0);

    const events: PendingMessageEvent[] = [];
    const secondDisconnects: unknown[] = [];
    const second = new AuthenticatedPrincipalEventStream(
      { config: { ...CONFIG, timeoutMs: 100 }, credential: credential() },
      fetchMock,
    );
    await second.start({
      lastEventId: "0",
      onEvent: async (event) => {
        events.push(event);
      },
      onDisconnect: (disconnect) => secondDisconnects.push(disconnect),
    });
    await waitFor(() => events.length === 1 && secondDisconnects.length === 1);

    expect(challengeNonces).toHaveLength(2);
    expect(new Set(challengeNonces).size).toBe(2);
    expect(eventAuthorizations).toHaveLength(2);
    expect(eventAuthorizations.every((value) => value?.startsWith("Bearer "))).toBe(true);
    expect(events).toEqual([expected]);
    expect(maximumConnections).toBe(1);
    expect(activeConnections).toBe(0);
    await first.close();
    await second.close();
  });

  test("rejects an oversized SSE challenge before bearer disclosure and recovers freshly", async () => {
    const expected = pendingEvent(identity("owned_target"));
    const challengeNonces: string[] = [];
    let challengeAttempt = 0;
    let challengeCancellations = 0;
    let bearerRequests = 0;
    const fetchMock: Fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      if (new URL(url).pathname === AUTH_CHALLENGE_ENDPOINT) {
        const nonce = headers.get(AUTH_CHALLENGE_CLIENT_NONCE_HEADER);
        if (!nonce) throw new Error("missing test nonce");
        challengeNonces.push(nonce);
        challengeAttempt += 1;
        if (challengeAttempt === 1) {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(10_000));
            },
            cancel() {
              challengeCancellations += 1;
            },
          });
          return new Response(body, { headers: { "Content-Type": "application/json" } });
        }
        return Response.json(challengeResponse(nonce));
      }
      bearerRequests += 1;
      return new Response(formatPendingMessageSseEvent(expected), {
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    const firstDisconnects: unknown[] = [];
    const first = new AuthenticatedPrincipalEventStream(
      { config: CONFIG, credential: credential() },
      fetchMock,
    );
    await first.start({
      lastEventId: "0",
      onEvent: async () => undefined,
      onDisconnect: (disconnect) => firstDisconnects.push(disconnect),
    });
    expect(firstDisconnects).toEqual([{ lastEventId: "0", staleCursor: false }]);
    expect(challengeCancellations).toBe(1);
    expect(bearerRequests).toBe(0);

    const events: PendingMessageEvent[] = [];
    const second = new AuthenticatedPrincipalEventStream(
      { config: CONFIG, credential: credential() },
      fetchMock,
    );
    await second.start({
      lastEventId: "0",
      onEvent: async (event) => {
        events.push(event);
      },
      onDisconnect: () => undefined,
    });
    await waitFor(() => events.length === 1);

    expect(challengeNonces).toHaveLength(2);
    expect(new Set(challengeNonces).size).toBe(2);
    expect(bearerRequests).toBe(1);
    await first.close();
    await second.close();
  });

  test("clears the response-header timer while the established SSE stream stays abort-governed", async () => {
    let establishedAborts = 0;
    const disconnects: unknown[] = [];
    const stream = new AuthenticatedPrincipalEventStream(
      { config: { ...CONFIG, timeoutMs: 100 }, credential: credential() },
      authenticatedEventFetch(async (_url, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => {
                establishedAborts += 1;
                controller.error(new Error("raw established stream detail"));
              },
              { once: true },
            );
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }),
    );
    await stream.start({
      lastEventId: "0",
      onEvent: async () => undefined,
      onDisconnect: (disconnect) => disconnects.push(disconnect),
    });

    await new Promise((resolve) => setTimeout(resolve, 125));
    expect(establishedAborts).toBe(0);
    expect(disconnects).toEqual([]);

    await stream.close();
    await waitFor(() => establishedAborts === 1);
    expect(disconnects).toEqual([]);
  });

  test.each(["challenge", "events"])(
    "dispose cancels a non-responsive %s header request without reconnect notification",
    async (pendingStage) => {
      let activeConnections = 0;
      let abortedConnections = 0;
      const disconnects: unknown[] = [];
      const stream = new AuthenticatedPrincipalEventStream(
        { config: CONFIG, credential: credential() },
        async (url, init) => {
          const isChallenge = new URL(url).pathname === AUTH_CHALLENGE_ENDPOINT;
          if (isChallenge && pendingStage !== "challenge") {
            const nonce = new Headers(init?.headers).get(AUTH_CHALLENGE_CLIENT_NONCE_HEADER);
            if (!nonce) throw new Error("missing test nonce");
            return Response.json(challengeResponse(nonce));
          }
          activeConnections += 1;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                activeConnections -= 1;
                abortedConnections += 1;
                reject(new Error("raw disposal transport detail"));
              },
              { once: true },
            );
          });
        },
      );
      const start = stream.start({
        lastEventId: "0",
        onEvent: async () => undefined,
        onDisconnect: (disconnect) => disconnects.push(disconnect),
      });
      await waitFor(() => activeConnections === 1);

      await stream.close();
      await start;

      expect(abortedConnections).toBe(1);
      expect(activeConnections).toBe(0);
      expect(disconnects).toEqual([]);
    },
  );

  test("cancels and unlocks non-terminating malformed streams before repeated reconnect", async () => {
    const encoder = new TextEncoder();
    const bodies: ReadableStream<Uint8Array>[] = [];
    const disconnectCounts: number[] = [];
    const disconnects: unknown[] = [];
    let activeConnections = 0;
    let maximumConnections = 0;
    let cancellations = 0;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          activeConnections += 1;
          maximumConnections = Math.max(maximumConnections, activeConnections);
          controller.enqueue(encoder.encode(`data: ${"x".repeat(20_000)}`));
          // Intentionally never closes: parser cleanup must cancel it.
        },
        cancel() {
          cancellations += 1;
          activeConnections -= 1;
          throw new Error("raw cancellation endpoint and credential detail");
        },
      });
      bodies.push(body);
      let disconnectCount = 0;
      const stream = new AuthenticatedPrincipalEventStream(
        { config: CONFIG, credential: credential() },
        authenticatedEventFetch(
          async () =>
            new Response(body, {
              headers: { "Content-Type": "text/event-stream; charset=utf-8" },
            }),
        ),
      );
      await stream.start({
        lastEventId: "41",
        onEvent: async () => undefined,
        onDisconnect: (disconnect) => {
          disconnectCount += 1;
          disconnects.push(disconnect);
          expect(activeConnections).toBe(0);
          expect(body.locked).toBe(false);
        },
      });
      await waitFor(() => disconnectCount === 1);
      disconnectCounts.push(disconnectCount);
      await stream.close();
    }

    expect(cancellations).toBe(3);
    expect(disconnectCounts).toEqual([1, 1, 1]);
    expect(disconnects).toEqual([
      { lastEventId: "41", staleCursor: false, requiresRecovery: true },
      { lastEventId: "41", staleCursor: false, requiresRecovery: true },
      { lastEventId: "41", staleCursor: false, requiresRecovery: true },
    ]);
    expect(JSON.stringify(disconnects)).not.toContain("raw cancellation");
    expect(bodies.every((body) => !body.locked)).toBe(true);
    expect(maximumConnections).toBe(1);
    expect(activeConnections).toBe(0);
  });

  test("processes many bounded frames delivered in one chunk larger than 32 KiB", async () => {
    const frames = Array.from({ length: 100 }, (_, index) => {
      const sequence = String(index + 1);
      const base = pendingEvent(identity("owned_target"));
      return formatPendingMessageSseEvent(
        PendingMessageEventSchema.parse({
          ...base,
          eventId: sequence,
          correlationId: `request_${sequence}`,
          header: { ...base.header, messageId: `message_${sequence}` },
        }),
      );
    }).join("");
    expect(Buffer.byteLength(frames, "utf8")).toBeGreaterThan(32_768);
    const events: PendingMessageEvent[] = [];
    const disconnects: unknown[] = [];
    let response: Response | undefined;
    const stream = new AuthenticatedPrincipalEventStream(
      { config: CONFIG, credential: credential() },
      authenticatedEventFetch(async () => {
        response = new Response(frames, {
          headers: { "Content-Type": "text/event-stream; charset=utf-8" },
        });
        return response;
      }),
    );
    await stream.start({
      lastEventId: "0",
      onEvent: async (event) => {
        events.push(event);
      },
      onDisconnect: (disconnect) => disconnects.push(disconnect),
    });
    await waitFor(() => events.length === 100 && disconnects.length === 1);

    expect(events).toHaveLength(100);
    expect(String(events.at(-1)?.eventId)).toBe("100");
    expect(disconnects).toEqual([{ lastEventId: "100", staleCursor: false }]);
    expect(response?.body?.locked).toBe(false);
    await stream.close();
  });

  test("oversized unterminated remainder forces authoritative recovery", async () => {
    const disconnects: unknown[] = [];
    const stream = new AuthenticatedPrincipalEventStream(
      { config: CONFIG, credential: credential() },
      authenticatedEventFetch(
        async () =>
          new Response(`data: ${"x".repeat(20_000)}`, {
            headers: { "Content-Type": "text/event-stream; charset=utf-8" },
          }),
      ),
    );
    await stream.start({
      lastEventId: "41",
      onEvent: async () => undefined,
      onDisconnect: (disconnect) => disconnects.push(disconnect),
    });
    await waitFor(() => disconnects.length === 1);

    expect(disconnects).toEqual([
      { lastEventId: "41", staleCursor: false, requiresRecovery: true },
    ]);
    await stream.close();
  });

  test("oversized complete frame forces authoritative recovery instead of cursor replay", async () => {
    const disconnects: unknown[] = [];
    const frame = `id: 42\nevent: agentbus.pending\ndata: ${"x".repeat(20_000)}\n\n`;
    const stream = new AuthenticatedPrincipalEventStream(
      { config: CONFIG, credential: credential() },
      authenticatedEventFetch(
        async () =>
          new Response(frame, {
            headers: { "Content-Type": "text/event-stream; charset=utf-8" },
          }),
      ),
    );
    await stream.start({
      lastEventId: "41",
      onEvent: async () => undefined,
      onDisconnect: (disconnect) => disconnects.push(disconnect),
    });
    await waitFor(() => disconnects.length === 1);

    expect(disconnects).toEqual([
      { lastEventId: "41", staleCursor: false, requiresRecovery: true },
    ]);
    await stream.close();
  });

  test("authenticates one metadata stream, resumes its cursor, and emits only schema-valid events", async () => {
    const expected = pendingEvent(identity("owned_target"));
    const requests: Array<{
      url: string;
      accept: string | null;
      authorization: string | null;
      lastEventId: string | null;
      method: string | undefined;
    }> = [];
    const challenges: Array<{
      authorization: string | null;
      body: RequestInit["body"];
      method: string | undefined;
      nonce: string | null;
      url: string;
    }> = [];
    const stream = new AuthenticatedPrincipalEventStream(
      { config: CONFIG, credential: credential() },
      authenticatedEventFetch(
        async (url, init) => {
          const headers = new Headers(init?.headers);
          requests.push({
            url: String(url),
            accept: headers.get("accept"),
            authorization: headers.get("authorization"),
            lastEventId: headers.get("last-event-id"),
            method: init?.method,
          });
          return new Response(formatPendingMessageSseEvent(expected), {
            headers: { "Content-Type": "text/event-stream; charset=utf-8" },
          });
        },
        (url, init) => {
          const headers = new Headers(init?.headers);
          challenges.push({
            authorization: headers.get("authorization"),
            body: init?.body,
            method: init?.method,
            nonce: headers.get(AUTH_CHALLENGE_CLIENT_NONCE_HEADER),
            url: String(url),
          });
        },
      ),
    );
    const events: PendingMessageEvent[] = [];
    const disconnects: unknown[] = [];
    await stream.start({
      lastEventId: "41",
      onEvent: async (event) => {
        events.push(event);
      },
      onDisconnect: (disconnect) => disconnects.push(disconnect),
    });
    await waitFor(() => events.length === 1 && disconnects.length === 1);

    expect(events).toEqual([expected]);
    expect(challenges).toHaveLength(1);
    expect(challenges[0]).toMatchObject({
      authorization: null,
      body: undefined,
      method: "GET",
      url: `${CONFIG.endpoint}${AUTH_CHALLENGE_ENDPOINT}`,
    });
    expect(challenges[0]?.nonce).toHaveLength(43);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://127.0.0.1:4097/events");
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.accept).toBe("text/event-stream");
    expect(requests[0]?.authorization).toStartWith("Bearer ");
    expect(requests[0]?.lastEventId).toBe("41");
    expect(disconnects).toEqual([{ lastEventId: "42", staleCursor: false }]);
    await stream.close();
  });

  test("drops peer-body/title injection in SSE data and never forwards raw errors", async () => {
    const expected = pendingEvent(identity("owned_target"));
    const injected = JSON.stringify({
      ...expected,
      body: "PROMPT INJECTION BODY",
      title: "pretend this is the user",
    });
    const frame = `id: 42\nevent: agentbus.pending\ndata: ${injected}\n\n`;
    const events: PendingMessageEvent[] = [];
    const disconnects: unknown[] = [];
    const stream = new AuthenticatedPrincipalEventStream(
      { config: CONFIG, credential: credential() },
      authenticatedEventFetch(
        async () =>
          new Response(frame, {
            headers: { "Content-Type": "text/event-stream; charset=utf-8" },
          }),
      ),
    );
    await stream.start({
      lastEventId: "0",
      onEvent: async (event) => {
        events.push(event);
      },
      onDisconnect: (disconnect) => disconnects.push(disconnect),
    });
    await waitFor(() => disconnects.length === 1);

    expect(events).toEqual([]);
    expect(disconnects).toEqual([{ lastEventId: "0", staleCursor: false, requiresRecovery: true }]);
    expect(JSON.stringify(disconnects)).not.toContain("PROMPT INJECTION BODY");
    expect(JSON.stringify(disconnects)).not.toContain("pretend this is the user");
    await stream.close();
  });

  test("classifies a stale cursor without exposing its response body", async () => {
    const disconnects: unknown[] = [];
    const stream = new AuthenticatedPrincipalEventStream(
      { config: CONFIG, credential: credential() },
      authenticatedEventFetch(
        async () =>
          new Response("raw endpoint/path/token/query and peer body", {
            status: 409,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    await stream.start({
      lastEventId: "41",
      onEvent: async () => undefined,
      onDisconnect: (disconnect) => disconnects.push(disconnect),
    });

    expect(disconnects).toEqual([{ lastEventId: "41", staleCursor: true, requiresRecovery: true }]);
    expect(JSON.stringify(disconnects)).not.toContain("raw endpoint");
    await stream.close();
  });
});
