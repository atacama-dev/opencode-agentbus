import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

import ts from "typescript";

const EXECUTABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const FORBIDDEN_MEMBERS = new Set(["prompt", "promptAsync", "synthetic"]);
const FORBIDDEN_CLIENT_MODULES = [
  /^@opencode-ai\/sdk(?:\/|$)/u,
  /^@opencode-ai\/client(?:\/|$)/u,
  /^opencode-ai\/sdk(?:\/|$)/u,
];

// Conservative build-graph policy: callers pass the package build root (`packages/plugin/src`).
// Every executable descendant is scanned, including test-named and generated directories.
// Forbidden member names are rejected whether direct, computed, imported, destructured, or aliased.

export type AuditRule = "forbidden-client-module" | "forbidden-member" | "executable-symlink";

export interface AuditViolation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly rule: AuditRule;
  readonly detail: string;
}

export interface AuditReport {
  readonly scannedFiles: number;
  readonly violations: readonly AuditViolation[];
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/u.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function evaluateStaticString(
  node: ts.Expression,
  constants: ReadonlyMap<string, string>,
): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return constants.get(node.text);
  if (ts.isParenthesizedExpression(node)) return evaluateStaticString(node.expression, constants);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluateStaticString(node.left, constants);
    const right = evaluateStaticString(node.right, constants);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function moduleName(node: ts.Node, constants: ReadonlyMap<string, string>): string | undefined {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isCallExpression(node) &&
    node.arguments.length === 1 &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  ) {
    const argument = node.arguments[0];
    return argument ? evaluateStaticString(argument, constants) : undefined;
  }
  return undefined;
}

function forbiddenMemberName(
  node: ts.Node,
  constants: ReadonlyMap<string, string>,
): string | undefined {
  if (ts.isPropertyAccessExpression(node) && FORBIDDEN_MEMBERS.has(node.name.text)) {
    return node.name.text;
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const name = evaluateStaticString(node.argumentExpression, constants);
    return name && FORBIDDEN_MEMBERS.has(name) ? name : undefined;
  }
  if (ts.isBindingElement(node)) {
    const propertyName = node.propertyName ?? node.name;
    if (ts.isIdentifier(propertyName) && FORBIDDEN_MEMBERS.has(propertyName.text)) {
      return propertyName.text;
    }
    if (ts.isStringLiteral(propertyName) && FORBIDDEN_MEMBERS.has(propertyName.text)) {
      return propertyName.text;
    }
  }
  if (ts.isImportSpecifier(node)) {
    const importedName = (node.propertyName ?? node.name).text;
    return FORBIDDEN_MEMBERS.has(importedName) ? importedName : undefined;
  }
  if (
    ts.isIdentifier(node) &&
    node.text === "promptAsync" &&
    ts.isCallExpression(node.parent) &&
    node.parent.expression === node
  ) {
    return node.text;
  }
  return undefined;
}

export function auditSourceText(sourceText: string, fileName: string): readonly AuditViolation[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  const constants = new Map<string, string>();
  const violations: AuditViolation[] = [];

  function collectConstants(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = evaluateStaticString(node.initializer, constants);
      if (value !== undefined) constants.set(node.name.text, value);
    }
    ts.forEachChild(node, collectConstants);
  }
  collectConstants(sourceFile);

  function addViolation(node: ts.Node, rule: AuditRule, detail: string): void {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({
      file: fileName.replaceAll("\\", "/"),
      line: position.line + 1,
      column: position.character + 1,
      rule,
      detail,
    });
  }

  function visit(node: ts.Node): void {
    const importedModule = moduleName(node, constants);
    if (
      importedModule &&
      FORBIDDEN_CLIENT_MODULES.some((pattern) => pattern.test(importedModule))
    ) {
      addViolation(node, "forbidden-client-module", importedModule);
    }

    const member = forbiddenMemberName(node, constants);
    if (member) addViolation(node, "forbidden-member", member);

    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return violations.sort(
    (left, right) =>
      left.line - right.line ||
      left.column - right.column ||
      left.rule.localeCompare(right.rule) ||
      left.detail.localeCompare(right.detail),
  );
}

export function auditProductTree(productRoot: string): AuditReport {
  if (!existsSync(productRoot)) return { scannedFiles: 0, violations: [] };

  const files: string[] = [];
  const violations: AuditViolation[] = [];

  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      const relativePath = relative(productRoot, absolutePath).replaceAll("\\", "/");

      if (entry.isSymbolicLink()) {
        violations.push({
          file: relativePath,
          line: 1,
          column: 1,
          rule: "executable-symlink",
          detail: "Product-tree symlinks are not followed or trusted.",
        });
      } else if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.isFile() && EXECUTABLE_EXTENSIONS.has(extname(entry.name))) {
        files.push(absolutePath);
      }
    }
  }

  walk(productRoot);
  files.sort();
  for (const filePath of files) {
    const relativePath = relative(productRoot, filePath).replaceAll("\\", "/");
    violations.push(...auditSourceText(readFileSync(filePath, "utf8"), relativePath));
  }

  return {
    scannedFiles: files.length,
    violations: violations.sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.column - right.column ||
        left.rule.localeCompare(right.rule),
    ),
  };
}
