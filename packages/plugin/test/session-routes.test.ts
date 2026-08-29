import { describe, expect, test } from "bun:test";

import { TrustedSessionRouteMap } from "../src/session-routes";

describe("trusted session route map", () => {
  test("routes attached workspaces independently and refreshes lifecycle directories", () => {
    const routes = new TrustedSessionRouteMap(4);
    routes.setForeground("host_a", { directory: "/workspace/A", worktree: "/workspace" });
    routes.setForeground("host_b", { directory: "/workspace/B", worktree: "/workspace" });

    expect(routes.directory("host_a")).toBe("/workspace/A");
    expect(routes.directory("host_b")).toBe("/workspace/B");
    routes.setLifecycle("host_a", "/workspace/A-renamed");
    expect(routes.directory("host_a")).toBe("/workspace/A-renamed");
    expect(routes.worktree("host_a")).toBe("/workspace");
  });

  test("is bounded, refreshes recency, and cleans deletion and disposal state", () => {
    const routes = new TrustedSessionRouteMap(2);
    routes.setLifecycle("host_old", "/workspace/old");
    routes.setLifecycle("host_kept", "/workspace/kept");
    routes.setLifecycle("host_old", "/workspace/old-refreshed");
    routes.setLifecycle("host_new", "/workspace/new");

    expect(routes.size).toBe(2);
    expect(routes.directory("host_old")).toBe("/workspace/old-refreshed");
    expect(routes.directory("host_kept")).toBeUndefined();
    expect(routes.directory("host_new")).toBe("/workspace/new");

    routes.delete("host_old");
    expect(routes.directory("host_old")).toBeUndefined();
    routes.clear();
    expect(routes.size).toBe(0);
  });
});
