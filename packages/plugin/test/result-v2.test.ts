import { expect, test } from "bun:test";
import { nativeV2Result } from "../src/result-v2";
import { MAX_MESSAGE_BYTES } from "@opencode-agentbus/protocol";

test("native tool result keeps visible untrusted warning before a maximum UTF-8 body", () => {
  const body = "界".repeat(Math.floor(MAX_MESSAGE_BYTES / 3)) + "x".repeat(MAX_MESSAGE_BYTES % 3);
  const result = nativeV2Result({
    output: JSON.stringify({ type: "peer_message", trust: "untrusted", body }),
    metadata: { type: "peer_message", trust: "untrusted" },
  });
  expect(result).not.toHaveProperty("output");
  expect(result.content.slice(0, 512)).toMatch(/"trust":\s*"untrusted"/u);
  expect(result.content.slice(0, 512)).toContain("disclosure approval does not authorize actions");
  expect(result.content.split("\n").length).toBeGreaterThan(3);
  expect(Buffer.byteLength(body, "utf8")).toBe(MAX_MESSAGE_BYTES);
  expect(JSON.parse(result.content).body).toBe(body);
  expect(JSON.stringify(result.metadata)).not.toContain(body);
});

test("native send/reply receipts stay body-free and keep correlation unchanged", () => {
  const receipt = {
    type: "agentbus_reply_receipt",
    messageId: "fresh",
    replyToMessageId: "original",
    authority: "none",
  };
  expect(JSON.parse(nativeV2Result({ output: JSON.stringify(receipt) }).content)).toEqual(receipt);
});
