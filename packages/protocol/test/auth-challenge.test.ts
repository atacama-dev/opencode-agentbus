import { describe, expect, test } from "bun:test";

import {
  AUTH_CHALLENGE_CLIENT_NONCE_HEADER,
  AUTH_CHALLENGE_CONTENT_TYPE,
  AUTH_CHALLENGE_ENDPOINT,
  AUTH_CHALLENGE_HTTP_CONTRACT,
  AUTH_CHALLENGE_USAGE_CONTRACT,
  AuthChallengeProofInputSchema,
  AuthChallengeRequestSchema,
  AuthChallengeResponseSchema,
  AuthenticatedClientPrincipalSchema,
  HandshakeRequestSchema,
  PROTOCOL_VERSION,
  TRANSPORT_CONTRACT,
  authChallengeMatchesMcpHandshake,
  authChallengeResponseMatchesRequest,
  createAuthChallengeProof,
  createErrorEnvelope,
  generateAuthChallengeNonce,
  negotiateProtocolVersion,
  verifyAuthChallengeResponse,
} from "../src/index";

const TOKEN = "ERERERERERERERERERERERERERERERERERERERERERE";
const WRONG_TOKEN = "REREREREREREREREREREREREREREREREREREREREREQ";
const CLIENT_NONCE = "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI";
const OTHER_CLIENT_NONCE = "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU";
const SERVER_NONCE = "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM";
const EXPECTED_PROOF = "b320363b107047e4dc0014fbe80686d6f5b8f384a5b706f6a23c6d384a0251d4";

const proofInput = AuthChallengeProofInputSchema.parse({
  protocolVersion: PROTOCOL_VERSION,
  brokerId: "broker_01",
  serverId: "server_01",
  clientNonce: CLIENT_NONCE,
  serverNonce: SERVER_NONCE,
});

const request = AuthChallengeRequestSchema.parse({
  method: "GET",
  path: AUTH_CHALLENGE_ENDPOINT,
  query: "",
  authorization: null,
  clientNonce: CLIENT_NONCE,
  body: null,
});

const response = AuthChallengeResponseSchema.parse({
  ...proofInput,
  proof: EXPECTED_PROOF,
});

describe("public listener-authentication challenge contract", () => {
  test("freezes endpoint, header, content type, and pre-bearer usage", () => {
    expect(AUTH_CHALLENGE_ENDPOINT).toBe("/auth/challenge");
    expect(AUTH_CHALLENGE_CLIENT_NONCE_HEADER).toBe("X-AgentBus-Client-Nonce");
    expect(AUTH_CHALLENGE_CONTENT_TYPE).toBe("application/json");
    expect(AUTH_CHALLENGE_HTTP_CONTRACT).toEqual({
      method: "GET",
      path: "/auth/challenge",
      clientNonceHeader: "X-AgentBus-Client-Nonce",
      contentType: "application/json",
      authorization: "forbidden",
      query: "forbidden",
      body: "forbidden",
      cacheControl: "no-store",
      contentTypeOptions: "nosniff",
      errorBody: "canonical_application_error_envelope",
      rateLimit: "required_product_policy",
    });
    expect(AUTH_CHALLENGE_USAGE_CONTRACT).toEqual({
      bearerDisclosure: "only_after_successful_challenge_verification",
      mcp: "new_challenge_immediately_before_first_bearer_request",
      sse: "new_challenge_immediately_before_each_bearer_connection",
      mcpBrokerCorrelation: "handshake_broker_id_must_equal_challenge_broker_id",
    });
  });

  test("accepts only GET without authorization, query, or body", () => {
    expect(AuthChallengeRequestSchema.safeParse(request).success).toBe(true);
    expect(AuthChallengeRequestSchema.safeParse({ ...request, method: "POST" }).success).toBe(
      false,
    );
    expect(
      AuthChallengeRequestSchema.safeParse({ ...request, authorization: `Bearer ${TOKEN}` })
        .success,
    ).toBe(false);
    expect(AuthChallengeRequestSchema.safeParse({ ...request, query: "?x=1" }).success).toBe(false);
    expect(AuthChallengeRequestSchema.safeParse({ ...request, body: "{}" }).success).toBe(false);
    expect(AuthChallengeRequestSchema.safeParse({ ...request, extra: true }).success).toBe(false);
  });
});

describe("canonical challenge proof", () => {
  test("matches the pinned domain-separated HMAC-SHA256 vector", () => {
    expect(createAuthChallengeProof(TOKEN, proofInput) as string).toBe(EXPECTED_PROOF);
    expect(EXPECTED_PROOF).toMatch(/^[0-9a-f]{64}$/);
  });

  test("verifies the exact server, echoed nonce, version, IDs, and proof", () => {
    expect(
      verifyAuthChallengeResponse({
        token: TOKEN,
        expectedServerId: "server_01",
        expectedClientNonce: CLIENT_NONCE,
        response,
      }),
    ).toBe(true);
    expect(
      verifyAuthChallengeResponse({
        token: WRONG_TOKEN,
        expectedServerId: "server_01",
        expectedClientNonce: CLIENT_NONCE,
        response,
      }),
    ).toBe(false);
    expect(
      verifyAuthChallengeResponse({
        token: TOKEN,
        expectedServerId: "server_other",
        expectedClientNonce: CLIENT_NONCE,
        response,
      }),
    ).toBe(false);
    expect(
      verifyAuthChallengeResponse({
        token: TOKEN,
        expectedServerId: "server_01",
        expectedClientNonce: CLIENT_NONCE,
        response: { ...response, brokerId: "broker_other" },
      }),
    ).toBe(false);
    expect(
      verifyAuthChallengeResponse({
        token: TOKEN,
        expectedServerId: "server_01",
        expectedClientNonce: CLIENT_NONCE,
        response: { ...response, clientNonce: OTHER_CLIENT_NONCE },
      }),
    ).toBe(false);
    expect(
      verifyAuthChallengeResponse({
        token: TOKEN,
        expectedServerId: "server_01",
        expectedClientNonce: CLIENT_NONCE,
        response: { ...response, protocolVersion: 1 },
      }),
    ).toBe(false);
    expect(
      verifyAuthChallengeResponse({
        token: TOKEN,
        expectedServerId: "server_01",
        expectedClientNonce: CLIENT_NONCE,
        response: { ...response, proof: "0".repeat(64) },
      }),
    ).toBe(false);
  });

  test("rejects replay of a response against a fresh client nonce", () => {
    expect(
      verifyAuthChallengeResponse({
        token: TOKEN,
        expectedServerId: "server_01",
        expectedClientNonce: OTHER_CLIENT_NONCE,
        response,
      }),
    ).toBe(false);
    expect(authChallengeResponseMatchesRequest(request, response)).toBe(true);
    expect(
      authChallengeResponseMatchesRequest(
        AuthChallengeRequestSchema.parse({ ...request, clientNonce: OTHER_CLIENT_NONCE }),
        response,
      ),
    ).toBe(false);
  });

  test("generates fresh safe 32-byte nonces", () => {
    const first = generateAuthChallengeNonce();
    const second = generateAuthChallengeNonce();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
  });
});

describe("challenge response hardening and MCP correlation", () => {
  test("rejects malformed, oversized, Unicode, control, and secret-bearing responses", () => {
    const malformed = [
      { ...response, brokerId: "b".repeat(129) },
      { ...response, serverId: "server_é" },
      { ...response, brokerId: "broker\n01" },
      { ...response, clientNonce: `${CLIENT_NONCE}x` },
      { ...response, serverNonce: "short" },
      { ...response, proof: EXPECTED_PROOF.toUpperCase() },
      { ...response, token: TOKEN },
    ];
    for (const candidate of malformed) {
      expect(AuthChallengeResponseSchema.safeParse(candidate).success).toBe(false);
      expect(
        verifyAuthChallengeResponse({
          token: TOKEN,
          expectedServerId: "server_01",
          expectedClientNonce: CLIENT_NONCE,
          response: candidate,
        }),
      ).toBe(false);
    }
  });

  test("serializes only constant-safe public data and canonical errors", () => {
    const serializedRequest = JSON.stringify(request);
    const serializedResponse = JSON.stringify(response);
    const serializedError = JSON.stringify(
      createErrorEnvelope("challenge_error", "INVALID_REQUEST"),
    );
    expect(serializedRequest).not.toContain(TOKEN);
    expect(serializedResponse).not.toContain(TOKEN);
    expect(serializedError).not.toContain(TOKEN);
    expect(serializedResponse).toMatch(/^[\x20-\x7e]+$/);
    expect(Object.keys(response).sort()).toEqual([
      "brokerId",
      "clientNonce",
      "proof",
      "protocolVersion",
      "serverId",
      "serverNonce",
    ]);
  });

  test("requires the MCP handshake to return the challenged broker identity", () => {
    const principal = AuthenticatedClientPrincipalSchema.parse({
      principalId: "principal_01",
      serverId: "server_01",
    });
    const handshakeRequest = HandshakeRequestSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      requestId: "request_01",
      method: "agentbus.handshake",
      params: { supportedProtocolVersions: [PROTOCOL_VERSION] },
    });
    const matching = negotiateProtocolVersion(handshakeRequest, "broker_01", principal);
    const replacement = negotiateProtocolVersion(handshakeRequest, "broker_other", principal);
    expect(authChallengeMatchesMcpHandshake(response, matching)).toBe(true);
    expect(authChallengeMatchesMcpHandshake(response, replacement)).toBe(false);
    expect(TRANSPORT_CONTRACT.mcp.exposure).toBe("programmatic_plugin_only");
  });
});
