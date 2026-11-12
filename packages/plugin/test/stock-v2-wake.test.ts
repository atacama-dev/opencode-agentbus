import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createStockWake } from "../src/stock-v2-wake";
import { FIXED_V2_WAKE_TEXT } from "../src/wake-v2";

test("public session-directed synthetic wake uses only fixed text, queue/resume, exact session and coalesces", async () => {
  const state = new Map<string, unknown>();
  const admissions: unknown[] = [];
  let currentDirectory = "/old/project";
  const wake = createStockWake({
    namespace: "stock-test",
    enabled: true,
    storage: {
      get: (key: string) => Effect.succeed(state.get(key)),
      set: (key: string, value: unknown) =>
        Effect.sync(() => {
          state.set(key, value);
        }),
    },
    session: {
      get: ({ sessionID }: { sessionID: string }) =>
        Effect.succeed({
          id: sessionID,
          location: { directory: currentDirectory },
          time: { busy: 1, idle: 2 },
        }),
      synthetic: (input: {
        sessionID: string;
        id: string;
        text: string;
        delivery: string;
        resume: boolean;
      }) =>
        Effect.sync(() => {
          admissions.push(input);
          return {
            id: input.id,
            sessionID: input.sessionID,
            type: "synthetic",
            delivery: "queue",
            payload: { text: input.text },
          };
        }),
    },
  });
  await wake.update("ses_one", 1);
  currentDirectory = "/different/project";
  await wake.update("ses_one", 2);
  expect(admissions).toHaveLength(1);
  expect(admissions[0]).toMatchObject({
    sessionID: "ses_one",
    text: FIXED_V2_WAKE_TEXT,
    delivery: "queue",
    resume: true,
  });
  expect(JSON.stringify(admissions)).not.toContain("/old/project");
  expect(JSON.stringify(admissions)).not.toContain("/different/project");
  wake.dispose();
});

test("missing recipient fails closed and busy recipient defers without synthetic admission", async () => {
  let exists = false;
  let idle = false;
  let admissions = 0;
  const storage = new Map<string, unknown>();
  const wake = createStockWake({
    namespace: "lifecycle",
    enabled: true,
    storage: {
      get: (key: string) => Effect.succeed(storage.get(key)),
      set: (key: string, value: unknown) =>
        Effect.sync(() => {
          storage.set(key, value);
        }),
    },
    session: {
      get: ({ sessionID }: { sessionID: string }) =>
        exists
          ? Effect.succeed({ id: sessionID, time: { busy: 3, idle: idle ? 4 : 2 } })
          : Effect.fail(new Error("deleted")),
      synthetic: (input: { sessionID: string; id: string; text: string; delivery: string }) =>
        Effect.sync(() => {
          admissions++;
          return {
            id: input.id,
            sessionID: input.sessionID,
            type: "synthetic",
            delivery: input.delivery,
            payload: { text: input.text },
          };
        }),
    },
  });
  try {
    await wake.update("ses_missing", 1);
    exists = true;
    await wake.update("ses_missing", 1);
    expect(admissions).toBe(0);
    idle = true;
    wake.refreshActivity("ses_missing");
    await wake.update("ses_missing", 1);
    expect(admissions).toBe(1);
  } finally {
    wake.dispose();
  }
});
