import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import {
  AUTH_CHALLENGE_CLIENT_NONCE_HEADER,
  AUTH_CHALLENGE_ENDPOINT,
  ApplicationResponseEnvelopeSchema,
  AuthChallengeNonceSchema,
  AuthChallengeResponseSchema,
  CredentialFileSchema,
  MAX_ACTIVE_SESSIONS_PER_PRINCIPAL,
  verifyAuthChallengeResponse,
  type AuthChallengeNonce,
  type CredentialFile,
} from "@opencode-agentbus/protocol";
import { BrokerDaemon } from "../src/server";
import { createHarness, type Harness } from "./helpers";

function nonce(byte: number): AuthChallengeNonce {
  return AuthChallengeNonceSchema.parse(Buffer.alloc(32, byte).toString("base64url"));
}

function numberedNonce(index: number): AuthChallengeNonce {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(index, 28);
  return AuthChallengeNonceSchema.parse(bytes.toString("base64url"));
}

function credential(harness: Harness): CredentialFile {
  return CredentialFileSchema.parse(JSON.parse(readFileSync(harness.credentialFilePath, "utf8")));
}

async function requestChallenge(endpoint: string, clientNonce: string): Promise<Response> {
  return fetch(`${endpoint}${AUTH_CHALLENGE_ENDPOINT}`, {
    headers: { [AUTH_CHALLENGE_CLIENT_NONCE_HEADER]: clientNonce },
    redirect: "error",
  });
}

describe("public authentication challenge", () => {
  let harness: Harness | undefined;
  let daemon: BrokerDaemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    harness?.close();
    harness = undefined;
  });

  test("returns a strict verifiable proof without bearer authentication or access", async () => {
    harness = createHarness();
    daemon = new BrokerDaemon({
      service: harness.service,
      hostname: "127.0.0.1",
      port: 0,
      clock: harness.clock,
    });
    const endpoint = await daemon.start();
    const clientNonce = nonce(0xa1);
    const currentCredential = credential(harness);

    const response = await requestChallenge(endpoint, clientNonce);
    const wire = AuthChallengeResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(wire.clientNonce).toBe(clientNonce);
    expect(wire.brokerId).toBe(harness.service.brokerId);
    expect(wire.serverId).toBe(currentCredential.serverId);
    expect(
      verifyAuthChallengeResponse({
        token: currentCredential.token,
        expectedServerId: currentCredential.serverId,
        expectedClientNonce: clientNonce,
        response: wire,
      }),
    ).toBe(true);

    const unauthenticatedMcp = await fetch(`${endpoint}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(unauthenticatedMcp.status).toBe(401);
    expect((await fetch(`${endpoint}/events`)).status).toBe(401);
    expect(daemon.connectionCounts()).toEqual({ mcp: 0, sse: 0 });
  });

  test("rejects method, query, body, authorization, and nonce contract violations safely", async () => {
    const logs: string[] = [];
    harness = createHarness({
      logger: {
        info: (message) => logs.push(message),
        warn: (message) => logs.push(message),
        error: (message) => logs.push(message),
      },
    });
    daemon = new BrokerDaemon({
      service: harness.service,
      hostname: "127.0.0.1",
      port: 0,
      clock: harness.clock,
    });
    const endpoint = await daemon.start();
    const validNonce = nonce(0xa2);
    const secretToken = credential(harness).token;
    const host = new URL(endpoint).host;
    const duplicateHeaders = new Headers({ Host: host });
    duplicateHeaders.append(AUTH_CHALLENGE_CLIENT_NONCE_HEADER, validNonce);
    duplicateHeaders.append(AUTH_CHALLENGE_CLIENT_NONCE_HEADER, nonce(0xa3));

    const responses = await Promise.all([
      fetch(`${endpoint}${AUTH_CHALLENGE_ENDPOINT}`, {
        method: "POST",
        headers: { [AUTH_CHALLENGE_CLIENT_NONCE_HEADER]: validNonce },
        body: "not-allowed",
      }),
      fetch(`${endpoint}${AUTH_CHALLENGE_ENDPOINT}?extra=1`, {
        headers: { [AUTH_CHALLENGE_CLIENT_NONCE_HEADER]: validNonce },
      }),
      fetch(`${endpoint}${AUTH_CHALLENGE_ENDPOINT}`, {
        headers: {
          Authorization: `Bearer ${secretToken}`,
          [AUTH_CHALLENGE_CLIENT_NONCE_HEADER]: validNonce,
        },
      }),
      fetch(`${endpoint}${AUTH_CHALLENGE_ENDPOINT}`),
      requestChallenge(endpoint, "malformed"),
      requestChallenge(endpoint, "A".repeat(1_024)),
      daemon.handleRequest(
        new Request(`${endpoint}${AUTH_CHALLENGE_ENDPOINT}`, { headers: duplicateHeaders }),
      ),
      daemon.handleRequest(
        new Request(`${endpoint}${AUTH_CHALLENGE_ENDPOINT}`, {
          headers: {
            Host: host,
            "Content-Length": "1",
            [AUTH_CHALLENGE_CLIENT_NONCE_HEADER]: validNonce,
          },
        }),
      ),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(400);
      const error = ApplicationResponseEnvelopeSchema.parse(await response.json());
      expect(error.ok).toBe(false);
      expect(JSON.stringify(error)).not.toContain(validNonce);
      expect(JSON.stringify(error)).not.toContain(secretToken);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
    expect(logs).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain(secretToken);
  });

  test("replayed client nonces receive fresh proofs and never authenticate", async () => {
    harness = createHarness();
    daemon = new BrokerDaemon({
      service: harness.service,
      hostname: "127.0.0.1",
      port: 0,
      clock: harness.clock,
    });
    const endpoint = await daemon.start();
    const clientNonce = nonce(0xa4);

    const first = AuthChallengeResponseSchema.parse(
      await (await requestChallenge(endpoint, clientNonce)).json(),
    );
    const replay = AuthChallengeResponseSchema.parse(
      await (await requestChallenge(endpoint, clientNonce)).json(),
    );

    expect(replay.clientNonce).toBe(clientNonce);
    expect(replay.serverNonce).not.toBe(first.serverNonce);
    expect(replay.proof).not.toBe(first.proof);
    expect(daemon.connectionCounts()).toEqual({ mcp: 0, sse: 0 });
  });

  test("credential rotation immediately invalidates old proof verification", async () => {
    harness = createHarness();
    daemon = new BrokerDaemon({
      service: harness.service,
      hostname: "127.0.0.1",
      port: 0,
      clock: harness.clock,
    });
    const endpoint = await daemon.start();
    const clientNonce = nonce(0xa5);
    const before = credential(harness);
    const oldChallenge = AuthChallengeResponseSchema.parse(
      await (await requestChallenge(endpoint, clientNonce)).json(),
    );

    const replacement = await daemon.rotateCredential();
    expect(
      verifyAuthChallengeResponse({
        token: replacement.token,
        expectedServerId: replacement.serverId,
        expectedClientNonce: clientNonce,
        response: oldChallenge,
      }),
    ).toBe(false);

    const newChallenge = AuthChallengeResponseSchema.parse(
      await (await requestChallenge(endpoint, clientNonce)).json(),
    );
    expect(newChallenge.proof).not.toBe(oldChallenge.proof);
    expect(
      verifyAuthChallengeResponse({
        token: replacement.token,
        expectedServerId: replacement.serverId,
        expectedClientNonce: clientNonce,
        response: newChallenge,
      }),
    ).toBe(true);
    expect(before.token).not.toBe(replacement.token);
  });

  test("bounds challenge attempts and recovers after the retry window", async () => {
    harness = createHarness();
    daemon = new BrokerDaemon({
      service: harness.service,
      hostname: "127.0.0.1",
      port: 0,
      clock: harness.clock,
      maxAuthChallengesPerMinute: 2,
    });
    const endpoint = await daemon.start();

    expect((await requestChallenge(endpoint, nonce(0xb1))).status).toBe(200);
    expect((await requestChallenge(endpoint, nonce(0xb2))).status).toBe(200);
    const limited = await requestChallenge(endpoint, nonce(0xb3));
    const error = ApplicationResponseEnvelopeSchema.parse(await limited.json());
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(Number(limited.headers.get("Retry-After"))).toBeLessThanOrEqual(60);
    expect(error.ok).toBe(false);
    if (error.ok) throw new Error("Expected challenge rate limit failure.");
    expect(error.error.code).toBe("RATE_LIMITED");
    expect(error.error.details?.retryAfterMs).toBeGreaterThan(0);
    expect(error.error.details?.retryAfterMs).toBeLessThanOrEqual(60_000);

    harness.clock.advance(60_001);
    expect((await requestChallenge(endpoint, nonce(0xb4))).status).toBe(200);
  });

  test("supports a complete 256-session startup and immediate-dispose challenge budget", async () => {
    harness = createHarness();
    daemon = new BrokerDaemon({
      service: harness.service,
      hostname: "127.0.0.1",
      port: 0,
      clock: harness.clock,
    });
    const endpoint = await daemon.start();
    const lifecycleChallengeCount = MAX_ACTIVE_SESSIONS_PER_PRINCIPAL * 4 + 6;
    const statuses = new Set<number>();

    for (let index = 0; index < lifecycleChallengeCount; index += 1) {
      const response = await requestChallenge(endpoint, numberedNonce(index));
      statuses.add(response.status);
      await response.arrayBuffer();
    }

    expect(lifecycleChallengeCount).toBe(1_030);
    expect(statuses).toEqual(new Set([200]));
    expect(daemon.authChallengeRateStateForTesting()).toEqual({
      capacity: 4_096,
      availableTokens: 4_096 - lifecycleChallengeCount,
    });
  });

  test("uses constant limiter state and counts malformed challenge attempts", async () => {
    harness = createHarness();
    daemon = new BrokerDaemon({
      service: harness.service,
      hostname: "127.0.0.1",
      port: 0,
      clock: harness.clock,
      maxAuthChallengesPerMinute: 3,
    });
    const endpoint = await daemon.start();

    for (let index = 0; index < 3; index += 1) {
      expect((await requestChallenge(endpoint, `malformed-${index}`)).status).toBe(400);
    }
    expect((await requestChallenge(endpoint, numberedNonce(100))).status).toBe(429);
    expect(daemon.authChallengeRateStateForTesting()).toEqual({
      capacity: 3,
      availableTokens: 0,
    });

    for (let index = 0; index < 100; index += 1) {
      expect((await requestChallenge(endpoint, `still-malformed-${index}`)).status).toBe(429);
    }
    expect(daemon.authChallengeRateStateForTesting()).toEqual({
      capacity: 3,
      availableTokens: 0,
    });

    harness.clock.advance(60_001);
    expect((await requestChallenge(endpoint, numberedNonce(101))).status).toBe(200);
    expect(daemon.authChallengeRateStateForTesting()).toEqual({
      capacity: 3,
      availableTokens: 2,
    });
  });
});
