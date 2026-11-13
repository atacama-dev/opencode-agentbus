import { expect, test } from "bun:test";
import { readReleaseConfig } from "./config";
import {
  assertPackageLine,
  assertDeclaredBundleImports,
  assertSourcePins,
  publicDependencies,
  validatePackedManifest,
} from "./package";

test("supported lines are selected without readiness or publication approval", () => {
  const config = readReleaseConfig();
  expect(assertPackageLine(config, "v1")).toBe("v1");
  expect(assertPackageLine({ ...config, supportedLines: ["v1", "v2"] }, "v2")).toBe("v2");
  expect(() => assertPackageLine({ ...config, supportedLines: ["v1"] }, "v2")).toThrow();
  expect(() => assertPackageLine(config, "../v1")).toThrow();
});

test("bundle import scan rejects undeclared bare static imports and literal dynamic imports", () => {
  const declared = { "@opencode-agentbus/broker": "0.1.0", "@opencode/plugin": "2.2.7" };
  expect(() =>
    assertDeclaredBundleImports(
      'import "node:fs"; import "@opencode/plugin/effect"; import("@opencode-agentbus/broker/cli")',
      declared,
    ),
  ).not.toThrow();
  expect(() => assertDeclaredBundleImports('import "@opencode/client"', declared)).toThrow(
    "@opencode/client",
  );
  expect(() => assertDeclaredBundleImports('import("effect")', declared)).toThrow("effect");
  expect(() => assertDeclaredBundleImports('import "./missing.js"', declared)).toThrow(
    "./missing.js",
  );
});

test("archive dependency pins cannot drift from source dependency pins", () => {
  const plugin = { dependencies: publicDependencies("v1") };
  const broker = { dependencies: { "@modelcontextprotocol/sdk": "1.32.2", zod: "4.6.7" } };
  const protocol = { dependencies: { zod: "4.6.7" } };
  expect(() => assertSourcePins("v1", plugin, broker, protocol)).not.toThrow();
  const legacyPlugin = {
    dependencies: { "@modelcontextprotocol/sdk": "1.32.2", "@opencode-ai/plugin": "1.18.19" },
  };
  expect(() => assertSourcePins("v1", legacyPlugin, broker, protocol)).not.toThrow();
  expect(() =>
    assertSourcePins(
      "v1",
      { dependencies: { ...plugin.dependencies, zod: "4.6.8" } },
      broker,
      protocol,
    ),
  ).toThrow("pins differ");
  expect(() => assertSourcePins("v2", plugin, broker, protocol)).toThrow("pins differ");
});

test("public dependency profiles exclude the opposite OpenCode SDK", () => {
  expect(publicDependencies("v1")).toEqual({
    "@modelcontextprotocol/sdk": "1.32.2",
    zod: "4.6.7",
    "@opencode-ai/plugin": "1.18.19",
  });
  expect(publicDependencies("v2")).toEqual({
    "@modelcontextprotocol/sdk": "1.32.2",
    zod: "4.6.7",
    "@opencode/plugin": "2.2.7",
    "@opencode/client": "2.2.7",
    "@opencode/schema": "2.2.7",
    effect: "4.1.0",
    "@types/json-schema": "7.0.15",
  });
});

test("packed manifest rejects workspace paths and lifecycle scripts", () => {
  const manifest = { name: "example", version: "0.1.0", dependencies: { zod: "4.6.7" } };
  expect(() => validatePackedManifest(manifest)).not.toThrow();
  expect(() =>
    validatePackedManifest({ ...manifest, dependencies: { zod: "workspace:4.6.7" } }),
  ).toThrow();
  expect(() =>
    validatePackedManifest({ ...manifest, dependencies: { zod: "file:../foo" } }),
  ).toThrow();
  expect(() => validatePackedManifest({ ...manifest, scripts: { prepack: "echo hi" } })).toThrow();
});
