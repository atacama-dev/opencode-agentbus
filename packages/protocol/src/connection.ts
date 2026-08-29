import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";

import { z } from "zod";

import {
  DEFAULT_ACTIVE_SESSIONS_PER_PRINCIPAL,
  DEFAULT_BROKER_ENDPOINT,
  DEFAULT_BROKER_STARTUP_TIMEOUT_MS,
  DEFAULT_CONNECTION_TIMEOUT_MS,
  MAX_ACTIVE_SESSIONS_PER_PRINCIPAL,
  MAX_BROKER_STARTUP_TIMEOUT_MS,
  MAX_CONNECTION_TIMEOUT_MS,
  MAX_CREDENTIAL_FILE_PATH_BYTES,
  MIN_ACTIVE_SESSIONS_PER_PRINCIPAL,
  MIN_CONNECTION_TIMEOUT_MS,
  MIN_BROKER_STARTUP_TIMEOUT_MS,
} from "./constants";
import { BrokerIdSchema, PrincipalIdSchema, ServerIdSchema } from "./schemas";
import type { BrokerId, PrincipalId } from "./schemas";
import { isWellFormedUnicode, utf8Bytes } from "./unicode";

const LOOPBACK_ENDPOINT_PATTERN = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/;

export const LoopbackBrokerEndpointSchema = z
  .string()
  .refine((value) => {
    const match = LOOPBACK_ENDPOINT_PATTERN.exec(value);
    if (!match?.[1]) return false;
    const port = Number.parseInt(match[1], 10);
    return port >= 1 && port <= 65_535;
  }, "broker endpoint must be literal loopback HTTP with an explicit valid port")
  .brand<"LoopbackBrokerEndpoint">();
export type LoopbackBrokerEndpoint = z.infer<typeof LoopbackBrokerEndpointSchema>;

export const CredentialFilePathSchema = z
  .string()
  .refine(isWellFormedUnicode, "credential file path must be well-formed Unicode")
  .refine(
    (value) => isWellFormedUnicode(value) && utf8Bytes(value) <= MAX_CREDENTIAL_FILE_PATH_BYTES,
  )
  .refine((value) => isAbsolute(value), "credential file path must be absolute")
  .refine((value) => !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value), "unsafe credential path");

/** Trusted local plugin configuration. The path is sensitive and must never reach model context. */
export const TrustedConnectionConfigSchema = z
  .object({
    endpoint: LoopbackBrokerEndpointSchema.default(DEFAULT_BROKER_ENDPOINT),
    timeoutMs: z
      .number()
      .int()
      .min(MIN_CONNECTION_TIMEOUT_MS)
      .max(MAX_CONNECTION_TIMEOUT_MS)
      .default(DEFAULT_CONNECTION_TIMEOUT_MS),
    credentialFilePath: CredentialFilePathSchema,
    autoStartBroker: z.boolean().default(true),
    brokerStartupTimeoutMs: z
      .number()
      .int()
      .min(MIN_BROKER_STARTUP_TIMEOUT_MS)
      .max(MAX_BROKER_STARTUP_TIMEOUT_MS)
      .default(DEFAULT_BROKER_STARTUP_TIMEOUT_MS),
    wakeOnMessage: z.boolean().default(false),
    focusOnReceiveApproval: z.boolean().default(false),
    maxActiveSessionsPerPrincipal: z
      .number()
      .int()
      .min(MIN_ACTIVE_SESSIONS_PER_PRINCIPAL)
      .max(MAX_ACTIVE_SESSIONS_PER_PRINCIPAL)
      .default(DEFAULT_ACTIVE_SESSIONS_PER_PRINCIPAL),
  })
  .strict()
  .readonly();
export type TrustedConnectionConfig = z.infer<typeof TrustedConnectionConfigSchema>;

export const BearerTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "bearer token must be 256-bit unpadded base64url")
  .brand<"SecretBearerToken">();
export type SecretBearerToken = z.infer<typeof BearerTokenSchema>;

/** Secret out-of-band file content. Never serialize this through protocol/error/model schemas. */
export const CredentialFileSchema = z
  .object({
    version: z.literal(1),
    principalId: PrincipalIdSchema,
    serverId: ServerIdSchema,
    token: BearerTokenSchema,
  })
  .strict()
  .readonly();
export type CredentialFile = z.infer<typeof CredentialFileSchema>;

export function generateBearerToken(): SecretBearerToken {
  return BearerTokenSchema.parse(randomBytes(32).toString("base64url"));
}

export function generateBrokerId(): BrokerId {
  return BrokerIdSchema.parse(randomBytes(32).toString("base64url"));
}

export function generatePrincipalId(): PrincipalId {
  return PrincipalIdSchema.parse(randomBytes(32).toString("base64url"));
}
