// Executed only inside an independently installed temporary consumer.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [packageName, line] = process.argv.slice(2);
if (!packageName || (line !== "v1" && line !== "v2")) throw new Error("Invalid probe arguments");
const require = createRequire(import.meta.url);
const root = require.resolve(packageName);
const cli = require.resolve("@opencode-agentbus/broker/cli", { paths: [root] });
if (
  !root.includes("/consumer/node_modules/") ||
  !cli.includes("/consumer/node_modules/") ||
  !(statSync(cli).mode & 0o100) ||
  !readFileSync(cli, "utf8").startsWith("#!/usr/bin/env bun\n")
)
  throw new Error(
    `Installed broker CLI is missing or not executable: ${root}, ${cli}, ${statSync(cli).mode.toString(8)}`,
  );
const plugin = await import(pathToFileURL(root).href);
if (Object.keys(plugin).join(",") !== "default") throw new Error("Unexpected plugin exports");
if (line === "v1" && typeof plugin.default !== "function")
  throw new Error("V1 default async factory missing");
if (
  line === "v2" &&
  (plugin.default?.id !== "agentbus-stock-experimental" ||
    typeof plugin.default.effect !== "function")
)
  throw new Error("V2 stock Effect definition missing");
if (line === "v2") {
  const { Effect, Stream } = await import(
    pathToFileURL(require.resolve("effect", { paths: [root] })).href
  );
  const names: string[] = [];
  const context = {
    options: {
      experimentalStock: true,
      deploymentNamespace: "package_probe",
      endpoint: "http://127.0.0.1:1",
      credentialFilePath: "/unused/credential",
      brokerDatabasePath: "/unused/broker.sqlite",
      autoStartBroker: false,
      focusOnReceiveApproval: false,
    },
    location: {
      directory: "/probe",
      workspaceID: "wsp_probe",
      project: { id: "project_probe", directory: "/probe", canonical: "/probe" },
    },
    event: { subscribe: () => Stream.never },
    session: { get: () => Effect.fail(new Error("No session query expected")) },
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
  };
  await Effect.runPromise(Effect.scoped(plugin.default.effect(context)));
  if (
    names.sort().join(",") !==
    "agentbus_receive,agentbus_reply,agentbus_search_sessions,agentbus_send"
  )
    throw new Error("Installed V2 did not register only the four model tools");
}
const state = join(import.meta.dir, "isolated-state");
mkdirSync(state, { mode: 0o700 });
const broker = await import(pathToFileURL(cli).href);
const daemon = await broker.launchBrokerDaemon(
  {
    databasePath: join(state, "broker.sqlite"),
    credentialFilePath: join(state, "credential.json"),
    hostname: "127.0.0.1",
    port: 0,
    maxActiveSessionsPerPrincipal: 300,
  },
  { info() {}, warn() {}, error() {} },
);
try {
  const response = await fetch(`${daemon.endpoint}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (response.status !== 401 || !existsSync(join(state, "credential.json")))
    throw new Error("Broker auth boundary unavailable");
  if (line === "v1") {
    const options = {
      endpoint: daemon.endpoint,
      credentialFilePath: join(state, "credential.json"),
      autoStartBroker: false,
      timeoutMs: 500,
      maxActiveSessionsPerPrincipal: 300,
    };
    const host = (id: string, title: string) => ({
      client: {
        session: {
          list: async () => ({
            data: [
              {
                id,
                projectID: "smoke_project",
                directory: state,
                title,
                version: "1.18.19",
                time: { created: 1, updated: 1 },
              },
            ],
          }),
          status: async () => ({ data: { [id]: { type: "idle" } } }),
        },
        project: {
          current: async () => ({
            data: { id: "smoke_project", worktree: state, time: { created: 1 } },
          }),
        },
        tui: { showToast: async () => ({ data: true }), publish: async () => ({ data: true }) },
      },
      directory: state,
      worktree: state,
      serverUrl: new URL(daemon.endpoint),
      project: { id: "smoke_project", worktree: state, time: { created: 1 } },
      experimental_workspace: { register() {} },
      $: {},
    });
    const hooksA = await plugin.default(host("installed_host_a", "Installed A"), options);
    const hooksB = await plugin.default(host("installed_host_b", "Installed B"), options);
    try {
      const approvalsA: string[] = [];
      const approvalsB: string[] = [];
      const ctx = (id: string, approvals: string[]) => ({
        sessionID: id,
        messageID: `message_${id}`,
        agent: "build",
        directory: state,
        worktree: state,
        abort: new AbortController().signal,
        metadata() {},
        ask: async (request: { permission: string }) => {
          approvals.push(request.permission);
        },
      });
      const a = ctx("installed_host_a", approvalsA);
      const b = ctx("installed_host_b", approvalsB);
      const tool = async (
        hooks: typeof hooksA,
        name: string,
        args: object,
        context: typeof a,
      ): Promise<Record<string, unknown>> =>
        JSON.parse((await hooks.tool[name].execute(args, context)).output);
      const retry = async <T>(action: () => Promise<T>): Promise<T> => {
        let failure: unknown;
        for (let n = 0; n < 120; n++) {
          try {
            return await action();
          } catch (error) {
            failure = error;
            await Bun.sleep(25);
          }
        }
        throw failure;
      };
      const handle = await retry(async () => {
        const result = await tool(
          hooksA,
          "agentbus_search_sessions",
          { query: "Installed B", limit: 1 },
          a,
        );
        const matches = result.matches as Array<{ handle?: unknown }> | undefined;
        if (typeof matches?.[0]?.handle !== "string") throw new Error("No recipient");
        return matches[0].handle;
      });
      const sent = await tool(
        hooksA,
        "agentbus_send",
        { target: handle, body: "A to B", ttlSeconds: 60 },
        a,
      );
      if (typeof sent.messageId !== "string" || "body" in sent)
        throw new Error("Invalid send receipt");
      const received = await retry(() => tool(hooksB, "agentbus_receive", {}, b));
      if (received.messageId !== sent.messageId || received.body !== "A to B")
        throw new Error("Receive mismatch");
      const reply = await tool(
        hooksB,
        "agentbus_reply",
        { messageId: received.messageId, body: "B to A", ttlSeconds: 60 },
        b,
      );
      if (
        reply.messageId === sent.messageId ||
        reply.replyToMessageId !== sent.messageId ||
        "body" in reply
      )
        throw new Error("Invalid reply receipt");
      const returned = await retry(() => tool(hooksA, "agentbus_receive", {}, a));
      if (
        returned.messageId !== reply.messageId ||
        returned.replyToMessageId !== sent.messageId ||
        returned.body !== "B to A"
      )
        throw new Error("Return mismatch");
      if (
        !approvalsA.includes("agentbus_search_sessions") ||
        !approvalsA.includes("agentbus_receive") ||
        !approvalsB.includes("agentbus_receive")
      )
        throw new Error("Fixture approval hooks missing");
    } finally {
      await Promise.all([hooksA.dispose?.(), hooksB.dispose?.()]);
    }
  }
} finally {
  await daemon.stop();
}
console.log(`Installed ${line} archive fixture passed (not real native host acceptance)`);
