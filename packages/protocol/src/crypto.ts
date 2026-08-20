import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  BodyHashSchema,
  BrokerServerIdentitySchema,
  CanonicalSearchQuerySchema,
  MessageBodySchema,
  ScopeFingerprintSchema,
  SearchQueryHashSchema,
  SessionFingerprintSchema,
  SessionIdentitySchema,
  canonicalizeSearchQueryUnchecked,
} from "./schemas";
import type {
  BodyHash,
  BrokerServerIdentity,
  CanonicalSearchQuery,
  ScopeFingerprint,
  SearchQueryHash,
  SessionFingerprint,
  SessionIdentity,
} from "./schemas";

const SESSION_FINGERPRINT_DOMAIN = "opencode-agentbus/session-fingerprint/v1";
const BROKER_SCOPE_DOMAIN = "opencode-agentbus/broker-scope/v1";
const SEARCH_QUERY_DOMAIN = "opencode-agentbus/search-query/v1";

function domainSeparatedSha256(domain: string, fields: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(domain, "utf8");
  hash.update("\0", "utf8");

  for (const field of fields) {
    const byteLength = Buffer.byteLength(field, "utf8");
    hash.update(byteLength.toString(16).padStart(8, "0"), "ascii");
    hash.update(field, "utf8");
  }

  return hash.digest("hex");
}

export function sessionFingerprint(identity: SessionIdentity): SessionFingerprint {
  const parsed = SessionIdentitySchema.parse(identity);
  return SessionFingerprintSchema.parse(
    domainSeparatedSha256(SESSION_FINGERPRINT_DOMAIN, [
      parsed.broker.brokerId,
      parsed.broker.serverId,
      parsed.sessionId,
    ]),
  );
}

export function brokerScopeFingerprint(identity: BrokerServerIdentity): ScopeFingerprint {
  const parsed = BrokerServerIdentitySchema.parse(identity);
  return ScopeFingerprintSchema.parse(
    domainSeparatedSha256(BROKER_SCOPE_DOMAIN, [parsed.brokerId, parsed.serverId]),
  );
}

export function bodySha256(body: string): BodyHash {
  const parsed = MessageBodySchema.parse(body);
  return BodyHashSchema.parse(createHash("sha256").update(parsed, "utf8").digest("hex"));
}

export function normalizeSearchQuery(query: string): CanonicalSearchQuery {
  if (typeof query !== "string") throw new TypeError("Search query must be a string.");
  return CanonicalSearchQuerySchema.parse(canonicalizeSearchQueryUnchecked(query));
}

export function hashNormalizedSearchQuery(query: CanonicalSearchQuery): SearchQueryHash {
  const canonical = CanonicalSearchQuerySchema.parse(query);
  return SearchQueryHashSchema.parse(domainSeparatedSha256(SEARCH_QUERY_DOMAIN, [canonical]));
}

export type ReceivePermissionResource = `target:${SessionFingerprint}:sender:${SessionFingerprint}`;

export function receivePermissionResource(
  target: SessionIdentity,
  source: SessionIdentity,
): ReceivePermissionResource {
  return `target:${sessionFingerprint(target)}:sender:${sessionFingerprint(source)}`;
}

export type SearchPermissionResource = `scope:${ScopeFingerprint}:query:${SearchQueryHash}`;

export function searchPermissionResource(
  scope: BrokerServerIdentity,
  query: CanonicalSearchQuery,
): SearchPermissionResource {
  return `scope:${brokerScopeFingerprint(scope)}:query:${hashNormalizedSearchQuery(query)}`;
}
