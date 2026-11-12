import { expect, test } from "bun:test";
import { requirePairedHost } from "../src/v2-capabilities";
import type { PairedHost } from "../src/v2-capabilities";

test("paired adapter rejects absent or incomplete host extensions before setup", () => {
  const host = {
    resolve: async () => undefined,
    activity: async () => [],
    reconcileSynthetic: async () => undefined,
    admitSynthetic: async () => undefined,
  };
  expect(() => requirePairedHost(undefined)).toThrow("paired host extensions");
  for (const missing of Object.keys(host))
    expect(() =>
      requirePairedHost({ ...host, [missing]: undefined } as unknown as PairedHost),
    ).toThrow("paired host extensions");
});

test("paired adapter preserves the checked host capability object", () => {
  const host: PairedHost = {
    resolve: async () => {
      throw new Error("not used during the shape check");
    },
    activity: async () => [],
    reconcileSynthetic: async () => undefined,
    admitSynthetic: async () => undefined,
  };
  expect(requirePairedHost(host)).toBe(host);
});
