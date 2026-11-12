import { expect, test } from "bun:test";
import { verifyStockForeground, hasNativeAskPolicy } from "../src/stock-v2-authority";

const session = {
  id: "ses_stock",
  projectID: "project_1",
  location: { directory: "/project/worktree" },
  title: "Hello",
  agent: "build",
};

test("stock identity remains the same after a project move", () => {
  const found = verifyStockForeground(session, "ses_stock");
  expect(String(found.hostSessionId)).toBe("ses_stock");
  const movedSession = {
    ...session,
    projectID: "project_2",
    location: { directory: "/another/project" },
  };
  const moved = verifyStockForeground(movedSession, "ses_stock");
  expect(moved).toEqual(found);
  for (const invalid of [
    { ...session, id: "ses_other" },
    { ...session, title: "\u0000unsafe" },
  ])
    expect(() => verifyStockForeground(invalid, "ses_stock")).toThrow();
  expect(() => verifyStockForeground(session, "invalid*id")).toThrow();
});

test("stock approval policy must be native ask after configured rules, not default wildcard allow", () => {
  const ask = { action: "agentbus_receive", resource: "*", effect: "ask" } as const;
  const deny = { action: "agentbus_receive", resource: "blocked*", effect: "deny" } as const;
  const allow = { action: "agentbus_receive", resource: "*", effect: "allow" } as const;
  expect(
    hasNativeAskPolicy(
      [{ action: "*", resource: "*", effect: "allow" }, ask],
      [],
      "agentbus_receive",
      "source_target",
    ),
  ).toBe(true);
  expect(hasNativeAskPolicy([allow], [], "agentbus_receive", "source_target")).toBe(false);
  expect(hasNativeAskPolicy([ask], [deny], "agentbus_receive", "blocked_src")).toBe(false);
  expect(hasNativeAskPolicy([ask], [allow], "agentbus_receive", "source_target")).toBe(false);
  expect(hasNativeAskPolicy([ask], [], "agentbus_search_sessions", "query")).toBe(false);
});
