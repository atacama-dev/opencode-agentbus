import { expect, test } from "bun:test";
import { resolveV2Foreground } from "../src/host-v2";

function placement() {
  return {
    session: {
      id: "ses_older",
      projectID: "project_1",
      location: { directory: "/work/tree/sub" },
      title: "recipient",
    },
    location: {
      directory: "/work/tree/sub",
      project: { id: "project_1", directory: "/work/tree", canonical: "/canonical" },
    },
    agent: "build",
  };
}

test("V2 exact lookup does not rely on a discovery page and permits canonical/worktree divergence", async () => {
  const calls: string[] = [];
  const result = await resolveV2Foreground(
    {
      resolve: async ({ sessionID }) => {
        calls.push(sessionID);
        return placement();
      },
    },
    "ses_older",
    new AbortController().signal,
  );
  expect(calls).toEqual(["ses_older"]);
  expect(String(result.foreground.hostSessionId)).toBe("ses_older");
  expect(result.directory).toBe("/work/tree/sub");
});

for (const id of ["", "bad*id", "bad\n", "x".repeat(513)]) {
  test(`V2 malformed ID fails before trusted host lookup: ${JSON.stringify(id).slice(0, 30)}`, async () => {
    let called = false;
    await expect(
      resolveV2Foreground(
        {
          resolve: async () => {
            called = true;
            return placement();
          },
        },
        id,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
}

for (const mutate of [
  (value: ReturnType<typeof placement>) => {
    value.session.id = "ses_other";
  },
  (value: ReturnType<typeof placement>) => {
    value.session.projectID = "foreign";
  },
  (value: ReturnType<typeof placement>) => {
    value.location.directory = "/elsewhere";
  },
  (value: ReturnType<typeof placement>) => {
    value.location.project.directory = "/unrelated";
  },
  (value: ReturnType<typeof placement>) => {
    value.session.title = "bad\nmetadata";
  },
  (value: ReturnType<typeof placement>) => {
    value.agent = "";
  },
]) {
  test("V2 rejects mismatched/malformed exact host placement", async () => {
    const value = placement();
    mutate(value);
    await expect(
      resolveV2Foreground(
        { resolve: async () => value },
        "ses_older",
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
}

test("V2 aborted lookup cannot release authority", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await expect(
    resolveV2Foreground(
      {
        resolve: async () => {
          called = true;
          return placement();
        },
      },
      "ses_older",
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(called).toBe(false);
});

test("V2 foreground projection does not retain native permission or arbitrary session metadata", async () => {
  const value = placement();
  const result = await resolveV2Foreground(
    {
      resolve: async () => ({
        ...value,
        session: {
          ...value.session,
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
          metadata: { body: "fixture-session-metadata-body" },
        },
      }),
    },
    "ses_older",
    new AbortController().signal,
  );
  expect(result).not.toHaveProperty("placement");
  expect(JSON.stringify(result)).not.toContain("fixture-session-metadata-body");
  expect(JSON.stringify(result)).not.toContain("permissions");
});
