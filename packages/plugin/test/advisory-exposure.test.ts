import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tool } from "@opencode-ai/plugin";
import type { PluginInput } from "@opencode-ai/plugin";
import ts from "typescript";

import { createAgentBusPlugin } from "../src/plugin";
import type { AgentBusRuntime } from "../src/runtime";

// Use the legacy SDK's own Zod classes, not the patched broker/protocol copy.
function assertScalarArgument(
  schema: unknown,
): asserts schema is InstanceType<
  typeof tool.schema.ZodString | typeof tool.schema.ZodNumber | typeof tool.schema.ZodOptional
> {
  const scalar = schema instanceof tool.schema.ZodOptional ? schema.unwrap() : schema;
  if (!(scalar instanceof tool.schema.ZodString || scalar instanceof tool.schema.ZodNumber)) {
    throw new Error("Legacy tool arguments must be strings/numbers, optionally wrapped once.");
  }
}

function isEffectModule(name: string): boolean {
  return name === "effect" || name.startsWith("effect/") || name.startsWith("@effect/");
}

function isCookieName(name: string): boolean {
  return /^(?:Http)?Cookies?$/u.test(name);
}

function forbiddenModule(name: string): boolean {
  return (
    /^(?:toml|glob|minimatch)(?:\/|$)/u.test(name) ||
    (isEffectModule(name) &&
      name.split("/").some((part) => isCookieName(part.replace(/\.js$/u, ""))))
  );
}

function literalText(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function loadedModule(node: ts.Expression): string | undefined {
  if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) {
    return loadedModule(node.expression);
  }
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  ) {
    return literalText(node.arguments[0]);
  }
  return undefined;
}

// A deliberately local import-surface guard, not interprocedural taint analysis
// or a claim about the SDK/host's own TOML, Cookie, glob, or minimatch execution.
function exposureViolations(source: string): string[] {
  const file = ts.createSourceFile("product.ts", source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const effectNamespaces = new Set<string>();
  const visit = (node: ts.Node, inspect: (node: ts.Node) => void): void => {
    inspect(node);
    ts.forEachChild(node, (child) => visit(child, inspect));
  };
  const inspectModule = (name: string | undefined): void => {
    if (name !== undefined && forbiddenModule(name)) violations.push(`affected module: ${name}`);
  };
  visit(file, (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const name = literalText(node.moduleSpecifier);
      inspectModule(name);
      if (name === undefined || !isEffectModule(name)) return;
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (clause?.name) effectNamespaces.add(clause.name.text);
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) effectNamespaces.add(bindings.name.text);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const binding of bindings.elements) {
            if (isCookieName((binding.propertyName ?? binding.name).text)) {
              violations.push("Effect Cookie named import");
            }
          }
        }
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const binding of node.exportClause.elements) {
          if (isCookieName((binding.propertyName ?? binding.name).text)) {
            violations.push("Effect Cookie named export");
          }
        }
      }
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const name = literalText(node.moduleReference.expression);
      inspectModule(name);
      if (name !== undefined && isEffectModule(name)) effectNamespaces.add(node.name.text);
    }
    if (ts.isCallExpression(node)) inspectModule(loadedModule(node));
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const name = loadedModule(node.initializer);
      if (name !== undefined && isEffectModule(name)) effectNamespaces.add(node.name.text);
    }
  });
  const fromEffectNamespace = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node)) return effectNamespaces.has(node.text);
    if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) {
      return fromEffectNamespace(node.expression);
    }
    const name = loadedModule(node);
    return name !== undefined && isEffectModule(name);
  };
  visit(file, (node) => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const member = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : literalText(node.argumentExpression);
      if (member && isCookieName(member) && fromEffectNamespace(node.expression)) {
        violations.push("Effect Cookie namespace access");
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      fromEffectNamespace(node.initializer) &&
      ts.isObjectBindingPattern(node.name)
    ) {
      for (const binding of node.name.elements) {
        const key = binding.propertyName ?? binding.name;
        if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && isCookieName(key.text)) {
          violations.push("Effect Cookie destructuring");
        }
      }
    }
  });
  return violations;
}

async function productSources(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected product-source symlink: ${path}`);
    if (entry.isDirectory()) paths.push(...(await productSources(path)));
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name)) paths.push(path);
  }
  return paths.sort();
}

describe("SDK-chain advisory exposure regressions", () => {
  test("rejects synthetic collection/expanding schemas before checking product arguments", () => {
    const z = tool.schema;
    for (const schema of [
      z.array(z.string()),
      z.object({ value: z.string() }),
      z.record(z.string(), z.string()),
      z.map(z.string(), z.string()),
      z.set(z.string()),
      z.tuple([z.string()]),
      z.union([z.string(), z.number()]),
      z.lazy(() => z.string()),
      z.custom(() => true),
      z.array(z.string()).optional(),
    ]) {
      expect(() => assertScalarArgument(schema)).toThrow("Legacy tool arguments");
    }
    // Small positive control for the issue-allocation mechanism (GHSA-mrhx-c7xc-m3w5).
    const expanded = z.array(z.string()).safeParse(Array(1024).fill(null));
    expect(expanded.success).toBe(false);
    if (expanded.success) throw new Error("Expected invalid collection.");
    expect(expanded.error.issues.length).toBeGreaterThan(2);
    for (const schema of [z.string(), z.number(), z.string().optional(), z.number().optional()]) {
      expect(() => assertScalarArgument(schema)).not.toThrow();
    }
  });

  test("all four actual legacy tools reject collection inputs with one bounded field issue", async () => {
    const unexpectedCalls: string[] = [];
    const fail = (name: string): never => {
      unexpectedCalls.push(name);
      throw new Error(`Unexpected fixture I/O: ${name}`);
    };
    const callbacks = new Map<ReturnType<typeof setTimeout>, () => void>();
    let disposals = 0;
    const plugin = createAgentBusPlugin({
      brokerBootstrapFactory: () => ({ ensureReady: async () => fail("broker readiness") }),
      runtimeFactory: () =>
        ({
          dispose: async () => {
            disposals += 1;
          },
        }) as unknown as AgentBusRuntime,
      bootstrapScheduler: {
        set: (callback) => {
          const handle = { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
          callbacks.set(handle, callback);
          return handle;
        },
        clear: (handle) => {
          callbacks.delete(handle);
        },
      },
    });
    const input = {
      client: new Proxy({}, { get: (_target, name) => fail(`host client ${String(name)}`) }),
      directory: "/worktree",
      worktree: "/worktree",
      serverUrl: new URL("http://127.0.0.1:4096"),
      project: { id: "project_01" },
      experimental_workspace: { register: () => fail("workspace registration") },
      $: {},
    } as unknown as PluginInput;
    const hooks = await plugin(input, {
      credentialFilePath: "/does/not/read/credentials/in/schema-fixture",
      autoStartBroker: false,
      wakeOnMessage: false,
    });
    try {
      const tools = hooks.tool ?? {};
      expect(Object.keys(tools).sort()).toEqual([
        "agentbus_receive",
        "agentbus_reply",
        "agentbus_search_sessions",
        "agentbus_send",
      ]);
      expect(callbacks.size).toBe(1);
      let fields = 0;
      for (const definition of Object.values(tools)) {
        expect(Object.keys(definition.args).length).toBeLessThanOrEqual(3);
        for (const schema of Object.values(definition.args)) {
          fields += 1;
          assertScalarArgument(schema);
          const result = schema.safeParse(Array(1024).fill(null));
          expect(result.success).toBe(false);
          if (result.success) throw new Error("Collection accepted by scalar argument.");
          expect(result.error.issues).toHaveLength(1);
        }
      }
      expect(fields).toBe(8);
      expect(tools.agentbus_receive?.args).toEqual({});
      expect(unexpectedCalls).toEqual([]);
    } finally {
      await hooks.dispose?.();
    }
    expect(callbacks.size).toBe(0);
    expect(disposals).toBe(1);
    expect(unexpectedCalls).toEqual([]);
  });

  test("detects synthetic affected imports, literal loads, and Effect Cookie aliases", () => {
    for (const source of [
      'import "toml";',
      'import { parse as decode } from "toml"; decode(peer);',
      'const { parse: decode } = require("toml"); decode(peer);',
      'await import("toml");',
      'import glob from "glob"; glob(peer);',
      'const { minimatch: match } = require("minimatch"); match(peer, peer);',
      "await import(`glob/sync`);",
      'import matcher = require("minimatch");',
      'export * from "glob";',
      'import * as C from "effect/unstable/http/Cookies"; C.parseHeader(peer);',
      'import { Cookies as C } from "effect/unstable/http"; C.parseHeader(peer);',
      'import { HttpCookies as C } from "@effect/platform"; C.fromInput(peer);',
      'export { Cookies as C } from "effect/unstable/http";',
      'import * as H from "effect/unstable/http"; H.Cookies.parseHeader(peer);',
      'const H = require("effect/unstable/http"); H["Cookies"].parseHeader(peer);',
      'const { Cookies: C } = await import("effect/unstable/http"); C.parseHeader(peer);',
      '(await import("effect/unstable/http")).Cookies.parseHeader(peer);',
    ]) {
      expect(exposureViolations(source).length, source).toBeGreaterThan(0);
    }
    expect(
      exposureViolations(`
      // import "toml"; glob(peer); Cookies.parseHeader(peer);
      const message = 'require("minimatch")';
      import { Effect, Exit, Stream } from "effect";
      import { parse } from "./toml-not-a-package";
      const unrelated = { Cookies: () => undefined }; unrelated.Cookies();
    `),
    ).toEqual([]);
  });

  test("owned product sources have no direct affected TOML/glob/minimatch/Cookie entrypoints", async () => {
    for (const name of ["plugin", "broker", "protocol"]) {
      const paths = await productSources(join(import.meta.dir, "..", "..", name, "src"));
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        expect(exposureViolations(await readFile(path, "utf8")), path).toEqual([]);
      }
    }
  });

  test("source traversal rejects symlinked product sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentbus-exposure-symlink-"));
    try {
      await writeFile(join(root, "target.ts"), 'import "toml";');
      await symlink("target.ts", join(root, "alias.ts"));
      await expect(productSources(root)).rejects.toThrow("Unexpected product-source symlink");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("source traversal includes generated and test-named code inside a product root", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentbus-exposure-sources-"));
    try {
      for (const directory of ["generated", "test"]) {
        await mkdir(join(root, directory));
        await writeFile(join(root, directory, "caller.test.ts"), 'import "toml";');
      }
      const paths = await productSources(root);
      expect(paths).toHaveLength(2);
      for (const path of paths)
        expect(exposureViolations(await readFile(path, "utf8"))).not.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
