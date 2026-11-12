import { ForegroundSessionSchema, HostSessionIdSchema } from "@opencode-agentbus/protocol";
import { SafeModelError, SAFE_MODEL_ERRORS } from "./errors";

interface StockSession {
  readonly id: string;
  readonly title?: string | undefined;
}

export function verifyStockForeground(session: StockSession, sessionID: string) {
  const invalid = () => new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
  if (!HostSessionIdSchema.safeParse(sessionID).success || !session || session.id !== sessionID)
    throw invalid();
  const foreground = ForegroundSessionSchema.safeParse({
    hostSessionId: sessionID,
    metadata: session.title === undefined ? {} : { title: session.title },
  });
  if (!foreground.success) throw invalid();
  return foreground.data;
}

interface Rule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

function match(value: string, pattern: string): boolean {
  const escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(
    value.replaceAll("\\", "/"),
  );
}

// Check configured agent/session policy only. Native saved `always` grants are deliberately
// excluded: the host evaluates those AFTER configured rules and configured denies.
export function hasNativeAskPolicy(
  agentRules: readonly Rule[],
  sessionRules: readonly Rule[],
  action: "agentbus_receive" | "agentbus_search_sessions",
  resource: string,
): boolean {
  const rules = [...agentRules, ...sessionRules];
  const effective = rules.findLast(
    (rule) => match(action, rule.action) && match(resource, rule.resource),
  );
  return (
    effective?.effect === "ask" &&
    rules.some((rule) => rule.action === action && rule.resource === "*" && rule.effect === "ask")
  );
}
