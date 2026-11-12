import { isAbsolute, relative } from "node:path";
import { ForegroundSessionSchema, HostSessionIdSchema } from "@opencode-agentbus/protocol";
import { SAFE_MODEL_ERRORS, SafeModelError } from "./errors";

export interface V2Placement {
  readonly session: {
    readonly id: string;
    readonly projectID: string;
    readonly location: { readonly directory: string; readonly workspaceID?: string | undefined };
    readonly title?: string | undefined;
  };
  readonly location: {
    readonly directory: string;
    readonly workspaceID?: string | undefined;
    readonly project: {
      readonly id: string;
      readonly directory: string;
      readonly canonical: string;
    };
  };
  readonly agent: string;
}

export interface V2Resolver {
  resolve(
    input: { readonly sessionID: string },
    options?: { readonly signal: AbortSignal },
  ): Promise<V2Placement>;
}

export function assertV2Live(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
}

function safePath(path: string): boolean {
  return (
    typeof path === "string" &&
    isAbsolute(path) &&
    !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(path) &&
    !path.split("/").includes("..")
  );
}

export async function resolveV2Foreground(
  host: V2Resolver,
  sessionID: string,
  signal: AbortSignal,
) {
  assertV2Live(signal);
  const parsedID = HostSessionIdSchema.safeParse(sessionID);
  if (!parsedID.success) throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
  const placement = await host.resolve({ sessionID: parsedID.data }, { signal });
  assertV2Live(signal);
  const { session, location, agent } = placement;
  if (
    !session ||
    !location ||
    !location.project ||
    session.id !== parsedID.data ||
    session.projectID !== location.project.id ||
    !session.location ||
    session.location.directory !== location.directory ||
    session.location.workspaceID !== location.workspaceID ||
    location.workspaceID !== undefined ||
    typeof agent !== "string" ||
    !agent.trim() ||
    agent.length > 128 ||
    /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(agent) ||
    !HostSessionIdSchema.safeParse(location.project.id).success ||
    !safePath(location.directory) ||
    !safePath(location.project.directory) ||
    !safePath(location.project.canonical)
  ) {
    throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
  }
  const within = relative(location.project.directory, location.directory);
  if (within === ".." || within.startsWith("../") || isAbsolute(within))
    throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
  const foreground = ForegroundSessionSchema.safeParse({
    hostSessionId: parsedID.data,
    metadata: session.title === undefined ? {} : { title: session.title },
  });
  if (!foreground.success) throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
  return {
    foreground: foreground.data,
    directory: location.directory,
    worktree: location.project.directory,
    projectID: location.project.id,
    agent,
  };
}
