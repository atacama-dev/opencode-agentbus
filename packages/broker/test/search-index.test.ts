import { chmodSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  METHODS,
  PROTOCOL_VERSION,
  type RegistrationResult,
  type SearchSessionsResult,
} from "@opencode-agentbus/protocol";
import { BrokerService } from "../src/service";
import { createHarness, expectSuccess, registerRequest, requestId } from "./helpers";

function searchRequest(requester: RegistrationResult, query: string) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId("canonical-search"),
    method: METHODS.SEARCH_SESSIONS,
    params: {
      requester: requester.identity,
      scope: requester.identity.broker,
      query,
      limit: 50,
    },
  } as const;
}

describe("canonical registry metadata index", () => {
  test("matches repeated whitespace, case, and Unicode normalization field by field", () => {
    const harness = createHarness();
    try {
      const requester = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("search-requester")),
      );
      const whitespace = expectSuccess<RegistrationResult>(
        harness.service.dispatch(
          harness.service.principal,
          registerRequest("whitespace", "Build    AGENT"),
        ),
      );
      const unicode = expectSuccess<RegistrationResult>(
        harness.service.dispatch(
          harness.service.principal,
          registerRequest("unicode", "Cafe\u0301 Worker"),
        ),
      );

      const normalizedWhitespace = expectSuccess<SearchSessionsResult>(
        harness.service.dispatch(
          harness.service.principal,
          searchRequest(requester, "build agent"),
        ),
      );
      expect(normalizedWhitespace.matches.map((match) => match.session)).toContainEqual(
        whitespace.identity,
      );
      const normalizedUnicode = expectSuccess<SearchSessionsResult>(
        harness.service.dispatch(
          harness.service.principal,
          searchRequest(requester, "café worker"),
        ),
      );
      expect(normalizedUnicode.matches.map((match) => match.session)).toContainEqual(
        unicode.identity,
      );
    } finally {
      harness.close();
    }
  });

  test("keeps title and label separators distinct and indexes each bounded field", () => {
    const harness = createHarness();
    try {
      const requester = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("separator-requester")),
      );
      const labels = [
        "Beta",
        "Mixed    CASE",
        "Needle    LABEL",
        ...Array.from({ length: 13 }, (_, index) => `Field-${index}-${"X".repeat(30)}`),
      ];
      const separated = expectSuccess<RegistrationResult>(
        harness.service.dispatch(
          harness.service.principal,
          registerRequest("separator", "Alpha", labels),
        ),
      );

      for (const query of ["alpha", "beta", "mixed case", "needle label"]) {
        const result = expectSuccess<SearchSessionsResult>(
          harness.service.dispatch(harness.service.principal, searchRequest(requester, query)),
        );
        expect(result.matches.map((match) => match.session)).toContainEqual(separated.identity);
      }
      const crossField = expectSuccess<SearchSessionsResult>(
        harness.service.dispatch(harness.service.principal, searchRequest(requester, "alpha beta")),
      );
      expect(crossField.matches.map((match) => match.session)).not.toContainEqual(
        separated.identity,
      );
    } finally {
      harness.close();
    }
  });

  test("migrates and reindexes existing version 2 rows", () => {
    const harness = createHarness();
    try {
      const requester = expectSuccess<RegistrationResult>(
        harness.service.dispatch(harness.service.principal, registerRequest("migration-requester")),
      );
      const legacy = expectSuccess<RegistrationResult>(
        harness.service.dispatch(
          harness.service.principal,
          registerRequest("migration-target", "Cafe\u0301    BUILD Agent"),
        ),
      );
      harness.service.close();
      const database = new Database(harness.databasePath);
      database.run("UPDATE sessions SET metadata_search = metadata_json");
      database.run("PRAGMA user_version = 2");
      database.close();
      chmodSync(harness.databasePath, 0o600);

      const migrated = BrokerService.open({
        databasePath: harness.databasePath,
        credentialFilePath: harness.credentialFilePath,
        clock: harness.clock,
        random: harness.random,
      });
      try {
        expect(migrated.schemaVersionForTesting()).toBe(3);
        const result = expectSuccess<SearchSessionsResult>(
          migrated.dispatch(migrated.principal, searchRequest(requester, "café build agent")),
        );
        expect(result.matches.map((match) => match.session)).toContainEqual(legacy.identity);
      } finally {
        migrated.close();
      }
    } finally {
      harness.close();
    }
  });
});
