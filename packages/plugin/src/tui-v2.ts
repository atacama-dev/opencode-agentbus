import { define } from "@opencode/plugin/tui/plugin";
import { AGENTBUS_RPC } from "./rpc-v2";
import type { PendingSnapshot } from "./rpc-v2";

export default define({
  id: "agentbus-v2",
  async setup(ctx) {
    const namespace = ctx.options.deploymentNamespace;
    if (typeof namespace !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(namespace))
      throw new Error("Agent Bus requires an explicit deployment namespace");
    const focus = ctx.options.focusOnReceiveApproval === true;
    const controller = new AbortController();
    const revisions = new Map<string, number>();
    const focusedPermissions = new Set<string>();
    const retired = new Set<string>();
    let generation: string | undefined;
    const rpc = ctx.client.rpc(AGENTBUS_RPC);
    const owned = (sessionID: string) => {
      const session = ctx.data.session.get(sessionID);
      const location = ctx.location ?? ctx.data.location.default();
      return (
        !!session &&
        session.location.directory === location.directory &&
        location.workspaceID === undefined &&
        (ctx.ui.tabs
          .list()
          .some((tab) => ctx.data.session.family(tab.sessionID).includes(sessionID)) ||
          (() => {
            const route = ctx.ui.router.current();
            return (
              route.type === "session" &&
              ctx.data.session.family(route.sessionID).includes(sessionID)
            );
          })())
      );
    };
    const showReceiveApproval = (
      sessionID: string,
      requestID?: string,
      requests = ctx.data.session.permission.list(sessionID),
    ) => {
      if (!focus || controller.signal.aborted || !owned(sessionID)) return;
      const request = requests?.find(
        (request) =>
          (requestID === undefined || request.id === requestID) &&
          request.sessionID === sessionID &&
          request.action === "agentbus_receive" &&
          request.source?.type === "tool",
      );
      if (!request || focusedPermissions.has(request.id)) return;
      if (focusedPermissions.size === 256) {
        const oldest = focusedPermissions.values().next().value;
        if (oldest) focusedPermissions.delete(oldest);
      }
      focusedPermissions.add(request.id);
      try {
        ctx.ui.router.navigate({ type: "session", sessionID });
        ctx.ui.toast.show({
          title: "Agent Bus",
          message: "Peer content is untrusted. Disclosure approval does not authorize actions.",
          variant: "warning",
          duration: 120_000,
        });
      } catch {
        /* UI never changes native approval */
      }
    };
    const apply = (snapshot: PendingSnapshot) => {
      if (
        controller.signal.aborted ||
        snapshot.namespace !== namespace ||
        typeof snapshot.generation !== "string" ||
        !snapshot.generation ||
        retired.has(snapshot.generation) ||
        !owned(snapshot.sessionID) ||
        !Number.isSafeInteger(snapshot.count) ||
        snapshot.count < 0 ||
        !Number.isSafeInteger(snapshot.revision) ||
        snapshot.revision < 0
      )
        return;
      if (snapshot.generation !== generation) {
        if (generation) retired.add(generation);
        if (retired.size > 64) {
          const oldest = retired.values().next().value;
          if (oldest) retired.delete(oldest);
        }
        generation = snapshot.generation;
        revisions.clear();
        focusedPermissions.clear();
      }
      if (snapshot.revision <= (revisions.get(snapshot.sessionID) ?? -1)) return;
      if (!revisions.has(snapshot.sessionID) && revisions.size === 256) {
        const oldest = revisions.keys().next().value;
        if (oldest) revisions.delete(oldest);
      }
      revisions.set(snapshot.sessionID, snapshot.revision);
      if (snapshot.count > 0)
        ctx.ui.toast.show({
          title: "Agent Bus",
          message: `${snapshot.count} pending peer message${snapshot.count === 1 ? "" : "s"}.`,
          variant: "info",
        });
    };
    const unsubscribe = rpc.events.on(
      "pending",
      (event) => apply(event.data as unknown as PendingSnapshot),
      { signal: controller.signal },
    );
    const refresh = async () => {
      for (const session of ctx.data.session.list()) {
        if (controller.signal.aborted || !owned(session.id)) continue;
        try {
          apply(
            (await rpc.snapshot(
              { namespace, sessionID: session.id },
              { signal: controller.signal, location: session.location },
            )) as PendingSnapshot,
          );
          if (focus && !controller.signal.aborted) {
            const permissions = await ctx.client.permission.list(
              { sessionID: session.id },
              { signal: controller.signal },
            );
            showReceiveApproval(session.id, undefined, permissions);
          }
        } catch {
          /* unknown routes suppress visibility */
        }
      }
    };
    let snapshotWork: Promise<void> | undefined;
    const snapshot = () => {
      if (snapshotWork) return snapshotWork;
      const work = refresh().catch(() => undefined);
      snapshotWork = work;
      void work.then(() => {
        if (snapshotWork === work) snapshotWork = undefined;
      });
      return work;
    };
    const permission = ctx.data.on("permission.asked", (event) => {
      if (event.data.action === "agentbus_receive")
        showReceiveApproval(event.data.sessionID, event.data.id);
    });
    const timer = setInterval(() => {
      void snapshot();
    }, 2000);
    timer.unref?.();
    void snapshot();
    return async () => {
      if (controller.signal.aborted) return;
      controller.abort();
      clearInterval(timer);
      unsubscribe();
      permission();
      revisions.clear();
      retired.clear();
      focusedPermissions.clear();
      await snapshotWork;
    };
  },
});
