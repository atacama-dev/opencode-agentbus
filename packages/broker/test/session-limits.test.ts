import { describe, expect, test } from "bun:test";

import {
  DEFAULT_ACTIVE_SESSIONS_PER_PRINCIPAL,
  MAX_ACTIVE_SESSIONS_PER_PRINCIPAL,
  MIN_ACTIVE_SESSIONS_PER_PRINCIPAL,
} from "@opencode-agentbus/protocol";

import { BROKER_SESSION_LIMIT_POLICY, resolveBrokerLimits } from "../src/service";
import { BROKER_DAEMON_CAPACITY_POLICY, deriveBrokerDaemonCapacityLimits } from "../src/server";
import { createHarness, expectSuccess, registerRequest } from "./helpers";

describe("broker active-session limit policy", () => {
  test("derives finite coherent defaults and bounded min/max configurations", () => {
    expect(BROKER_SESSION_LIMIT_POLICY).toEqual({
      durableSessionsPerActiveSession: 4,
      globalDurableSessionsPerActiveSession: 16,
      minimumRegistrationBudget: 256,
      maxDurableSessionsPerPrincipal: 65_536,
      maxDurableSessionsGlobal: 262_144,
      maxForegroundSessionReserve: 16_384,
      maxRegistrationsPerPrincipalPerMinute: 16_384,
    });
    expect(resolveBrokerLimits()).toMatchObject({
      maxActiveSessionsPerPrincipal: DEFAULT_ACTIVE_SESSIONS_PER_PRINCIPAL,
      maxSessionsPerPrincipal: 16_384,
      maxSessionsGlobal: 65_536,
      foregroundSessionReserve: 4_096,
      registrationsPerPrincipalPerMinute: 4_096,
    });
    expect(
      resolveBrokerLimits({
        maxActiveSessionsPerPrincipal: MIN_ACTIVE_SESSIONS_PER_PRINCIPAL,
      }),
    ).toMatchObject({
      maxActiveSessionsPerPrincipal: 2,
      maxSessionsPerPrincipal: 8,
      maxSessionsGlobal: 32,
      foregroundSessionReserve: 2,
      registrationsPerPrincipalPerMinute: 256,
    });
    expect(
      resolveBrokerLimits({
        maxActiveSessionsPerPrincipal: MAX_ACTIVE_SESSIONS_PER_PRINCIPAL,
      }),
    ).toMatchObject({
      maxActiveSessionsPerPrincipal: 16_384,
      maxSessionsPerPrincipal: 65_536,
      maxSessionsGlobal: 262_144,
      foregroundSessionReserve: 16_384,
      registrationsPerPrincipalPerMinute: 16_384,
    });
    expect(resolveBrokerLimits({ maxActiveSessionsPerPrincipal: 300 })).toMatchObject({
      maxActiveSessionsPerPrincipal: 300,
      maxSessionsPerPrincipal: 1_200,
      maxSessionsGlobal: 4_800,
      foregroundSessionReserve: 300,
      registrationsPerPrincipalPerMinute: 300,
    });
  });

  test("rejects active and derived quota values beyond finite hard maxima", () => {
    for (const limits of [
      { maxActiveSessionsPerPrincipal: 1 },
      { maxActiveSessionsPerPrincipal: MAX_ACTIVE_SESSIONS_PER_PRINCIPAL + 1 },
      {
        maxActiveSessionsPerPrincipal: 2,
        maxSessionsPerPrincipal: BROKER_SESSION_LIMIT_POLICY.maxDurableSessionsPerPrincipal + 1,
      },
      {
        maxActiveSessionsPerPrincipal: 2,
        maxSessionsGlobal: BROKER_SESSION_LIMIT_POLICY.maxDurableSessionsGlobal + 1,
      },
      {
        maxActiveSessionsPerPrincipal: 2,
        foregroundSessionReserve: BROKER_SESSION_LIMIT_POLICY.maxForegroundSessionReserve + 1,
      },
      {
        maxActiveSessionsPerPrincipal: 2,
        registrationsPerPrincipalPerMinute:
          BROKER_SESSION_LIMIT_POLICY.maxRegistrationsPerPrincipalPerMinute + 1,
      },
    ]) {
      expect(() => resolveBrokerLimits(limits)).toThrow();
    }
  });

  test("derives finite authentication and transport capacity from active sessions", () => {
    expect(BROKER_DAEMON_CAPACITY_POLICY).toEqual({
      authChallengesPerActiveSession: 4,
      authChallengeFixedHeadroom: 256,
      bootstrapSessionsPerWorkspace: 256,
      transportOperationalHeadroom: 4,
      globalConnectionMultiplier: 2,
      maxAuthChallengesPerMinute: 65_792,
      maxMcpSessionsPerPrincipal: 68,
      maxMcpSessionsGlobal: 136,
      maxSseConnectionsPerPrincipal: 68,
      maxSseConnectionsGlobal: 136,
    });
    expect(deriveBrokerDaemonCapacityLimits(MIN_ACTIVE_SESSIONS_PER_PRINCIPAL)).toEqual({
      maxAuthChallengesPerMinute: 264,
      maxMcpSessionsPerPrincipal: 5,
      maxMcpSessionsGlobal: 10,
      maxSseConnectionsPerPrincipal: 5,
      maxSseConnectionsGlobal: 10,
    });
    const defaultDaemonLimits = deriveBrokerDaemonCapacityLimits(
      DEFAULT_ACTIVE_SESSIONS_PER_PRINCIPAL,
    );
    expect(defaultDaemonLimits).toEqual({
      maxAuthChallengesPerMinute: 16_640,
      maxMcpSessionsPerPrincipal: 20,
      maxMcpSessionsGlobal: 40,
      maxSseConnectionsPerPrincipal: 20,
      maxSseConnectionsGlobal: 40,
    });
    const hardMaximumDaemonLimits = deriveBrokerDaemonCapacityLimits(
      MAX_ACTIVE_SESSIONS_PER_PRINCIPAL,
    );
    expect(hardMaximumDaemonLimits).toEqual({
      maxAuthChallengesPerMinute: 65_792,
      maxMcpSessionsPerPrincipal: 68,
      maxMcpSessionsGlobal: 136,
      maxSseConnectionsPerPrincipal: 68,
      maxSseConnectionsGlobal: 136,
    });
    expect(defaultDaemonLimits.maxAuthChallengesPerMinute).toBeGreaterThanOrEqual(
      DEFAULT_ACTIVE_SESSIONS_PER_PRINCIPAL * 4 + 6,
    );
    expect(hardMaximumDaemonLimits.maxAuthChallengesPerMinute).toBeGreaterThanOrEqual(
      MAX_ACTIVE_SESSIONS_PER_PRINCIPAL * 4 + 6,
    );
    expect(deriveBrokerDaemonCapacityLimits(256).maxSseConnectionsPerPrincipal).toBe(5);
    expect(deriveBrokerDaemonCapacityLimits(257).maxSseConnectionsPerPrincipal).toBe(6);
    expect(() => deriveBrokerDaemonCapacityLimits(1)).toThrow();
    expect(() => deriveBrokerDaemonCapacityLimits(MAX_ACTIVE_SESSIONS_PER_PRINCIPAL + 1)).toThrow();
  });

  test("admits 300 active sessions without durable or registration quotas causing displacement", () => {
    const harness = createHarness({ limits: { maxActiveSessionsPerPrincipal: 300 } });
    try {
      for (let index = 0; index < 300; index += 1) {
        expectSuccess(
          harness.service.dispatch(
            harness.service.principal,
            registerRequest(`configured-active-${index}`),
          ),
        );
      }
      expect(harness.service.storageStatsForTesting()).toMatchObject({
        sessions: 300,
        activeSessions: 300,
        displacedSessions: 0,
        registrationRateRows: 300,
      });
    } finally {
      harness.close();
    }
  });

  test("sustains the default 4096-session store capacity in the ordinary CI suite", () => {
    const harness = createHarness();
    try {
      for (let index = 0; index < DEFAULT_ACTIVE_SESSIONS_PER_PRINCIPAL; index += 1) {
        expectSuccess(
          harness.service.dispatch(
            harness.service.principal,
            registerRequest(`default-active-${index}`),
          ),
        );
      }
      expect(harness.service.storageStatsForTesting()).toMatchObject({
        sessions: DEFAULT_ACTIVE_SESSIONS_PER_PRINCIPAL,
        activeSessions: DEFAULT_ACTIVE_SESSIONS_PER_PRINCIPAL,
        displacedSessions: 0,
        registrationRateRows: DEFAULT_ACTIVE_SESSIONS_PER_PRINCIPAL,
      });
    } finally {
      harness.close();
    }
  }, 20_000);
});
