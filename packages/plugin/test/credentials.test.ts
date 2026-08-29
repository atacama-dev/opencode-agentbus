import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_ACTIVE_SESSIONS_PER_PRINCIPAL,
  MAX_ACTIVE_SESSIONS_PER_PRINCIPAL,
  METHODS,
  MIN_ACTIVE_SESSIONS_PER_PRINCIPAL,
} from "@opencode-agentbus/protocol";

import {
  readCredentialFileIfPresentSecure,
  readCredentialFileSecure,
  resolveTrustedConnectionConfig,
} from "../src/credentials";
import { SAFE_MODEL_ERRORS } from "../src/errors";
import { AgentBusRuntime } from "../src/runtime";
import {
  CONFIG,
  MockChannel,
  MockEventStream,
  TOKEN_A,
  TOKEN_B,
  credential,
  credentialSnapshot,
} from "./helpers";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agentbus-plugin-"));
  temporaryDirectories.push(path);
  return path;
}

async function writeCredential(path: string, token = TOKEN_A, mode = 0o600): Promise<void> {
  await writeFile(path, JSON.stringify(credential(token)), { mode });
  await chmod(path, mode);
}

describe("trusted connection config and secure credential loading", () => {
  test("accepts only trusted option/environment fields and literal loopback endpoints", () => {
    expect(
      resolveTrustedConnectionConfig(
        { credentialFilePath: "/secure/credential", endpoint: "http://[::1]:4097" },
        {},
      ),
    ).toMatchObject({
      credentialFilePath: "/secure/credential",
      endpoint: "http://[::1]:4097",
    });
    const fromEnvironment = resolveTrustedConnectionConfig(
      {},
      {
        HOME: "/home/agentbus-env",
        OPENCODE_AGENTBUS_CREDENTIAL_FILE: "/env/credential",
        OPENCODE_AGENTBUS_ENDPOINT: "http://127.0.0.1:5000",
        OPENCODE_AGENTBUS_TIMEOUT_MS: "800",
        OPENCODE_AGENTBUS_AUTO_START_BROKER: "false",
        OPENCODE_AGENTBUS_BROKER_STARTUP_TIMEOUT_MS: "1200",
        OPENCODE_AGENTBUS_WAKE_ON_MESSAGE: "true",
        OPENCODE_AGENTBUS_FOCUS_ON_RECEIVE_APPROVAL: "true",
        OPENCODE_AGENTBUS_MAX_ACTIVE_SESSIONS_PER_PRINCIPAL: "1",
      },
    );
    expect(String(fromEnvironment.endpoint)).toBe("http://127.0.0.1:5000");
    expect(fromEnvironment.credentialFilePath).toBe("/env/credential");
    expect(fromEnvironment.timeoutMs).toBe(800);
    expect(fromEnvironment.autoStartBroker).toBe(false);
    expect(fromEnvironment.brokerStartupTimeoutMs).toBe(1_200);
    expect(fromEnvironment.wakeOnMessage).toBe(true);
    expect(fromEnvironment.focusOnReceiveApproval).toBe(true);
    expect(fromEnvironment.maxActiveSessionsPerPrincipal).toBe(
      DEFAULT_ACTIVE_SESSIONS_PER_PRINCIPAL,
    );
    for (const endpoint of [
      "http://localhost:4097",
      "http://user:pass@127.0.0.1:4097",
      "http://127.0.0.1:4097/path",
      "https://127.0.0.1:4097",
    ]) {
      expect(() =>
        resolveTrustedConnectionConfig({ credentialFilePath: "/secure/credential", endpoint }, {}),
      ).toThrow(SAFE_MODEL_ERRORS.INVALID_CONFIG);
    }
    expect(() =>
      resolveTrustedConnectionConfig(
        { credentialFilePath: "/secure/credential", arbitraryCommand: "unsafe" } as never,
        {},
      ),
    ).toThrow(SAFE_MODEL_ERRORS.INVALID_CONFIG);
  });

  test("defaults autostart and bounded startup timeout while allowing trusted option overrides", () => {
    expect(resolveTrustedConnectionConfig({}, { HOME: "/home/agentbus" })).toMatchObject({
      endpoint: "http://127.0.0.1:4097",
      timeoutMs: 5_000,
      credentialFilePath: "/home/agentbus/.config/opencode-agentbus/credential.json",
      autoStartBroker: true,
      brokerStartupTimeoutMs: 5_000,
      wakeOnMessage: false,
      focusOnReceiveApproval: false,
      maxActiveSessionsPerPrincipal: DEFAULT_ACTIVE_SESSIONS_PER_PRINCIPAL,
    });
    expect(
      resolveTrustedConnectionConfig(
        {
          credentialFilePath: "/secure/credential",
          autoStartBroker: false,
          brokerStartupTimeoutMs: 250,
          wakeOnMessage: true,
          focusOnReceiveApproval: true,
          maxActiveSessionsPerPrincipal: MAX_ACTIVE_SESSIONS_PER_PRINCIPAL,
        },
        {},
      ),
    ).toMatchObject({
      autoStartBroker: false,
      brokerStartupTimeoutMs: 250,
      wakeOnMessage: true,
      focusOnReceiveApproval: true,
      maxActiveSessionsPerPrincipal: MAX_ACTIVE_SESSIONS_PER_PRINCIPAL,
    });
    for (const brokerStartupTimeoutMs of [99, 30_001, 1.5, Number.NaN]) {
      expect(() =>
        resolveTrustedConnectionConfig(
          { credentialFilePath: "/secure/credential", brokerStartupTimeoutMs },
          {},
        ),
      ).toThrow(SAFE_MODEL_ERRORS.INVALID_CONFIG);
    }
    for (const value of ["1", "yes", "TRUE", ""]) {
      expect(() =>
        resolveTrustedConnectionConfig(
          { credentialFilePath: "/secure/credential" },
          { OPENCODE_AGENTBUS_AUTO_START_BROKER: value },
        ),
      ).toThrow(SAFE_MODEL_ERRORS.INVALID_CONFIG);
    }
    for (const option of ["wakeOnMessage", "focusOnReceiveApproval"] as const) {
      expect(() =>
        resolveTrustedConnectionConfig(
          { credentialFilePath: "/secure/credential", [option]: "yes" },
          {},
        ),
      ).toThrow(SAFE_MODEL_ERRORS.INVALID_CONFIG);
    }
    for (const maxActiveSessionsPerPrincipal of [
      MIN_ACTIVE_SESSIONS_PER_PRINCIPAL,
      MAX_ACTIVE_SESSIONS_PER_PRINCIPAL,
    ]) {
      expect(
        resolveTrustedConnectionConfig(
          { credentialFilePath: "/secure/credential", maxActiveSessionsPerPrincipal },
          {},
        ).maxActiveSessionsPerPrincipal,
      ).toBe(maxActiveSessionsPerPrincipal);
    }
    for (const maxActiveSessionsPerPrincipal of [
      0,
      1,
      -1,
      1.5,
      Number.NaN,
      MAX_ACTIVE_SESSIONS_PER_PRINCIPAL + 1,
      "4096",
      " 4096 ",
    ]) {
      expect(() =>
        resolveTrustedConnectionConfig(
          { credentialFilePath: "/secure/credential", maxActiveSessionsPerPrincipal },
          {},
        ),
      ).toThrow(SAFE_MODEL_ERRORS.INVALID_CONFIG);
    }
  });

  test("reads only an owner-owned regular 0600 file and rejects permissive mode", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "credential.json");
    await writeCredential(path);

    const snapshot = await readCredentialFileSecure(path);
    expect(snapshot.credential).toEqual(credential());
    expect(snapshot.fileIdentity).not.toContain(path);
    expect(snapshot.fileIdentity).not.toContain(TOKEN_A);

    await chmod(path, 0o640);
    await expect(readCredentialFileSecure(path)).rejects.toThrow(
      SAFE_MODEL_ERRORS.INVALID_CREDENTIAL,
    );
  });

  test("treats only an absent credential as first-run state", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "credential.json");
    await expect(readCredentialFileIfPresentSecure(path)).resolves.toBeUndefined();

    await writeFile(path, "not-json", { mode: 0o600 });
    await expect(readCredentialFileIfPresentSecure(path)).rejects.toThrow(
      SAFE_MODEL_ERRORS.INVALID_CREDENTIAL,
    );
    expect(await readFile(path, "utf8")).toBe("not-json");
  });

  test("rejects symlinks and detects replacement between path check and descriptor read", async () => {
    const directory = await tempDirectory();
    const realPath = join(directory, "real.json");
    const linkPath = join(directory, "link.json");
    await writeCredential(realPath);
    await symlink(realPath, linkPath);

    await expect(readCredentialFileSecure(linkPath)).rejects.toThrow(
      SAFE_MODEL_ERRORS.INVALID_CREDENTIAL,
    );
    await expect(
      readCredentialFileSecure(realPath, {
        afterPathCheck: async () => {
          await rm(realPath);
          await writeCredential(realPath, TOKEN_B);
        },
      }),
    ).rejects.toThrow(SAFE_MODEL_ERRORS.INVALID_CREDENTIAL);
  });

  test("credential rotation reconnects and resolves foreground identity only for the real operation", async () => {
    let snapshot = credentialSnapshot(TOKEN_A, "file-v1");
    const channels: MockChannel[] = [];
    let counter = 0;
    const runtime = new AgentBusRuntime({
      config: CONFIG,
      readCredential: async () => snapshot,
      channelFactory: (input) => {
        const channel = new MockChannel(input);
        channels.push(channel);
        return channel;
      },
      eventStreamFactory: () => new MockEventStream(),
      notifyPending: async () => undefined,
      createRequestId: () => `rotation_${++counter}`,
      reconnectDelayMs: 60_000,
    });
    const toolContext = {
      sessionID: "host_rotate",
      directory: "/worktree",
      worktree: "/worktree",
      ask: async () => undefined,
    };
    await runtime.receive(toolContext);
    snapshot = credentialSnapshot(TOKEN_B, "file-v2");
    await runtime.send(
      { target: "target_after_rotation", body: "hello", ttlSeconds: 60 },
      toolContext,
    );

    expect(channels).toHaveLength(2);
    expect(channels[0]?.closed).toBe(true);
    expect(channels[1]?.calls.map((request) => request.method).slice(0, 3)).toEqual([
      METHODS.HANDSHAKE,
      METHODS.RESOLVE_FOREGROUND_SESSION,
      METHODS.ENQUEUE_MESSAGE,
    ]);
    await runtime.dispose();
  });
});
