import {
  ForegroundSessionSchema,
  HostSessionIdSchema,
  MAX_BOOTSTRAP_SESSIONS_PER_WORKSPACE,
  SessionMetadataSchema,
} from "@opencode-agentbus/protocol";
import type { ForegroundSession, SessionMetadata } from "@opencode-agentbus/protocol";
import type { PluginInput } from "@opencode-ai/plugin";
import { isAbsolute, relative, sep } from "node:path";

import { SAFE_MODEL_ERRORS, SafeModelError } from "./errors";
import type { HostSessionRegistration } from "./runtime";

interface HostSessionInfo {
  readonly id: string;
  readonly projectID: string;
  readonly directory: string;
  readonly title: string;
}

export interface TrustedForegroundContext {
  readonly sessionID: string;
  readonly directory: string;
  readonly worktree: string;
}

/**
 * Project installation is the MVP opt-in boundary. OpenCode 1.18.19 exposes no server-side list
 * limit, so the trusted newest-first result is defensively capped before broker registration.
 */
export const MAX_BOOTSTRAP_SESSIONS = MAX_BOOTSTRAP_SESSIONS_PER_WORKSPACE;

export function safeHostSessionMetadata(title: string): SessionMetadata {
  const parsed = SessionMetadataSchema.safeParse({ title });
  return parsed.success ? parsed.data : SessionMetadataSchema.parse({});
}

export function hostSessionRegistration(
  info: HostSessionInfo,
  input: Pick<PluginInput, "directory" | "project">,
): HostSessionRegistration | undefined {
  if (info.directory !== input.directory || info.projectID !== input.project.id) return undefined;
  const registration = ForegroundSessionSchema.safeParse({
    hostSessionId: info.id,
    metadata: safeHostSessionMetadata(info.title),
  });
  return registration.success ? registration.data : undefined;
}

export async function listHostSessionRegistrations(
  input: Pick<PluginInput, "client" | "directory" | "project">,
  exactHostSessionId?: string,
): Promise<readonly HostSessionRegistration[]> {
  let response: Awaited<ReturnType<PluginInput["client"]["session"]["list"]>>;
  try {
    response = await input.client.session.list({ query: { directory: input.directory } });
  } catch {
    throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
  }
  if (!response.data) throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
  const registrations: HostSessionRegistration[] = [];
  for (const info of response.data) {
    if (exactHostSessionId !== undefined && info.id !== exactHostSessionId) continue;
    const registration = hostSessionRegistration(info, input);
    if (registration) registrations.push(registration);
    if (
      registrations.length === MAX_BOOTSTRAP_SESSIONS ||
      (exactHostSessionId !== undefined && registrations.length === 1)
    ) {
      break;
    }
  }
  if (exactHostSessionId !== undefined && registrations.length !== 1) {
    throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
  }
  return registrations;
}

export async function resolveForegroundHostSession(
  input: Pick<PluginInput, "client">,
  context: TrustedForegroundContext,
): Promise<ForegroundSession> {
  const unavailable = (): never => {
    throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
  };
  const parsedHostSessionId = HostSessionIdSchema.safeParse(context.sessionID);
  if (
    !parsedHostSessionId.success ||
    typeof context.directory !== "string" ||
    !isAbsolute(context.directory) ||
    typeof context.worktree !== "string" ||
    !isAbsolute(context.worktree)
  ) {
    return unavailable();
  }
  const hostSessionId = parsedHostSessionId.data;

  let sessions: Awaited<ReturnType<PluginInput["client"]["session"]["list"]>>;
  try {
    sessions = await input.client.session.list({ query: { directory: context.directory } });
  } catch {
    return unavailable();
  }
  if (!Array.isArray(sessions.data)) return unavailable();
  const exactSessions = (sessions.data as readonly unknown[]).filter(
    (info): info is Record<string, unknown> =>
      typeof info === "object" && info !== null && "id" in info && info.id === hostSessionId,
  );
  if (exactSessions.length !== 1) return unavailable();
  const [info] = exactSessions;
  if (
    !info ||
    info.directory !== context.directory ||
    typeof info.projectID !== "string" ||
    typeof info.title !== "string"
  ) {
    return unavailable();
  }
  const parsedRegistration = ForegroundSessionSchema.safeParse({
    hostSessionId: info.id,
    metadata: { title: info.title },
  });
  if (!parsedRegistration.success || parsedRegistration.data.hostSessionId !== hostSessionId) {
    return unavailable();
  }

  let currentProject: Awaited<ReturnType<PluginInput["client"]["project"]["current"]>>;
  try {
    currentProject = await input.client.project.current({
      query: { directory: context.directory },
    });
  } catch {
    return unavailable();
  }
  const project = currentProject.data as unknown;
  if (
    typeof project !== "object" ||
    project === null ||
    !("id" in project) ||
    typeof project.id !== "string" ||
    !("worktree" in project) ||
    typeof project.worktree !== "string" ||
    !isAbsolute(project.worktree) ||
    info.projectID !== project.id ||
    !directoryBelongsToWorktree(context.directory, context.worktree) ||
    !directoryBelongsToWorktree(context.directory, project.worktree)
  ) {
    return unavailable();
  }
  return parsedRegistration.data;
}

function directoryBelongsToWorktree(directory: string, worktree: string): boolean {
  const pathFromWorktree = relative(worktree, directory);
  return (
    pathFromWorktree === "" ||
    (pathFromWorktree !== ".." &&
      !pathFromWorktree.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromWorktree))
  );
}
