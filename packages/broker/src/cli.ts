#!/usr/bin/env bun

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BROKER_CLI_EXIT_CODES } from "@opencode-agentbus/protocol";
import { BrokerLeaseContentionError, acquireBrokerProcessLease } from "./process-lease";
import { BrokerDaemon, BROKER_DEFAULTS, validateListenHost } from "./server";
import { BrokerService, type BrokerLogger } from "./service";

export interface BrokerEnvironmentConfig {
  readonly databasePath: string;
  readonly credentialFilePath: string;
  readonly hostname: "127.0.0.1" | "::1";
  readonly port: number;
}

const daemonLogger: BrokerLogger = {
  info(message) {
    console.info(message);
  },
  warn(message) {
    console.warn(message);
  },
  error(message) {
    console.error(message);
  },
};

function configuredPort(value: string | undefined): number {
  if (value === undefined) return BROKER_DEFAULTS.port;
  if (!/^[1-9][0-9]{0,4}$/.test(value)) throw new TypeError("Broker port is invalid.");
  const port = Number(value);
  if (port > 65_535) throw new TypeError("Broker port is invalid.");
  return port;
}

function configuredPath(value: string, kind: string): string {
  if (
    !isAbsolute(value) ||
    value.length > 4_096 ||
    /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)
  ) {
    throw new TypeError(`${kind} path is invalid.`);
  }
  return value;
}

export function parseBrokerEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  fallbackHome = homedir(),
): BrokerEnvironmentConfig {
  const home = environment.HOME ?? fallbackHome;
  return {
    databasePath: configuredPath(
      environment.OPENCODE_AGENTBUS_DB_PATH ??
        join(home, ".local", "state", "opencode-agentbus", "broker.sqlite"),
      "Database",
    ),
    credentialFilePath: configuredPath(
      environment.OPENCODE_AGENTBUS_CREDENTIAL_FILE ??
        join(home, ".config", "opencode-agentbus", "credential.json"),
      "Credential",
    ),
    hostname: validateListenHost(environment.OPENCODE_AGENTBUS_HOST ?? BROKER_DEFAULTS.hostname),
    port: configuredPort(environment.OPENCODE_AGENTBUS_PORT),
  };
}

export async function launchBrokerDaemon(
  config: BrokerEnvironmentConfig,
  logger: BrokerLogger = daemonLogger,
): Promise<BrokerDaemon> {
  const service = BrokerService.open({
    databasePath: config.databasePath,
    credentialFilePath: config.credentialFilePath,
    logger,
  });
  const daemon = new BrokerDaemon({
    service,
    hostname: config.hostname,
    port: config.port,
  });
  try {
    await daemon.start();
    return daemon;
  } catch (error) {
    service.close();
    throw error;
  }
}

async function main(): Promise<void> {
  const config = parseBrokerEnvironment(process.env);
  const lease = await acquireBrokerProcessLease({ hostname: config.hostname, port: config.port });
  let daemon: BrokerDaemon;
  try {
    daemon = await launchBrokerDaemon(config);
  } catch (error) {
    await lease.release();
    throw error;
  }
  daemonLogger.info("Agent bus broker started on the configured loopback endpoint.");
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    daemon
      .stop()
      .then(async () => {
        await lease.release();
        process.exit(BROKER_CLI_EXIT_CODES.SUCCESS);
      })
      .catch(async () => {
        await lease.release();
        daemonLogger.error("Agent bus broker shutdown failed.");
        process.exit(BROKER_CLI_EXIT_CODES.FAILURE);
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (import.meta.main) {
  main().catch((error) => {
    if (error instanceof BrokerLeaseContentionError) {
      process.exit(BROKER_CLI_EXIT_CODES.LEASE_CONTENTION);
    }
    daemonLogger.error("Agent bus broker startup failed.");
    process.exit(BROKER_CLI_EXIT_CODES.FAILURE);
  });
}
