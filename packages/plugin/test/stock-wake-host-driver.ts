// Manual actual-public-host wake acceptance; isolated test credentials and ports only.
import { OpenCode } from "@opencode/client";
import { FIXED_V2_WAKE_TEXT } from "../src/wake-v2";
import { stockTestAuthorization, stockTestConfig } from "./stock-test-config";

const config = stockTestConfig(process.env, true);
const client = OpenCode.make({
  baseUrl: String(config.serverUrl),
  headers: { Authorization: stockTestAuthorization(config.serverLog) },
});
const location = { directory: config.directory };
const providerMetrics = async () =>
  (await (await fetch(`${String(config.providerUrl)}/__metrics`)).json()) as {
    wakeRequests: number;
    wakeBodySeen: number;
    warningSeen: number;
    wakeResultBodySeen: number;
  };
const events: Array<{ type: string; data?: unknown }> = [];
const controller = new AbortController();
const work = (async () => {
  try {
    for await (const event of client.event.subscribe({ signal: controller.signal }))
      events.push(event);
  } catch {
    /* test cleanup */
  }
})();
const data = (event: { data?: unknown }) => event.data as Record<string, unknown> | undefined;
const wait = async <T>(
  name: string,
  check: () => Promise<T | undefined> | T | undefined,
): Promise<T> => {
  for (let i = 0; i < 200; i++) {
    const value = await check();
    if (value !== undefined) return value;
    await Bun.sleep(100);
  }
  throw new Error(
    `timed out: ${name}; recent=${JSON.stringify(events.slice(-10).map((event) => event.type))}`,
  );
};
const output = (event: { data?: unknown }) => {
  const content = data(event)?.content as Array<{ text: string }>;
  return JSON.parse(content.map((part) => part.text).join("")) as Record<string, unknown>;
};
const success = (id: string, after: number) =>
  wait("tool success", () => {
    const matching = events.slice(after).filter((e) => data(e)?.sessionID === id);
    const failed = matching.find((e) => e.type === "session.tool.failed");
    if (failed) throw new Error(`tool failed: ${JSON.stringify(data(failed)?.error)}`);
    return matching.find((e) => e.type === "session.tool.success");
  });
try {
  const metricsBefore = await providerMetrics();
  await wait("plugin active", async () =>
    (await client.plugin.list({ location })).data.find(
      (p) => p.id === "agentbus-stock-experimental" && p.state.status === "active",
    ),
  );
  const recipientTitle = `wake recipient ${crypto.randomUUID()}`;
  const A = await client.session.create({ title: "wake sender", location });
  const B = await client.session.create({ title: recipientTitle, location });
  await Bun.sleep(600);
  let start = events.length;
  await client.session.prompt({
    sessionID: A.id,
    text: `BUS_TEST ${JSON.stringify({ tool: "agentbus_search_sessions", args: { query: recipientTitle } })}`,
  });
  const searchPermission = await wait("search approval", async () =>
    (await client.permission.list({ sessionID: A.id })).find(
      (p) => p.action === "agentbus_search_sessions",
    ),
  );
  await client.permission.reply({
    sessionID: A.id,
    requestID: searchPermission.id,
    decision: "once",
  });
  const registry = output(await success(A.id, start));
  const target = (
    registry.matches as Array<{ metadata?: { title?: string }; handle: string }>
  ).find((m) => m.metadata?.title === recipientTitle)?.handle;
  if (!target) throw new Error("recipient absent from opt-in registry");
  start = events.length;
  const sentinel = "fixed-wake-test-body-not-a-secret";
  await client.session.prompt({
    sessionID: A.id,
    text: `BUS_TEST ${JSON.stringify({ tool: "agentbus_send", args: { target, body: sentinel } })}`,
  });
  const receipt = output(await success(A.id, start));
  if ("body" in receipt) throw new Error("body in send receipt");
  const synthetic = await wait("native fixed wake admission", () =>
    events.find(
      (e) =>
        e.type === "session.inbox.enqueued" &&
        data(e)?.sessionID === B.id &&
        (data(e)?.item as { type?: string } | undefined)?.type === "synthetic",
    ),
  );
  const item = data(synthetic)?.item as {
    delivery: string;
    payload: { text: string; metadata?: unknown; description?: string };
  };
  if (
    item.delivery !== "queue" ||
    item.payload.text !== FIXED_V2_WAKE_TEXT ||
    item.payload.description !== undefined ||
    item.payload.metadata !== undefined ||
    JSON.stringify(item).includes(sentinel)
  )
    throw new Error("native wake contained peer data or wrong delivery");
  const approval = await wait("autonomous receive approval", async () =>
    (await client.permission.list({ sessionID: B.id })).find(
      (p) => p.action === "agentbus_receive",
    ),
  );
  if (approval.source?.type !== "tool" || JSON.stringify(approval).includes(sentinel))
    throw new Error("wake bypassed approval or disclosed body");
  const metricsPending = await providerMetrics();
  if (
    metricsPending.wakeRequests <= metricsBefore.wakeRequests ||
    metricsPending.wakeBodySeen !== metricsBefore.wakeBodySeen ||
    metricsPending.wakeResultBodySeen !== metricsBefore.wakeResultBodySeen
  )
    throw new Error("provider observed peer body in fixed wake before native approval");
  console.log(
    "idle recipient resumed autonomously; native approval pending before body; fixed body-free queue wake",
  );
  const moved = config.otherDirectory;
  if (!moved) throw new Error("The isolated second project was not configured.");
  await client.session.move({ sessionID: B.id, directory: moved });
  await wait("queued cross-project move", () =>
    events.find(
      (e) =>
        e.type === "session.inbox.enqueued" &&
        data(e)?.sessionID === B.id &&
        (data(e)?.item as { type?: string } | undefined)?.type === "move",
    ),
  );
  await client.permission.reply({ sessionID: B.id, requestID: approval.id, decision: "once" });
  const received = output(
    await wait("same-session receive", () =>
      events.find((e) => e.type === "session.tool.success" && data(e)?.sessionID === B.id),
    ),
  );
  if (received.body !== sentinel || received.messageId !== receipt.messageId)
    throw new Error("moved recipient lost approved message");
  await wait("approved body appears only in later provider request", async () => {
    const metrics = await providerMetrics();
    return metrics.wakeResultBodySeen > metricsPending.wakeResultBodySeen &&
      metrics.warningSeen > metricsBefore.warningSeen
      ? true
      : undefined;
  });
  console.log("project move during approval preserved same-session delivery");

  const busyTitle = `busy wake recipient ${crypto.randomUUID()}`;
  const C = await client.session.create({ title: "busy wake sender", location });
  const D = await client.session.create({ title: busyTitle, location });
  await Bun.sleep(500);
  let cursor = events.length;
  await client.session.prompt({
    sessionID: C.id,
    text: `BUS_TEST ${JSON.stringify({ tool: "agentbus_search_sessions", args: { query: busyTitle } })}`,
  });
  const find = await wait("busy-target search approval", async () =>
    (await client.permission.list({ sessionID: C.id })).find(
      (p) => p.action === "agentbus_search_sessions",
    ),
  );
  await client.permission.reply({ sessionID: C.id, requestID: find.id, decision: "once" });
  const busyTarget = (
    output(await success(C.id, cursor)).matches as Array<{
      metadata?: { title?: string };
      handle: string;
    }>
  ).find((m) => m.metadata?.title === busyTitle)?.handle;
  if (!busyTarget) throw new Error("busy recipient not registered");
  const busyFrom = events.length;
  await client.session.prompt({ sessionID: D.id, text: "BUS_BUSY" });
  await wait("busy recipient began execution", () =>
    events
      .slice(busyFrom)
      .find((e) => e.type === "session.execution.started" && data(e)?.sessionID === D.id),
  );
  cursor = events.length;
  await client.session.prompt({
    sessionID: C.id,
    text: `BUS_TEST ${JSON.stringify({ tool: "agentbus_send", args: { target: busyTarget, body: "busy-pending-not-a-secret" } })}`,
  });
  await success(C.id, cursor);
  const busyWake = await wait("queued wake for busy recipient", () =>
    events
      .slice(busyFrom)
      .find(
        (e) =>
          e.type === "session.inbox.enqueued" &&
          data(e)?.sessionID === D.id &&
          (data(e)?.item as { type?: string } | undefined)?.type === "synthetic",
      ),
  );
  if ((data(busyWake)?.item as { delivery?: string } | undefined)?.delivery !== "queue")
    throw new Error("busy wake not queued");
  if (
    events
      .slice(busyFrom)
      .some((e) => e.type === "session.execution.interrupted" && data(e)?.sessionID === D.id)
  )
    throw new Error("busy recipient interrupted");
  const busyPermission = await wait("busy recipient autonomous receive approval", async () =>
    (await client.permission.list({ sessionID: D.id })).find(
      (p) => p.action === "agentbus_receive",
    ),
  );
  await Bun.sleep(600);
  const countWakes = () =>
    events
      .slice(busyFrom)
      .filter(
        (e) =>
          e.type === "session.inbox.enqueued" &&
          data(e)?.sessionID === D.id &&
          (data(e)?.item as { type?: string } | undefined)?.type === "synthetic",
      ).length;
  if (countWakes() !== 1) throw new Error("duplicate busy wake episode");
  await client.permission.reply({
    sessionID: D.id,
    requestID: busyPermission.id,
    decision: "reject",
  });
  await Bun.sleep(800);
  if (countWakes() !== 1) throw new Error("rejected receive caused wake storm");
  console.log(
    "busy recipient queued without interruption; duplicate/rejected hints did not cause wake storm",
  );

  const movingTitle = `move-before-wake ${crypto.randomUUID()}`;
  const E = await client.session.create({ title: "moving wake sender", location });
  const F = await client.session.create({ title: movingTitle, location });
  await Bun.sleep(500);
  let moveCursor = events.length;
  await client.session.prompt({
    sessionID: E.id,
    text: `BUS_TEST ${JSON.stringify({ tool: "agentbus_search_sessions", args: { query: movingTitle } })}`,
  });
  const moveSearch = await wait("moving-recipient search approval", async () =>
    (await client.permission.list({ sessionID: E.id })).find(
      (p) => p.action === "agentbus_search_sessions",
    ),
  );
  await client.permission.reply({ sessionID: E.id, requestID: moveSearch.id, decision: "once" });
  const movingTarget = (
    output(await success(E.id, moveCursor)).matches as Array<{
      metadata?: { title?: string };
      handle: string;
    }>
  ).find((m) => m.metadata?.title === movingTitle)?.handle;
  if (!movingTarget) throw new Error("moving recipient missing before project change");
  moveCursor = events.length;
  await client.session.prompt({ sessionID: F.id, text: "BUS_BUSY" });
  await wait("moving recipient busy", () =>
    events
      .slice(moveCursor)
      .find((e) => e.type === "session.execution.started" && data(e)?.sessionID === F.id),
  );
  await client.session.move({ sessionID: F.id, directory: moved });
  await wait("recipient move queued while busy", () =>
    events
      .slice(moveCursor)
      .find(
        (e) =>
          e.type === "session.inbox.enqueued" &&
          data(e)?.sessionID === F.id &&
          (data(e)?.item as { type?: string } | undefined)?.type === "move",
      ),
  );
  const bodyMoving = "pending-before-project-change";
  const sentMoving = events.length;
  await client.session.prompt({
    sessionID: E.id,
    text: `BUS_TEST ${JSON.stringify({ tool: "agentbus_send", args: { target: movingTarget, body: bodyMoving } })}`,
  });
  await success(E.id, sentMoving);
  const fixedMoved = await wait("same session wake after project move", () =>
    events
      .slice(moveCursor)
      .find(
        (e) =>
          e.type === "session.inbox.enqueued" &&
          data(e)?.sessionID === F.id &&
          (data(e)?.item as { type?: string } | undefined)?.type === "synthetic",
      ),
  );
  if (
    (data(fixedMoved)?.item as { payload?: { text?: string } } | undefined)?.payload?.text !==
    FIXED_V2_WAKE_TEXT
  )
    throw new Error("wrong session or dynamic moved wake");
  const movedApproval = await wait("moved recipient native approval", async () =>
    (await client.permission.list({ sessionID: F.id })).find(
      (p) => p.action === "agentbus_receive",
    ),
  );
  await client.permission.reply({ sessionID: F.id, requestID: movedApproval.id, decision: "once" });
  const movedReceived = output(
    await wait("moved recipient actual tool delivery", () =>
      events
        .slice(moveCursor)
        .find((e) => e.type === "session.tool.success" && data(e)?.sessionID === F.id),
    ),
  );
  if (movedReceived.body !== bodyMoving) throw new Error("moved recipient lost queued message");
  const movedInfo = await wait("recipient genuinely changed project", async () => {
    const session = await client.session.get({ sessionID: F.id });
    return session.location.directory === moved ? session : undefined;
  });
  const initialProject = (await client.session.get({ sessionID: E.id })).projectID;
  if (movedInfo.projectID === initialProject)
    throw new Error("test move did not change project ID");
  console.log(
    "queued busy wake followed project move and delivered to same session after approval",
  );

  // Diagnostic only: stock Core persists native `always` grants per project.
  const savedFirst = events.length;
  await client.session.prompt({
    sessionID: E.id,
    text: `BUS_TEST ${JSON.stringify({ tool: "agentbus_send", args: { target: movingTarget, body: "same-pair-saved-in-moved-project" } })}`,
  });
  await success(E.id, savedFirst);
  let savedReceive = events.length;
  await client.session.prompt({
    sessionID: F.id,
    text: `BUS_TEST ${JSON.stringify({ tool: "agentbus_receive", args: {} })}`,
  });
  const savedPermission = await wait("moved project saved-pair approval", async () =>
    (await client.permission.list({ sessionID: F.id })).find(
      (p) => p.action === "agentbus_receive",
    ),
  );
  await client.permission.reply({
    sessionID: F.id,
    requestID: savedPermission.id,
    decision: "always",
  });
  await success(F.id, savedReceive);
  const returnMove = events.length;
  await client.session.move({ sessionID: F.id, directory: location.directory });
  await wait("session moved back to original project", () =>
    events.slice(returnMove).find((e) => e.type === "session.moved" && data(e)?.sessionID === F.id),
  );
  const returnedInfo = await client.session.get({ sessionID: F.id });
  if (
    returnedInfo.projectID !== initialProject ||
    returnedInfo.location.directory !== location.directory
  )
    throw new Error("test recipient did not return to original project");
  const savedSecond = events.length;
  await client.session.prompt({
    sessionID: E.id,
    text: `BUS_TEST ${JSON.stringify({ tool: "agentbus_send", args: { target: movingTarget, body: "same-pair-after-project-change" } })}`,
  });
  await success(E.id, savedSecond);
  savedReceive = events.length;
  await client.session.prompt({
    sessionID: F.id,
    text: `BUS_TEST ${JSON.stringify({ tool: "agentbus_receive", args: {} })}`,
  });
  const secondDecision = await wait("cross-project native saved-grant outcome", async () => {
    const pending = (await client.permission.list({ sessionID: F.id })).find(
      (p) => p.action === "agentbus_receive",
    );
    if (pending) return { pending };
    if (
      events
        .slice(savedReceive)
        .some((e) => e.type === "session.tool.success" && data(e)?.sessionID === F.id)
    )
      return { allowed: true };
    return undefined;
  });
  if ("pending" in secondDecision && secondDecision.pending) {
    const pending = secondDecision.pending;
    if (pending.resources[0] !== savedPermission.resources[0])
      throw new Error("pair resource changed across project move");
    await client.permission.reply({ sessionID: F.id, requestID: pending.id, decision: "once" });
    await success(F.id, savedReceive);
    console.log(
      "UNMET: native always approval is project-scoped; exact pair prompted again after project move",
    );
  } else console.log("native exact-pair always survived project change");

  const deletedTitle = `deleted wake recipient ${crypto.randomUUID()}`;
  const G = await client.session.create({ title: "wake deletion sender", location });
  const H = await client.session.create({ title: deletedTitle, location });
  await Bun.sleep(450);
  let deletedCursor = events.length;
  await client.session.prompt({
    sessionID: G.id,
    text: `BUS_TEST ${JSON.stringify({ tool: "agentbus_search_sessions", args: { query: deletedTitle } })}`,
  });
  const deletedSearch = await wait("deleted-target search approval", async () =>
    (await client.permission.list({ sessionID: G.id })).find(
      (p) => p.action === "agentbus_search_sessions",
    ),
  );
  await client.permission.reply({ sessionID: G.id, requestID: deletedSearch.id, decision: "once" });
  const deletedTarget = (
    output(await success(G.id, deletedCursor)).matches as Array<{
      metadata?: { title?: string };
      handle: string;
    }>
  ).find((m) => m.metadata?.title === deletedTitle)?.handle;
  if (!deletedTarget) throw new Error("deletion target not registered");
  deletedCursor = events.length;
  await client.session.prompt({
    sessionID: G.id,
    text: `BUS_TEST ${JSON.stringify({ tool: "agentbus_send", args: { target: deletedTarget, body: "interrupted-before-disclosure" } })}`,
  });
  await success(G.id, deletedCursor);
  const interruptedFrom = events.length;
  const interruptedApproval = await wait("native pending wake receive before interrupt", async () =>
    (await client.permission.list({ sessionID: H.id })).find(
      (p) => p.action === "agentbus_receive",
    ),
  );
  if (JSON.stringify(interruptedApproval).includes("interrupted-before-disclosure"))
    throw new Error("peer body in permission before interrupt");
  await client.session.interrupt({ sessionID: H.id });
  await Bun.sleep(450);
  if (
    events
      .slice(interruptedFrom)
      .some((e) => e.type === "session.tool.success" && data(e)?.sessionID === H.id)
  )
    throw new Error("interrupted wake disclosed peer body");
  const beforeDeletion = events.length;
  await client.session.remove({ sessionID: H.id });
  await wait("native recipient deleted", () =>
    events
      .slice(beforeDeletion)
      .find((e) => e.type === "session.deleted" && data(e)?.sessionID === H.id),
  );
  await Bun.sleep(450);
  if (
    events
      .slice(beforeDeletion)
      .some(
        (e) =>
          e.type === "session.inbox.enqueued" &&
          data(e)?.sessionID === H.id &&
          (data(e)?.item as { type?: string } | undefined)?.type === "synthetic",
      )
  )
    throw new Error("deleted recipient reawakened");
  console.log("interrupted and deleted recipient had no approved disclosure or follow-up wake");
} finally {
  controller.abort();
  await work;
}
