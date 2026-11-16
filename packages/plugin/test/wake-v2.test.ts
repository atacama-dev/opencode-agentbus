import { expect, test } from "bun:test";
import { V2WakeEpisodes, FIXED_V2_WAKE_TEXT } from "../src/wake-v2";

test("a new pending episode during wake cooldown is retried without another broker hint", async () => {
  const state = new Map<string, unknown>();
  let ids = 0;
  let admissions = 0;
  const wake = new V2WakeEpisodes({
    namespace: "cooldown",
    enabled: true,
    cooldownMs: 30,
    storage: {
      get: async (key) => state.get(key),
      set: async (key, value) => {
        state.set(key, value);
      },
    },
    createID: () => `msg_${++ids}`,
    activity: async () => [],
    resolve: async () => true,
    admit: async (input) => {
      admissions++;
      return {
        id: input.id,
        sessionID: input.sessionID,
        type: "synthetic",
        delivery: "queue",
        payload: { text: FIXED_V2_WAKE_TEXT },
      };
    },
  });
  try {
    await wake.update("ses_cooldown", 1);
    await wake.update("ses_cooldown", 0);
    await wake.update("ses_cooldown", 1);
    for (let i = 0; i < 40 && admissions < 2; i++) await Bun.sleep(10);
    expect(admissions).toBe(2);
  } finally {
    wake.dispose();
  }
});

test("fixed queue episode persists before submission, validates ack, and never replays after reload", async () => {
  const state = new Map<string, unknown>();
  const calls: unknown[] = [];
  const episodes = new V2WakeEpisodes({
    namespace: "test-host",
    enabled: true,
    storage: {
      get: async (key) => state.get(key),
      set: async (key, value) => {
        state.set(key, value);
      },
    },
    createID: () => "msg_episode",
    activity: async () => [],
    resolve: async () => true,
    admit: async (input) => {
      expect([...state.values()][0]).toMatchObject({ state: "submitting" });
      calls.push(input);
      return {
        id: input.id,
        sessionID: input.sessionID,
        type: "synthetic",
        delivery: "queue",
        payload: { text: FIXED_V2_WAKE_TEXT },
      };
    },
  });
  await episodes.update("ses_one", 1);
  expect(calls).toEqual([
    {
      sessionID: "ses_one",
      id: "msg_episode",
      text: FIXED_V2_WAKE_TEXT,
      delivery: "queue",
      resume: true,
    },
  ]);
  await episodes.update("ses_one", 2);
  expect(calls).toHaveLength(1);
  const reloaded = new V2WakeEpisodes({
    ...episodes.options,
    admit: async () => {
      throw new Error("must never replay");
    },
  });
  await reloaded.update("ses_one", 1);
  expect(calls).toHaveLength(1);
});

test("mismatched acknowledgement becomes uncertain and suppresses replay", async () => {
  const state = new Map<string, unknown>();
  let attempts = 0;
  const episodes = new V2WakeEpisodes({
    namespace: "test",
    enabled: true,
    storage: {
      get: async (key) => state.get(key),
      set: async (key, value) => {
        state.set(key, value);
      },
    },
    createID: () => "msg_uncertain",
    activity: async () => [],
    resolve: async () => true,
    admit: async () => {
      attempts++;
      return { type: "synthetic", id: "wrong" };
    },
  });
  await episodes.update("ses_one", 1);
  await episodes.update("ses_one", 1);
  expect(attempts).toBe(1);
  expect([...state.values()][0]).toMatchObject({ state: "uncertain" });
});

test("unknown activity, busy, and receive latch defer; disabled default performs no writes", async () => {
  let writes = 0;
  let admissions = 0;
  const options = {
    namespace: "test",
    enabled: false,
    storage: {
      get: async () => undefined,
      set: async () => {
        writes++;
      },
    },
    createID: () => "msg_one",
    activity: async () => ["ses_one"],
    resolve: async () => true,
    admit: async () => {
      admissions++;
    },
  };
  await new V2WakeEpisodes(options).update("ses_one", 1);
  const busy = new V2WakeEpisodes({ ...options, enabled: true });
  await busy.update("ses_one", 1);
  const unknown = new V2WakeEpisodes({
    ...options,
    enabled: true,
    activity: async () => {
      throw new Error("unknown");
    },
  });
  await unknown.update("ses_one", 1);
  expect(writes).toBe(0);
  expect(admissions).toBe(0);
});

test("receive remains latched through rejection until authoritative empty; activity retries are bounded", async () => {
  const state = new Map<string, unknown>();
  let calls = 0;
  let admissions = 0;
  let idle = false;
  const episodes = new V2WakeEpisodes({
    namespace: "test",
    enabled: true,
    storage: {
      get: async (key) => state.get(key),
      set: async (key, value) => {
        state.set(key, value);
      },
    },
    createID: () => "msg_latched",
    resolve: async () => true,
    activity: async () => {
      calls++;
      if (!idle) throw new Error("unknown");
      return [];
    },
    admit: async (input) => {
      admissions++;
      return {
        id: input.id,
        sessionID: input.sessionID,
        type: "synthetic",
        delivery: "queue",
        payload: { text: FIXED_V2_WAKE_TEXT },
      };
    },
  });
  for (let i = 0; i < 8; i++) await episodes.update("ses_one", 1);
  expect(calls).toBe(3);
  const receiving = episodes.beginReceive("ses_one");
  episodes.endReceive("ses_one", receiving);
  idle = true;
  episodes.refreshActivity("ses_one");
  await episodes.update("ses_one", 1);
  expect(admissions).toBe(0);
  await episodes.update("ses_one", 0);
  await episodes.update("ses_one", 1);
  expect(admissions).toBe(1);
});

test("trusted empty receive rearms a zero-count latch without rewriting pending counts", async () => {
  const state = new Map<string, unknown>();
  let admissions = 0;
  const episodes = new V2WakeEpisodes({
    namespace: "empty-rearm",
    enabled: true,
    storage: {
      get: async (key) => state.get(key),
      set: async (key, value) => {
        state.set(key, value);
      },
    },
    createID: () => "msg_empty_rearm",
    activity: async () => [],
    resolve: async () => true,
    admit: async (input) => {
      admissions++;
      return {
        id: input.id,
        sessionID: input.sessionID,
        type: "synthetic",
        delivery: "queue",
        payload: { text: FIXED_V2_WAKE_TEXT },
      };
    },
  });
  try {
    episodes.beginReceive("ses_empty_rearm");
    await episodes.update("ses_empty_rearm", 0);
    const receiving = episodes.beginReceive("ses_empty_rearm");
    episodes.endReceive("ses_empty_rearm", receiving, true);
    await episodes.update("ses_empty_rearm", 1);
    expect(admissions).toBe(1);
  } finally {
    episodes.dispose();
  }
});

test("empty receive racing a newer positive observation wakes without replacing its count", async () => {
  const state = new Map<string, unknown>();
  const admitted = Promise.withResolvers<void>();
  let admissions = 0;
  const episodes = new V2WakeEpisodes({
    namespace: "empty-race",
    enabled: true,
    storage: {
      get: async (key) => state.get(key),
      set: async (key, value) => {
        state.set(key, value);
        if (value.state === "admitted") admitted.resolve();
      },
    },
    createID: () => "msg_empty_race",
    activity: async () => [],
    resolve: async () => true,
    admit: async (input) => {
      admissions++;
      return {
        id: input.id,
        sessionID: input.sessionID,
        type: "synthetic",
        delivery: "queue",
        payload: { text: FIXED_V2_WAKE_TEXT },
      };
    },
  });
  try {
    episodes.beginReceive("ses_empty_race");
    await episodes.update("ses_empty_race", 0);
    const receiving = episodes.beginReceive("ses_empty_race");
    await episodes.update("ses_empty_race", 1);
    expect(admissions).toBe(0);
    episodes.endReceive("ses_empty_race", receiving, true);
    await Promise.race([
      admitted.promise,
      Bun.sleep(100).then(() => {
        throw new Error("new pending count was not woken after empty receive");
      }),
    ]);
    expect(admissions).toBe(1);
    expect(state.get("agentbus/episodes/v1/empty-race/ses_empty_race")).toMatchObject({
      state: "admitted",
    });
  } finally {
    episodes.dispose();
  }
});

test("an older EMPTY acknowledgement cannot release a newer receive's latch", async () => {
  const state = new Map<string, unknown>();
  let admissions = 0;
  const episodes = new V2WakeEpisodes({
    namespace: "overlapping-receives",
    enabled: true,
    storage: {
      get: async (key) => state.get(key),
      set: async (key, value) => {
        state.set(key, value);
      },
    },
    createID: () => "msg_overlap",
    activity: async () => [],
    resolve: async () => true,
    admit: async (input) => {
      admissions++;
      return {
        id: input.id,
        sessionID: input.sessionID,
        type: "synthetic",
        delivery: "queue",
        payload: { text: FIXED_V2_WAKE_TEXT },
      };
    },
  });
  try {
    const first = episodes.beginReceive("ses_overlap");
    const second = episodes.beginReceive("ses_overlap");
    await episodes.update("ses_overlap", 1);
    expect(admissions).toBe(0);
    episodes.endReceive("ses_overlap", first, true);
    await episodes.update("ses_overlap", 1);
    expect(admissions).toBe(0);
    episodes.endReceive("ses_overlap", second); // a denied receive is still latched
    await episodes.update("ses_overlap", 1);
    expect(admissions).toBe(0);
    episodes.endReceive("ses_overlap", second, true);
    await episodes.update("ses_overlap", 1);
    expect(admissions).toBe(1);
  } finally {
    episodes.dispose();
  }
});

test("a delayed zero observation cannot clear a receive started after that observation", async () => {
  const state = new Map<string, unknown>();
  const enteredZeroGet = Promise.withResolvers<void>();
  const releaseZeroGet = Promise.withResolvers<void>();
  let firstGet = true;
  let admissions = 0;
  const episodes = new V2WakeEpisodes({
    namespace: "delayed-zero",
    enabled: true,
    storage: {
      get: async (key) => {
        if (firstGet) {
          firstGet = false;
          enteredZeroGet.resolve();
          await releaseZeroGet.promise;
        }
        return state.get(key);
      },
      set: async (key, value) => {
        state.set(key, value);
      },
    },
    createID: () => "msg_delayed_zero",
    activity: async () => [],
    resolve: async () => true,
    admit: async (input) => {
      admissions++;
      return {
        id: input.id,
        sessionID: input.sessionID,
        type: "synthetic",
        delivery: "queue",
        payload: { text: FIXED_V2_WAKE_TEXT },
      };
    },
  });
  let zero: Promise<void> | undefined;
  let positive: Promise<void> | undefined;
  try {
    episodes.beginReceive("ses_delayed_zero");
    zero = episodes.update("ses_delayed_zero", 0);
    await enteredZeroGet.promise;
    const current = episodes.beginReceive("ses_delayed_zero");
    positive = episodes.update("ses_delayed_zero", 1);
    releaseZeroGet.resolve();
    await Promise.all([zero, positive]);
    expect(admissions).toBe(0);
    episodes.endReceive("ses_delayed_zero", current);
    await episodes.update("ses_delayed_zero", 1);
    expect(admissions).toBe(0);
    episodes.endReceive("ses_delayed_zero", current, true);
    await episodes.update("ses_delayed_zero", 1);
    expect(admissions).toBe(1);
  } finally {
    releaseZeroGet.resolve();
    await Promise.allSettled([zero, positive]);
    episodes.dispose();
  }
});

for (const state of ["unknown", "projected", "pending"] as const) {
  test(`reload reconciliation ${state} never re-admits an old synthetic ID`, async () => {
    const stored = {
      version: 1,
      sessionID: "ses_one",
      id: "msg_frozen",
      text: FIXED_V2_WAKE_TEXT,
      delivery: "queue",
      state: "submitting",
      admittedAt: 0,
    };
    let result: unknown;
    let admissions = 0;
    const episodes = new V2WakeEpisodes({
      namespace: "test",
      enabled: true,
      storage: {
        get: async () => stored,
        set: async (_key, value) => {
          result = value;
        },
      },
      createID: () => "msg_new",
      activity: async () => [],
      resolve: async () => true,
      admit: async () => {
        admissions++;
      },
      reconcile: async (input) => {
        expect(input.id).toBe("msg_frozen");
        return state === "pending"
          ? {
              state,
              item: {
                sessionID: "ses_one",
                id: "msg_frozen",
                type: "synthetic",
                delivery: "queue",
                payload: { text: FIXED_V2_WAKE_TEXT },
              },
            }
          : { state };
      },
    });
    await episodes.update("ses_one", 1);
    expect(admissions).toBe(0);
    expect(result).toMatchObject({
      state: state === "pending" ? "admitted" : "uncertain",
      id: "msg_frozen",
    });
  });
}

for (const initial of ["prepared", "submitting", "uncertain"] as const) {
  test(`unreconciled ${initial} wake remains held after the mailbox drains and refills`, async () => {
    let stored = {
      version: 1 as const,
      sessionID: "ses_one",
      id: "msg_unconfirmed",
      text: FIXED_V2_WAKE_TEXT,
      delivery: "queue" as const,
      state: initial as "prepared" | "submitting" | "uncertain" | "admitted" | "closed",
      admittedAt: 0,
    };
    let admissions = 0;
    const episodes = new V2WakeEpisodes({
      namespace: "uncertain-refill",
      enabled: true,
      storage: {
        get: async () => stored,
        set: async (_key, value) => {
          stored = value;
        },
      },
      createID: () => "msg_new",
      resolve: async () => true,
      activity: async () => [],
      admit: async () => {
        admissions++;
      },
    });
    await episodes.update("ses_one", 0);
    await episodes.update("ses_one", 1);
    expect(admissions).toBe(0);
    expect(stored).toMatchObject({ id: "msg_unconfirmed", state: "uncertain" });
    episodes.dispose();
  });
}

for (const boundary of ["resolve", "prepared", "submitting"] as const) {
  test(`removed wake generation at held ${boundary} never admits or resurrects work`, async () => {
    let release!: () => void;
    let entered = false;
    let admissions = 0;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = new Map<string, unknown>();
    const episodes = new V2WakeEpisodes({
      namespace: "review",
      enabled: true,
      storage: {
        get: async (key) => state.get(key),
        set: async (key, value) => {
          state.set(key, value);
          if (boundary === value.state) {
            entered = true;
            await barrier;
          }
        },
      },
      createID: () => "msg_review",
      activity: async () => [],
      resolve: async () => {
        if (boundary === "resolve") {
          entered = true;
          await barrier;
        }
        return true;
      },
      admit: async () => {
        admissions++;
        return undefined;
      },
    });
    const work = episodes.update("ses_removed", 1);
    for (let attempt = 0; !entered && attempt < 100; attempt++) await Bun.sleep(1);
    expect(entered).toBe(true);
    episodes.removeSession("ses_removed");
    release();
    await work;
    expect(admissions).toBe(0);
    episodes.dispose();
  });
}
