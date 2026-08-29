import { describe, expect, test } from "bun:test";

import { MAX_ID_BYTES } from "@opencode-agentbus/protocol";
import type { PluginInput } from "@opencode-ai/plugin";

import {
  MAX_BOOTSTRAP_SESSIONS,
  listHostSessionRegistrations,
  resolveForegroundHostSession,
} from "../src/host-sessions";
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

function project(id: string, worktree: string) {
  return { id, worktree, time: { created: 1 } };
}

describe("trusted OpenCode host session lifecycle", () => {
  test("resolves server-served foreground sessions from the exact trusted tool directory", async () => {
    const sessionListCalls: unknown[] = [];
    const projectCurrentCalls: unknown[] = [];
    const returned = [session("host_workspace", "Workspace", "/workspace/A", "project_A")];
    const input = {
      client: {
        session: {
          list: async (request: unknown) => {
            sessionListCalls.push(request);
            return { data: returned };
          },
        },
        project: {
          current: async (request: unknown) => {
            projectCurrentCalls.push(request);
            return { data: project("project_A", "/workspace/A") };
          },
        },
      },
      directory: "/home/julien",
      worktree: "/home/julien",
      project: project("server_root_project", "/home/julien"),
    } as unknown as Pick<PluginInput, "client" | "directory" | "project">;

    await expect(
      resolveForegroundHostSession(input, {
        sessionID: "host_workspace",
        directory: "/workspace/A",
        worktree: "/workspace/A",
      }),
    ).resolves.toMatchObject({
      hostSessionId: "host_workspace",
      metadata: { title: "Workspace" },
    });
    expect(sessionListCalls).toEqual([{ query: { directory: "/workspace/A" } }]);
    expect(projectCurrentCalls).toEqual([{ query: { directory: "/workspace/A" } }]);
  });

  test("accepts a specific ToolContext worktree beneath the legitimate global project root", async () => {
    const input = {
      client: {
        session: {
          list: async () => ({
            data: [session("host_global", "Global", "/workspace/project", "global")],
          }),
        },
        project: { current: async () => ({ data: project("global", "/") }) },
      },
      directory: "/home/julien",
      project: project("server_root_project", "/home/julien"),
    } as unknown as Pick<PluginInput, "client" | "directory" | "project">;

    await expect(
      resolveForegroundHostSession(input, {
        sessionID: "host_global",
        directory: "/workspace/project",
        worktree: "/workspace",
      }),
    ).resolves.toMatchObject({ hostSessionId: "host_global" });
  });

  test("accepts different nested trusted worktrees when both contain the exact directory", async () => {
    const input = {
      client: {
        session: {
          list: async () => ({
            data: [session("host_nested", "Nested", "/workspace/project/subdir", "project_nested")],
          }),
        },
        project: {
          current: async () => ({ data: project("project_nested", "/workspace/project") }),
        },
      },
    } as unknown as Pick<PluginInput, "client">;

    await expect(
      resolveForegroundHostSession(input, {
        sessionID: "host_nested",
        directory: "/workspace/project/subdir",
        worktree: "/workspace",
      }),
    ).resolves.toMatchObject({ hostSessionId: "host_nested" });
  });

  test.each([
    ["empty", ""],
    ["invalid-character", "host/workspace"],
    ["control-character", "host\nworkspace"],
    ["Unicode-unsafe", "høst_workspace"],
    ["oversized", "h".repeat(MAX_ID_BYTES + 1)],
  ] as const)(
    "rejects %s ToolContext session IDs before querying the host",
    async (_name, sessionID) => {
      let sessionCalls = 0;
      let projectCalls = 0;
      const input = {
        client: {
          session: {
            list: async () => {
              sessionCalls += 1;
              return {
                data: [session(sessionID, "Workspace", "/workspace/A", "project_A")],
              };
            },
          },
          project: {
            current: async () => {
              projectCalls += 1;
              return { data: project("project_A", "/workspace/A") };
            },
          },
        },
      } as unknown as Pick<PluginInput, "client">;

      await expect(
        resolveForegroundHostSession(input, {
          sessionID,
          directory: "/workspace/A",
          worktree: "/workspace/A",
        }),
      ).rejects.toThrow("Agent Bus is unavailable.");
      expect({ projectCalls, sessionCalls }).toEqual({ projectCalls: 0, sessionCalls: 0 });
    },
  );

  test.each([
    ["returned ID mismatch", session("host_other", "Workspace", "/workspace/A", "project_A")],
    [
      "malformed returned metadata",
      session("host_workspace", "Unsafe\u0000Title", "/workspace/A", "project_A"),
    ],
  ] as const)("rejects %s at the host-validation boundary", async (_name, returned) => {
    let projectCalls = 0;
    const input = {
      client: {
        session: { list: async () => ({ data: [returned] }) },
        project: {
          current: async () => {
            projectCalls += 1;
            return { data: project("project_A", "/workspace/A") };
          },
        },
      },
    } as unknown as Pick<PluginInput, "client">;

    await expect(
      resolveForegroundHostSession(input, {
        sessionID: "host_workspace",
        directory: "/workspace/A",
        worktree: "/workspace/A",
      }),
    ).rejects.toThrow("Agent Bus is unavailable.");
    expect(projectCalls).toBe(0);
  });

  test.each([
    ["missing tool directory", { sessionID: "host_exact", worktree: "/workspace/A" }, undefined],
    ["missing tool worktree", { sessionID: "host_exact", directory: "/workspace/A" }, undefined],
    ["missing tool session ID", { directory: "/workspace/A", worktree: "/workspace/A" }, undefined],
    [
      "relative tool directory",
      { sessionID: "host_exact", directory: "workspace/A", worktree: "/workspace/A" },
      undefined,
    ],
    [
      "session directory mismatch",
      { sessionID: "host_exact", directory: "/workspace/A", worktree: "/workspace/A" },
      [session("host_exact", "Wrong directory", "/workspace/B", "project_A")],
    ],
    [
      "project mismatch",
      { sessionID: "host_exact", directory: "/workspace/A", worktree: "/workspace/A" },
      [session("host_exact", "Wrong project", "/workspace/A", "project_B")],
    ],
    [
      "duplicate session ID",
      { sessionID: "host_exact", directory: "/workspace/A", worktree: "/workspace/A" },
      [
        session("host_exact", "Duplicate one", "/workspace/A", "project_A"),
        session("host_exact", "Duplicate two", "/workspace/A", "project_A"),
      ],
    ],
    [
      "worktree mismatch",
      { sessionID: "host_exact", directory: "/workspace/A", worktree: "/workspace/other" },
      [session("host_exact", "Wrong worktree", "/workspace/A", "project_A")],
    ],
  ] as const)("fails closed on %s", async (_name, context, returned) => {
    const input = {
      client: {
        session: { list: async () => ({ data: returned }) },
        project: { current: async () => ({ data: project("project_A", "/workspace/A") }) },
      },
      directory: "/home/julien",
      project: project("server_root_project", "/home/julien"),
    } as unknown as Pick<PluginInput, "client" | "directory" | "project">;

    await expect(resolveForegroundHostSession(input, context as never)).rejects.toThrow(
      "Agent Bus is unavailable.",
    );
  });

  test.each(["session", "project"] as const)(
    "maps foreground %s host query failure to unavailable",
    async (failingQuery) => {
      const input = {
        client: {
          session: {
            list: async () => {
              if (failingQuery === "session") throw new Error("private session failure");
              return { data: [session("host_exact", "Exact", "/workspace/A", "project_A")] };
            },
          },
          project: {
            current: async () => {
              if (failingQuery === "project") throw new Error("private project failure");
              return { data: project("project_A", "/workspace/A") };
            },
          },
        },
        directory: "/home/julien",
        project: project("server_root_project", "/home/julien"),
      } as unknown as Pick<PluginInput, "client" | "directory" | "project">;

      await expect(
        resolveForegroundHostSession(input, {
          sessionID: "host_exact",
          directory: "/workspace/A",
          worktree: "/workspace/A",
        }),
      ).rejects.toThrow("Agent Bus is unavailable.");
    },
  );

  test.each(["missing session data", "missing project data", "malformed session"] as const)(
    "maps %s response to unavailable",
    async (failure) => {
      const input = {
        client: {
          session: {
            list: async () => ({
              data:
                failure === "missing session data"
                  ? undefined
                  : failure === "malformed session"
                    ? [null]
                    : [session("host_exact", "Exact", "/workspace/A", "project_A")],
            }),
          },
          project: {
            current: async () => ({
              data:
                failure === "missing project data"
                  ? undefined
                  : project("project_A", "/workspace/A"),
            }),
          },
        },
      } as unknown as Pick<PluginInput, "client">;

      await expect(
        resolveForegroundHostSession(input, {
          sessionID: "host_exact",
          directory: "/workspace/A",
          worktree: "/workspace/A",
        }),
      ).rejects.toThrow("Agent Bus is unavailable.");
    },
  );

  test("validates every tool before broker readiness or runtime operation across host failures", async () => {
    const operations = ["send", "reply", "receive", "search"] as const;
    const failures = [
      "missing",
      "duplicate",
      "directory",
      "project",
      "context worktree unrelated",
      "context worktree escaping",
      "context worktree relative",
      "project worktree unrelated",
      "project worktree escaping",
      "project worktree relative",
      "session query",
      "project query",
    ] as const;
    for (const operation of operations) {
      for (const failure of failures) {
        let readinessCalls = 0;
        let runtimeCalls = 0;
        const plugin = createAgentBusPlugin({
          brokerBootstrapFactory: () => ({
            ensureReady: async () => {
              readinessCalls += 1;
            },
          }),
          runtimeFactory: () =>
            ({
              send: async () => {
                runtimeCalls += 1;
                return "sent";
              },
              reply: async () => {
                runtimeCalls += 1;
                return "replied";
              },
              receive: async () => {
                runtimeCalls += 1;
                return "received";
              },
              search: async () => {
                runtimeCalls += 1;
                return "searched";
              },
              dispose: async () => undefined,
            }) as unknown as AgentBusRuntime,
          bootstrapScheduler: {
            set: () => ({ unref: () => undefined }) as unknown as ReturnType<typeof setTimeout>,
            clear: () => undefined,
          },
        });
        const exact = session("host_workspace", "Workspace", "/workspace/A", "project_A");
        const returned =
          failure === "missing"
            ? []
            : failure === "duplicate"
              ? [exact, exact]
              : failure === "directory"
                ? [session("host_workspace", "Workspace", "/workspace/B", "project_A")]
                : failure === "project"
                  ? [session("host_workspace", "Workspace", "/workspace/A", "project_B")]
                  : [exact];
        const input = {
          client: {
            session: {
              list: async () => {
                if (failure === "session query") throw new Error("private session route");
                return { data: returned };
              },
            },
            project: {
              current: async () => {
                if (failure === "project query") throw new Error("private project route");
                return {
                  data: project(
                    "project_A",
                    failure === "project worktree unrelated"
                      ? "/workspace/B"
                      : failure === "project worktree escaping"
                        ? "/workspace/A/child"
                        : failure === "project worktree relative"
                          ? "workspace/A"
                          : "/workspace/A",
                  ),
                };
              },
            },
          },
          directory: "/home/julien",
          worktree: "/home/julien",
          project: project("server_root_project", "/home/julien"),
        } as unknown as PluginInput;
        const hooks = await plugin(input, { credentialFilePath: "/trusted/credential" });
        const send = hooks.tool?.agentbus_send;
        const reply = hooks.tool?.agentbus_reply;
        const receive = hooks.tool?.agentbus_receive;
        const search = hooks.tool?.agentbus_search_sessions;
        if (!send || !reply || !receive || !search) throw new Error("missing Agent Bus tools");
        const context = {
          sessionID: "host_workspace",
          directory: "/workspace/A",
          worktree:
            failure === "context worktree unrelated"
              ? "/workspace/B"
              : failure === "context worktree escaping"
                ? "/workspace/A/child"
                : failure === "context worktree relative"
                  ? "workspace/A"
                  : "/workspace/A",
        } as never;
        const work =
          operation === "send"
            ? send.execute({ target: "target", body: "body" }, context)
            : operation === "reply"
              ? reply.execute({ messageId: "message", body: "body" }, context)
              : operation === "receive"
                ? receive.execute({}, context)
                : search.execute({ query: "target" }, context);

        await expect(work).rejects.toThrow("Agent Bus is unavailable.");
        expect({ readinessCalls, runtimeCalls }).toEqual({ readinessCalls: 0, runtimeCalls: 0 });
        await hooks.dispose?.();
      }
    }
  });

  test("strictly parses every tool's foreground ID and echoed registration before broker effects", async () => {
    const operations = ["send", "reply", "receive", "search"] as const;
    const oversizedId = "h".repeat(MAX_ID_BYTES + 1);
    const failures = [
      {
        name: "invalid-character ToolContext ID",
        contextSessionId: "host/workspace",
        returned: session("host/workspace", "Workspace", "/workspace/A", "project_A"),
      },
      {
        name: "oversized ToolContext ID",
        contextSessionId: oversizedId,
        returned: session(oversizedId, "Workspace", "/workspace/A", "project_A"),
      },
      {
        name: "returned ID mismatch",
        contextSessionId: "host_workspace",
        returned: session("host_other", "Workspace", "/workspace/A", "project_A"),
      },
      {
        name: "malformed echoed metadata",
        contextSessionId: "host_workspace",
        returned: session("host_workspace", "Unsafe\u0000Title", "/workspace/A", "project_A"),
      },
    ] as const;

    for (const operation of operations) {
      for (const failure of failures) {
        const effects = {
          auth: 0,
          channel: 0,
          launch: 0,
          probe: 0,
          readiness: 0,
          runtime: 0,
        };
        const plugin = createAgentBusPlugin({
          brokerBootstrapFactory: () => ({
            ensureReady: async () => {
              effects.readiness += 1;
              effects.auth += 1;
              effects.probe += 1;
              effects.launch += 1;
            },
          }),
          runtimeFactory: () => {
            const invoked = async (result: string): Promise<string> => {
              effects.runtime += 1;
              effects.channel += 1;
              return result;
            };
            return {
              send: async () => invoked("sent"),
              reply: async () => invoked("replied"),
              receive: async () => invoked("received"),
              search: async () => invoked("searched"),
              dispose: async () => undefined,
            } as unknown as AgentBusRuntime;
          },
          bootstrapScheduler: {
            set: () => ({ unref: () => undefined }) as unknown as ReturnType<typeof setTimeout>,
            clear: () => undefined,
          },
        });
        const input = {
          client: {
            session: { list: async () => ({ data: [failure.returned] }) },
            project: {
              current: async () => ({ data: project("project_A", "/workspace/A") }),
            },
          },
          directory: "/home/julien",
          worktree: "/home/julien",
          project: project("server_root_project", "/home/julien"),
        } as unknown as PluginInput;
        const hooks = await plugin(input, { credentialFilePath: "/trusted/credential" });
        const send = hooks.tool?.agentbus_send;
        const reply = hooks.tool?.agentbus_reply;
        const receive = hooks.tool?.agentbus_receive;
        const search = hooks.tool?.agentbus_search_sessions;
        if (!send || !reply || !receive || !search) throw new Error("missing Agent Bus tools");
        const context = {
          sessionID: failure.contextSessionId,
          directory: "/workspace/A",
          worktree: "/workspace/A",
        } as never;
        const work =
          operation === "send"
            ? send.execute({ target: "target", body: "body" }, context)
            : operation === "reply"
              ? reply.execute({ messageId: "message", body: "body" }, context)
              : operation === "receive"
                ? receive.execute({}, context)
                : search.execute({ query: "target" }, context);

        await expect(work, `${operation}: ${failure.name}`).rejects.toThrow(
          "Agent Bus is unavailable.",
        );
        expect(effects, `${operation}: ${failure.name}`).toEqual({
          auth: 0,
          channel: 0,
          launch: 0,
          probe: 0,
          readiness: 0,
          runtime: 0,
        });
        await hooks.dispose?.();
      }
    }
  });

  test("validates foreground once before readiness and passes the correlated registration to runtime", async () => {
    const order: string[] = [];
    const runtimeArguments: unknown[] = [];
    const plugin = createAgentBusPlugin({
      brokerBootstrapFactory: () => ({
        ensureReady: async () => {
          order.push("ready");
        },
      }),
      runtimeFactory: () =>
        ({
          send: async (...args: unknown[]) => {
            order.push("runtime");
            runtimeArguments.push(...args);
            return "sent";
          },
          dispose: async () => undefined,
        }) as unknown as AgentBusRuntime,
      bootstrapScheduler: {
        set: () => ({ unref: () => undefined }) as unknown as ReturnType<typeof setTimeout>,
        clear: () => undefined,
      },
    });
    const input = {
      client: {
        session: {
          list: async () => {
            order.push("session");
            return {
              data: [session("host_workspace", "Workspace", "/workspace/A", "project_A")],
            };
          },
        },
        project: {
          current: async () => {
            order.push("project");
            return { data: project("project_A", "/") };
          },
        },
      },
      directory: "/home/julien",
      worktree: "/home/julien",
      project: project("server_root_project", "/home/julien"),
    } as unknown as PluginInput;
    const hooks = await plugin(input, { credentialFilePath: "/trusted/credential" });
    const context = {
      sessionID: "host_workspace",
      directory: "/workspace/A",
      worktree: "/workspace/A",
    } as never;
    const send = hooks.tool?.agentbus_send;
    if (!send) throw new Error("missing send tool");

    await expect(send.execute({ target: "target", body: "body" }, context)).resolves.toBe("sent");
    expect(order).toEqual(["session", "project", "ready", "runtime"]);
    expect(runtimeArguments[2]).toEqual({
      hostSessionId: "host_workspace",
      metadata: { title: "Workspace" },
    });
    await hooks.dispose?.();
  });

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

  test("returns hooks before broker readiness or a never-resolving session list can start", async () => {
    const callbacks: Array<() => void> = [];
    let readinessCalls = 0;
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
      brokerBootstrapFactory: () => ({
        ensureReady: () => {
          readinessCalls += 1;
          return new Promise<never>(() => undefined);
        },
      }),
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
    expect(Object.keys(hooks.tool ?? {})).toHaveLength(4);
    expect(listCalls).toBe(0);
    expect(callbacks).toHaveLength(1);

    callbacks[0]?.();
    expect(readinessCalls).toBe(1);
    expect(listCalls).toBe(0);
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

    const hooks = await plugin(input, {
      credentialFilePath: "/trusted/credential",
      autoStartBroker: false,
    });
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
      const hooks = await plugin(input, {
        credentialFilePath: "/trusted/credential",
        autoStartBroker: false,
      });
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
    const hooks = await plugin(input, {
      credentialFilePath: "/trusted/credential",
      autoStartBroker: false,
    });
    callbacks[0]?.();
    await waitFor(() => bootstrapStarted);

    await hooks.dispose?.();
    expect(runtimeDisposed).toBe(true);
    bootstrapGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("tool calls before deferred bootstrap perform only foreground host validation", async () => {
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
    const hooks = await plugin(input, {
      credentialFilePath: "/trusted/credential",
      autoStartBroker: false,
    });
    const receive = hooks.tool?.agentbus_receive;
    if (!receive) throw new Error("missing receive tool");

    await expect(
      receive.execute({}, {
        sessionID: "host_early",
        directory: "/worktree",
        worktree: "/worktree",
      } as never),
    ).rejects.toThrow("Agent Bus is unavailable.");
    expect(listCalls).toBe(1);
    await hooks.dispose?.();
  });

  test("autostart tool operations await bounded broker readiness", async () => {
    const readiness = deferred<void>();
    let readinessCalls = 0;
    let receiveCalls = 0;
    const plugin = createAgentBusPlugin({
      brokerBootstrapFactory: () => ({
        ensureReady: async () => {
          readinessCalls += 1;
          await readiness.promise;
        },
      }),
      runtimeFactory: () =>
        ({
          receive: async () => {
            receiveCalls += 1;
            return "ready";
          },
          dispose: async () => undefined,
        }) as unknown as AgentBusRuntime,
    });
    const input = {
      client: {
        session: {
          list: async () => ({ data: [session("host_waiting", "Waiting")] }),
        },
        project: {
          current: async () => ({ data: project("project_01", "/worktree") }),
        },
      },
      directory: "/worktree",
      worktree: "/worktree",
      project: { id: "project_01" },
    } as unknown as PluginInput;
    const hooks = await plugin(input, {
      credentialFilePath: "/trusted/credential",
      brokerStartupTimeoutMs: 100,
    });
    const receive = hooks.tool?.agentbus_receive;
    if (!receive) throw new Error("missing receive tool");

    const work = receive.execute({}, {
      sessionID: "host_waiting",
      directory: "/worktree",
      worktree: "/worktree",
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readinessCalls).toBe(1);
    expect(receiveCalls).toBe(0);
    readiness.resolve();
    await expect(work).resolves.toBe("ready");
    expect(receiveCalls).toBe(1);
    await hooks.dispose?.();
  });

  test("unrelated host events return without awaiting stalled broker readiness", async () => {
    const callbacks: Array<() => void> = [];
    let readinessCalls = 0;
    const plugin = createAgentBusPlugin({
      brokerBootstrapFactory: () => ({
        ensureReady: () => {
          readinessCalls += 1;
          return new Promise<never>(() => undefined);
        },
      }),
      runtimeFactory: () =>
        ({
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
      client: { session: { list: async () => ({ data: [] }) } },
      directory: "/worktree",
      project: { id: "project_01" },
    } as unknown as PluginInput;
    const hooks = await plugin(input, { credentialFilePath: "/trusted/credential" });

    await expect(
      Promise.race([
        hooks.event?.({ event: { type: "server.connected", properties: {} } } as never),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("unrelated event stalled")), 50),
        ),
      ]),
    ).resolves.toBeUndefined();
    expect(readinessCalls).toBe(0);
    expect(callbacks).toHaveLength(1);
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
        project: {
          current: async () => ({ data: project("project_01", "/worktree") }),
        },
      },
      directory: "/worktree",
      worktree: "/worktree",
      project: { id: "project_01" },
    } as unknown as PluginInput;
    const hooks = await plugin(input, {
      credentialFilePath: "/trusted/credential",
      timeoutMs: 100,
      autoStartBroker: false,
    });
    const search = hooks.tool?.agentbus_search_sessions;
    if (!search) throw new Error("missing search tool");

    await expect(
      search.execute({ query: "Searchable" }, {
        sessionID: "host_search",
        directory: "/worktree",
        worktree: "/worktree",
      } as never),
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
      worktree: "/worktree",
      project: { id: "project_01" },
    } as unknown as PluginInput;
    const hooks = await plugin(input, {
      credentialFilePath: "/trusted/credential",
      timeoutMs: 1_000,
      autoStartBroker: false,
    });
    const search = hooks.tool?.agentbus_search_sessions;
    if (!search) throw new Error("missing search tool");
    const searchWork = search.execute({ query: "pending" }, {
      sessionID: "host_search",
      directory: "/worktree",
      worktree: "/worktree",
    } as never);
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
    const hooks = await plugin(input, {
      credentialFilePath: "/trusted/credential",
      autoStartBroker: false,
    });
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

  test("trusted lifecycle routes refresh attached-workspace focus and clean on deletion and dispose", async () => {
    const publishes: unknown[] = [];
    const plugin = createAgentBusPlugin({
      runtimeFactory: () =>
        ({
          deregisterHostSession: async () => undefined,
          dispose: async () => undefined,
        }) as unknown as AgentBusRuntime,
      bootstrapScheduler: {
        set: () => ({ unref: () => undefined }) as unknown as ReturnType<typeof setTimeout>,
        clear: () => undefined,
      },
    });
    const input = {
      client: {
        session: { list: async () => ({ data: [] }) },
        tui: {
          publish: async (request: unknown) => {
            publishes.push(structuredClone(request));
            return { data: true };
          },
          showToast: async () => ({ data: true }),
        },
      },
      directory: "/home/julien",
      worktree: "/home/julien",
      project: project("server_root_project", "/home/julien"),
    } as unknown as PluginInput;
    const hooks = await plugin(input, {
      credentialFilePath: "/trusted/credential",
      focusOnReceiveApproval: true,
    });
    const approval = async (): Promise<void> => {
      await hooks["permission.ask"]?.(
        { type: "agentbus_receive", sessionID: "host_attached" } as never,
        { status: "ask" } as never,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    await hooks.event?.({
      event: {
        type: "session.created",
        properties: {
          info: session("host_attached", "/peer/title/must/not/route", "/workspace/A", "project_A"),
        },
      },
    });
    await approval();
    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: {
          info: session("host_attached", "Updated", "/workspace/B", "project_B"),
        },
      },
    });
    await approval();
    await hooks.event?.({
      event: {
        type: "session.deleted",
        properties: {
          info: session("host_attached", "Deleted", "/workspace/B", "project_B"),
        },
      },
    });
    await approval();
    await hooks.dispose?.();
    await approval();

    expect(publishes).toEqual([
      expect.objectContaining({ query: { directory: "/workspace/A" } }),
      expect.objectContaining({ query: { directory: "/workspace/B" } }),
    ]);
    expect(JSON.stringify(publishes)).not.toContain("/home/julien");
    expect(JSON.stringify(publishes)).not.toContain("/peer/title/must/not/route");
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

    const hooks = await plugin(input, {
      credentialFilePath: "/trusted/credential",
      autoStartBroker: false,
    });
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
    const hooks = await plugin(input, {
      credentialFilePath: "/trusted/credential",
      autoStartBroker: false,
    });
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

    const hooks = await plugin(input, {
      credentialFilePath: "/trusted/credential",
      autoStartBroker: false,
    });
    expect(Object.keys(hooks.tool ?? {})).toHaveLength(4);
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

    const hooks = await plugin(input, {
      credentialFilePath: "/trusted/credential",
      autoStartBroker: false,
    });
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
