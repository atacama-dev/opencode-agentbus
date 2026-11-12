import type { V2Placement } from "./host-v2";

// Optional paired-host extensions. These are NOT part of the public @opencode/plugin 2.2.7 API.
// All methods must be present before registering any tool or opening the broker.
export interface PairedHost {
  resolve(input: { sessionID: string }, options?: { signal: AbortSignal }): Promise<V2Placement>;
  activity(options?: { signal: AbortSignal }): Promise<readonly string[]>;
  reconcileSynthetic(
    input: { sessionID: string; id: string },
    options?: { signal: AbortSignal },
  ): Promise<unknown>;
  admitSynthetic(
    input: { sessionID: string; id: string; text: string; delivery: "queue"; resume: true },
    options?: { signal: AbortSignal },
  ): Promise<unknown>;
}

declare module "@opencode/plugin/promise/plugin" {
  interface Context {
    readonly host?: PairedHost;
  }
}

declare module "@opencode/plugin/promise/tool" {
  interface ToolContext {
    readonly assertPermission?: (input: {
      readonly action: string;
      readonly resources: readonly string[];
      readonly save: readonly string[];
      readonly metadata: Readonly<Record<string, unknown>>;
    }) => Promise<void>;
  }
}

export function requirePairedHost(host: PairedHost | undefined): PairedHost {
  if (
    !host ||
    typeof host.resolve !== "function" ||
    typeof host.activity !== "function" ||
    typeof host.reconcileSynthetic !== "function" ||
    typeof host.admitSynthetic !== "function"
  ) {
    throw new Error(
      "This paired Agent Bus V2 entry requires paired host extensions; the separate stock entry is experimental and not release-approved",
    );
  }
  return host;
}
