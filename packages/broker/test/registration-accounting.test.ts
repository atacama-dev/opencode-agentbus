import { describe, expect, test } from "bun:test";
import { METHODS, type RegistrationResult } from "@opencode-agentbus/protocol";
import {
  claimRequest,
  createHarness,
  expectError,
  expectSuccess,
  registerRequest,
} from "./helpers";

describe("registration churn accounting", () => {
  test("allows more than 61 legitimate initial registrations by default", () => {
    const harness = createHarness();
    try {
      for (let index = 0; index < 62; index += 1) {
        expectSuccess(
          harness.service.dispatch(
            harness.service.principal,
            registerRequest(`bootstrap-${index}`),
          ),
        );
      }
      expect(harness.service.storageStatsForTesting().registrationRateRows).toBe(62);
    } finally {
      harness.close();
    }
  });

  test("supports one complete 256-session bootstrap and rejects the next create", () => {
    const harness = createHarness();
    try {
      for (let index = 0; index < 256; index += 1) {
        expectSuccess(
          harness.service.dispatch(
            harness.service.principal,
            registerRequest(`full-bootstrap-${index}`),
          ),
        );
      }
      expect(harness.service.storageStatsForTesting()).toMatchObject({
        sessions: 256,
        registrationRateRows: 256,
      });
      expectError(
        harness.service.dispatch(
          harness.service.principal,
          registerRequest("full-bootstrap-over-limit"),
        ),
        "RATE_LIMITED",
      );
    } finally {
      harness.close();
    }
  });

  test("does not charge rapid unchanged reconnect and lease refresh", () => {
    const harness = createHarness({
      limits: {
        registrationsPerPrincipalPerMinute: 1,
        rateRetentionMs: 300_000,
      },
    });
    try {
      const first = expectSuccess<RegistrationResult>(
        harness.service.dispatch(
          harness.service.principal,
          registerRequest("rapid-reconnect", "Stable", ["same"]),
        ),
      );
      for (let index = 0; index < 100; index += 1) {
        harness.clock.advance(10);
        const refreshed = expectSuccess<RegistrationResult>(
          harness.service.dispatch(
            harness.service.principal,
            registerRequest("rapid-reconnect", "Stable", ["same"]),
          ),
        );
        expect(refreshed.identity).toEqual(first.identity);
      }
      harness.clock.advance(120_000);
      expectSuccess(
        harness.service.dispatch(
          harness.service.principal,
          registerRequest("rapid-reconnect", "Stable", ["same"]),
        ),
      );
      expect(harness.service.storageStatsForTesting().registrationRateRows).toBe(1);
    } finally {
      harness.close();
    }
  });

  test("charges real metadata and opt-in changes but not unchanged repeats", () => {
    const metadataHarness = createHarness({ limits: { registrationsPerPrincipalPerMinute: 2 } });
    try {
      expectSuccess(
        metadataHarness.service.dispatch(
          metadataHarness.service.principal,
          registerRequest("metadata-change", "Version A"),
        ),
      );
      expectSuccess(
        metadataHarness.service.dispatch(
          metadataHarness.service.principal,
          registerRequest("metadata-change", "Version A"),
        ),
      );
      expectSuccess(
        metadataHarness.service.dispatch(
          metadataHarness.service.principal,
          registerRequest("metadata-change", "Version B"),
        ),
      );
      expectSuccess(
        metadataHarness.service.dispatch(
          metadataHarness.service.principal,
          registerRequest("metadata-change", "Version B"),
        ),
      );
      expectError(
        metadataHarness.service.dispatch(
          metadataHarness.service.principal,
          registerRequest("metadata-change", "Version C"),
        ),
        "RATE_LIMITED",
      );
      expect(metadataHarness.service.storageStatsForTesting().registrationRateRows).toBe(2);
    } finally {
      metadataHarness.close();
    }

    const optInHarness = createHarness({ limits: { registrationsPerPrincipalPerMinute: 2 } });
    try {
      const created = expectSuccess<RegistrationResult>(
        optInHarness.service.dispatch(
          optInHarness.service.principal,
          registerRequest("opt-in-change"),
        ),
      );
      expectSuccess(
        optInHarness.service.dispatch(
          optInHarness.service.principal,
          claimRequest(METHODS.DEREGISTER_SESSION, created.identity),
        ),
      );
      expectSuccess(
        optInHarness.service.dispatch(
          optInHarness.service.principal,
          registerRequest("opt-in-change"),
        ),
      );
      expectSuccess(
        optInHarness.service.dispatch(
          optInHarness.service.principal,
          claimRequest(METHODS.DEREGISTER_SESSION, created.identity),
        ),
      );
      expectError(
        optInHarness.service.dispatch(
          optInHarness.service.principal,
          registerRequest("opt-in-change"),
        ),
        "RATE_LIMITED",
      );
    } finally {
      optInHarness.close();
    }
  });

  test("bounds repeated create/deregister churn", () => {
    const harness = createHarness({
      limits: {
        registrationsPerPrincipalPerMinute: 3,
        maxActiveSessionsPerPrincipal: 10,
      },
    });
    try {
      for (let index = 0; index < 3; index += 1) {
        const registration = expectSuccess<RegistrationResult>(
          harness.service.dispatch(harness.service.principal, registerRequest(`churn-${index}`)),
        );
        expectSuccess(
          harness.service.dispatch(
            harness.service.principal,
            claimRequest(METHODS.DEREGISTER_SESSION, registration.identity),
          ),
        );
      }
      expectError(
        harness.service.dispatch(harness.service.principal, registerRequest("churn-over-limit")),
        "RATE_LIMITED",
      );
    } finally {
      harness.close();
    }
  });
});
