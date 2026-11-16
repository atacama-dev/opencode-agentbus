import { expect, spyOn, test } from "bun:test";
import { Effect, Exit, Stream } from "effect";
import { BrokerBootstrap } from "../src/broker-bootstrap";
import { AgentBusRuntime } from "../src/runtime";
import StockPlugin from "../src/stock-v2";
import { V2WakeEpisodes } from "../src/wake-v2";

test("stock prototype is opt-in and rejects unsupported approval focus before broker access", async () => {
  let tools = 0;
  let sessions = 0;
  const base = {
    options: {
      experimentalStock: true,
      deploymentNamespace: "test",
      endpoint: "http://127.0.0.1:1",
      credentialFilePath: "/not/an/actual/credential",
      brokerDatabasePath: "/not/an/actual/db.sqlite",
      autoStartBroker: false,
    },
    location: {
      directory: "/project",
      project: { id: "project_1", directory: "/project", canonical: "/project" },
    },
    session: {
      get: async () => {
        sessions++;
        throw Error("should not query");
      },
    },
    tool: {
      transform: async () => {
        tools++;
        return { dispose: async () => {} };
      },
    },
  };
  for (const overrides of [
    { options: { ...base.options, experimentalStock: false } },
    { options: { ...base.options, focusOnReceiveApproval: true } },
  ]) {
    const pluginContext = { ...base, ...overrides } as unknown as Parameters<
      typeof StockPlugin.effect
    >[0];
    await expect(
      Effect.runPromise(Effect.scoped(StockPlugin.effect(pluginContext))),
    ).rejects.toThrow();
  }
  expect(tools).toBe(0);
  expect(sessions).toBe(0);
});

test("stock executor rejects fabricated context before session lookup or broker access", async () => {
  let queries = 0;
  let execute!: (input: unknown, invocation: unknown) => unknown;
  const ctx = {
    options: {
      experimentalStock: true,
      deploymentNamespace: "test",
      endpoint: "http://127.0.0.1:1",
      credentialFilePath: "/not/an/actual/credential",
      brokerDatabasePath: "/not/an/actual/db.sqlite",
      autoStartBroker: false,
    },
    location: {
      directory: "/project",
      project: { id: "project_1", directory: "/project", canonical: "/project" },
    },
    event: { subscribe: () => Stream.never },
    session: {
      get: () => {
        queries++;
        return Effect.fail(new Error("unexpected lookup"));
      },
    },
    tool: {
      hook: () => Effect.succeed({ dispose: Effect.void }),
      transform: (
        callback: (editor: { add(tool: { name: string; execute: typeof execute }): void }) => void,
      ) => {
        callback({
          add(tool) {
            if (tool.name === "agentbus_receive") execute = tool.execute;
          },
        });
        return Effect.succeed({ dispose: Effect.void });
      },
    },
  } as unknown as Parameters<typeof StockPlugin.effect>[0];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* StockPlugin.effect(ctx);
        const failure = yield* Effect.flip(
          execute(
            {},
            {
              sessionID: "ses_forged",
              agent: "build",
              messageID: "msg_forged",
              id: "call_forged",
              progress: () => Effect.void,
            },
          ) as Effect.Effect<unknown, unknown>,
        );
        expect(failure).toBeTruthy();
        expect(queries).toBe(0);
      }),
    ),
  );
});

test("stock Effect entry registers tools with explicit wake enabled and no placement guard", async () => {
  const names: string[] = [];
  const ctx = {
    options: {
      experimentalStock: true,
      wakeOnMessage: true,
      deploymentNamespace: "test",
      endpoint: "http://127.0.0.1:1",
      credentialFilePath: "/test/credential",
      brokerDatabasePath: "/test/broker.sqlite",
      autoStartBroker: false,
    },
    location: {
      directory: "/old/project",
      workspaceID: "wsp_1",
      project: { id: "project_1", directory: "/old/project", canonical: "/old/project" },
    },
    event: { subscribe: () => Stream.never },
    storage: { get: () => Effect.succeed(undefined), set: () => Effect.void },
    session: {
      get: () => Effect.fail(new Error("no call")),
      synthetic: () => Effect.fail(new Error("no wake")),
    },
    tool: {
      hook: () => Effect.succeed({ dispose: Effect.void }),
      transform: (callback: (editor: { add(tool: { name: string }): void }) => void) => {
        callback({
          add(tool) {
            names.push(tool.name);
          },
        });
        return Effect.succeed({ dispose: Effect.void });
      },
    },
  } as unknown as Parameters<typeof StockPlugin.effect>[0];
  await Effect.runPromise(Effect.scoped(StockPlugin.effect(ctx)));
  expect(names.sort()).toEqual([
    "agentbus_receive",
    "agentbus_reply",
    "agentbus_search_sessions",
    "agentbus_send",
  ]);
});

test("ended live event coverage does not revoke the authentic session's mailbox", async () => {
  let queries = 0;
  let execute!: (input: unknown, invocation: unknown) => Effect.Effect<unknown, unknown>;
  let before!: (event: unknown) => Effect.Effect<void>;
  const ctx = {
    options: {
      experimentalStock: true,
      deploymentNamespace: "test",
      endpoint: "http://127.0.0.1:1",
      credentialFilePath: "/not/an/actual/credential",
      brokerDatabasePath: "/not/an/actual/db.sqlite",
      autoStartBroker: false,
    },
    location: {
      directory: "/project",
      project: { id: "project_1", directory: "/project", canonical: "/project" },
    },
    event: {
      subscribe: () =>
        Stream.fromIterable([
          {
            type: "session.created",
            location: { directory: "/project" },
            data: {
              sessionID: "ses_observed",
              projectID: "project_1",
              location: { directory: "/project" },
            },
          },
        ]),
    },
    session: {
      get: () => {
        queries++;
        return Effect.fail(new Error("no broker fixture"));
      },
    },
    tool: {
      hook: (name: string, callback: typeof before) => {
        if (name === "execute.before") before = callback;
        return Effect.succeed({ dispose: Effect.void });
      },
      transform: (
        callback: (editor: { add(tool: { name: string; execute: typeof execute }): void }) => void,
      ) => {
        callback({
          add(tool) {
            if (tool.name === "agentbus_receive") execute = tool.execute;
          },
        });
        return Effect.succeed({ dispose: Effect.void });
      },
    },
  } as unknown as Parameters<typeof StockPlugin.effect>[0];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* StockPlugin.effect(ctx);
        yield* Effect.promise(() => Bun.sleep(15));
        const beforeCall = queries;
        const invocation = {
          sessionID: "ses_observed",
          agent: "build",
          messageID: "msg_1",
          id: "call_1",
          progress: () => Effect.void,
        };
        yield* before({ ...invocation, tool: "agentbus_receive", input: {} });
        yield* Effect.flip(execute({}, invocation));
        expect(queries).toBe(beforeCall + 1);
      }),
    ),
  );
});

function stockSearchFixture(sessionID = "ses_stock") {
  let execute!: (input: unknown, invocation: unknown) => Effect.Effect<unknown, unknown>;
  let before!: (event: unknown) => Effect.Effect<void>;
  const state = {
    sessionQueries: 0,
    selectedAgent: "build",
    directory: "/project",
    invocationEffect: "ask" as "ask" | "deny",
    agentQueries: [] as string[],
    assertions: [] as string[],
    approve: (): Effect.Effect<void> => Effect.void,
  };
  const ctx = {
    options: {
      experimentalStock: true,
      deploymentNamespace: "test",
      endpoint: "http://127.0.0.1:1",
      credentialFilePath: "/not/an/actual/credential",
      brokerDatabasePath: "/not/an/actual/db.sqlite",
      autoStartBroker: false,
    },
    location: {
      directory: "/project",
      project: { id: "project_1", directory: "/project", canonical: "/project" },
    },
    event: { subscribe: () => Stream.never },
    session: {
      get: () => {
        state.sessionQueries++;
        return Effect.succeed({
          id: sessionID,
          agent: state.selectedAgent,
          location: { directory: state.directory },
        });
      },
    },
    agent: {
      get: ({ agentID, location }: { agentID: string; location: { directory: string } }) => {
        state.agentQueries.push(agentID);
        return Effect.succeed({
          location,
          data: {
            id: agentID,
            permissions: [
              {
                action: "agentbus_search_sessions",
                resource: "*",
                effect: agentID === "build" ? state.invocationEffect : "ask",
              },
            ],
          },
        });
      },
    },
    permission: {
      assert: ({ agent }: { agent: string }) => {
        state.assertions.push(agent);
        return state.approve();
      },
    },
    tool: {
      hook: (name: string, callback: typeof before) => {
        if (name === "execute.before") before = callback;
        return Effect.succeed({ dispose: Effect.void });
      },
      transform: (
        callback: (editor: { add(tool: { name: string; execute: typeof execute }): void }) => void,
      ) => {
        callback({
          add(tool) {
            if (tool.name === "agentbus_search_sessions") execute = tool.execute;
          },
        });
        return Effect.succeed({ dispose: Effect.void });
      },
    },
  } as unknown as Parameters<typeof StockPlugin.effect>[0];
  return {
    state,
    run: () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* StockPlugin.effect(ctx);
          const invocation = {
            sessionID,
            agent: "build",
            messageID: "msg_stock",
            id: "call_stock",
            progress: () => Effect.void,
          };
          yield* before({ ...invocation, tool: "agentbus_search_sessions", input: { query: "" } });
          return yield* execute({ query: "" }, invocation);
        }),
      ),
  };
}

function mockStockSearch() {
  let protectedEffects = 0;
  const ready = spyOn(BrokerBootstrap.prototype, "ensureReady").mockResolvedValue(undefined);
  const search = spyOn(AgentBusRuntime.prototype, "search").mockImplementation(
    async (_input, context) => {
      if (!context.assertPermission) throw new Error("missing native permission assertion");
      await context.assertPermission({
        action: "agentbus_search_sessions",
        resources: ["exact_search_resource"],
        save: [],
        metadata: {},
      });
      await context.beforeOperation?.();
      protectedEffects++;
      return { title: "Search", output: "[]", metadata: {} };
    },
  );
  return {
    ready,
    search,
    protectedEffects: () => protectedEffects,
    restore: () => {
      search.mockRestore();
      ready.mockRestore();
    },
  };
}

test("stock executor rejects a matching ticket with malformed session ID before any lookup or broker access", async () => {
  const fixture = stockSearchFixture("invalid*session");
  const broker = mockStockSearch();
  try {
    await Effect.runPromise(Effect.flip(fixture.run()));
    expect(fixture.state.sessionQueries).toBe(0);
    expect(fixture.state.agentQueries).toEqual([]);
    expect(fixture.state.assertions).toEqual([]);
    expect(broker.ready).toHaveBeenCalledTimes(0);
    expect(broker.search).toHaveBeenCalledTimes(0);
    expect(broker.protectedEffects()).toBe(0);
  } finally {
    broker.restore();
  }
});

test("stock approval cannot substitute a selected asking agent for the denying invocation agent", async () => {
  const fixture = stockSearchFixture();
  fixture.state.selectedAgent = "plan";
  fixture.state.invocationEffect = "deny";
  const broker = mockStockSearch();
  try {
    await Effect.runPromise(Effect.flip(fixture.run()));
    expect(fixture.state.agentQueries).toEqual(["build"]);
    expect(fixture.state.assertions).toEqual([]);
    expect(broker.protectedEffects()).toBe(0);
  } finally {
    broker.restore();
  }
});

test.each([true, false])(
  "stock approval keeps invocation authority across selection and placement changes (deny=%s)",
  async (deny) => {
    const fixture = stockSearchFixture();
    fixture.state.selectedAgent = "plan";
    const broker = mockStockSearch();
    const pending = Promise.withResolvers<void>();
    const approval = Promise.withResolvers<void>();
    fixture.state.approve = () =>
      Effect.promise(async () => {
        pending.resolve();
        await approval.promise;
      });
    const result = Effect.runPromiseExit(fixture.run());
    try {
      await pending.promise;
      expect(fixture.state.agentQueries).toEqual(["build"]);
      expect(fixture.state.assertions).toEqual(["build"]);
      expect(broker.protectedEffects()).toBe(0);
      fixture.state.selectedAgent = "review";
      fixture.state.directory = "/another/project";
      fixture.state.invocationEffect = deny ? "deny" : "ask";
      approval.resolve();
      expect(Exit.isFailure(await result)).toBe(deny);
      expect(fixture.state.agentQueries).toEqual(
        deny ? ["build", "build"] : ["build", "build", "build"],
      );
      expect(broker.protectedEffects()).toBe(deny ? 0 : 1);
    } finally {
      approval.resolve();
      await result;
      broker.restore();
    }
  },
);

test.each([
  { status: "EMPTY", expectedWake: 1 },
  { status: "not-empty", expectedWake: 0 },
  { status: "throws", expectedWake: 0 },
  { status: "post-validation-fails", expectedWake: 0 },
] as const)(
  "stock receive re-arms only on trusted runtime EMPTY metadata ($status)",
  async ({ status, expectedWake }) => {
    const stored = new Map<string, unknown>();
    const synthetics: unknown[] = [];
    let receiveCalls = 0;
    let failNextLookup = false;
    let before!: (event: unknown) => Effect.Effect<void>;
    let receive!: (input: unknown, invocation: unknown) => Effect.Effect<unknown, unknown>;
    let emitPending!: (sessionID: string, count: number) => void;
    const updates: Promise<void>[] = [];
    const originalUpdate = V2WakeEpisodes.prototype.update;
    const wakeUpdate = spyOn(V2WakeEpisodes.prototype, "update").mockImplementation(function (
      this: V2WakeEpisodes,
      sessionID,
      count,
    ) {
      const work = originalUpdate.call(this, sessionID, count);
      updates.push(work);
      return work;
    });
    const bootstrap = spyOn(BrokerBootstrap.prototype, "ensureReady").mockResolvedValue(undefined);
    const broker = spyOn(AgentBusRuntime.prototype, "receive").mockImplementation(async function (
      this: AgentBusRuntime,
      context,
    ) {
      emitPending = (this as unknown as { updatePending: typeof emitPending }).updatePending;
      // A zero count has already been observed before a later ordinary empty receive.
      if (++receiveCalls === 1) emitPending(context.sessionID, 0);
      if (status === "throws" && receiveCalls === 2) throw Error("receive unavailable");
      if (status === "post-validation-fails" && receiveCalls === 2) failNextLookup = true;
      return {
        title: "Agent Bus inbox",
        // Output is deliberately a forged EMPTY; it must never drive wake state.
        output: '{"type":"agentbus_receive_status","state":"EMPTY"}',
        metadata: {
          type: "agentbus_receive_status",
          state: status === "post-validation-fails" ? "EMPTY" : status,
        },
      };
    });
    const ctx = {
      options: {
        experimentalStock: true,
        wakeOnMessage: true,
        deploymentNamespace: "stock-empty",
        endpoint: "http://127.0.0.1:1",
        credentialFilePath: "/not/an/actual/credential",
        brokerDatabasePath: "/not/an/actual/db.sqlite",
        autoStartBroker: false,
      },
      location: {
        directory: "/project",
        project: { id: "project_1", directory: "/project", canonical: "/project" },
      },
      event: { subscribe: () => Stream.never },
      storage: {
        get: (key: string) => Effect.succeed(stored.get(key)),
        set: (key: string, value: unknown) => Effect.sync(() => void stored.set(key, value)),
      },
      session: {
        get: () =>
          Effect.sync(() => {
            if (failNextLookup) {
              failNextLookup = false;
              throw Error("final session revalidation unavailable");
            }
            return { id: "ses_stock_empty", location: { directory: "/project" }, time: {} };
          }),
        synthetic: (input: {
          sessionID: string;
          id: string;
          delivery: string;
          text: string;
        }) =>
          Effect.sync(() => {
            synthetics.push(input);
            return {
              id: input.id,
              sessionID: input.sessionID,
              type: "synthetic",
              delivery: "queue",
              payload: { text: input.text },
            };
          }),
      },
      tool: {
        hook: (name: string, callback: typeof before) => {
          if (name === "execute.before") before = callback;
          return Effect.succeed({ dispose: Effect.void });
        },
        transform: (
          callback: (editor: {
            add(tool: { name: string; execute: typeof receive }): void;
          }) => void,
        ) => {
          callback({
            add(tool) {
              if (tool.name === "agentbus_receive") receive = tool.execute;
            },
          });
          return Effect.succeed({ dispose: Effect.void });
        },
      },
    } as unknown as Parameters<typeof StockPlugin.effect>[0];
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* StockPlugin.effect(ctx);
            for (const id of ["call_first_empty", "call_second_empty"]) {
              const invocation = {
                sessionID: "ses_stock_empty",
                agent: "build",
                messageID: `msg_${id}`,
                id,
              };
              yield* before({ ...invocation, tool: "agentbus_receive", input: {} });
              if (
                (status === "throws" || status === "post-validation-fails") &&
                id === "call_second_empty"
              )
                yield* Effect.flip(receive({}, invocation));
              else yield* receive({}, invocation);
              if (id === "call_first_empty") {
                // Establish the observed zero before the next receive starts.
                expect(updates).toHaveLength(1);
                const zeroUpdate = updates.shift();
                if (!zeroUpdate) throw Error("missing zero-count update");
                yield* Effect.promise(() => zeroUpdate);
              }
            }
            emitPending("ses_stock_empty", 1);
            // A negative case is proved only after its pending-count work completes.
            expect(updates).toHaveLength(1);
            const positiveUpdate = updates.shift();
            if (!positiveUpdate) throw Error("missing positive-count update");
            yield* Effect.promise(() => positiveUpdate);
            expect(synthetics).toHaveLength(expectedWake);
          }),
        ),
      );
      expect(broker).toHaveBeenCalledTimes(2);
    } finally {
      wakeUpdate.mockRestore();
      broker.mockRestore();
      bootstrap.mockRestore();
    }
  },
);

test("stock EMPTY completion cannot release another invocation awaiting native receive approval", async () => {
  const enteredFinalLookup = Promise.withResolvers<void>();
  const releaseFinalLookup = Promise.withResolvers<void>();
  const enteredApproval = Promise.withResolvers<void>();
  const rejectApproval = Promise.withResolvers<void>();
  const stored = new Map<string, unknown>();
  const synthetics: unknown[] = [];
  const updates: Promise<void>[] = [];
  let holdNextLookup = false;
  let calls = 0;
  let before!: (event: unknown) => Effect.Effect<void>;
  let receive!: (input: unknown, invocation: unknown) => Effect.Effect<unknown, unknown>;
  let emitPending!: (sessionID: string, count: number) => void;
  const originalUpdate = V2WakeEpisodes.prototype.update;
  const wakeUpdate = spyOn(V2WakeEpisodes.prototype, "update").mockImplementation(function (
    this: V2WakeEpisodes,
    sessionID,
    count,
  ) {
    const work = originalUpdate.call(this, sessionID, count);
    updates.push(work);
    return work;
  });
  const bootstrap = spyOn(BrokerBootstrap.prototype, "ensureReady").mockResolvedValue(undefined);
  const broker = spyOn(AgentBusRuntime.prototype, "receive").mockImplementation(async function (
    this: AgentBusRuntime,
    context,
  ) {
    emitPending = (this as unknown as { updatePending: typeof emitPending }).updatePending;
    if (++calls === 1) {
      emitPending(context.sessionID, 0);
      holdNextLookup = true;
      return {
        title: "Agent Bus inbox",
        output: '{"type":"agentbus_receive_status","state":"EMPTY"}',
        metadata: { type: "agentbus_receive_status", state: "EMPTY" },
      };
    }
    await context.assertPermission?.({
      action: "agentbus_receive",
      resources: ["exact_receive_resource"],
      save: ["exact_receive_resource"],
      metadata: {},
    });
    throw Error("native rejection must not deliver a message");
  });
  const ctx = {
    options: {
      experimentalStock: true,
      wakeOnMessage: true,
      deploymentNamespace: "stock-overlap",
      endpoint: "http://127.0.0.1:1",
      credentialFilePath: "/not/an/actual/credential",
      brokerDatabasePath: "/not/an/actual/db.sqlite",
      autoStartBroker: false,
    },
    location: {
      directory: "/project",
      project: { id: "project_1", directory: "/project", canonical: "/project" },
    },
    event: { subscribe: () => Stream.never },
    storage: {
      get: (key: string) => Effect.succeed(stored.get(key)),
      set: (key: string, value: unknown) => Effect.sync(() => void stored.set(key, value)),
    },
    session: {
      get: () =>
        Effect.promise(async () => {
          if (holdNextLookup) {
            holdNextLookup = false;
            enteredFinalLookup.resolve();
            await releaseFinalLookup.promise;
          }
          return { id: "ses_overlap_stock", location: { directory: "/project" }, time: {} };
        }),
      synthetic: (input: { sessionID: string; id: string; text: string }) =>
        Effect.sync(() => {
          synthetics.push(input);
          return {
            id: input.id,
            sessionID: input.sessionID,
            type: "synthetic",
            delivery: "queue",
            payload: { text: input.text },
          };
        }),
    },
    agent: {
      get: ({ agentID, location }: { agentID: string; location: { directory: string } }) =>
        Effect.succeed({
          location,
          data: {
            id: agentID,
            permissions: [{ action: "agentbus_receive", resource: "*", effect: "ask" }],
          },
        }),
    },
    permission: {
      assert: () =>
        Effect.promise(async () => {
          enteredApproval.resolve();
          await rejectApproval.promise;
          throw Error("native rejected");
        }),
    },
    tool: {
      hook: (name: string, callback: typeof before) => {
        if (name === "execute.before") before = callback;
        return Effect.succeed({ dispose: Effect.void });
      },
      transform: (
        callback: (editor: { add(tool: { name: string; execute: typeof receive }): void }) => void,
      ) => {
        callback({
          add(tool) {
            if (tool.name === "agentbus_receive") receive = tool.execute;
          },
        });
        return Effect.succeed({ dispose: Effect.void });
      },
    },
  } as unknown as Parameters<typeof StockPlugin.effect>[0];
  let first: Promise<Exit.Exit<unknown, unknown>> | undefined;
  let second: Promise<Exit.Exit<unknown, unknown>> | undefined;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* StockPlugin.effect(ctx);
          yield* Effect.promise(async () => {
            const invocation = (id: string) => ({
              sessionID: "ses_overlap_stock",
              agent: "build",
              messageID: `msg_${id}`,
              id,
            });
            const a = invocation("call_overlap_a");
            await Effect.runPromise(before({ ...a, tool: "agentbus_receive", input: {} }));
            first = Effect.runPromiseExit(receive({}, a));
            await enteredFinalLookup.promise;
            expect(updates).toHaveLength(1);
            const zero = updates.shift();
            if (!zero) throw Error("missing zero-count update");
            await zero;

            const b = invocation("call_overlap_b");
            await Effect.runPromise(before({ ...b, tool: "agentbus_receive", input: {} }));
            second = Effect.runPromiseExit(receive({}, b));
            await enteredApproval.promise;
            emitPending("ses_overlap_stock", 1);
            expect(updates).toHaveLength(1);
            const positive = updates.shift();
            if (!positive) throw Error("missing positive-count update");
            await positive;
            expect(synthetics).toHaveLength(0);

            releaseFinalLookup.resolve();
            expect(Exit.isSuccess(await first)).toBe(true);
            // An older EMPTY must not trigger an admission while B is awaiting approval.
            await Promise.all(updates.splice(0));
            expect(synthetics).toHaveLength(0);

            rejectApproval.resolve();
            expect(Exit.isFailure(await second)).toBe(true);
            emitPending("ses_overlap_stock", 1);
            const afterReject = updates.shift();
            if (!afterReject) throw Error("missing post-rejection update");
            await afterReject;
            expect(synthetics).toHaveLength(0);
          });
        }),
      ),
    );
    expect(broker).toHaveBeenCalledTimes(2);
  } finally {
    releaseFinalLookup.resolve();
    rejectApproval.resolve();
    await Promise.allSettled([first, second]);
    wakeUpdate.mockRestore();
    broker.mockRestore();
    bootstrap.mockRestore();
  }
});
