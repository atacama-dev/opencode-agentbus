import { describe, expect, test } from "bun:test";

import { BROKER_CLI_EXIT_CODES } from "@opencode-agentbus/protocol";
import type { TrustedConnectionConfig } from "@opencode-agentbus/protocol";

import {
  BrokerBootstrap,
  brokerChildEnvironment,
  endpointListenAddress,
  resolveBundledBrokerCli,
  type BundledBrokerLaunchInput,
  type BrokerBootstrapDependencies,
} from "../src/broker-bootstrap";
import {
  OPERATOR_ERRORS,
  SAFE_MODEL_ERRORS,
  BrokerProtocolMismatchError,
  SafeModelError,
} from "../src/errors";
import { credentialSnapshot } from "./helpers";

const CONFIG = {
  endpoint: "http://127.0.0.1:49123",
  timeoutMs: 100,
  credentialFilePath: "/private/agentbus-credential.json",
  autoStartBroker: true,
  brokerStartupTimeoutMs: 500,
} as unknown as TrustedConnectionConfig;

function deterministicTime(): Pick<BrokerBootstrapDependencies, "now" | "sleep"> {
  let now = 1_000;
  return {
    now: () => now,
    sleep: async (delayMs) => {
      now += delayMs;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("persistent broker bootstrap", () => {
  test("derives only the validated loopback host and port", () => {
    expect(endpointListenAddress(CONFIG.endpoint)).toEqual({ hostname: "127.0.0.1", port: 49_123 });
    expect(endpointListenAddress("http://[::1]:4097" as never)).toEqual({
      hostname: "::1",
      port: 4_097,
    });
  });

  test("manual mode fails unavailable without probing, spawning, or reporting an upgrade", async () => {
    let probes = 0;
    let spawnCount = 0;
    let reports = 0;
    const bootstrap = new BrokerBootstrap(
      { ...CONFIG, autoStartBroker: false, brokerStartupTimeoutMs: 100 },
      {
        ...deterministicTime(),
        readCredential: async () => undefined,
        authenticate: async () => {
          throw new Error("not ready");
        },
        probeEndpoint: async () => {
          probes += 1;
          return "unused";
        },
        launchBroker: () => {
          spawnCount += 1;
          return undefined;
        },
        reportOperatorError: () => {
          reports += 1;
        },
      },
    );

    await expect(bootstrap.ensureReady()).rejects.toThrow(SAFE_MODEL_ERRORS.UNAVAILABLE);
    expect(probes).toBe(0);
    expect(spawnCount).toBe(0);
    expect(reports).toBe(0);
  });

  test("reuses an existing authenticated broker without probing or spawning", async () => {
    let authentications = 0;
    let probes = 0;
    let spawns = 0;
    const bootstrap = new BrokerBootstrap(CONFIG, {
      readCredential: async () => credentialSnapshot(),
      authenticate: async () => {
        authentications += 1;
      },
      probeEndpoint: async () => {
        probes += 1;
        return "occupied";
      },
      launchBroker: () => {
        spawns += 1;
        return undefined;
      },
    });

    await bootstrap.ensureReady();
    await bootstrap.ensureReady();
    expect(authentications).toBe(2);
    expect(probes).toBe(0);
    expect(spawns).toBe(0);
  });

  test("coalesces only concurrent readiness work", async () => {
    const authentication = deferred<void>();
    let authentications = 0;
    const bootstrap = new BrokerBootstrap(CONFIG, {
      readCredential: async () => credentialSnapshot(),
      authenticate: async () => {
        authentications += 1;
        await authentication.promise;
      },
      probeEndpoint: async () => "occupied",
    });

    const first = bootstrap.ensureReady();
    const second = bootstrap.ensureReady();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(authentications).toBe(1);
    authentication.resolve();
    await Promise.all([first, second]);
    await bootstrap.ensureReady();
    expect(authentications).toBe(2);
  });

  test("re-authenticates and relaunches after a previously ready broker disappears", async () => {
    let running = true;
    let spawnCount = 0;
    const bootstrap = new BrokerBootstrap(CONFIG, {
      ...deterministicTime(),
      readCredential: async () => credentialSnapshot(),
      authenticate: async () => {
        if (!running) throw new Error("stopped");
      },
      probeEndpoint: async () => (running ? "occupied" : "unused"),
      launchBroker: () => {
        spawnCount += 1;
        running = true;
        return { pid: 123, exited: new Promise<never>(() => undefined) };
      },
    });

    await bootstrap.ensureReady();
    running = false;
    await bootstrap.ensureReady();
    expect(spawnCount).toBe(1);
  });

  test("an unknown occupied listener is never replaced or signalled", async () => {
    let spawnCount = 0;
    const bootstrap = new BrokerBootstrap(
      { ...CONFIG, brokerStartupTimeoutMs: 100 },
      {
        ...deterministicTime(),
        readCredential: async () => credentialSnapshot(),
        authenticate: async () => {
          throw new Error("wrong listener");
        },
        probeEndpoint: async () => "occupied",
        launchBroker: () => {
          spawnCount += 1;
          return undefined;
        },
      },
    );

    await expect(bootstrap.ensureReady()).rejects.toThrow(SAFE_MODEL_ERRORS.UNAVAILABLE);
    expect(spawnCount).toBe(0);
  });

  test.each([true, false])(
    "an authenticated version-1 detached broker with autostart=%s is reported once and never probed or replaced",
    async (autoStartBroker) => {
      let probes = 0;
      let spawns = 0;
      const operatorErrors: string[] = [];
      const bootstrap = new BrokerBootstrap(
        { ...CONFIG, autoStartBroker },
        {
          readCredential: async () => credentialSnapshot(),
          authenticate: async () => {
            throw new BrokerProtocolMismatchError();
          },
          probeEndpoint: async () => {
            probes += 1;
            return "occupied";
          },
          launchBroker: () => {
            spawns += 1;
            return undefined;
          },
          reportOperatorError: () => operatorErrors.push(OPERATOR_ERRORS.PROTOCOL_MISMATCH),
        },
      );

      await expect(bootstrap.ensureReady()).rejects.toThrow(SAFE_MODEL_ERRORS.UNAVAILABLE);
      await expect(bootstrap.ensureReady()).rejects.toThrow(SAFE_MODEL_ERRORS.UNAVAILABLE);
      expect(operatorErrors).toEqual([OPERATOR_ERRORS.PROTOCOL_MISMATCH]);
      expect(probes).toBe(0);
      expect(spawns).toBe(0);
    },
  );

  test("starts the bundled broker for first-run state and waits for authenticated readiness", async () => {
    let launched = false;
    let spawnCount = 0;
    const launchInputs: BundledBrokerLaunchInput[] = [];
    const bootstrap = new BrokerBootstrap(CONFIG, {
      environment: {
        PATH: "/trusted/bin:/usr/bin",
        HOME: "/trusted/home",
        OPENCODE_AGENTBUS_DB_PATH: "/trusted/state.sqlite",
        AWS_SECRET_ACCESS_KEY: "must-not-be-inherited",
        OPENAI_API_KEY: "must-not-be-inherited",
        NODE_OPTIONS: "--require=/unsafe/injection.js",
        BUN_OPTIONS: "--preload=/unsafe/injection.ts",
        UNRELATED: "must-not-be-inherited",
      },
      ...deterministicTime(),
      readCredential: async () => (launched ? credentialSnapshot() : undefined),
      authenticate: async () => {
        if (!launched) throw new Error("not ready");
      },
      probeEndpoint: async () => "unused",
      launchBroker: (input) => {
        spawnCount += 1;
        launched = true;
        launchInputs.push(input);
        return undefined;
      },
    });

    await bootstrap.ensureReady();
    expect(spawnCount).toBe(1);
    expect(launchInputs).toEqual([
      {
        credentialFilePath: CONFIG.credentialFilePath,
        environment: {
          PATH: "/trusted/bin:/usr/bin",
          HOME: "/trusted/home",
          OPENCODE_AGENTBUS_DB_PATH: "/trusted/state.sqlite",
        },
        hostname: "127.0.0.1",
        port: 49_123,
      },
    ]);
    const launchInput = launchInputs[0];
    if (!launchInput) throw new Error("Missing launch input.");
    expect(brokerChildEnvironment(launchInput)).toEqual({
      PATH: "/trusted/bin:/usr/bin",
      HOME: "/trusted/home",
      OPENCODE_AGENTBUS_DB_PATH: "/trusted/state.sqlite",
      OPENCODE_AGENTBUS_CREDENTIAL_FILE: CONFIG.credentialFilePath,
      OPENCODE_AGENTBUS_HOST: "127.0.0.1",
      OPENCODE_AGENTBUS_PORT: "49123",
    });
  });

  test("lease-contention loser waits for the winner until authenticated readiness", async () => {
    let now = 1_000;
    let ready = false;
    let sleepCount = 0;
    let spawnCount = 0;
    const bootstrap = new BrokerBootstrap(CONFIG, {
      now: () => now,
      readCredential: async () => credentialSnapshot(),
      authenticate: async () => {
        if (!ready) throw new Error("winner not listening yet");
      },
      probeEndpoint: async () => "unused",
      launchBroker: () => {
        spawnCount += 1;
        return { pid: 123, exited: Promise.resolve(BROKER_CLI_EXIT_CODES.LEASE_CONTENTION) };
      },
      sleep: async (delayMs) => {
        sleepCount += 1;
        now += delayMs;
        ready = true;
      },
    });

    await bootstrap.ensureReady();
    expect(spawnCount).toBe(1);
    expect(sleepCount).toBe(1);
  });

  test.each([BROKER_CLI_EXIT_CODES.FAILURE, null])(
    "fails safely as soon as its spawned broker exits before readiness (%s)",
    async (exitCode) => {
      let sleepCount = 0;
      const bootstrap = new BrokerBootstrap(CONFIG, {
        readCredential: async () => undefined,
        authenticate: async () => {
          throw new Error("raw startup failure");
        },
        probeEndpoint: async () => "unused",
        launchBroker: () => ({ pid: 123, exited: Promise.resolve(exitCode) }),
        sleep: async () => {
          sleepCount += 1;
          await new Promise<never>(() => undefined);
        },
      });

      const failure = await Promise.race([
        bootstrap.ensureReady(),
        Bun.sleep(100).then(() => {
          throw new Error("readiness ignored child exit");
        }),
      ]).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SafeModelError);
      expect((failure as Error).message).toBe(SAFE_MODEL_ERRORS.UNAVAILABLE);
      expect((failure as Error).message).not.toContain("raw startup failure");
      expect(sleepCount).toBeLessThanOrEqual(1);
    },
  );

  test("an insecure or malformed existing credential fails closed without spawning", async () => {
    let spawnCount = 0;
    const bootstrap = new BrokerBootstrap(CONFIG, {
      readCredential: async () => {
        throw new SafeModelError(SAFE_MODEL_ERRORS.INVALID_CREDENTIAL);
      },
      authenticate: async () => undefined,
      probeEndpoint: async () => "unused",
      launchBroker: () => {
        spawnCount += 1;
        return undefined;
      },
    });

    await expect(bootstrap.ensureReady()).rejects.toThrow(SAFE_MODEL_ERRORS.INVALID_CREDENTIAL);
    expect(spawnCount).toBe(0);
  });

  test("resolves the broker CLI through the declared package dependency", () => {
    expect(resolveBundledBrokerCli()).toMatch(/@opencode-agentbus\/broker|packages\/broker/);
    expect(resolveBundledBrokerCli()).toEndWith("/dist/cli.js");
  });
});
