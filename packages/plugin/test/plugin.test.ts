import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { PluginInput } from "@opencode-ai/plugin";

import AgentBusPlugin from "../src/index";
import * as SourceRootModule from "../src/index";
import { pendingToastPayload } from "../src/plugin";

function pluginInput(): PluginInput {
  return {
    client: {
      session: {
        list: async () => ({ data: [] }),
      },
      tui: {
        showToast: async () => ({ data: true }),
      },
    },
    directory: "/worktree",
    worktree: "/worktree",
    serverUrl: new URL("http://127.0.0.1:4096"),
    project: { id: "project_01" },
    experimental_workspace: { register: () => undefined },
    $: {},
  } as unknown as PluginInput;
}

describe("OpenCode plugin export", () => {
  test("exports a valid plugin function with only the three custom model-facing tools", async () => {
    expect(typeof AgentBusPlugin).toBe("function");
    const hooks = await AgentBusPlugin(pluginInput(), {
      credentialFilePath: "/does/not/connect/until/a/tool/runs",
    });
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
      "agentbus_receive",
      "agentbus_search_sessions",
      "agentbus_send",
    ]);
    expect(hooks).not.toHaveProperty("mcp");
    expect(hooks.dispose).toBeFunction();
    expect(hooks.event).toBeFunction();
    await hooks.dispose?.();
  });

  test("source and loader-shaped built package roots export default only", async () => {
    expect(Object.keys(SourceRootModule)).toEqual(["default"]);
    const directory = await mkdtemp(join(import.meta.dir, ".agentbus-plugin-build-"));
    try {
      const result = await Bun.build({
        entrypoints: [join(import.meta.dir, "..", "src", "index.ts")],
        outdir: directory,
        format: "esm",
        target: "bun",
        packages: "external",
        naming: "index.js",
      });
      expect(result.success).toBe(true);
      const built = (await import(
        `${pathToFileURL(join(directory, "index.js")).href}?loader-test`
      )) as {
        readonly default: typeof AgentBusPlugin;
      };
      expect(Object.keys(built)).toEqual(["default"]);
      const hooks = await built.default(pluginInput(), {
        credentialFilePath: "/does/not/connect/with/an/empty-bootstrap",
      });
      expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
        "agentbus_receive",
        "agentbus_search_sessions",
        "agentbus_send",
      ]);
      await hooks.dispose?.();

      let stalledListCalls = 0;
      const stalledInput = {
        ...pluginInput(),
        client: {
          session: {
            list: () => {
              stalledListCalls += 1;
              return new Promise<never>(() => undefined);
            },
          },
          tui: { showToast: async () => ({ data: true }) },
        },
      } as unknown as PluginInput;
      const stalledHooks = await Promise.race([
        built.default(stalledInput, {
          credentialFilePath: "/does/not/connect/while/session-list-is-pending",
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("loader-shaped plugin initialization timed out")), 100),
        ),
      ]);
      expect(stalledListCalls).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stalledListCalls).toBe(1);
      await Promise.race([
        stalledHooks.dispose?.(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("loader-shaped plugin disposal timed out")), 100),
        ),
      ]);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  test("product source contains no prompt, synthetic, raw MCP registration, or indirect injection APIs", async () => {
    const sourceDirectory = join(import.meta.dir, "..", "src");
    const files = (await readdir(sourceDirectory)).filter((name) => name.endsWith(".ts"));
    const source = (
      await Promise.all(files.map((name) => readFile(join(sourceDirectory, name), "utf8")))
    ).join("\n");
    for (const forbidden of [
      ".prompt(",
      ".promptAsync(",
      ".synthetic(",
      "appendPrompt(",
      "submitPrompt(",
      "session.messages(",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).not.toContain("mcp:");
    expect(source).not.toContain("console.");
    expect(source).not.toContain("app.log");
  });

  test("toast content is fixed and accepts only a trusted pending count", () => {
    expect(pendingToastPayload(1)).toEqual({
      title: "Agent Bus",
      message: "1 pending peer message.",
      variant: "info",
    });
    expect(pendingToastPayload(3)).toEqual({
      title: "Agent Bus",
      message: "3 pending peer messages.",
      variant: "info",
    });
    expect(JSON.stringify(pendingToastPayload(Number.NaN))).not.toContain("NaN");
    expect(JSON.stringify(pendingToastPayload(2))).not.toContain("sender");
    expect(JSON.stringify(pendingToastPayload(2))).not.toContain("title from peer");
  });
});
