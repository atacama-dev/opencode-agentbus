import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import {
  AUTH_CHALLENGE_CLIENT_NONCE_HEADER,
  AUTH_CHALLENGE_CONTENT_TYPE,
  AUTH_CHALLENGE_PROOF_DOMAIN,
  TrustedConnectionConfigSchema,
} from "../../packages/protocol/src";

import {
  BrokerBootstrap,
  launchBundledBroker,
  type BundledBrokerLaunchInput,
} from "../../packages/plugin/src/broker-bootstrap";
import { readCredentialFileSecure } from "../../packages/plugin/src/credentials";
import { OPERATOR_ERRORS } from "../../packages/plugin/src/errors";
import { createAgentBusPlugin } from "../../packages/plugin/src/plugin";
import { BrokerService } from "../../packages/broker/src/service";
import {
  FakeOpenCodeHost,
  NativePermissionHarness,
  eventually,
  executeTool,
  outputJson,
  registryMatches,
  reserveLoopbackPort,
  session,
  waitFor,
} from "./helpers";

const temporaryDirectories: string[] = [];
const spawnedPids = new Set<number>();

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processState(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] ?? "unknown";
  } catch {
    return "missing";
  }
}

async function stopSpawnedBrokers(): Promise<void> {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Losing concurrent startup processes may already have exited.
    }
  }
  try {
    await waitFor(() => [...spawnedPids].every((pid) => !processIsAlive(pid)), 3_000);
  } catch {
    for (const pid of spawnedPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The process may have exited between observation and cleanup.
      }
    }
    await waitFor(() => [...spawnedPids].every((pid) => !processIsAlive(pid)), 3_000);
  }
  spawnedPids.clear();
}

afterEach(async () => {
  await stopSpawnedBrokers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryState(): Promise<{
  readonly directory: string;
  readonly credentialFilePath: string;
  readonly databasePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "agentbus-autostart-integration-"));
  temporaryDirectories.push(directory);
  return {
    directory,
    credentialFilePath: join(directory, "credential.json"),
    databasePath: join(directory, "broker.sqlite"),
  };
}

function trackedLaunch(input: BundledBrokerLaunchInput) {
  const child = launchBundledBroker(input);
  if (child.pid !== undefined) {
    const pid = child.pid;
    spawnedPids.add(pid);
    void child.exited.finally(() => spawnedPids.delete(pid));
  }
  return child;
}

function emptyHost(onList: () => void): Record<string, unknown> {
  return {
    client: {
      session: {
        list: async () => {
          onList();
          return { data: [] };
        },
      },
      tui: { showToast: async () => ({ data: true }) },
    },
    directory: "/worktree",
    worktree: "/worktree",
    serverUrl: new URL("http://127.0.0.1:4096"),
    project: { id: "project_autostart" },
    experimental_workspace: { register: () => undefined },
    $: {},
  };
}

function legacyChallenge(clientNonce: string, token: string): Record<string, unknown> {
  const brokerId = "broker_detached_v1";
  const serverId = "server_detached_v1";
  const serverNonce = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const encoder = new TextEncoder();
  const domain = encoder.encode(AUTH_CHALLENGE_PROOF_DOMAIN);
  const fields = ["1", brokerId, serverId, clientNonce, serverNonce].map((field) =>
    encoder.encode(field),
  );
  const buffer = new ArrayBuffer(
    domain.byteLength + 1 + fields.reduce((sum, field) => sum + 4 + field.byteLength, 0),
  );
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(domain);
  let offset = domain.byteLength + 1;
  for (const field of fields) {
    view.setUint32(offset, field.byteLength, false);
    offset += 4;
    bytes.set(field, offset);
    offset += field.byteLength;
  }
  const proof = createHmac("sha256", Uint8Array.from(Buffer.from(token, "base64url")))
    .update(bytes)
    .digest("hex");
  return { protocolVersion: 1, brokerId, serverId, clientNonce, serverNonce, proof };
}

describe("plugin-managed persistent broker startup", () => {
  test("reports an authenticated detached v1 listener in manual mode without bearer reuse, launch, takeover, or model detail", async () => {
    const state = await temporaryState();
    const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    await writeFile(
      state.credentialFilePath,
      `${JSON.stringify({
        version: 1,
        principalId: "principal_detached_v1",
        serverId: "server_detached_v1",
        token,
      })}\n`,
      { mode: 0o600 },
    );
    let challengeRequests = 0;
    let bearerRequests = 0;
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (request.headers.has("authorization")) bearerRequests += 1;
        const nonce = request.headers.get(AUTH_CHALLENGE_CLIENT_NONCE_HEADER);
        if (!nonce) return new Response(null, { status: 400 });
        challengeRequests += 1;
        return Response.json(legacyChallenge(nonce, token), {
          headers: { "Content-Type": AUTH_CHALLENGE_CONTENT_TYPE },
        });
      },
    });
    const host = new FakeOpenCodeHost([session("host_v2", "Version 2")]);
    const permissions = new NativePermissionHarness([]);
    let probes = 0;
    let launches = 0;
    const hooks = await createAgentBusPlugin({
      brokerBootstrapFactory: (config, environment, reportOperatorError: () => void) =>
        new BrokerBootstrap(config, {
          environment,
          probeEndpoint: async () => {
            probes += 1;
            return "occupied";
          },
          launchBroker: (input) => {
            launches += 1;
            return trackedLaunch(input);
          },
          reportOperatorError,
        }),
    })(host.input as never, {
      endpoint: `http://127.0.0.1:${listener.port}`,
      credentialFilePath: state.credentialFilePath,
      timeoutMs: 250,
      brokerStartupTimeoutMs: 500,
      autoStartBroker: false,
    });
    try {
      await waitFor(() =>
        host.toasts.some((toast) => JSON.stringify(toast).includes("protocol v1")),
      );
      expect(host.toasts).toEqual([
        {
          body: {
            title: "Agent Bus upgrade required",
            message: OPERATOR_ERRORS.PROTOCOL_MISMATCH,
            variant: "error",
          },
          query: { directory: host.directory },
        },
      ]);
      const error = await executeTool(
        hooks as never,
        "agentbus_receive",
        {},
        host.context("host_v2", permissions),
      ).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Agent Bus is unavailable.");
      expect((error as Error).message).not.toContain("protocol");
      await Bun.sleep(0);
      expect(host.toasts).toHaveLength(1);
      expect(challengeRequests).toBeGreaterThan(0);
      expect(bearerRequests).toBe(0);
      expect(probes).toBe(0);
      expect(launches).toBe(0);
      const stillListening = await fetch(`http://127.0.0.1:${listener.port}/auth/challenge`, {
        headers: {
          [AUTH_CHALLENGE_CLIENT_NONCE_HEADER]: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
        },
      });
      expect(stillListening.status).toBe(200);
    } finally {
      await hooks.dispose?.();
      await listener.stop(true);
    }
  });

  test.each(["unreachable", "non-agent-bus", "invalid-auth"])(
    "manual mode does not show upgrade guidance for an %s endpoint",
    async (kind) => {
      const state = await temporaryState();
      const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      await writeFile(
        state.credentialFilePath,
        `${JSON.stringify({
          version: 1,
          principalId: "principal_manual_negative",
          serverId: "server_detached_v1",
          token,
        })}\n`,
        { mode: 0o600 },
      );
      let listener: ReturnType<typeof Bun.serve> | undefined;
      let endpoint: string;
      if (kind === "unreachable") {
        endpoint = `http://127.0.0.1:${await reserveLoopbackPort()}`;
      } else {
        listener = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request) {
            if (kind === "non-agent-bus") {
              return new Response("not Agent Bus", { headers: { "Content-Type": "text/plain" } });
            }
            const nonce = request.headers.get(AUTH_CHALLENGE_CLIENT_NONCE_HEADER);
            if (!nonce) return new Response(null, { status: 400 });
            return Response.json(
              legacyChallenge(nonce, "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
              { headers: { "Content-Type": AUTH_CHALLENGE_CONTENT_TYPE } },
            );
          },
        });
        endpoint = `http://127.0.0.1:${listener.port}`;
      }
      const host = new FakeOpenCodeHost([session("host_manual_negative", "Manual negative")]);
      const permissions = new NativePermissionHarness([]);
      let launches = 0;
      const hooks = await createAgentBusPlugin({
        brokerBootstrapFactory: (config, environment, reportOperatorError: () => void) =>
          new BrokerBootstrap(config, {
            environment,
            launchBroker: (input) => {
              launches += 1;
              return trackedLaunch(input);
            },
            reportOperatorError,
          }),
      })(host.input as never, {
        endpoint,
        credentialFilePath: state.credentialFilePath,
        timeoutMs: 100,
        brokerStartupTimeoutMs: 250,
        autoStartBroker: false,
      });
      try {
        const error = await executeTool(
          hooks as never,
          "agentbus_receive",
          {},
          host.context("host_manual_negative", permissions),
        ).catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("Agent Bus is unavailable.");
        await Bun.sleep(0);
        expect(host.toasts).toEqual([]);
        expect(launches).toBe(0);
      } finally {
        await hooks.dispose?.();
        await listener?.stop(true);
      }
    },
  );

  test("the bundled v2 broker migrates schema v3 to v5 on manual restart", async () => {
    const state = await temporaryState();
    const initial = BrokerService.open({
      databasePath: state.databasePath,
      credentialFilePath: state.credentialFilePath,
    });
    initial.close();
    const v3 = new Database(state.databasePath);
    v3.run("DROP INDEX IF EXISTS sessions_admission_idx");
    v3.run("ALTER TABLE sessions DROP COLUMN last_foreground_ms");
    v3.run("ALTER TABLE sessions DROP COLUMN displaced");
    v3.run("ALTER TABLE messages DROP COLUMN reply_to_message_id");
    v3.run("PRAGMA user_version = 3");
    v3.close();
    await chmod(state.databasePath, 0o600);

    const port = await reserveLoopbackPort();
    const environment = { ...process.env, OPENCODE_AGENTBUS_DB_PATH: state.databasePath };
    const config = TrustedConnectionConfigSchema.parse({
      endpoint: `http://127.0.0.1:${port}`,
      credentialFilePath: state.credentialFilePath,
      timeoutMs: 250,
      brokerStartupTimeoutMs: 5_000,
    });
    await new BrokerBootstrap(config, {
      environment,
      launchBroker: trackedLaunch,
    }).ensureReady();

    const migrated = new Database(state.databasePath, { readonly: true });
    const version = migrated.query<{ user_version: number }, []>("PRAGMA user_version").get();
    const columns = migrated
      .query<{ name: string }, []>("PRAGMA table_info(messages)")
      .all()
      .map((column) => column.name);
    migrated.close();
    expect(version?.user_version).toBe(5);
    expect(columns).toContain("reply_to_message_id");
  }, 10_000);

  test("independent cold-start callers all resolve through one lease winner", async () => {
    const state = await temporaryState();
    const port = await reserveLoopbackPort();
    const endpoint = `http://127.0.0.1:${port}`;
    const environment = { ...process.env, OPENCODE_AGENTBUS_DB_PATH: state.databasePath };
    const config = TrustedConnectionConfigSchema.parse({
      endpoint,
      credentialFilePath: state.credentialFilePath,
      timeoutMs: 250,
      brokerStartupTimeoutMs: 5_000,
    });
    let probeArrivals = 0;
    let releaseProbes!: () => void;
    const allProbed = new Promise<void>((resolve) => {
      releaseProbes = resolve;
    });
    let launchAttempts = 0;
    const launchBroker = (input: BundledBrokerLaunchInput) => {
      launchAttempts += 1;
      return trackedLaunch(input);
    };
    const probeEndpoint = async () => {
      probeArrivals += 1;
      if (probeArrivals === 3) releaseProbes();
      await allProbed;
      return "unused" as const;
    };
    const bootstraps = Array.from(
      { length: 3 },
      () => new BrokerBootstrap(config, { environment, launchBroker, probeEndpoint }),
    );

    await Promise.all(bootstraps.map((bootstrap) => bootstrap.ensureReady()));
    expect(probeArrivals).toBe(3);
    expect(launchAttempts).toBe(3);
    await waitFor(
      () => spawnedPids.size === 1 && [...spawnedPids].filter(processIsAlive).length === 1,
      3_000,
    );
    expect(await readCredentialFileSecure(state.credentialFilePath)).toBeDefined();
  }, 10_000);

  test("concurrent plugin startups create one usable persistent broker and dispose leaves it running", async () => {
    const state = await temporaryState();
    const port = await reserveLoopbackPort();
    const endpoint = `http://127.0.0.1:${port}`;
    const environment = { ...process.env, OPENCODE_AGENTBUS_DB_PATH: state.databasePath };
    const options = {
      endpoint,
      credentialFilePath: state.credentialFilePath,
      timeoutMs: 250,
      brokerStartupTimeoutMs: 5_000,
    };
    let listCalls = 0;
    const plugin = createAgentBusPlugin({
      brokerBootstrapFactory: (config) =>
        new BrokerBootstrap(config, { environment, launchBroker: trackedLaunch }),
    });

    const [firstHooks, secondHooks, thirdHooks] = await Promise.all([
      plugin(
        emptyHost(() => {
          listCalls += 1;
        }) as never,
        options,
      ),
      plugin(
        emptyHost(() => {
          listCalls += 1;
        }) as never,
        options,
      ),
      plugin(
        emptyHost(() => {
          listCalls += 1;
        }) as never,
        options,
      ),
    ]);
    expect(listCalls).toBe(0);
    await waitFor(() => listCalls === 3, 6_000);

    const config = TrustedConnectionConfigSchema.parse({ ...options, autoStartBroker: false });
    await new BrokerBootstrap(config, { environment }).ensureReady();
    const credentialBeforeDispose = await readCredentialFileSecure(state.credentialFilePath);
    expect((await lstat(state.credentialFilePath)).mode & 0o777).toBe(0o600);
    expect((await lstat(state.databasePath)).mode & 0o777).toBe(0o600);

    try {
      await waitFor(
        () => spawnedPids.size === 1 && [...spawnedPids].filter(processIsAlive).length === 1,
        3_000,
      );
    } catch {
      throw new Error(
        `Concurrent broker children did not settle: ${JSON.stringify(
          [...spawnedPids].map((pid) => ({ pid, state: processState(pid) })),
        )}`,
      );
    }
    expect([...spawnedPids].filter(processIsAlive)).toHaveLength(1);
    await Promise.all([firstHooks.dispose?.(), secondHooks.dispose?.(), thirdHooks.dispose?.()]);

    await new BrokerBootstrap(config, { environment }).ensureReady();
    expect(await readCredentialFileSecure(state.credentialFilePath)).toEqual(
      credentialBeforeDispose,
    );
    expect([...spawnedPids].filter(processIsAlive)).toHaveLength(1);
  }, 12_000);

  test("the detached broker survives exit of the process that launched it", async () => {
    const state = await temporaryState();
    const port = await reserveLoopbackPort();
    const endpoint = `http://127.0.0.1:${port}`;
    const pidFilePath = join(state.directory, "broker.pid");
    const parent = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures", "detached-launch-parent.ts"),
        endpoint,
        state.credentialFilePath,
        state.databasePath,
        pidFilePath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    expect(await parent.exited).toBe(0);
    const pid = Number.parseInt(await readFile(pidFilePath, "utf8"), 10);
    expect(Number.isSafeInteger(pid)).toBe(true);
    spawnedPids.add(pid);
    expect(processIsAlive(pid)).toBe(true);

    const config = TrustedConnectionConfigSchema.parse({
      endpoint,
      credentialFilePath: state.credentialFilePath,
      timeoutMs: 250,
      autoStartBroker: false,
      brokerStartupTimeoutMs: 2_000,
    });
    await new BrokerBootstrap(config, {
      environment: { ...process.env, OPENCODE_AGENTBUS_DB_PATH: state.databasePath },
    }).ensureReady();
    expect(processIsAlive(pid)).toBe(true);
  }, 10_000);

  test("same hooks relaunch after SIGKILL and consume a WAL-backed pending message exactly once", async () => {
    const state = await temporaryState();
    const port = await reserveLoopbackPort();
    const endpoint = `http://127.0.0.1:${port}`;
    const environment = { ...process.env, OPENCODE_AGENTBUS_DB_PATH: state.databasePath };
    const options = {
      endpoint,
      credentialFilePath: state.credentialFilePath,
      timeoutMs: 250,
      brokerStartupTimeoutMs: 5_000,
    };
    const plugin = createAgentBusPlugin({
      brokerBootstrapFactory: (config) =>
        new BrokerBootstrap(config, { environment, launchBroker: trackedLaunch }),
    });
    const host = new FakeOpenCodeHost([
      session("host_wal_sender", "WAL Sender"),
      session("host_wal_recipient", "WAL Recipient"),
    ]);
    const permissions = new NativePermissionHarness([], "once");
    const hooks = await plugin(host.input as never, options);

    const registry = await eventually(
      () =>
        executeTool(
          hooks as never,
          "agentbus_search_sessions",
          { query: "WAL Recipient" },
          host.context("host_wal_sender", permissions),
        ),
      6_000,
    );
    const target = registryMatches(registry)[0]?.handle;
    if (!target) throw new Error("Missing WAL recovery target.");
    const pendingBody = "pending body committed before SIGKILL";
    await executeTool(
      hooks as never,
      "agentbus_send",
      { target, body: pendingBody, ttlSeconds: 60 },
      host.context("host_wal_sender", permissions),
    );
    const credentialBeforeKill = await readCredentialFileSecure(state.credentialFilePath);

    const killedPid = [...spawnedPids].find(processIsAlive);
    if (killedPid === undefined) throw new Error("Missing running autostart broker.");
    process.kill(killedPid, "SIGKILL");
    await waitFor(() => !spawnedPids.has(killedPid), 3_000);

    const received = await eventually(
      () =>
        executeTool(
          hooks as never,
          "agentbus_receive",
          {},
          host.context("host_wal_recipient", permissions),
        ),
      6_000,
    );
    expect(outputJson(received).body).toBe(pendingBody);
    expect(await readCredentialFileSecure(state.credentialFilePath)).toEqual(credentialBeforeKill);
    expect([...spawnedPids].filter(processIsAlive)).toHaveLength(1);

    const replay = await executeTool(
      hooks as never,
      "agentbus_receive",
      {},
      host.context("host_wal_recipient", permissions),
    );
    expect(outputJson(replay)).toEqual({ type: "agentbus_receive_status", state: "EMPTY" });
    expect(JSON.stringify(replay)).not.toContain(pendingBody);
    await hooks.dispose?.();
  }, 15_000);
});
