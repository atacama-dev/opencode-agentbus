import { describe, expect, test } from "bun:test";

import type { PluginInput } from "@opencode-ai/plugin";

import { MAX_BOOTSTRAP_SESSIONS, listHostSessionRegistrations } from "../src/host-sessions";
import { createAgentBusPlugin } from "../src/plugin";
import type { AgentBusRuntime } from "../src/runtime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}

function session(id: string, title: string, directory = "/worktree", projectID = "project_01") {
  return {
    id,
    projectID,
    directory,
    title,
    version: "1.18.19",
    time: { created: 1, updated: 1 },
  };
}

describe("trusted OpenCode host session lifecycle", () => {
  test("bounds recent current-project bootstrap at 256 for 61+, exact, and oversized lists", async () => {
    expect(MAX_BOOTSTRAP_SESSIONS).toBe(256);
    for (const returnedCount of [62, 256, 300]) {
      const returned = Array.from({ length: returnedCount }, (_, index) =>
        session(`host_${index.toString().padStart(3, "0")}`, `Title ${index}`),
      );
      const input = {
        client: { session: { list: async () => ({ data: returned }) } },
        directory: "/worktree",
        project: { id: "project_01" },
      } as unknown as Pick<PluginInput, "client" | "directory" | "project">;

      const registrations = await listHostSessionRegistrations(input);
      expect(registrations).toHaveLength(Math.min(returnedCount, MAX_BOOTSTRAP_SESSIONS));
      expect(registrations[0]?.hostSessionId).toBe("host_000");
      expect(registrations.at(-1)?.hostSessionId).toBe(
        `host_${(Math.min(returnedCount, MAX_BOOTSTRAP_SESSIONS) - 1).toString().padStart(3, "0")}`,
      );
      expect(registrations.some((item) => item.hostSessionId === "host_256")).toBe(false);
    }
  });

  test("returns hooks before a next-turn bootstrap can call a never-resolving session list", async () => {
    const callbacks: Array<() => void> = [];
    let listCalls = 0;
    let runtimeDisposed = false;
    const plugin = createAgentBusPlugin({
      runtimeFactory: () =>
        ({
          bootstrapHostSessions: async () => undefined,
          dispose: async () => {
            runtimeDisposed = true;
          },
        }) as unknown as AgentBusRuntime,
      bootstrapScheduler: {
        set: (callback) => {
          callbacks.push(callback);
          return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
        },
        clear: () => undefined,
      },
    });
    const input = {
      client: {
        session: {
          list: () => {
            listCalls += 1;
            return new Promise<never>(() => undefined);
          },
        },
      },
      directory: "/worktree",
      project: { id: "project_01" },
    } as unknown as PluginInput;

    const pluginPromise = plugin(input, { credentialFilePath: "/trusted/credential" });
    expect(listCalls).toBe(0);
    const hooks = await pluginPromise;
    expect(Object.keys(hooks.tool ?? {})).toHaveLength(3);
    expect(listCalls).toBe(0);
    expect(callbacks).toHaveLength(1);

    callbacks[0]?.();
    expect(listCalls).toBe(1);
    await hooks.dispose?.();
    expect(runtimeDisposed).toBe(true);
  });

  test("dispose before the initial next-turn callback prevents all bootstrap work", async () => {
    const callbacks: Array<() => void> = [];
    let clearCount = 0;
    let listCalls = 0;
    const plugin = createAgentBusPlugin({
      runtimeFactory: () =>
        ({
          bootstrapHostSessions: async () => undefined,
          dispose: async () => undefined,
        }) as unknown as AgentBusRuntime,
      bootstrapScheduler: {
        set: (callback) => {
          callbacks.push(callback);
          return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
        },
        clear: () => {
          clearCount += 1;
        },
      },
    });
    const input = {
      client: {
        session: {
          list: async () => {
            listCalls += 1;
            return { data: [] };
          },
        },
      },
      directory: "/worktree",
      project: { id: "project_01" },
    } as unknown as PluginInput;

    const hooks = await plugin(input, { credentialFilePath: "/trusted/credential" });
    await hooks.dispose?.();
    callbacks[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(clearCount).toBe(1);
    expect(listCalls).toBe(0);
  });

  test("dispose during a rejected session list is nonblocking and produces no unhandled rejection", async () => {
    const callbacks: Array<() => void> = [];
    const listGate = deferred<{ data: readonly ReturnType<typeof session>[] }>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let runtimeDisposed = false;
      let bootstrapCalls = 0;
      const plugin = createAgentBusPlugin({
        runtimeFactory: () =>
          ({
            bootstrapHostSessions: async () => {
              bootstrapCalls += 1;
            },
            dispose: async () => {
              runtimeDisposed = true;
            },
          }) as unknown as AgentBusRuntime,
        bootstrapScheduler: {
          set: (callback) => {
            callbacks.push(callback);
            return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
          },
          clear: () => undefined,
        },
      });
      const input = {
        client: { session: { list: () => listGate.promise } },
        directory: "/worktree",
        project: { id: "project_01" },
      } as unknown as PluginInput;
      const hooks = await plugin(input, { credentialFilePath: "/trusted/credential" });
      callbacks[0]?.();
      await new Promise((resolve) => setTimeout(resolve, 0));

      await hooks.dispose?.();
      expect(runtimeDisposed).toBe(true);
      listGate.reject(new Error("raw OpenCode route and project detail"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(bootstrapCalls).toBe(0);
      expect(callbacks).toHaveLength(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("dispose does not await delayed runtime bootstrap completion", async () => {
    const callbacks: Array<() => void> = [];
    const bootstrapGate = deferred<void>();
    let bootstrapStarted = false;
    let runtimeDisposed = false;
    const plugin = createAgentBusPlugin({
      runtimeFactory: () =>
        ({
          bootstrapHostSessions: async () => {
            bootstrapStarted = true;
            await bootstrapGate.promise;
          },
          dispose: async () => {
            runtimeDisposed = true;
          },
        }) as unknown as AgentBusRuntime,
      bootstrapScheduler: {
        set: (callback) => {
          callbacks.push(callback);
          return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
        },
        clear: () => undefined,
      },
    });
    const input = {
      client: { session: { list: async () => ({ data: [] }) } },
      directory: "/worktree",
      project: { id: "project_01" },
    } as unknown as PluginInput;
    const hooks = await plugin(input, { credentialFilePath: "/trusted/credential" });
    callbacks[0]?.();
    await waitFor(() => bootstrapStarted);

    await hooks.dispose?.();
    expect(runtimeDisposed).toBe(true);
    bootstrapGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("tool calls before deferred bootstrap fail closed without touching the session list", async () => {
    const callbacks: Array<() => void> = [];
    let listCalls = 0;
    const plugin = createAgentBusPlugin({
      runtimeFactory: () =>
        ({
          bootstrapHostSessions: async () => undefined,
          dispose: async () => undefined,
          receive: async () => {
            throw new Error("raw broker credential and endpoint detail");
          },
        }) as unknown as AgentBusRuntime,
      bootstrapScheduler: {
        set: (callback) => {
          callbacks.push(callback);
          return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
        },
        clear: () => undefined,
      },
    });
    const input = {
      client: {
        session: {
          list: async () => {
            listCalls += 1;
            return { data: [] };
          },
        },
      },
      directory: "/worktree",
      project: { id: "project_01" },
    } as unknown as PluginInput;
    const hooks = await plugin(input, { credentialFilePath: "/trusted/credential" });
    const receive = hooks.tool?.agentbus_receive;
    if (!receive) throw new Error("missing receive tool");

    await expect(receive.execute({}, { sessionID: "host_early" } as never)).rejects.toThrow(
      "Agent Bus is unavailable.",
    );
    expect(listCalls).toBe(0);
    await hooks.dispose?.();
  });

  test("an early registry tool stages listed sessions without event recovery before searching", async () => {
    const callbacks: Array<() => void> = [];
    const order: string[] = [];
    const bootstrapCalls: Array<{
      registrations: unknown;
      deferEventRecovery: boolean | undefined;
    }> = [];
    const plugin = createAgentBusPlugin({
      runtimeFactory: () =>
        ({
          bootstrapHostSessions: async (registrations: unknown, deferEventRecovery?: boolean) => {
            order.push("stage");
            bootstrapCalls.push({ registrations, deferEventRecovery });
          },
          search: async () => {
            order.push("search");
            return "searched";
          },
          dispose: async () => undefined,
        }) as unknown as AgentBusRuntime,
      bootstrapScheduler: {
        set: (callback) => {
          callbacks.push(callback);
          return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
        },
        clear: () => undefined,
      },
    });
    const input = {
      client: {
        session: {
          list: async () => ({ data: [session("host_search", "Searchable")] }),
        },
      },
      directory: "/worktree",
      project: { id: "project_01" },
    } as unknown as PluginInput;
    const hooks = await plugin(input, {
      credentialFilePath: "/trusted/credential",
      timeoutMs: 100,
    });
    const search = hooks.tool?.agentbus_search_sessions;
    if (!search) throw new Error("missing search tool");

    await expect(
      search.execute({ query: "Searchable" }, { sessionID: "host_search" } as never),
    ).resolves.toBe("searched");

    expect(order).toEqual(["stage", "search"]);
    expect(bootstrapCalls).toEqual([
      {
        registrations: [{ hostSessionId: "host_search", metadata: { title: "Searchable" } }],
        deferEventRecovery: true,
      },
    ]);
    expect(callbacks).toHaveLength(2);
    await hooks.dispose?.();
  });

  test("dispose cancels an early registry tool waiting on a stalled session list", async () => {
    const callbacks: Array<() => void> = [];
    let listCalls = 0;
    let runtimeDisposed = false;
    const plugin = createAgentBusPlugin({
      runtimeFactory: () =>
        ({
          bootstrapHostSessions: async () => undefined,
          search: async () => "unused",
          dispose: async () => {
            runtimeDisposed = true;
          },
        }) as unknown as AgentBusRuntime,
      bootstrapScheduler: {
        set: (callback) => {
          callbacks.push(callback);
          return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
        },
        clear: () => undefined,
      },
    });
    const input = {
      client: {
        session: {
          list: () => {
            listCalls += 1;
            return new Promise<never>(() => undefined);
          },
        },
      },
      directory: "/worktree",
      project: { id: "project_01" },
    } as unknown as PluginInput;
    const hooks = await plugin(input, {
      credentialFilePath: "/trusted/credential",
      timeoutMs: 1_000,
    });
    const search = hooks.tool?.agentbus_search_sessions;
    if (!search) throw new Error("missing search tool");
    const searchWork = search.execute({ query: "pending" }, { sessionID: "host_search" } as never);
    await waitFor(() => listCalls === 1);

    const rejected = expect(searchWork).rejects.toThrow("Agent Bus is unavailable.");
    await hooks.dispose?.();
    await rejected;
    expect(runtimeDisposed).toBe(true);
  });

  test("events racing a deferred bootstrap preserve latest updates and deletion tombstones", async () => {
    const callbacks: Array<() => void> = [];
    const listGate = deferred<{ data: readonly ReturnType<typeof session>[] }>();
    const bootstrapCalls: unknown[] = [];
    const upserts: unknown[] = [];
    const deletions: string[] = [];
    const runtime = {
      bootstrapHostSessions: async (registrations: unknown) => {
        bootstrapCalls.push(registrations);
      },
      upsertHostSession: async (...args: unknown[]) => {
        upserts.push(args);
      },
      deregisterHostSession: async (hostSessionId: string) => {
        deletions.push(hostSessionId);
      },
      dispose: async () => undefined,
    } as unknown as AgentBusRuntime;
    const plugin = createAgentBusPlugin({
      runtimeFactory: () => runtime,
      bootstrapScheduler: {
        set: (callback) => {
          callbacks.push(callback);
          return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
        },
        clear: () => undefined,
      },
    });
    const input = {
      client: { session: { list: () => listGate.promise } },
      directory: "/worktree",
      project: { id: "project_01" },
    } as unknown as PluginInput;
    const hooks = await plugin(input, { credentialFilePath: "/trusted/credential" });
    callbacks[0]?.();

    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: { info: session("host_updated", "Latest") },
      },
    });
    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: session("host_deleted", "Deleted") },
      },
    });
    await hooks.event?.({
      event: {
        type: "session.created",
        properties: { info: session("host_created", "Created") },
      },
    });
    listGate.resolve({
      data: [
        session("host_updated", "Stale"),
        session("host_deleted", "Must not return"),
        session("host_existing", "Existing"),
      ],
    });
    await waitFor(() => bootstrapCalls.length === 1);

    expect(upserts).toEqual([
      ["host_updated", { title: "Latest" }],
      ["host_created", { title: "Created" }],
    ]);
    expect(deletions).toEqual(["host_deleted"]);
    expect(bootstrapCalls).toEqual([
      [
        { hostSessionId: "host_created", metadata: { title: "Created" } },
        { hostSessionId: "host_updated", metadata: { title: "Latest" } },
        { hostSessionId: "host_existing", metadata: { title: "Existing" } },
      ],
    ]);
    await hooks.dispose?.();
  });

  test("bootstraps current sessions with safe titles and tracks create/update/delete events", async () => {
    const listCalls: unknown[] = [];
    const bootstrapCalls: unknown[] = [];
    const upsertCalls: unknown[] = [];
    const deleteCalls: string[] = [];
    const runtime = {
      bootstrapHostSessions: async (registrations: unknown) => {
        bootstrapCalls.push(registrations);
      },
      upsertHostSession: async (...args: unknown[]) => {
        upsertCalls.push(args);
      },
      deregisterHostSession: async (hostSessionId: string) => {
        deleteCalls.push(hostSessionId);
      },
      dispose: async () => undefined,
      send: async () => "unused",
      receive: async () => "unused",
      search: async () => "unused",
    } as unknown as AgentBusRuntime;
    const plugin = createAgentBusPlugin({ runtimeFactory: () => runtime });
    const input = {
      client: {
        session: {
          list: async (options: unknown) => {
            listCalls.push(options);
            return {
              data: [
                session("host_alpha", "Alpha reviewer"),
                session("host_unsafe", "  unsafe\npeer title  "),
                session("host_other_directory", "Other", "/other"),
                session("host_other_project", "Other project", "/worktree", "project_02"),
              ],
            };
          },
        },
        tui: { showToast: async () => ({ data: true }) },
      },
      directory: "/worktree",
      worktree: "/worktree",
      project: { id: "project_01" },
      serverUrl: new URL("http://127.0.0.1:4096"),
      experimental_workspace: { register: () => undefined },
      $: {},
    } as unknown as PluginInput;

    const hooks = await plugin(input, { credentialFilePath: "/trusted/credential" });
    expect(listCalls).toEqual([]);
    await waitFor(() => bootstrapCalls.length === 1);
    expect(listCalls).toEqual([{ query: { directory: "/worktree" } }]);
    expect(bootstrapCalls).toEqual([
      [
        { hostSessionId: "host_alpha", metadata: { title: "Alpha reviewer" } },
        { hostSessionId: "host_unsafe", metadata: {} },
      ],
    ]);

    await hooks.event?.({
      event: {
        type: "session.created",
        properties: { info: session("host_beta", "Beta builder") },
      },
    });
    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: { info: session("host_beta", "Beta renamed") },
      },
    });
    await hooks.event?.({
      event: {
        type: "session.created",
        properties: { info: session("ignored", "Ignored", "/other") },
      },
    });
    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: { info: session("host_beta", "Beta renamed") },
      },
    });

    expect(upsertCalls).toEqual([
      ["host_beta", { title: "Beta builder" }],
      ["host_beta", { title: "Beta renamed" }],
    ]);
    expect(deleteCalls).toEqual(["host_beta"]);
    await hooks.dispose?.();
  });

  test("a newly active session evicts the oldest registration at the 256-session bound", async () => {
    const deleted: string[] = [];
    const upserted: string[] = [];
    let bootstrapped = false;
    const runtime = {
      bootstrapHostSessions: async () => {
        bootstrapped = true;
      },
      upsertHostSession: async (hostSessionId: string) => {
        upserted.push(hostSessionId);
      },
      deregisterHostSession: async (hostSessionId: string) => {
        deleted.push(hostSessionId);
      },
      dispose: async () => undefined,
      send: async () => "unused",
      receive: async () => "unused",
      search: async () => "unused",
    } as unknown as AgentBusRuntime;
    const plugin = createAgentBusPlugin({ runtimeFactory: () => runtime });
    const input = {
      client: {
        session: {
          list: async () => ({
            data: Array.from({ length: 256 }, (_, index) =>
              session(`host_${index}`, `Title ${index}`),
            ),
          }),
        },
        tui: { showToast: async () => ({ data: true }) },
      },
      directory: "/worktree",
      project: { id: "project_01" },
    } as unknown as PluginInput;
    const hooks = await plugin(input, { credentialFilePath: "/trusted/credential" });
    await waitFor(() => bootstrapped);

    await hooks.event?.({
      event: {
        type: "session.created",
        properties: { info: session("host_new", "Newest") },
      },
    });
    expect(deleted).toEqual(["host_255"]);
    expect(upserted).toEqual(["host_new"]);
    await hooks.dispose?.();
  });

  test("returns valid hooks and retries when trusted host enumeration initially fails", async () => {
    let listAvailable = false;
    const callbacks: Array<() => void> = [];
    const bootstrapCalls: unknown[] = [];
    let disposed = false;
    let clearedTimers = 0;
    const plugin = createAgentBusPlugin({
      runtimeFactory: () =>
        ({
          bootstrapHostSessions: async (registrations: unknown) => {
            bootstrapCalls.push(registrations);
          },
          dispose: async () => {
            disposed = true;
          },
        }) as unknown as AgentBusRuntime,
      bootstrapScheduler: {
        set: (callback) => {
          callbacks.push(callback);
          return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
        },
        clear: () => {
          clearedTimers += 1;
        },
      },
    });
    const input = {
      client: {
        session: {
          list: async () =>
            listAvailable
              ? { data: [session("host_recovered", "Recovered")] }
              : { data: undefined, error: { raw: "private path" } },
        },
        tui: { showToast: async () => ({ data: true }) },
      },
      directory: "/worktree",
      project: { id: "project_01" },
    } as unknown as PluginInput;

    const hooks = await plugin(input, { credentialFilePath: "/trusted/credential" });
    expect(Object.keys(hooks.tool ?? {})).toHaveLength(3);
    expect(callbacks).toHaveLength(1);
    expect(bootstrapCalls).toEqual([]);
    callbacks[0]?.();
    await waitFor(() => bootstrapCalls.length === 1 && callbacks.length === 2);
    expect(bootstrapCalls).toEqual([[]]);
    listAvailable = true;
    callbacks[1]?.();
    await waitFor(() => bootstrapCalls.length === 2);
    expect(bootstrapCalls).toEqual([
      [],
      [{ hostSessionId: "host_recovered", metadata: { title: "Recovered" } }],
    ]);
    await hooks.dispose?.();
    expect(disposed).toBe(true);
    expect(clearedTimers).toBe(0);
    callbacks[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bootstrapCalls).toHaveLength(2);
  });

  test("dispose cancels a pending host bootstrap retry", async () => {
    const callbacks: Array<() => void> = [];
    let clearCount = 0;
    let listCount = 0;
    const plugin = createAgentBusPlugin({
      runtimeFactory: () =>
        ({
          bootstrapHostSessions: async () => undefined,
          dispose: async () => undefined,
        }) as unknown as AgentBusRuntime,
      bootstrapScheduler: {
        set: (callback) => {
          callbacks.push(callback);
          return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
        },
        clear: () => {
          clearCount += 1;
        },
      },
    });
    const input = {
      client: {
        session: {
          list: async () => {
            listCount += 1;
            return { data: undefined, error: { raw: "private" } };
          },
        },
        tui: { showToast: async () => ({ data: true }) },
      },
      directory: "/worktree",
      project: { id: "project_01" },
    } as unknown as PluginInput;

    const hooks = await plugin(input, { credentialFilePath: "/trusted/credential" });
    expect(callbacks).toHaveLength(1);
    expect(listCount).toBe(0);
    callbacks[0]?.();
    await waitFor(() => listCount === 1 && callbacks.length === 2);
    await hooks.dispose?.();
    expect(clearCount).toBe(1);
    callbacks[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listCount).toBe(1);
  });
});
