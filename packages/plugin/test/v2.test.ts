import { expect, test } from "bun:test";
import NativePlugin from "../src/v2";

function setupContext() {
  const tools: Array<{
    name: string;
    description?: string;
    options?: { codemode?: boolean };
    input: unknown;
    execute: (input: unknown, invocation: unknown) => Promise<unknown>;
  }> = [];
  let lookups = 0;
  let disposed = 0;
  const context = {
    options: {
      deploymentNamespace: "test",
      endpoint: "http://127.0.0.1:1",
      credentialFilePath: "/private/credential.json",
      brokerDatabasePath: "/private/broker.sqlite",
      autoStartBroker: false,
    },
    location: {
      directory: "/private/project",
      project: { id: "project_1", directory: "/private/project", canonical: "/private/project" },
    },
    host: {
      resolve: async () => {
        lookups++;
        throw new Error("missing session");
      },
      activity: async () => [],
      reconcileSynthetic: async () => ({ state: "absent" }),
      admitSynthetic: async () => ({ state: "absent" }),
    },
    rpc: {
      register: async () => ({
        events: { emit: async () => undefined },
        dispose: async () => {
          disposed++;
        },
      }),
    },
    tool: {
      transform: async (
        callback: (editor: { add: (tool: (typeof tools)[number]) => void }) => void,
      ) => {
        callback({ add: (tool) => tools.push(tool) });
        return {
          dispose: async () => {
            disposed++;
          },
        };
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) =>
        (async function* () {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        })(),
    },
    storage: { get: async () => undefined, set: async () => undefined },
  };
  return {
    context: context as unknown as Parameters<typeof NativePlugin.setup>[0],
    tools,
    lookups: () => lookups,
    disposed: () => disposed,
  };
}

test("V2 registers exactly four direct tools with strict authority-free native JSON schemas", async () => {
  const host = setupContext();
  const cleanup = await NativePlugin.setup(host.context);
  expect(host.tools.map((tool) => tool.name).sort()).toEqual([
    "agentbus_receive",
    "agentbus_reply",
    "agentbus_search_sessions",
    "agentbus_send",
  ]);
  for (const tool of host.tools) {
    expect(tool.options?.codemode).toBe(false);
    expect(tool.input).toMatchObject({ type: "object", additionalProperties: false });
    expect(JSON.stringify(tool.input)).not.toContain("directory");
    expect(JSON.stringify(tool.input)).not.toContain("sessionID");
  }
  expect(host.lookups()).toBe(0);
  const search = host.tools.find((tool) => tool.name === "agentbus_search_sessions");
  expect(search?.input).toMatchObject({
    properties: { query: { type: "string" }, limit: { minimum: 1, maximum: 200, default: 20 } },
  });
  expect(search?.description).toContain("empty query");
  expect(search?.description).toContain("1-200");
  await cleanup?.();
  expect(host.disposed()).toBe(2);
});

test("official public host without verified placement and invocation assertion fails before broker or tool registration", async () => {
  const fixture = setupContext();
  for (const host of [undefined, {}, { resolve: async () => undefined }]) {
    const publicContext = {
      ...fixture.context,
      host,
      permission: { assert: async () => undefined },
    } as unknown as Parameters<typeof NativePlugin.setup>[0];
    await expect(NativePlugin.setup(publicContext)).rejects.toThrow(/paired host extensions/);
  }
  expect(fixture.tools).toHaveLength(0);
  expect(fixture.lookups()).toBe(0);
});

test("missing invocation assertion and invalid exact IDs fail before host/broker effects; captured tools expire on cleanup", async () => {
  const host = setupContext();
  const cleanup = await NativePlugin.setup(host.context);
  const send = host.tools.find((tool) => tool.name === "agentbus_send");
  if (!send) throw new Error("missing send");
  const invocation = {
    sessionID: "invalid*id",
    signal: new AbortController().signal,
    assertPermission: async () => undefined,
  };
  await expect(send.execute({ target: "target", body: "body" }, invocation)).rejects.toThrow();
  await expect(
    send.execute(
      { target: "target", body: "body" },
      { ...invocation, sessionID: "ses_valid", assertPermission: undefined },
    ),
  ).rejects.toThrow();
  expect(host.lookups()).toBe(0);
  await cleanup?.();
  await expect(
    send.execute({ target: "target", body: "body" }, { ...invocation, sessionID: "ses_valid" }),
  ).rejects.toThrow();
  expect(host.lookups()).toBe(0);
});

test("V2 requires explicit namespace/database/endpoint/credential and rejects unverified metadata origins", async () => {
  for (const options of [
    {},
    { deploymentNamespace: "test" },
    { metadataOrigin: "https://127.0.0.1" },
  ]) {
    const host = setupContext();
    const context = {
      ...host.context,
      options: options.metadataOrigin ? { ...host.context.options, ...options } : options,
    };
    await expect(NativePlugin.setup(context)).rejects.toThrow();
    expect(host.tools).toHaveLength(0);
    expect(host.lookups()).toBe(0);
  }
});

test("failed native tool registration releases the already acquired RPC and preserves setup failure", async () => {
  const host = setupContext();
  const failure = new Error("fixture tool registration failure");
  const context = {
    ...host.context,
    tool: {
      transform: async () => {
        throw failure;
      },
    },
  } as unknown as Parameters<typeof NativePlugin.setup>[0];
  expect(await Promise.resolve(NativePlugin.setup(context)).catch((error) => error)).toBe(failure);
  expect(host.disposed()).toBe(1);
  expect(host.lookups()).toBe(0);
});
