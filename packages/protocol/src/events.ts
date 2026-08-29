import { z } from "zod";

import { MAX_ACTIVE_SESSIONS_PER_PRINCIPAL, PENDING_MESSAGE_EVENT_TYPE } from "./constants";
import {
  AuthenticatedClientPrincipalSchema,
  EventCursorSchema,
  EventIdSchema,
  PrincipalSessionBindingSchema,
} from "./schemas";
import type {
  AuthenticatedClientPrincipal,
  PrincipalSessionBinding,
  SessionIdentity,
} from "./schemas";
import { PendingMessageEventSchema } from "./transport";
import type { PendingMessageEvent } from "./transport";

function sameSession(left: SessionIdentity, right: SessionIdentity): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.broker.brokerId === right.broker.brokerId &&
    left.broker.serverId === right.broker.serverId
  );
}

export const EventStreamSubscriptionSchema = z
  .object({
    principal: AuthenticatedClientPrincipalSchema,
    lastEventId: EventCursorSchema.optional(),
    authoritativeRecoveryCompleted: z.boolean(),
  })
  .strict()
  .superRefine((subscription, context) => {
    if (subscription.lastEventId === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastEventId"],
        message: "event streams require an authoritative replay watermark",
      });
    }
  })
  .readonly();
export type EventStreamSubscription = z.infer<typeof EventStreamSubscriptionSchema>;

export function compareEventIds(left: string, right: string): number {
  const parsedLeft = BigInt(EventIdSchema.parse(left));
  const parsedRight = BigInt(EventIdSchema.parse(right));
  return parsedLeft < parsedRight ? -1 : parsedLeft > parsedRight ? 1 : 0;
}

export function eventsAfterCursor(
  events: readonly PendingMessageEvent[],
  cursor: string,
): readonly PendingMessageEvent[] {
  const parsedCursor = EventCursorSchema.parse(cursor);
  return events
    .map((event) => PendingMessageEventSchema.parse(event))
    .filter((event) => BigInt(event.eventId) > BigInt(parsedCursor))
    .sort((left, right) => compareEventIds(left.eventId, right.eventId));
}

export function formatPendingMessageSseEvent(event: PendingMessageEvent): string {
  const parsed = PendingMessageEventSchema.parse(event);
  const data = JSON.stringify(parsed);
  if (data.includes("\n") || data.includes("\r")) {
    throw new TypeError("Pending event JSON must fit on one SSE data line.");
  }
  return `id: ${parsed.eventId}\nevent: ${PENDING_MESSAGE_EVENT_TYPE}\ndata: ${data}\n\n`;
}

export function formatSseComment(comment: string): string {
  if (!/^[A-Za-z0-9 ._-]{1,64}$/u.test(comment)) {
    throw new TypeError("SSE comments must be short safe single-line text.");
  }
  return `: ${comment}\n\n`;
}

export function pendingEventMatchesPrincipalBindings(
  event: PendingMessageEvent,
  principal: AuthenticatedClientPrincipal,
  bindings: readonly PrincipalSessionBinding[],
): boolean {
  return bindings.some(
    (binding) =>
      binding.ownerPrincipalId === principal.principalId &&
      binding.identity.broker.serverId === principal.serverId &&
      sameSession(binding.identity, event.target) &&
      sameSession(binding.identity, event.header.target),
  );
}

export const AuthenticatedPendingMessageEventInputSchema = z
  .object({
    principal: AuthenticatedClientPrincipalSchema,
    bindings: z
      .array(PrincipalSessionBindingSchema)
      .min(1)
      .max(MAX_ACTIVE_SESSIONS_PER_PRINCIPAL)
      .readonly(),
    event: PendingMessageEventSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (!pendingEventMatchesPrincipalBindings(input.event, input.principal, input.bindings)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["event", "target"],
        message: "pending event target is not owned by the authenticated stream principal",
      });
    }
  })
  .readonly();
export type AuthenticatedPendingMessageEventInput = z.infer<
  typeof AuthenticatedPendingMessageEventInputSchema
>;
