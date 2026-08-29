import { Buffer } from "node:buffer";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  AUTH_CHALLENGE_ENDPOINT,
  AUTH_CHALLENGE_PROOF_DOMAIN,
  PROTOCOL_VERSION,
} from "./constants";
import { BearerTokenSchema } from "./connection";
import { BrokerIdSchema, ServerIdSchema } from "./schemas";
import { HandshakeResponseSchema } from "./transport";

export const AuthChallengeNonceSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "challenge nonce must be 32-byte unpadded base64url")
  .refine((value) => {
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength === 32 && decoded.toString("base64url") === value;
  })
  .brand<"AuthChallengeNonce">();
export type AuthChallengeNonce = z.infer<typeof AuthChallengeNonceSchema>;

export const AuthChallengeProofSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "challenge proof must be lowercase HMAC-SHA256 hex")
  .brand<"AuthChallengeProof">();
export type AuthChallengeProof = z.infer<typeof AuthChallengeProofSchema>;

const AuthChallengeIdentityProofShape = {
  brokerId: BrokerIdSchema,
  serverId: ServerIdSchema,
  clientNonce: AuthChallengeNonceSchema,
  serverNonce: AuthChallengeNonceSchema,
};

const AuthChallengeProofShape = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  ...AuthChallengeIdentityProofShape,
};

const VersionedAuthChallengeProofInputSchema = z
  .object({
    protocolVersion: z.number().int().positive(),
    ...AuthChallengeIdentityProofShape,
  })
  .strict()
  .readonly();
type VersionedAuthChallengeProofInput = z.infer<typeof VersionedAuthChallengeProofInputSchema>;

const VersionedAuthChallengeResponseSchema = z
  .object({
    protocolVersion: z.number().int().positive(),
    ...AuthChallengeIdentityProofShape,
    proof: AuthChallengeProofSchema,
  })
  .strict()
  .readonly();

export const AuthChallengeProofInputSchema = z.object(AuthChallengeProofShape).strict().readonly();
export type AuthChallengeProofInput = z.infer<typeof AuthChallengeProofInputSchema>;

export const AuthChallengeResponseSchema = z
  .object({
    ...AuthChallengeProofShape,
    proof: AuthChallengeProofSchema,
  })
  .strict()
  .readonly();
export type AuthChallengeResponse = z.infer<typeof AuthChallengeResponseSchema>;

/** Extracted HTTP request contract; `authorization: null` means the header must be absent. */
export const AuthChallengeRequestSchema = z
  .object({
    method: z.literal("GET"),
    path: z.literal(AUTH_CHALLENGE_ENDPOINT),
    query: z.literal(""),
    authorization: z.null(),
    clientNonce: AuthChallengeNonceSchema,
    body: z.null(),
  })
  .strict()
  .readonly();
export type AuthChallengeRequest = z.infer<typeof AuthChallengeRequestSchema>;

/** Domain UTF-8 bytes, NUL, then each ordered UTF-8 field prefixed by a 32-bit BE byte length. */
function canonicalProofBytes(input: VersionedAuthChallengeProofInput): Uint8Array {
  const encoder = new TextEncoder();
  const fields = [
    String(input.protocolVersion),
    input.brokerId,
    input.serverId,
    input.clientNonce,
    input.serverNonce,
  ];
  const domain = encoder.encode(AUTH_CHALLENGE_PROOF_DOMAIN);
  const encodedFields = fields.map((field) => encoder.encode(field));
  const byteLength =
    domain.byteLength + 1 + encodedFields.reduce((sum, field) => sum + 4 + field.byteLength, 0);
  const buffer = new ArrayBuffer(byteLength);
  const canonical = new Uint8Array(buffer);
  const view = new DataView(buffer);
  canonical.set(domain, 0);
  let offset = domain.byteLength;
  canonical[offset] = 0;
  offset += 1;
  for (const field of encodedFields) {
    view.setUint32(offset, field.byteLength, false);
    offset += 4;
    canonical.set(field, offset);
    offset += field.byteLength;
  }
  return canonical;
}

export function encodeAuthChallengeProofInput(input: AuthChallengeProofInput): Uint8Array {
  const parsed = AuthChallengeProofInputSchema.parse(input);
  return canonicalProofBytes(parsed);
}

function decodedBearerKey(token: string): DataView {
  const parsed = BearerTokenSchema.parse(token);
  const decoded = Buffer.from(parsed, "base64url");
  const keyBuffer = new ArrayBuffer(decoded.byteLength);
  const key = new Uint8Array(keyBuffer);
  key.set(decoded);
  return new DataView(keyBuffer);
}

export function createAuthChallengeProof(
  token: string,
  input: AuthChallengeProofInput,
): AuthChallengeProof {
  const parsed = AuthChallengeProofInputSchema.parse(input);
  const encoded = canonicalProofBytes(parsed);
  const proof = createHmac("sha256", decodedBearerKey(token))
    .update(new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength))
    .digest("hex");
  return AuthChallengeProofSchema.parse(proof);
}

function createVersionedAuthChallengeProof(
  token: string,
  input: VersionedAuthChallengeProofInput,
): AuthChallengeProof {
  const parsed = VersionedAuthChallengeProofInputSchema.parse(input);
  const encoded = canonicalProofBytes(parsed);
  const proof = createHmac("sha256", decodedBearerKey(token))
    .update(new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength))
    .digest("hex");
  return AuthChallengeProofSchema.parse(proof);
}

function constantTimeProofEqual(left: AuthChallengeProof, right: AuthChallengeProof): boolean {
  const leftBytes = Uint8Array.from(Buffer.from(left, "hex"));
  const rightBytes = Uint8Array.from(Buffer.from(right, "hex"));
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

export interface VerifyAuthChallengeResponseInput {
  readonly token: string;
  readonly expectedServerId: string;
  readonly expectedClientNonce: string;
  readonly response: unknown;
}

/** Must succeed immediately before any transport is allowed to disclose the bearer token. */
export function verifyAuthChallengeResponse(input: VerifyAuthChallengeResponseInput): boolean {
  const token = BearerTokenSchema.safeParse(input.token);
  const serverId = ServerIdSchema.safeParse(input.expectedServerId);
  const clientNonce = AuthChallengeNonceSchema.safeParse(input.expectedClientNonce);
  const response = AuthChallengeResponseSchema.safeParse(input.response);
  if (!token.success || !serverId.success || !clientNonce.success || !response.success)
    return false;

  const expectedProof = createAuthChallengeProof(token.data, {
    protocolVersion: response.data.protocolVersion,
    brokerId: response.data.brokerId,
    serverId: response.data.serverId,
    clientNonce: response.data.clientNonce,
    serverNonce: response.data.serverNonce,
  });
  const proofMatches = constantTimeProofEqual(expectedProof, response.data.proof);
  return (
    proofMatches &&
    response.data.serverId === serverId.data &&
    response.data.clientNonce === clientNonce.data
  );
}

/** Authenticates a known incompatible listener version without accepting it for normal use. */
export function verifyAuthChallengeResponseVersion(
  input: VerifyAuthChallengeResponseInput,
  expectedProtocolVersion: number,
): boolean {
  const token = BearerTokenSchema.safeParse(input.token);
  const serverId = ServerIdSchema.safeParse(input.expectedServerId);
  const clientNonce = AuthChallengeNonceSchema.safeParse(input.expectedClientNonce);
  const response = VersionedAuthChallengeResponseSchema.safeParse(input.response);
  if (
    !token.success ||
    !serverId.success ||
    !clientNonce.success ||
    !response.success ||
    response.data.protocolVersion !== expectedProtocolVersion
  ) {
    return false;
  }
  const { proof: _proof, ...proofInput } = response.data;
  const expectedProof = createVersionedAuthChallengeProof(token.data, proofInput);
  return (
    constantTimeProofEqual(expectedProof, response.data.proof) &&
    response.data.serverId === serverId.data &&
    response.data.clientNonce === clientNonce.data
  );
}

export function generateAuthChallengeNonce(): AuthChallengeNonce {
  return AuthChallengeNonceSchema.parse(randomBytes(32).toString("base64url"));
}

export function authChallengeResponseMatchesRequest(
  request: AuthChallengeRequest,
  candidate: unknown,
): candidate is AuthChallengeResponse {
  const parsedRequest = AuthChallengeRequestSchema.safeParse(request);
  const response = AuthChallengeResponseSchema.safeParse(candidate);
  return (
    parsedRequest.success &&
    response.success &&
    response.data.clientNonce === parsedRequest.data.clientNonce
  );
}

export function authChallengeMatchesMcpHandshake(
  challengeCandidate: unknown,
  handshakeCandidate: unknown,
): boolean {
  const challenge = AuthChallengeResponseSchema.safeParse(challengeCandidate);
  const handshake = HandshakeResponseSchema.safeParse(handshakeCandidate);
  return (
    challenge.success &&
    handshake.success &&
    handshake.data.ok &&
    handshake.data.protocolVersion === challenge.data.protocolVersion &&
    handshake.data.result.selectedProtocolVersion === challenge.data.protocolVersion &&
    handshake.data.result.broker.brokerId === challenge.data.brokerId &&
    handshake.data.result.broker.serverId === challenge.data.serverId
  );
}
