import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  CREDENTIAL_FILE_MODE,
  CredentialFileSchema,
  TrustedConnectionConfigSchema,
} from "@opencode-agentbus/protocol";
import type { CredentialFile, TrustedConnectionConfig } from "@opencode-agentbus/protocol";

import { SAFE_MODEL_ERRORS, SafeModelError } from "./errors";

const MAX_CREDENTIAL_BYTES = 4_096;

export interface SecureCredentialSnapshot {
  readonly credential: CredentialFile;
  /** Opaque local change detector. It contains neither the path nor credential content. */
  readonly fileIdentity: string;
}

export interface CredentialReadTestHooks {
  readonly afterPathCheck?: () => Promise<void>;
}

export interface AgentBusTrustedOptions {
  readonly endpoint?: unknown;
  readonly timeoutMs?: unknown;
  readonly credentialFilePath?: unknown;
  readonly autoStartBroker?: unknown;
  readonly brokerStartupTimeoutMs?: unknown;
  readonly wakeOnMessage?: unknown;
  readonly focusOnReceiveApproval?: unknown;
  readonly maxActiveSessionsPerPrincipal?: unknown;
}

export type TrustedEnvironment = Readonly<Record<string, string | undefined>>;

const TRUSTED_OPTION_KEYS = new Set([
  "endpoint",
  "timeoutMs",
  "credentialFilePath",
  "autoStartBroker",
  "brokerStartupTimeoutMs",
  "wakeOnMessage",
  "focusOnReceiveApproval",
  "maxActiveSessionsPerPrincipal",
]);

function configuredBoolean(value: unknown): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function invalidCredential(): SafeModelError {
  return new SafeModelError(SAFE_MODEL_ERRORS.INVALID_CREDENTIAL);
}

export function resolveTrustedConnectionConfig(
  options: AgentBusTrustedOptions,
  environment: TrustedEnvironment = process.env,
): TrustedConnectionConfig {
  if (Object.keys(options).some((key) => !TRUSTED_OPTION_KEYS.has(key))) {
    throw new SafeModelError(SAFE_MODEL_ERRORS.INVALID_CONFIG);
  }
  const credentialFilePath =
    options.credentialFilePath ??
    environment.OPENCODE_AGENTBUS_CREDENTIAL_FILE ??
    join(environment.HOME ?? homedir(), ".config", "opencode-agentbus", "credential.json");
  const endpoint = options.endpoint ?? environment.OPENCODE_AGENTBUS_ENDPOINT;
  const configuredTimeout = options.timeoutMs ?? environment.OPENCODE_AGENTBUS_TIMEOUT_MS;
  const configuredStartupTimeout =
    options.brokerStartupTimeoutMs ?? environment.OPENCODE_AGENTBUS_BROKER_STARTUP_TIMEOUT_MS;
  const timeoutMs =
    typeof configuredTimeout === "string" && configuredTimeout.length > 0
      ? Number(configuredTimeout)
      : configuredTimeout;
  const brokerStartupTimeoutMs =
    typeof configuredStartupTimeout === "string" && configuredStartupTimeout.length > 0
      ? Number(configuredStartupTimeout)
      : configuredStartupTimeout;
  const configuredAutoStart =
    options.autoStartBroker ?? environment.OPENCODE_AGENTBUS_AUTO_START_BROKER;
  const autoStartBroker = configuredBoolean(configuredAutoStart);
  const wakeOnMessage = configuredBoolean(
    options.wakeOnMessage ?? environment.OPENCODE_AGENTBUS_WAKE_ON_MESSAGE,
  );
  const focusOnReceiveApproval = configuredBoolean(
    options.focusOnReceiveApproval ?? environment.OPENCODE_AGENTBUS_FOCUS_ON_RECEIVE_APPROVAL,
  );
  const candidate = {
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(autoStartBroker === undefined ? {} : { autoStartBroker }),
    ...(brokerStartupTimeoutMs === undefined ? {} : { brokerStartupTimeoutMs }),
    ...(wakeOnMessage === undefined ? {} : { wakeOnMessage }),
    ...(focusOnReceiveApproval === undefined ? {} : { focusOnReceiveApproval }),
    ...(options.maxActiveSessionsPerPrincipal === undefined
      ? {}
      : { maxActiveSessionsPerPrincipal: options.maxActiveSessionsPerPrincipal }),
    credentialFilePath,
  };
  const parsed = TrustedConnectionConfigSchema.safeParse(candidate);
  if (!parsed.success) throw new SafeModelError(SAFE_MODEL_ERRORS.INVALID_CONFIG);
  return parsed.data;
}

function sameOpenedFile(pathStat: Stats, descriptorStat: Stats): boolean {
  return pathStat.dev === descriptorStat.dev && pathStat.ino === descriptorStat.ino;
}

function secureRegularFile(stat: Stats): boolean {
  const getuid = process.getuid;
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    (stat.mode & 0o7777) === CREDENTIAL_FILE_MODE &&
    getuid !== undefined &&
    stat.uid === getuid() &&
    stat.size > 0 &&
    stat.size <= MAX_CREDENTIAL_BYTES
  );
}

function unchangedDuringRead(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.uid === after.uid &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

export async function readCredentialFileSecure(
  credentialFilePath: string,
  testHooks: CredentialReadTestHooks = {},
): Promise<SecureCredentialSnapshot> {
  const snapshot = await readCredentialFileIfPresentSecure(credentialFilePath, testHooks);
  if (!snapshot) throw invalidCredential();
  return snapshot;
}

export async function readCredentialFileIfPresentSecure(
  credentialFilePath: string,
  testHooks: CredentialReadTestHooks = {},
): Promise<SecureCredentialSnapshot | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    let pathStat: Stats;
    try {
      pathStat = await lstat(credentialFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!secureRegularFile(pathStat)) throw invalidCredential();
    await testHooks.afterPathCheck?.();

    handle = await open(credentialFilePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!sameOpenedFile(pathStat, before) || !secureRegularFile(before)) throw invalidCredential();

    const contents = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat();
    if (!unchangedDuringRead(before, after)) throw invalidCredential();

    const parsedJson: unknown = JSON.parse(contents);
    const parsedCredential = CredentialFileSchema.safeParse(parsedJson);
    if (!parsedCredential.success) throw invalidCredential();
    return {
      credential: parsedCredential.data,
      fileIdentity: [
        String(after.dev),
        String(after.ino),
        String(after.size),
        String(after.mtimeMs),
        String(after.ctimeMs),
      ].join(":"),
    };
  } catch (error) {
    if (error instanceof SafeModelError) throw error;
    throw invalidCredential();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function sameCredentialSnapshot(
  left: SecureCredentialSnapshot | undefined,
  right: SecureCredentialSnapshot,
): boolean {
  return (
    left !== undefined &&
    left.fileIdentity === right.fileIdentity &&
    left.credential.version === right.credential.version &&
    left.credential.principalId === right.credential.principalId &&
    left.credential.serverId === right.credential.serverId &&
    left.credential.token === right.credential.token
  );
}
