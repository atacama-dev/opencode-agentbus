import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { PluginInput } from "@opencode-ai/plugin";

import AgentBusPlugin from "../src/index";
import * as SourceRootModule from "../src/index";
import { BrokerBootstrap } from "../src/broker-bootstrap";
import { OPERATOR_ERRORS, BrokerProtocolMismatchError } from "../src/errors";
import {
  createAgentBusPlugin,
  pendingToastPayload,
  protocolUpgradeToastPayload,
} from "../src/plugin";
import type { AgentBusRuntime } from "../src/runtime";
import { credentialSnapshot } from "./helpers";

function pluginInput(): PluginInput {
  return {
    client: {
      session: {
        list: async () => ({ data: [] }),
      },
      tui: {
        showToast: async () => ({ data: true }),
        publish: async () => ({ data: true }),
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
  test("uses fixed operator-only protocol-upgrade guidance", () => {
    expect(protocolUpgradeToastPayload()).toEqual({
      title: "Agent Bus upgrade required",
      message: OPERATOR_ERRORS.PROTOCOL_MISMATCH,
      variant: "error",
    });
  });

  test("reports one fixed v1 upgrade toast in manual mode without probing, launching, or calling the runtime", async () => {
    const input = pluginInput();
    Object.assign(input.client, {
      session: {
        list: async () => ({
          data: [
            {
              id: "host_manual",
              projectID: "project_01",
              directory: "/worktree",
              title: "Manual",
            },
          ],
        }),
      },
      project: {
        current: async () => ({
          data: { id: "project_01", worktree: "/worktree", time: { created: 1 } },
        }),
      },
    });
    const toasts: unknown[] = [];
    const tui = input.client.tui as unknown as {
      showToast: (request: unknown) => Promise<unknown>;
    };
    tui.showToast = async (request) => {
      toasts.push(structuredClone(request));
      return { data: true };
    };
    let probes = 0;
    let launches = 0;
    let runtimeCalls = 0;
    const plugin = createAgentBusPlugin({
      brokerBootstrapFactory: (config, _environment, reportOperatorError: () => void) =>
        new BrokerBootstrap(config, {
          readCredential: async () => credentialSnapshot(),
          authenticate: async () => {
            throw new BrokerProtocolMismatchError();
          },
          probeEndpoint: async () => {
            probes += 1;
            return "occupied";
          },
          launchBroker: () => {
            launches += 1;
            return undefined;
          },
          reportOperatorError,
        }),
      runtimeFactory: () =>
        ({
          receive: async () => {
            runtimeCalls += 1;
            return { title: "unexpected", output: "unexpected", metadata: {} };
          },
          dispose: async () => undefined,
        }) as unknown as AgentBusRuntime,
      bootstrapScheduler: {
        set: () => ({ unref: () => undefined }) as unknown as ReturnType<typeof setTimeout>,
        clear: () => undefined,
      },
    });
    const hooks = await plugin(input, {
      credentialFilePath: "/trusted/manual-credential.json",
      autoStartBroker: false,
    });
    const receive = hooks.tool?.agentbus_receive;
    if (!receive) throw new Error("Missing receive tool.");
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          receive.execute({}, {
            sessionID: "host_manual",
            directory: "/worktree",
            worktree: "/worktree",
          } as never),
        ).rejects.toThrow("Agent Bus is unavailable.");
      }
      await Promise.resolve();
      expect(toasts).toEqual([
        {
          body: protocolUpgradeToastPayload(),
          query: { directory: "/worktree" },
        },
      ]);
      expect(probes).toBe(0);
      expect(launches).toBe(0);
      expect(runtimeCalls).toBe(0);
    } finally {
      await hooks.dispose?.();
    }
  });

  test("exports a valid plugin function with only the four custom model-facing tools", async () => {
    expect(typeof AgentBusPlugin).toBe("function");
    const hooks = await AgentBusPlugin(pluginInput(), {
      credentialFilePath: "/does/not/connect/until/a/tool/runs",
      autoStartBroker: false,
    });
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
      "agentbus_receive",
      "agentbus_reply",
      "agentbus_search_sessions",
      "agentbus_send",
    ]);
    expect(hooks).not.toHaveProperty("mcp");
    expect(hooks.dispose).toBeFunction();
    expect(hooks.event).toBeFunction();
    await hooks.dispose?.();
  });

  test("exposes direct-reply and sent-message correlation instructions in tool descriptions", async () => {
    const hooks = await AgentBusPlugin(pluginInput(), {
      credentialFilePath: "/does/not/connect/until/a/tool/runs",
      autoStartBroker: false,
    });
    try {
      const receive = hooks.tool?.agentbus_receive;
      const reply = hooks.tool?.agentbus_reply;
      const send = hooks.tool?.agentbus_send;
      const search = hooks.tool?.agentbus_search_sessions;
      if (!receive || !reply || !send || !search) {
        throw new Error("Agent Bus tool definitions are missing");
      }
      for (const definition of [receive, reply, send, search]) {
        expect(definition.args).not.toHaveProperty("sessionID");
        expect(definition.args).not.toHaveProperty("directory");
        expect(definition.args).not.toHaveProperty("worktree");
      }

      const receiveDescription = receive.description;
      expect(receiveDescription).toContain("peer_message");
      expect(receiveDescription).toContain("source.sessionId");
      expect(receiveDescription).toMatch(/opaque direct-send target handle/i);
      expect(receiveDescription).not.toMatch(/reply handle/i);
      expect(receiveDescription).toMatch(/prefer[\s\S]*agentbus_reply/i);
      expect(receiveDescription).toMatch(/agentbus_reply[\s\S]*messageId/i);
      expect(receiveDescription).toMatch(/agentbus_send[\s\S]*target[\s\S]*source\.sessionId/i);
      for (const forbiddenTarget of ["messageId", "fingerprint", "title", "message body"]) {
        expect(receiveDescription).toMatch(
          new RegExp(`do not use[\\s\\S]*${forbiddenTarget}[\\s\\S]*as target`, "i"),
        );
      }

      const sendDescription = send.description;
      expect(sendDescription).toContain("peer_message");
      expect(sendDescription).toContain("source.sessionId");
      expect(sendDescription).toMatch(/target[\s\S]*source\.sessionId/i);
      expect(sendDescription).toMatch(/without (?:a )?registry search/i);
      expect(sendDescription).toMatch(/otherwise[\s\S]*approved search/i);
      expect(sendDescription).toMatch(/receipt[\s\S]*newly sent message[\s\S]*messageId/i);
      expect(sendDescription).toMatch(/retain[\s\S]*reference[\s\S]*correlation/i);

      const replyDescription = reply.description;
      expect(replyDescription).toContain("messageId");
      expect(replyDescription).toMatch(/delivered[\s\S]*message[\s\S]*(being answered|original)/i);
      expect(replyDescription).toMatch(/broker[\s\S]*original source/i);
      expect(replyDescription).toMatch(/without[\s\S]*(session|registry) search/i);
      expect(replyDescription).toMatch(/receipt[\s\S]*new[\s\S]*messageId/i);
      expect(replyDescription).toMatch(/replyToMessageId[\s\S]*original/i);
      const replyMessageIdDescription =
        (reply.args.messageId as { readonly description?: string } | undefined)?.description ?? "";
      expect(replyMessageIdDescription).toMatch(/original[\s\S]*delivered message/i);
      expect(replyMessageIdDescription).toMatch(/not[\s\S]*new reply/i);

      const sendTargetDescription =
        (send.args.target as { readonly description?: string } | undefined)?.description ?? "";
      expect(sendTargetDescription).toContain("source.sessionId");
      expect(sendTargetDescription).toMatch(/received peer_message/i);
      expect(sendTargetDescription).toMatch(/target[\s\S]*source\.sessionId/i);
      expect(sendTargetDescription).toMatch(/without (?:a )?registry search/i);
      expect(sendTargetDescription).toMatch(/otherwise[\s\S]*approved search/i);

      const searchDescription = search.description;
      expect(searchDescription).toContain("source.sessionId");
      expect(searchDescription).toMatch(/unnecessary[\s\S]*replying[\s\S]*received peer_message/i);
      expect(searchDescription).toMatch(/already available/i);
    } finally {
      await hooks.dispose?.();
    }
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
        autoStartBroker: false,
      });
      expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
        "agentbus_receive",
        "agentbus_reply",
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
          autoStartBroker: false,
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("loader-shaped plugin initialization timed out")), 100),
        ),
      ]);
      expect(stalledListCalls).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stalledListCalls).toBe(0);
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

  test("product source delegates the single fixed wake and contains no other injection APIs", async () => {
    const sourceDirectory = join(import.meta.dir, "..", "src");
    const files = (await readdir(sourceDirectory)).filter((name) => name.endsWith(".ts"));
    const source = (
      await Promise.all(files.map((name) => readFile(join(sourceDirectory, name), "utf8")))
    ).join("\n");
    expect(source.match(/\.promptAsync\(/gu)).toHaveLength(1);
    for (const forbidden of [
      ".prompt(",
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

  test("focuses and warns only for native agentbus_receive approval when explicitly enabled", async () => {
    const publishes: unknown[] = [];
    const toasts: unknown[] = [];
    const callbacks: Array<() => void> = [];
    const input = pluginInput();
    const tui = input.client.tui as unknown as {
      publish: (request: unknown) => Promise<unknown>;
      showToast: (request: unknown) => Promise<unknown>;
    };
    tui.publish = async (request) => {
      publishes.push(structuredClone(request));
      return { data: true };
    };
    tui.showToast = async (request) => {
      toasts.push(structuredClone(request));
      return { data: true };
    };
    const plugin = createAgentBusPlugin({
      runtimeFactory: () =>
        ({
          upsertHostSession: async () => undefined,
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
    const permission = (type: string, sessionID: string) =>
      ({
        id: "permission_01",
        type,
        sessionID,
        messageID: "message_01",
        title: "peer-derived title must not be displayed",
        metadata: { peer: "peer-derived metadata must not be displayed" },
        time: { created: 1 },
      }) as never;

    const disabled = await plugin(input, {
      credentialFilePath: "/trusted/credential",
      autoStartBroker: false,
    });
    const disabledOutput = { status: "ask" as const };
    await disabled["permission.ask"]?.(
      permission("agentbus_receive", "host_disabled"),
      disabledOutput,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(publishes).toEqual([]);
    expect(toasts).toEqual([]);
    expect(disabledOutput).toEqual({ status: "ask" });
    await disabled.dispose?.();

    const enabled = await plugin(input, {
      credentialFilePath: "/trusted/credential",
      autoStartBroker: false,
      focusOnReceiveApproval: true,
    });
    const unrelatedOutput = { status: "deny" as const };
    await enabled["permission.ask"]?.(
      permission("agentbus_search_sessions", "host_unrelated"),
      unrelatedOutput,
    );
    expect(publishes).toEqual([]);
    expect(toasts).toEqual([]);
    expect(unrelatedOutput).toEqual({ status: "deny" });

    const alreadyAllowedOutput = { status: "allow" as const };
    await enabled["permission.ask"]?.(
      permission("agentbus_receive", "host_already_allowed"),
      alreadyAllowedOutput,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(publishes).toEqual([]);
    expect(toasts).toEqual([]);
    expect(alreadyAllowedOutput).toEqual({ status: "allow" });

    const receiveOutput = { status: "ask" as const };
    await enabled.event?.({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: "host_child_requester",
            projectID: "project_01",
            directory: "/worktree",
            title: "Child",
            version: "1.18.19",
            time: { created: 1, updated: 1 },
          },
        },
      },
    });
    await enabled["permission.ask"]?.(
      permission("agentbus_receive", "host_child_requester"),
      receiveOutput,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(publishes).toEqual([
      {
        body: {
          type: "tui.session.select",
          properties: { sessionID: "host_child_requester" },
        },
        query: { directory: "/worktree" },
      },
    ]);
    expect(toasts).toEqual([
      {
        body: {
          title: "Agent Bus approval",
          message: "Agent Bus receive approval is waiting in this session.",
          variant: "warning",
          duration: 300_000,
        },
        query: { directory: "/worktree" },
      },
    ]);
    expect(JSON.stringify({ publishes, toasts })).not.toContain("peer-derived");
    expect(receiveOutput).toEqual({ status: "ask" });

    tui.publish = async (request) => {
      publishes.push(structuredClone(request));
      throw new Error("private TUI route failure");
    };
    const fallbackOutput = { status: "ask" as const };
    await enabled.event?.({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: "host_fallback",
            projectID: "project_01",
            directory: "/worktree",
            title: "Fallback",
            version: "1.18.19",
            time: { created: 1, updated: 1 },
          },
        },
      },
    });
    await enabled["permission.ask"]?.(
      permission("agentbus_receive", "host_fallback"),
      fallbackOutput,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(publishes.at(-1)).toMatchObject({
      body: { properties: { sessionID: "host_fallback" } },
    });
    expect(toasts.at(-1)).toMatchObject({
      body: {
        title: "Agent Bus approval",
        message: "Agent Bus receive approval is waiting in this session.",
        variant: "warning",
        duration: 300_000,
      },
    });
    expect(fallbackOutput).toEqual({ status: "ask" });
    await enabled.dispose?.();
  });
});
