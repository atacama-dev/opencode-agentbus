import { Rpc } from "@opencode/plugin";

// Native portable JSON-schema codecs disable regex patterns; the handler enforces the exact namespace.
const snapshotInput = {
  type: "object",
  properties: {
    namespace: { type: "string", maxLength: 64 },
    sessionID: { type: "string", maxLength: 128 },
  },
  required: ["namespace", "sessionID"],
  additionalProperties: false,
} as const;
const pending = {
  type: "object",
  properties: {
    namespace: { type: "string" },
    generation: { type: "string" },
    sessionID: { type: "string" },
    count: { type: "integer", minimum: 0 },
    revision: { type: "integer", minimum: 0 },
  },
  required: ["namespace", "generation", "sessionID", "count", "revision"],
  additionalProperties: false,
} as const;
export const AGENTBUS_RPC = Rpc.define({
  id: "agentbus-v2",
  methods: { snapshot: { input: snapshotInput, output: pending } },
  events: { pending: { schema: pending } },
});
export interface PendingSnapshot {
  namespace: string;
  generation: string;
  sessionID: string;
  count: number;
  revision: number;
}
