import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerService, BrokerDaemon } from "@opencode-agentbus/broker";
import NativePlugin from "../src/v2";

for (const operation of ["agentbus_send", "agentbus_reply"] as const) {
  for (const change of ["moved", "deleted", "removed-event"] as const) {
    test(`${operation}: readiness barrier ${change} produces zero real broker operations`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "bus-placement-"));
      await mkdir(join(directory, "broker"), { mode: 0o700 });
      const credentialFilePath = join(directory, "broker/credential.json");
      const brokerDatabasePath = join(directory, "broker/state.sqlite");
      const service = BrokerService.open({ databasePath: brokerDatabasePath, credentialFilePath });
      const calls: string[] = [];
      const dispatch = service.dispatch.bind(service);
      service.dispatch = ((principal, request) => {
        calls.push((request as { method: string }).method);
        return dispatch(principal, request);
      }) as typeof service.dispatch;
      const daemon = new BrokerDaemon({ service, hostname: "127.0.0.1", port: 0 });
      const target = await daemon.start();
      let release!: () => void;
      let blocked = false;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (new URL(request.url).pathname === "/auth/challenge" && !blocked) {
            blocked = true;
            await barrier;
          }
          return fetch(target + new URL(request.url).pathname, {
            method: request.method,
            headers: request.headers,
            ...(request.method === "GET" || request.method === "HEAD"
              ? {}
              : { body: await request.arrayBuffer() }),
          });
        },
      });
      let location = "/project";
      let missing = false;
      let event: unknown;
      let signal: AbortSignal | undefined;
      const tools = new Map<
        string,
        { execute(input: unknown, invocation: unknown): Promise<unknown> }
      >();
      const ctx = {
        options: {
          deploymentNamespace: "placement",
          endpoint: proxy.url.origin,
          credentialFilePath,
          brokerDatabasePath,
          autoStartBroker: false,
        },
        location: {
          directory: "/project",
          project: { id: "project_1", directory: "/project", canonical: "/project" },
        },
        host: {
          activity: async () => [],
          reconcileSynthetic: async () => ({ state: "absent" }),
          admitSynthetic: async () => ({ state: "absent" }),
          resolve: async ({ sessionID }: { sessionID: string }) => {
            if (missing) throw new Error("deleted");
            return {
              session: { id: sessionID, projectID: "project_1", location: { directory: location } },
              location: {
                directory: location,
                project: { id: "project_1", directory: location, canonical: "/project" },
              },
              agent: "build",
            };
          },
        },
        rpc: {
          register: async () => ({
            events: { emit: async () => undefined },
            dispose: async () => undefined,
          }),
        },
        storage: { get: async () => undefined, set: async () => undefined },
        tool: {
          transform: async (
            callback: (editor: {
              add(tool: {
                name: string;
                execute(input: unknown, invocation: unknown): Promise<unknown>;
              }): void;
            }) => void,
          ) => {
            callback({ add: (tool) => tools.set(tool.name, tool) });
            return { dispose: async () => undefined };
          },
        },
        event: {
          subscribe: (options: { signal: AbortSignal }) => {
            signal = options.signal;
            return (async function* () {
              while (!options.signal.aborted) {
                if (event) {
                  const value = event;
                  event = undefined;
                  yield value;
                } else await Bun.sleep(1);
              }
            })();
          },
        },
      } as unknown as Parameters<typeof NativePlugin.setup>[0];
      const cleanup = await NativePlugin.setup(ctx);
      try {
        const tool = tools.get(operation);
        if (!tool) throw new Error("missing tool");
        const work = tool
          .execute(
            operation === "agentbus_send"
              ? { target: "target", body: "fixture" }
              : { messageId: "message_parent", body: "fixture" },
            {
              sessionID: "ses_call",
              signal: new AbortController().signal,
              assertPermission: async () => undefined,
            },
          )
          .catch((error) => error);
        for (let attempt = 0; !blocked && attempt < 1000; attempt++) await Bun.sleep(1);
        expect(blocked).toBe(true);
        if (change === "moved") location = "/moved";
        if (change === "deleted") missing = true;
        if (change === "removed-event") {
          event = { type: "session.deleted", data: { sessionID: "ses_call" } };
          await Bun.sleep(10);
        }
        release();
        const result = await work;
        expect(result).toBeInstanceOf(Error);
        expect(calls).toEqual([]);
      } finally {
        release();
        await cleanup?.();
        expect(signal?.aborted).toBe(true);
        await proxy.stop(true);
        await daemon.stop();
        service.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
