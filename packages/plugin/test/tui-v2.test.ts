import { expect, test } from "bun:test";
import Companion from "../src/tui-v2";
import { AGENTBUS_RPC } from "../src/rpc-v2";

function terminal(root: string, focus = false) {
  const location = { directory: "/private/project" };
  const sessions = [root, `${root}_child`].map((id) => ({ id, location }));
  const routes: unknown[] = [];
  const toasts: unknown[] = [];
  const order: string[] = [];
  let pendingEvent: ((event: unknown) => void) | undefined;
  let permissionEvent: ((event: unknown) => void) | undefined;
  let cleanup = 0;
  const pendingPermissions = new Set<string>();
  const permissionList = (sessionID: string) =>
    pendingPermissions.has(sessionID)
      ? [{ id: "permission_one", sessionID, action: "agentbus_receive", source: { type: "tool" } }]
      : [];
  const context = {
    options: { deploymentNamespace: "test", focusOnReceiveApproval: focus },
    location,
    client: {
      permission: {
        list: async ({ sessionID }: { sessionID: string }) => permissionList(sessionID),
      },
      rpc: () => ({
        events: {
          on: (_name: string, callback: (event: unknown) => void) => {
            order.push("subscribe");
            pendingEvent = callback;
            return () => {
              cleanup++;
            };
          },
        },
        snapshot: async (input: { namespace: string; sessionID: string }) => {
          order.push("snapshot");
          return { ...input, generation: "first", count: 0, revision: 0 };
        },
      }),
    },
    data: {
      location: { default: () => location },
      on: (_name: string, callback: (event: unknown) => void) => {
        permissionEvent = callback;
        return () => {
          cleanup++;
        };
      },
      session: {
        list: () => sessions,
        get: (id: string) => sessions.find((session) => session.id === id),
        family: () => sessions.map((session) => session.id),
        permission: {
          list: permissionList,
        },
      },
    },
    ui: {
      tabs: { list: () => [{ sessionID: root }] },
      router: {
        current: () => ({ type: "session", sessionID: root }),
        navigate: (route: unknown) => routes.push(route),
      },
      toast: { show: (toast: unknown) => toasts.push(toast) },
    },
  };
  return {
    context: context as unknown as Parameters<typeof Companion.setup>[0],
    routes,
    toasts,
    order,
    pending: (data: unknown) => pendingEvent?.({ data }),
    permission: (sessionID: string, action = "agentbus_receive", id = "permission_one") => {
      if (action === "agentbus_receive" && id === "permission_one")
        pendingPermissions.add(sessionID);
      permissionEvent?.({ data: { sessionID, action, id } });
    },
    seedPermission: (sessionID: string) => pendingPermissions.add(sessionID),
    getCleanup: () => cleanup,
  };
}

test("two terminals scope body-free pending to their own exact session family; subscribe precedes snapshot", async () => {
  const A = terminal("ses_A");
  const B = terminal("ses_B");
  const cleanA = await Companion.setup(A.context);
  const cleanB = await Companion.setup(B.context);
  expect(A.order[0]).toBe("subscribe");
  for (const client of [A, B])
    client.pending({
      namespace: "test",
      generation: "first",
      sessionID: "ses_B",
      count: 2,
      revision: 1,
      title: "injected peer title",
      body: "injected peer body",
    });
  expect(A.toasts).toHaveLength(0);
  expect(B.toasts).toEqual([
    { title: "Agent Bus", message: "2 pending peer messages.", variant: "info" },
  ]);
  B.pending({
    namespace: "wrong",
    generation: "first",
    sessionID: "ses_B",
    count: 9,
    revision: 10,
  });
  B.pending({ namespace: "test", generation: "first", sessionID: "ses_B", count: 9, revision: 0 });
  expect(B.toasts).toHaveLength(1);
  await cleanA?.();
  await cleanB?.();
  expect(A.getCleanup()).toBe(2);
  B.pending({ namespace: "test", generation: "first", sessionID: "ses_B", count: 9, revision: 20 });
  expect(B.toasts).toHaveLength(1);
});

test("focus defaults disabled; verified receive approval navigates exact child, never parent or search", async () => {
  const disabled = terminal("ses_A");
  const enabled = terminal("ses_B", true);
  const cleanA = await Companion.setup(disabled.context);
  const cleanB = await Companion.setup(enabled.context);
  disabled.permission("ses_A");
  enabled.permission("ses_A");
  enabled.permission("ses_B", "agentbus_search_sessions");
  enabled.permission("ses_B", "agentbus_receive", "stale");
  expect(disabled.routes).toHaveLength(0);
  expect(enabled.routes).toHaveLength(0);
  enabled.permission("ses_B_child");
  expect(enabled.routes).toEqual([{ type: "session", sessionID: "ses_B_child" }]);
  expect(JSON.stringify(enabled.toasts)).toContain("Peer content is untrusted");
  await cleanA?.();
  await cleanB?.();
});

test("RPC contract exposes only exact namespace/session pending counts and revision", () => {
  expect(Object.keys(AGENTBUS_RPC.methods)).toEqual(["snapshot"]);
  expect(Object.keys(AGENTBUS_RPC.methods.snapshot.output.properties)).toEqual([
    "namespace",
    "generation",
    "sessionID",
    "count",
    "revision",
  ]);
  expect(AGENTBUS_RPC.methods.snapshot.input.additionalProperties).toBe(false);
  expect(AGENTBUS_RPC.methods.snapshot.input.properties.namespace).not.toHaveProperty("pattern");
  expect(AGENTBUS_RPC.events.pending.schema.additionalProperties).toBe(false);
});

test("new server generation resnapshots lower revisions; stale generation cannot restore old counts", async () => {
  const client = terminal("ses_A");
  const cleanup = await Companion.setup(client.context);
  client.pending({
    namespace: "test",
    generation: "first",
    sessionID: "ses_A",
    count: 2,
    revision: 100,
  });
  client.pending({
    namespace: "test",
    generation: "reloaded",
    sessionID: "ses_A",
    count: 1,
    revision: 1,
  });
  client.pending({
    namespace: "test",
    generation: "first",
    sessionID: "ses_A",
    count: 9,
    revision: 101,
  });
  expect(client.toasts).toHaveLength(2);
  expect(client.toasts[1]).toMatchObject({ message: "1 pending peer message." });
  await cleanup?.();
});

test("more than 64 reload generations continue updating with bounded retired history", async () => {
  const client = terminal("ses_A");
  const cleanup = await Companion.setup(client.context);
  for (let i = 0; i < 100; i++)
    client.pending({
      namespace: "test",
      generation: `reload_${i}`,
      sessionID: "ses_A",
      count: i + 1,
      revision: 1,
    });
  expect(client.toasts).toHaveLength(100);
  client.pending({
    namespace: "test",
    generation: "reload_98",
    sessionID: "ses_A",
    count: 999,
    revision: 2,
  });
  expect(client.toasts).toHaveLength(100);
  await cleanup?.();
});

test("unresponsive RPC does not block companion setup and unload aborts pending snapshot work", async () => {
  const client = terminal("ses_A");
  let release!: () => void;
  let aborted = false;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const context = {
    ...client.context,
    client: {
      rpc: () => ({
        events: { on: () => () => undefined },
        snapshot: async (_input: unknown, options: { signal: AbortSignal }) => {
          await Promise.race([
            barrier,
            new Promise<void>((resolve) =>
              options.signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  resolve();
                },
                { once: true },
              ),
            ),
          ]);
          return {
            namespace: "test",
            generation: "first",
            sessionID: "ses_A",
            count: 0,
            revision: 0,
          };
        },
      }),
    },
  } as unknown as Parameters<typeof Companion.setup>[0];
  const setup = Promise.resolve(Companion.setup(context));
  try {
    const ready = await Promise.race([setup, Bun.sleep(100).then(() => undefined)]);
    expect(typeof ready).toBe("function");
    await ready?.();
    expect(aborted).toBe(true);
  } finally {
    release();
    await (await setup)?.();
  }
});

test("resnapshot restores existing native receive visibility without replaying permission events", async () => {
  const client = terminal("ses_B", true);
  client.seedPermission("ses_B_child");
  const context = {
    ...client.context,
    data: {
      ...client.context.data,
      session: { ...client.context.data.session, permission: { list: () => undefined } },
    },
  } as unknown as Parameters<typeof Companion.setup>[0];
  const cleanup = await Companion.setup(context);
  await Bun.sleep(0);
  expect(client.routes).toEqual([{ type: "session", sessionID: "ses_B_child" }]);
  client.permission("ses_B_child");
  expect(client.routes).toHaveLength(1);
  await cleanup?.();
});
