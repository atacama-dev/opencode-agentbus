import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import {
  AUTH_CHALLENGE_CLIENT_NONCE_HEADER,
  AUTH_CHALLENGE_CONTENT_TYPE,
  AUTH_CHALLENGE_PROOF_DOMAIN,
  verifyAuthChallengeResponseVersion,
} from "@opencode-agentbus/protocol";

import { authenticateBrokerListener } from "../src/auth-challenge";
import { SAFE_MODEL_ERRORS, BrokerProtocolMismatchError } from "../src/errors";
import { CONFIG, challengeResponse, credential } from "./helpers";

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

function challengeJson(init?: RequestInit): string {
  const nonce = new Headers(init?.headers).get(AUTH_CHALLENGE_CLIENT_NONCE_HEADER);
  if (!nonce) throw new Error("missing test nonce");
  return JSON.stringify(challengeResponse(nonce));
}

function legacyChallengeJson(init?: RequestInit): string {
  const clientNonce = new Headers(init?.headers).get(AUTH_CHALLENGE_CLIENT_NONCE_HEADER);
  if (!clientNonce) throw new Error("missing test nonce");
  const brokerId = "broker_legacy_v1";
  const serverId = "server_01";
  const serverNonce = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const encoder = new TextEncoder();
  const domain = encoder.encode(AUTH_CHALLENGE_PROOF_DOMAIN);
  const fields = ["1", brokerId, serverId, clientNonce, serverNonce].map((field) =>
    encoder.encode(field),
  );
  const buffer = new ArrayBuffer(
    domain.byteLength + 1 + fields.reduce((sum, field) => sum + 4 + field.byteLength, 0),
  );
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(domain);
  let offset = domain.byteLength + 1;
  for (const field of fields) {
    view.setUint32(offset, field.byteLength, false);
    offset += 4;
    bytes.set(field, offset);
    offset += field.byteLength;
  }
  const proof = createHmac("sha256", Uint8Array.from(Buffer.from(credential().token, "base64url")))
    .update(bytes)
    .digest("hex");
  return JSON.stringify({
    protocolVersion: 1,
    brokerId,
    serverId,
    clientNonce,
    serverNonce,
    proof,
  });
}

describe("bounded broker authentication challenge", () => {
  test("distinguishes an authenticated detached version-1 broker for operator recovery", async () => {
    let candidate: unknown;
    const error = await authenticateBrokerListener({
      config: CONFIG,
      controller: new AbortController(),
      credential: credential(),
      fetchImplementation: async (_url, init) => {
        candidate = JSON.parse(legacyChallengeJson(init));
        return new Response(JSON.stringify(candidate), {
          headers: { "Content-Type": AUTH_CHALLENGE_CONTENT_TYPE },
        });
      },
    }).catch((failure: unknown) => failure);

    const response = candidate as { clientNonce?: string };
    expect(
      verifyAuthChallengeResponseVersion(
        {
          token: credential().token,
          expectedServerId: "server_01",
          expectedClientNonce: response.clientNonce ?? "missing",
          response: candidate,
        },
        1,
      ),
    ).toBe(true);
    expect(error).toBeInstanceOf(BrokerProtocolMismatchError);
  });

  test.each([
    [
      "missing",
      () => new Response(null, { headers: { "Content-Type": AUTH_CHALLENGE_CONTENT_TYPE } }),
    ],
    [
      "malformed",
      () =>
        new Response("{not-json", {
          headers: { "Content-Type": AUTH_CHALLENGE_CONTENT_TYPE },
        }),
    ],
  ])("rejects a %s challenge body with only a stable error", async (_kind, response) => {
    await expect(
      authenticateBrokerListener({
        config: CONFIG,
        controller: new AbortController(),
        credential: credential(),
        fetchImplementation: async () => response(),
      }),
    ).rejects.toThrow(SAFE_MODEL_ERRORS.UNAVAILABLE);
  });

  test.each(["content-length", "chunked"])(
    "rejects oversized %s bodies, cancels them, and permits clean recovery",
    async (framing) => {
      let cancellations = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(10_000));
        },
        cancel() {
          cancellations += 1;
        },
      });
      const oversized = new Response(body, {
        headers: {
          "Content-Type": AUTH_CHALLENGE_CONTENT_TYPE,
          ...(framing === "content-length" ? { "Content-Length": "10000" } : {}),
        },
      });
      let attempt = 0;
      const fetchImplementation = async (_url: string | URL, init?: RequestInit) => {
        attempt += 1;
        return attempt === 1
          ? oversized
          : new Response(challengeJson(init), {
              headers: { "Content-Type": AUTH_CHALLENGE_CONTENT_TYPE },
            });
      };

      await expect(
        authenticateBrokerListener({
          config: CONFIG,
          controller: new AbortController(),
          credential: credential(),
          fetchImplementation,
        }),
      ).rejects.toThrow(SAFE_MODEL_ERRORS.UNAVAILABLE);
      expect(cancellations).toBe(1);
      expect(body.locked).toBe(false);

      const recovered = await authenticateBrokerListener({
        config: CONFIG,
        controller: new AbortController(),
        credential: credential(),
        fetchImplementation,
      });
      expect(String(recovered.brokerId)).toBe("broker_01");
      expect(String(recovered.serverId)).toBe("server_01");
    },
  );

  test("times out a never-ending trickle across the entire challenge body", async () => {
    let cancellations = 0;
    let activeConnections = 0;
    let interval: ReturnType<typeof setInterval> | undefined;
    let body: ReadableStream<Uint8Array> | undefined;
    const controller = new AbortController();
    const work = authenticateBrokerListener({
      config: { ...CONFIG, timeoutMs: 100 },
      controller,
      credential: credential(),
      fetchImplementation: async () => {
        activeConnections += 1;
        body = new ReadableStream<Uint8Array>({
          start(streamController) {
            interval = setInterval(() => streamController.enqueue(new Uint8Array([0x20])), 10);
          },
          cancel() {
            if (interval) clearInterval(interval);
            activeConnections -= 1;
            cancellations += 1;
          },
        });
        return new Response(body, { headers: { "Content-Type": AUTH_CHALLENGE_CONTENT_TYPE } });
      },
    });

    await expect(work).rejects.toThrow(SAFE_MODEL_ERRORS.UNAVAILABLE);
    expect(controller.signal.aborted).toBe(true);
    expect(cancellations).toBe(1);
    expect(activeConnections).toBe(0);
    expect(body?.locked).toBe(false);
  });

  test.each(["timeout", "dispose"])(
    "cancels and releases a stalled challenge body on %s",
    async (exit) => {
      let cancellations = 0;
      let body: ReadableStream<Uint8Array> | undefined;
      const controller = new AbortController();
      const work = authenticateBrokerListener({
        config: { ...CONFIG, timeoutMs: exit === "timeout" ? 100 : 1_000 },
        controller,
        credential: credential(),
        fetchImplementation: async () => {
          body = new ReadableStream<Uint8Array>({
            cancel() {
              cancellations += 1;
            },
          });
          return new Response(body, { headers: { "Content-Type": AUTH_CHALLENGE_CONTENT_TYPE } });
        },
      });
      await waitFor(() => body?.locked === true);
      if (exit === "dispose") controller.abort();

      await expect(work).rejects.toThrow(SAFE_MODEL_ERRORS.UNAVAILABLE);
      expect(cancellations).toBe(1);
      expect(body?.locked).toBe(false);
    },
  );
});
