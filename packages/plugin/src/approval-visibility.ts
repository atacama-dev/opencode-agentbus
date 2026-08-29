import type { PluginInput } from "@opencode-ai/plugin";

type TuiSessionSelectPublisher = (options: {
  readonly body: {
    readonly type: "tui.session.select";
    readonly properties: { readonly sessionID: string };
  };
  readonly query: { readonly directory: string };
}) => Promise<unknown>;

export function showAgentBusReceiveApproval(
  input: Pick<PluginInput, "client" | "directory">,
  sessionID: string,
  routeDirectory = input.directory,
): void {
  void (async () => {
    try {
      const publish = input.client.tui.publish as unknown;
      if (typeof publish === "function") {
        await (publish as TuiSessionSelectPublisher).call(input.client.tui, {
          body: {
            type: "tui.session.select",
            properties: { sessionID },
          },
          query: { directory: routeDirectory },
        });
      }
    } catch {
      // Selection is best-effort; the fixed toast below remains the fallback.
    }

    try {
      const showToast = input.client.tui.showToast as unknown;
      if (typeof showToast === "function") {
        await showToast.call(input.client.tui, {
          body: {
            title: "Agent Bus approval",
            message: "Agent Bus receive approval is waiting in this session.",
            variant: "warning",
            duration: 300_000,
          },
          query: { directory: routeDirectory },
        });
      }
    } catch {
      // UI failures must never reject or modify the native permission flow.
    }
  })();
}
