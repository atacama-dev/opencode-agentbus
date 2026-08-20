import { SessionMetadataSchema } from "@opencode-agentbus/protocol";
import type { SessionMetadata } from "@opencode-agentbus/protocol";
import type { PluginInput } from "@opencode-ai/plugin";

import { SAFE_MODEL_ERRORS, SafeModelError } from "./errors";
import type { HostSessionRegistration } from "./runtime";

interface HostSessionInfo {
  readonly id: string;
  readonly projectID: string;
  readonly directory: string;
  readonly title: string;
}

/**
 * Project installation is the MVP opt-in boundary. OpenCode 1.18.19 exposes no server-side list
 * limit, so the trusted newest-first result is defensively capped before broker registration.
 */
export const MAX_BOOTSTRAP_SESSIONS = 256;

export function safeHostSessionMetadata(title: string): SessionMetadata {
  const parsed = SessionMetadataSchema.safeParse({ title });
  return parsed.success ? parsed.data : SessionMetadataSchema.parse({});
}

export function hostSessionRegistration(
  info: HostSessionInfo,
  input: Pick<PluginInput, "directory" | "project">,
): HostSessionRegistration | undefined {
  if (info.directory !== input.directory || info.projectID !== input.project.id) return undefined;
  return {
    hostSessionId: info.id,
    metadata: safeHostSessionMetadata(info.title),
  };
}

export async function listHostSessionRegistrations(
  input: Pick<PluginInput, "client" | "directory" | "project">,
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
    const registration = hostSessionRegistration(info, input);
    if (registration) registrations.push(registration);
    if (registrations.length === MAX_BOOTSTRAP_SESSIONS) break;
  }
  return registrations;
}
