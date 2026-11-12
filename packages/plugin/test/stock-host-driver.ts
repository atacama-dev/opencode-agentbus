// Manual, isolated-only stock V2 acceptance probe. Not part of CI or release evidence.
import { mkdirSync } from "node:fs";
import { OpenCode } from "@opencode/client";
import { stockTestAuthorization, stockTestConfig } from "./stock-test-config";

const config = stockTestConfig();
const client = OpenCode.make({
  baseUrl: String(config.serverUrl),
  headers: { Authorization: stockTestAuthorization(config.serverLog) },
});
const location = { directory: config.directory };
const events: Array<{ type: string; data?: unknown }> = [];
const details = (event: { data?: unknown }) =>
  event.data as { sessionID?: string; message?: string; error?: unknown } | undefined;
const controller = new AbortController();
const listener = (async () => {
  try {
    for await (const event of client.event.subscribe({ signal: controller.signal }))
      events.push(event);
  } catch {
    /* test cancellation */
  }
})();
async function waitFor<T>(
  label: string,
  get: () => Promise<T | undefined> | T | undefined,
): Promise<T> {
  for (let attempt = 0; attempt < 180; attempt++) {
    const value = await get();
    if (value !== undefined) return value;
    await Bun.sleep(100);
  }
  throw new Error(
    `timed out: ${label}; events=${JSON.stringify(events.map((e) => e.type).slice(-15))}`,
  );
}
try {
  await waitFor("plugin loaded", async () => {
    const plugins = await client.plugin.list({ location });
    return plugins.data.find(
      (plugin) => plugin.id === "agentbus-stock-experimental" && plugin.state.status === "active",
    );
  });
  const A = await client.session.create({ title: "fixture sender", location });
  const recipientTitle = `fixture recipient ${crypto.randomUUID()}`;
  const B = await client.session.create({ title: recipientTitle, location });
  console.log("isolated sessions created", A.id, B.id);
  await Bun.sleep(350);
  const output = (event: { data?: unknown }) => {
    const data = event.data as { content?: Array<{ text?: string }> };
    return JSON.parse(data.content?.map((part) => part.text ?? "").join("") ?? "") as {
      matches?: Array<{ metadata?: { title?: string }; handle?: string }>;
      messageId?: string;
      replyToMessageId?: string;
      body?: string;
      trust?: string;
    };
  };
  const invoke = async (sessionID: string, tool: string, args: unknown) => {
    const after = events.length;
    await client.session.prompt({ sessionID, text: `BUS_TEST ${JSON.stringify({ tool, args })}` });
    return after;
  };
  const success = (sessionID: string, after: number) =>
    waitFor("tool success", () => {
      const own = events.slice(after).filter((event) => details(event)?.sessionID === sessionID);
      const failed = own.find((event) => event.type === "session.tool.failed");
      if (failed) throw new Error(`native tool failed: ${JSON.stringify(details(failed)?.error)}`);
      return own.find((event) => event.type === "session.tool.success");
    });
  const permission = (sessionID: string, action: string) =>
    waitFor("native approval", async () =>
      (await client.permission.list({ sessionID })).find((item) => item.action === action),
    );
  const after = await invoke(A.id, "agentbus_search_sessions", { query: recipientTitle });
  const request = await waitFor("native search approval", async () => {
    const pending = await client.permission.list({ sessionID: A.id });
    return pending.find((item) => item.action === "agentbus_search_sessions");
  }).catch((error) => {
    const failed = events.slice(after).filter((event) => event.type === "session.tool.failed");
    throw new Error(
      `${String(error)}; tool-failures=${JSON.stringify(failed.map((event) => details(event)?.error ?? details(event)?.message))}`,
    );
  });
  console.log(
    "native search approval",
    request.action,
    request.source?.type,
    request.resources.length,
    request.save?.length,
  );
  await client.permission.reply({ sessionID: A.id, requestID: request.id, decision: "once" });
  const result = output(await success(A.id, after));
  const target = result.matches?.find(
    (match: { metadata?: { title?: string } }) => match.metadata?.title === recipientTitle,
  )?.handle;
  if (typeof target !== "string")
    throw new Error("stock search did not find second native host session");
  console.log("native stock search matched second host session");
  const body = "local-fixture-body-not-a-secret";
  const sentAfter = await invoke(A.id, "agentbus_send", { target, body });
  const sent = output(await success(A.id, sentAfter));
  if ("body" in sent || typeof sent.messageId !== "string")
    throw new Error("invalid body-free send receipt");
  const receiveAfter = await invoke(B.id, "agentbus_receive", {});
  const receiveApproval = await permission(B.id, "agentbus_receive");
  if (
    JSON.stringify(receiveApproval).includes(body) ||
    receiveApproval.source?.type !== "tool" ||
    JSON.stringify(receiveApproval.resources) !== JSON.stringify(receiveApproval.save)
  )
    throw new Error("receive authorization disclosed body or lost exact resource");
  if (
    events
      .slice(receiveAfter)
      .some((event) => event.type === "session.tool.success" && details(event)?.sessionID === B.id)
  )
    throw new Error("receive completed before approval");
  console.log("native receive pending before body, exact save resource");
  await client.permission.reply({
    sessionID: B.id,
    requestID: receiveApproval.id,
    decision: "once",
  });
  const received = output(await success(B.id, receiveAfter));
  if (
    received.body !== body ||
    received.messageId !== sent.messageId ||
    received.trust !== "untrusted"
  )
    throw new Error("approved untrusted receive mismatch");
  const replyAfter = await invoke(B.id, "agentbus_reply", {
    messageId: received.messageId,
    body: "local-fixture-return",
  });
  const reply = output(await success(B.id, replyAfter));
  if (
    reply.replyToMessageId !== received.messageId ||
    reply.messageId === received.messageId ||
    "body" in reply
  )
    throw new Error("invalid body-free correlated reply receipt");
  const returnAfter = await invoke(A.id, "agentbus_receive", {});
  const returnApproval = await permission(A.id, "agentbus_receive");
  await client.permission.reply({
    sessionID: A.id,
    requestID: returnApproval.id,
    decision: "once",
  });
  const returned = output(await success(A.id, returnAfter));
  if (returned.body !== "local-fixture-return" || returned.replyToMessageId !== received.messageId)
    throw new Error("approved return delivery mismatch");
  console.log("native stock send/approved receive/correlated reply/approved return succeeded");

  const sentAgain = await invoke(A.id, "agentbus_send", { target, body: "same-pair-first" });
  await success(A.id, sentAgain);
  const alwaysAfter = await invoke(B.id, "agentbus_receive", {});
  const alwaysApproval = await permission(B.id, "agentbus_receive");
  await client.permission.reply({
    sessionID: B.id,
    requestID: alwaysApproval.id,
    decision: "always",
  });
  if (output(await success(B.id, alwaysAfter)).body !== "same-pair-first")
    throw new Error("first always-approved delivery mismatch");
  const sentSaved = await invoke(A.id, "agentbus_send", { target, body: "same-pair-saved" });
  await success(A.id, sentSaved);
  const savedAfter = await invoke(B.id, "agentbus_receive", {});
  if (
    output(await success(B.id, savedAfter)).body !== "same-pair-saved" ||
    (await client.permission.list({ sessionID: B.id })).some(
      (item) => item.action === "agentbus_receive",
    )
  )
    throw new Error("native exact saved always approval not reused");
  console.log("native exact-pair always approval reused without second prompt");

  const C = await client.session.create({ title: "fixture different source", location });
  await Bun.sleep(350);
  const sentOther = await invoke(C.id, "agentbus_send", {
    target,
    body: "separate-pair-stays-pending",
  });
  await success(C.id, sentOther);
  const rejectedAfter = await invoke(B.id, "agentbus_receive", {});
  const rejected = await permission(B.id, "agentbus_receive");
  if (rejected.resources[0] === alwaysApproval.resources[0])
    throw new Error("saved pair leaked into different source's permission resource");
  await client.permission.reply({ sessionID: B.id, requestID: rejected.id, decision: "reject" });
  await Bun.sleep(350);
  if (
    events
      .slice(rejectedAfter)
      .some((event) => event.type === "session.tool.success" && details(event)?.sessionID === B.id)
  )
    throw new Error("plain rejected peer body was consumed");
  console.log(
    "plain rejection did not disclose different-source message",
    events
      .slice(rejectedAfter)
      .filter((event) => event.type.startsWith("session.execution."))
      .map((event) => event.type),
  );

  const feedbackAfter = await invoke(B.id, "agentbus_receive", {});
  const corrected = await permission(B.id, "agentbus_receive");
  await client.permission.reply({
    sessionID: B.id,
    requestID: corrected.id,
    decision: "reject",
    message: "Fixture correction; do not disclose.",
  });
  await Bun.sleep(350);
  if (
    events
      .slice(feedbackAfter)
      .some((event) => event.type === "session.tool.success" && details(event)?.sessionID === B.id)
  )
    throw new Error("feedback rejection consumed peer body");
  console.log(
    "feedback rejection did not disclose peer body",
    events
      .slice(feedbackAfter)
      .filter((event) => event.type.startsWith("session.execution."))
      .map((event) => event.type),
  );
  const movedDirectory = `${location.directory}/moved`;
  mkdirSync(movedDirectory, { recursive: true });
  const movedAfter = await invoke(B.id, "agentbus_receive", {});
  const movingApproval = await permission(B.id, "agentbus_receive");
  await client.session.move({ sessionID: B.id, directory: movedDirectory });
  await waitFor("move queued before approval", () =>
    events
      .slice(movedAfter)
      .find(
        (event) =>
          event.type === "session.inbox.enqueued" &&
          details(event)?.sessionID === B.id &&
          (details(event) as { item?: { type?: string } } | undefined)?.item?.type === "move",
      ),
  );
  await client.permission.reply({
    sessionID: B.id,
    requestID: movingApproval.id,
    decision: "once",
  });
  if (output(await success(B.id, movedAfter)).body !== "separate-pair-stays-pending")
    throw new Error("approved recipient lost queued message during move");
  console.log("pending move preserved approved recipient delivery");

  const D = await client.session.create({ title: "fixture pre-call move", location });
  await Bun.sleep(350);
  const movedBefore = events.length;
  await client.session.move({ sessionID: D.id, directory: movedDirectory });
  await waitFor("pre-call native move", () =>
    events
      .slice(movedBefore)
      .find((event) => event.type === "session.moved" && details(event)?.sessionID === D.id),
  );
  const foreignAfter = await invoke(D.id, "agentbus_search_sessions", { query: "recipient" });
  const movedSearch = await permission(D.id, "agentbus_search_sessions");
  await client.permission.reply({ sessionID: D.id, requestID: movedSearch.id, decision: "once" });
  await success(D.id, foreignAfter);
  console.log("moved caller retained native search approval and mailbox identity");

  const FTitle = `fixture interrupted recipient ${crypto.randomUUID()}`;
  const E = await client.session.create({ title: "fixture interruption sender", location });
  const F = await client.session.create({ title: FTitle, location });
  await Bun.sleep(350);
  const findAfter = await invoke(E.id, "agentbus_search_sessions", { query: FTitle });
  const findApproval = await permission(E.id, "agentbus_search_sessions");
  await client.permission.reply({ sessionID: E.id, requestID: findApproval.id, decision: "once" });
  const FTarget = output(await success(E.id, findAfter)).matches?.find(
    (match) => match.metadata?.title === FTitle,
  )?.handle;
  if (!FTarget) throw new Error("interruption target not found");
  const interruptSend = await invoke(E.id, "agentbus_send", {
    target: FTarget,
    body: "interrupted-body-not-secret",
  });
  await success(E.id, interruptSend);
  const interruptAfter = await invoke(F.id, "agentbus_receive", {});
  await permission(F.id, "agentbus_receive");
  await client.session.interrupt({ sessionID: F.id });
  await Bun.sleep(400);
  if (
    events
      .slice(interruptAfter)
      .some((event) => event.type === "session.tool.success" && details(event)?.sessionID === F.id)
  )
    throw new Error("interrupted receive consumed peer body");
  console.log("interrupted pending receive did not disclose body");
  const G = await client.session.create({
    title: "fixture misconfigured allow",
    location,
    permissions: [{ action: "agentbus_search_sessions", resource: "*", effect: "allow" }],
  });
  await Bun.sleep(300);
  const allowAfter = await invoke(G.id, "agentbus_search_sessions", { query: "recipient" });
  await waitFor("configured allow fails closed", () =>
    events
      .slice(allowAfter)
      .find((event) => event.type === "session.tool.failed" && details(event)?.sessionID === G.id),
  );
  if (
    (await client.permission.list({ sessionID: G.id })).some(
      (item) => item.action === "agentbus_search_sessions",
    ) ||
    events
      .slice(allowAfter)
      .some((event) => event.type === "session.tool.success" && details(event)?.sessionID === G.id)
  )
    throw new Error("configured allow bypassed Agent Bus search policy gate");
  console.log("configured allow overriding ask fails closed");
} finally {
  controller.abort();
  await listener;
}
