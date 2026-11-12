import { expect, test } from "bun:test";
import {
  METHODS,
  ForegroundSessionSchema,
  PROTOCOL_VERSION,
  bodySha256,
  receivePermissionResource,
} from "@opencode-agentbus/protocol";
import { AgentBusRuntime } from "../src/runtime";
import {
  CONFIG,
  MockChannel,
  MockEventStream,
  credentialSnapshot,
  canonicalForHost,
  identity,
  NOW,
  LATER,
} from "./helpers";

test("native search waits for successful assertion and preserves decline object unchanged", async () => {
  const channels: MockChannel[] = [];
  const runtime = new AgentBusRuntime({
    config: CONFIG,
    readCredential: async () => credentialSnapshot(),
    channelFactory: (input) => {
      const channel = new MockChannel(input);
      channels.push(channel);
      return channel;
    },
    eventStreamFactory: () => new MockEventStream(),
  });
  let reject!: (error: unknown) => void;
  let requested = false;
  const decline = { _tag: "Permission.DeclinedError" };
  const assertion = new Promise<void>((_, fail) => {
    reject = fail;
  });
  const context = {
    sessionID: "ses_native",
    directory: "/project",
    worktree: "/project",
    ask: async () => {
      throw new Error("legacy ask must not run");
    },
    assertPermission: async (policy: { action: string; save?: readonly string[] }) => {
      expect(policy.action).toBe("agentbus_search_sessions");
      expect(policy.save).toEqual([]);
      requested = true;
      await assertion;
    },
  };
  const foreground = ForegroundSessionSchema.parse({
    hostSessionId: context.sessionID,
    metadata: { title: "native" },
  });
  const result = runtime.search({ query: "recipient" }, context, foreground);
  for (let index = 0; index < 100 && !requested; index++) await Bun.sleep(1);
  expect(requested).toBe(true);
  expect(
    channels
      .flatMap((channel) => channel.calls)
      .filter((call) => call.method === METHODS.SEARCH_SESSIONS),
  ).toHaveLength(0);
  reject(decline);
  expect(await result.catch((error) => error)).toBe(decline);
  expect(
    channels
      .flatMap((channel) => channel.calls)
      .filter((call) => call.method === METHODS.SEARCH_SESSIONS),
  ).toHaveLength(0);
  await runtime.dispose();
});

for (const outcome of ["decline", "correction", "cancel", "stale-generation", "allow"] as const) {
  test(`native receive ${outcome}: exact policy, no preapproval consume, unchanged control`, async () => {
    const target = canonicalForHost("ses_native");
    const source = identity("peer_native");
    const body = "native test peer content";
    const header = {
      messageId: "message_native",
      source,
      target,
      bodyHash: bodySha256(body),
      bodyBytes: Buffer.byteLength(body),
      state: "PENDING",
      enqueuedAt: NOW,
      expiresAt: LATER,
    };
    const calls: string[] = [];
    const runtime = new AgentBusRuntime({
      config: CONFIG,
      readCredential: async () => credentialSnapshot(),
      eventStreamFactory: () => new MockEventStream(),
      channelFactory: (input) => {
        const channel = new MockChannel(input);
        channel.overrideResponse = (request, fallback) => {
          calls.push(request.method);
          if (request.method === METHODS.LIST_PENDING_MESSAGES)
            return {
              protocolVersion: PROTOCOL_VERSION,
              requestId: request.requestId,
              ok: true,
              result: { target, requestedLimit: request.params.limit, headers: [header] },
            };
          if (request.method === METHODS.PEEK_NEXT_MESSAGE)
            return {
              protocolVersion: PROTOCOL_VERSION,
              requestId: request.requestId,
              ok: true,
              result: { header },
            };
          if (request.method === METHODS.CONSUME_MESSAGE)
            return {
              protocolVersion: PROTOCOL_VERSION,
              requestId: request.requestId,
              ok: true,
              result: {
                messageId: header.messageId,
                source,
                target,
                bodyHash: header.bodyHash,
                bodyBytes: header.bodyBytes,
                body,
                state: "DELIVERED",
                deliveredAt: LATER,
              },
            };
          return fallback;
        };
        return channel;
      },
    });
    const controller = new AbortController();
    const control = {
      _tag: outcome === "correction" ? "Permission.CorrectedError" : "Permission.DeclinedError",
    };
    const context = {
      sessionID: "ses_native",
      directory: "/project",
      worktree: "/project",
      signal: controller.signal,
      ask: async () => {
        throw new Error("legacy ask forbidden");
      },
      assertPermission: async (policy: {
        action: string;
        resources: readonly string[];
        save: readonly string[];
        metadata: Readonly<Record<string, unknown>>;
      }) => {
        expect(policy.action).toBe("agentbus_receive");
        expect(policy.resources).toEqual([receivePermissionResource(target, source)]);
        expect(policy.save).toEqual(policy.resources);
        expect(JSON.stringify(policy.metadata)).not.toContain(body);
        expect(calls).not.toContain(METHODS.CONSUME_MESSAGE);
        if (outcome === "decline" || outcome === "correction") throw control;
        if (outcome === "cancel") controller.abort(control);
        if (outcome === "stale-generation") await runtime.dispose();
      },
    };
    const result = await runtime
      .receive(
        context,
        ForegroundSessionSchema.parse({ hostSessionId: context.sessionID, metadata: {} }),
      )
      .catch((error) => error);
    if (outcome === "allow") {
      expect(calls.filter((method) => method === METHODS.CONSUME_MESSAGE)).toHaveLength(1);
      expect(result.output).toContain('"trust":"untrusted"');
    } else {
      expect(calls).not.toContain(METHODS.CONSUME_MESSAGE);
      if (outcome !== "stale-generation") expect(result).toBe(control);
    }
    await runtime.dispose();
  });
}

for (const operation of ["send", "reply"] as const) {
  test(`native pre-aborted ${operation} cannot start broker work and preserves interruption`, async () => {
    let opened = 0;
    const runtime = new AgentBusRuntime({
      config: CONFIG,
      readCredential: async () => {
        opened++;
        return credentialSnapshot();
      },
      channelFactory: (input) => new MockChannel(input),
      eventStreamFactory: () => new MockEventStream(),
    });
    const controller = new AbortController();
    const interruption = { _tag: "Native.Interrupted" };
    controller.abort(interruption);
    const context = {
      sessionID: "ses_native",
      directory: "/project",
      worktree: "/project",
      signal: controller.signal,
      ask: async () => undefined,
    };
    const foreground = ForegroundSessionSchema.parse({
      hostSessionId: context.sessionID,
      metadata: {},
    });
    const result =
      operation === "send"
        ? runtime.send({ target: "target", body: "fixture" }, context, foreground)
        : runtime.reply({ messageId: "message_parent", body: "fixture" }, context, foreground);
    expect(await result.catch((error) => error)).toBe(interruption);
    expect(opened).toBe(0);
    await runtime.dispose();
  });
}
