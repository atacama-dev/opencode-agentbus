import { tool } from "@opencode-ai/plugin";

export const receive = tool({
  description: "Receive an approved message",
  args: {},
  async execute(_args, context) {
    await context.ask({
      permission: "agentbus_receive",
      patterns: ["target:abc:sender:def"],
      always: ["target:abc:sender:def"],
    });
    return { type: "peer_message", trust: "untrusted" };
  },
});
