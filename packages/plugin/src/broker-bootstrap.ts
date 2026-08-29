import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { createRequire } from "node:module";
import { createConnection } from "node:net";

import { BROKER_CLI_EXIT_CODES } from "@opencode-agentbus/protocol";
import type { LoopbackBrokerEndpoint, TrustedConnectionConfig } from "@opencode-agentbus/protocol";

import { authenticateBrokerListener } from "./auth-challenge";
import type { SecureCredentialSnapshot, TrustedEnvironment } from "./credentials";
import { readCredentialFileIfPresentSecure } from "./credentials";
import {
  SAFE_MODEL_ERRORS,
  BrokerProtocolMismatchError,
  SafeModelError,
  asSafeModelError,
} from "./errors";

const READINESS_POLL_INTERVAL_MS = 100;
const INHERITED_BROKER_ENVIRONMENT_KEYS = ["PATH", "HOME", "OPENCODE_AGENTBUS_DB_PATH"] as const;
// Keep unref'ed ChildProcess objects observable until exit so the host reaps losing startup races.
const observedBrokerChildren = new Set<ReturnType<typeof spawn>>();

export interface BrokerListenAddress {
  readonly hostname: "127.0.0.1" | "::1";
  readonly port: number;
}

export interface BundledBrokerLaunchInput extends BrokerListenAddress {
  readonly credentialFilePath: string;
  readonly environment: TrustedEnvironment;
  readonly maxActiveSessionsPerPrincipal: number;
}

export interface SpawnedBrokerProcess {
  readonly pid: number | undefined;
  readonly exited: Promise<number | null>;
}

export interface BrokerAuthenticationInput {
  readonly config: TrustedConnectionConfig;
  readonly credential: SecureCredentialSnapshot;
}

export interface EndpointProbeInput {
  readonly address: BrokerListenAddress;
  readonly timeoutMs: number;
}

export interface BrokerBootstrapDependencies {
  readonly environment?: TrustedEnvironment;
  readonly readCredential?: (
    credentialFilePath: string,
  ) => Promise<SecureCredentialSnapshot | undefined>;
  readonly authenticate?: (input: BrokerAuthenticationInput) => Promise<void>;
  readonly probeEndpoint?: (input: EndpointProbeInput) => Promise<"occupied" | "unused">;
  readonly launchBroker?: (input: BundledBrokerLaunchInput) => SpawnedBrokerProcess | undefined;
  readonly now?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly reportOperatorError?: () => void;
}

interface ResolvedBrokerBootstrapDependencies {
  readonly environment: TrustedEnvironment;
  readonly readCredential: NonNullable<BrokerBootstrapDependencies["readCredential"]>;
  readonly authenticate: NonNullable<BrokerBootstrapDependencies["authenticate"]>;
  readonly probeEndpoint: NonNullable<BrokerBootstrapDependencies["probeEndpoint"]>;
  readonly launchBroker: NonNullable<BrokerBootstrapDependencies["launchBroker"]>;
  readonly now: NonNullable<BrokerBootstrapDependencies["now"]>;
  readonly sleep: NonNullable<BrokerBootstrapDependencies["sleep"]>;
  readonly reportOperatorError: NonNullable<BrokerBootstrapDependencies["reportOperatorError"]>;
}

export function endpointListenAddress(endpoint: LoopbackBrokerEndpoint): BrokerListenAddress {
  const parsed = new URL(endpoint);
  return {
    hostname: parsed.hostname === "[::1]" ? "::1" : "127.0.0.1",
    port: Number.parseInt(parsed.port, 10),
  };
}

export function resolveBundledBrokerCli(): string {
  const resolved = createRequire(import.meta.url).resolve("@opencode-agentbus/broker/cli");
  if (!isAbsolute(resolved)) throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
  return resolved;
}

function inheritedBrokerEnvironment(environment: TrustedEnvironment): TrustedEnvironment {
  const inherited: Record<string, string> = {};
  for (const key of INHERITED_BROKER_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined) inherited[key] = value;
  }
  return inherited;
}

export function brokerChildEnvironment(
  input: BundledBrokerLaunchInput,
): Readonly<Record<string, string>> {
  return {
    ...inheritedBrokerEnvironment(input.environment),
    OPENCODE_AGENTBUS_CREDENTIAL_FILE: input.credentialFilePath,
    OPENCODE_AGENTBUS_HOST: input.hostname,
    OPENCODE_AGENTBUS_MAX_ACTIVE_SESSIONS_PER_PRINCIPAL: String(
      input.maxActiveSessionsPerPrincipal,
    ),
    OPENCODE_AGENTBUS_PORT: String(input.port),
  };
}

export function launchBundledBroker(input: BundledBrokerLaunchInput): SpawnedBrokerProcess {
  const child = spawn(resolveBundledBrokerCli(), [], {
    detached: true,
    stdio: "ignore",
    env: brokerChildEnvironment(input),
  });
  observedBrokerChildren.add(child);
  const exited = new Promise<number | null>((resolve) => {
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      observedBrokerChildren.delete(child);
      resolve(code);
    };
    child.once("error", () => finish(null));
    child.once("exit", (code) => finish(code));
  });
  child.unref();
  return { pid: child.pid, exited };
}

async function probeLoopbackEndpoint(input: EndpointProbeInput): Promise<"occupied" | "unused"> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: input.address.hostname, port: input.address.port });
    let settled = false;
    const finish = (result: "occupied" | "unused") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(result);
    };
    const timeout = setTimeout(() => finish("occupied"), input.timeoutMs);
    timeout.unref?.();
    socket.once("connect", () => finish("occupied"));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ECONNREFUSED" ? "unused" : "occupied"),
    );
  });
}

function defaultAuthenticate(input: BrokerAuthenticationInput): Promise<void> {
  return authenticateBrokerListener({
    config: input.config,
    controller: new AbortController(),
    credential: input.credential.credential,
    fetchImplementation: globalThis.fetch,
  }).then(() => undefined);
}

export class BrokerBootstrap {
  private readonly dependencies: ResolvedBrokerBootstrapDependencies;
  private readonly address: BrokerListenAddress;
  private work: Promise<void> | undefined;
  private protocolMismatchReported = false;

  constructor(
    private readonly config: TrustedConnectionConfig,
    dependencies: BrokerBootstrapDependencies = {},
  ) {
    this.address = endpointListenAddress(config.endpoint);
    this.dependencies = {
      environment: dependencies.environment ?? process.env,
      readCredential: dependencies.readCredential ?? readCredentialFileIfPresentSecure,
      authenticate: dependencies.authenticate ?? defaultAuthenticate,
      probeEndpoint: dependencies.probeEndpoint ?? probeLoopbackEndpoint,
      launchBroker: dependencies.launchBroker ?? launchBundledBroker,
      now: dependencies.now ?? Date.now,
      sleep: dependencies.sleep ?? ((delayMs) => Bun.sleep(delayMs)),
      reportOperatorError: dependencies.reportOperatorError ?? (() => undefined),
    };
  }

  ensureReady(): Promise<void> {
    if (this.work) return this.work;
    const work = this.attempt().catch((error) => {
      throw asSafeModelError(error);
    });
    this.work = work;
    void work
      .finally(() => {
        if (this.work === work) this.work = undefined;
      })
      .catch(() => undefined);
    return work;
  }

  private async attempt(): Promise<void> {
    const deadline = this.dependencies.now() + this.config.brokerStartupTimeoutMs;
    const initialAuthentication = await this.tryAuthenticate(deadline);
    if (initialAuthentication === "ready") return;
    if (initialAuthentication === "protocol_mismatch") this.failProtocolMismatch();
    if (!this.config.autoStartBroker) {
      throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
    }

    const remainingForProbe = this.remaining(deadline);
    if (remainingForProbe <= 0) throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
    const endpointState = await this.dependencies.probeEndpoint({
      address: this.address,
      timeoutMs: remainingForProbe,
    });
    let spawned: SpawnedBrokerProcess | undefined;
    if (endpointState === "unused" && this.config.autoStartBroker) {
      spawned = this.dependencies.launchBroker({
        ...this.address,
        credentialFilePath: this.config.credentialFilePath,
        environment: inheritedBrokerEnvironment(this.dependencies.environment),
        maxActiveSessionsPerPrincipal: this.config.maxActiveSessionsPerPrincipal,
      });
    }

    while (this.remaining(deadline) > 0) {
      const delayMs = Math.min(READINESS_POLL_INTERVAL_MS, this.remaining(deadline));
      if (spawned) {
        const outcome = await Promise.race([
          this.dependencies.sleep(delayMs).then(() => ({ type: "poll" as const })),
          spawned.exited.then(
            (code) => ({ type: "exited" as const, code }),
            () => ({ type: "exited" as const, code: null }),
          ),
        ]);
        if (outcome.type === "exited") {
          const authentication = await this.tryAuthenticate(deadline);
          if (authentication === "ready") return;
          if (authentication === "protocol_mismatch") this.failProtocolMismatch();
          if (outcome.code === BROKER_CLI_EXIT_CODES.LEASE_CONTENTION) {
            spawned = undefined;
            continue;
          }
          throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
        }
      } else {
        await this.dependencies.sleep(delayMs);
      }
      const authentication = await this.tryAuthenticate(deadline);
      if (authentication === "ready") return;
      if (authentication === "protocol_mismatch") this.failProtocolMismatch();
    }
    throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
  }

  private async tryAuthenticate(
    deadline: number,
  ): Promise<"ready" | "unavailable" | "protocol_mismatch"> {
    const credential = await this.dependencies.readCredential(this.config.credentialFilePath);
    if (!credential) return "unavailable";
    const remaining = this.remaining(deadline);
    if (remaining <= 0) return "unavailable";
    try {
      await this.dependencies.authenticate({
        config: {
          ...this.config,
          timeoutMs: Math.min(this.config.timeoutMs, remaining),
        },
        credential,
      });
      return "ready";
    } catch (error) {
      return error instanceof BrokerProtocolMismatchError ? "protocol_mismatch" : "unavailable";
    }
  }

  private failProtocolMismatch(): never {
    if (!this.protocolMismatchReported) {
      this.protocolMismatchReported = true;
      this.dependencies.reportOperatorError();
    }
    throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
  }

  private remaining(deadline: number): number {
    return Math.max(0, deadline - this.dependencies.now());
  }
}
