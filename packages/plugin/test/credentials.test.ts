import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { METHODS } from "@opencode-agentbus/protocol";

import { readCredentialFileSecure, resolveTrustedConnectionConfig } from "../src/credentials";
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
        OPENCODE_AGENTBUS_CREDENTIAL_FILE: "/env/credential",
        OPENCODE_AGENTBUS_ENDPOINT: "http://127.0.0.1:5000",
        OPENCODE_AGENTBUS_TIMEOUT_MS: "800",
      },
    );
    expect(String(fromEnvironment.endpoint)).toBe("http://127.0.0.1:5000");
    expect(fromEnvironment.credentialFilePath).toBe("/env/credential");
    expect(fromEnvironment.timeoutMs).toBe(800);
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

  test("credential rotation reconnects, reinitializes, and re-registers before use", async () => {
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
      METHODS.REGISTER_SESSION,
      METHODS.LIST_PENDING_MESSAGES,
    ]);
    await runtime.dispose();
  });
});
