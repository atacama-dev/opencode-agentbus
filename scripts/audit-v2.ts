import ts from "typescript";
import { FIXED_V2_WAKE_TEXT } from "../packages/plugin/src/wake-v2";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export function auditV2Source(text: string, requireWake = false): readonly string[] {
  const file = ts.createSourceFile("v2.ts", text, ts.ScriptTarget.Latest, true);
  const errors: string[] = [];
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)
      ? unwrap(node.expression)
      : node;
  let wakes = 0;
  if (
    text.includes("nativeHost.") &&
    !text.includes("const nativeHost = requirePairedHost(ctx.host);")
  )
    errors.push("native host capability not gated");
  const path = (node: ts.Expression | undefined): string => {
    if (!node) return "";
    const value = unwrap(node);
    if (ts.isIdentifier(value)) return value.text;
    if (ts.isPropertyAccessExpression(value)) return `${path(value.expression)}.${value.name.text}`;
    return "";
  };
  const allowedHost = new Set(["resolve", "activity", "admitSynthetic", "reconcileSynthetic"]);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && path(node.expression) === "wake.update") {
      let owner: ts.Node | undefined = node.parent;
      let scheduled = false;
      while (owner) {
        if (
          ts.isVariableDeclaration(owner) &&
          ts.isIdentifier(owner.name) &&
          owner.name.text === "schedule"
        )
          scheduled = true;
        owner = owner.parent;
      }
      if (!scheduled) errors.push("wake dispatch outside stable metadata coordinator");
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "admitSynthetic" &&
      path(node) !== "ctx.host.admitSynthetic" &&
      path(node) !== "nativeHost.admitSynthetic"
    )
      errors.push("unreviewed native admission receiver");
    if (ts.isIdentifier(node) && node.text === "ctx") {
      const parent = node.parent;
      const declaration = ts.isParameter(parent) && parent.name === node;
      const direct = ts.isPropertyAccessExpression(parent) && parent.expression === node;
      if (!declaration && !direct) errors.push("context capability escape");
    }
    if (ts.isPropertyAccessExpression(node) && path(node) === "ctx.host") {
      const parent = node.parent;
      const direct =
        ts.isPropertyAccessExpression(parent) &&
        allowedHost.has(parent.name.text) &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent;
      const featureCheck =
        (ts.isPrefixUnaryExpression(parent) &&
          parent.operator === ts.SyntaxKind.ExclamationToken) ||
        (ts.isPropertyAccessExpression(parent) &&
          parent.name.text === "resolve" &&
          ts.isTypeOfExpression(parent.parent)) ||
        (ts.isCallExpression(parent) && path(parent.expression) === "requirePairedHost");
      if (!direct && !featureCheck) errors.push("host capability escape");
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ["prompt", "promptAsync", "synthetic"].includes(node.name.text)
    )
      errors.push("forbidden prompt/synthetic API");
    if (
      ts.isElementAccessExpression(node) &&
      /ctx|host|session|client/u.test(node.expression.getText(file))
    )
      errors.push("computed authority access");
    if (
      ts.isCallExpression(node) &&
      ["ctx.host.admitSynthetic", "nativeHost.admitSynthetic"].includes(path(node.expression))
    ) {
      wakes += 1;
      const input = node.arguments[0];
      const options = node.arguments[1];
      const optionProperty =
        options && ts.isObjectLiteralExpression(options) && options.properties.length === 1
          ? options.properties[0]
          : undefined;
      const signal =
        optionProperty &&
        ts.isPropertyAssignment(optionProperty) &&
        optionProperty.name.getText(file) === "signal"
          ? optionProperty.initializer
          : undefined;
      const scopedSignal =
        signal &&
        ts.isBinaryExpression(signal) &&
        signal.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
        path(signal.left) === "options.signal" &&
        path(signal.right) === "controller.signal";
      if (!signal || (path(signal) !== "controller.signal" && !scopedSignal))
        errors.push("unreviewed native cancellation signal");
      const keys = ["sessionID", "id", "text", "delivery", "resume"];
      if (
        !input ||
        !ts.isObjectLiteralExpression(input) ||
        node.arguments.length !== 2 ||
        input.properties.length !== keys.length ||
        input.properties.some(
          (property) =>
            !ts.isPropertyAssignment(property) || !keys.includes(property.name.getText(file)),
        )
      ) {
        errors.push("invalid fixed wake shape");
      } else {
        const props = new Map(
          input.properties
            .filter(ts.isPropertyAssignment)
            .map((property) => [property.name.getText(file), property.initializer]),
        );
        if (
          path(props.get("sessionID")) !== "input.sessionID" ||
          path(props.get("id")) !== "input.id" ||
          props.get("text")?.getText(file) !== JSON.stringify(FIXED_V2_WAKE_TEXT) ||
          props.get("delivery")?.getText(file) !== '"queue"' ||
          props.get("resume")?.kind !== ts.SyntaxKind.TrueKeyword
        )
          errors.push("non-fixed wake intent");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (wakes > 1 || (requireWake && wakes !== 1)) errors.push("fixed wake cardinality");
  return errors;
}

export function auditV2ProductTree(root: string): readonly string[] {
  const errors: string[] = [];
  let found = false;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
        continue;
      }
      if (!entry.isFile() || !/\.[cm]?[jt]sx?$/u.test(entry.name)) continue;
      const text = readFileSync(file, "utf8");
      if (relative(root, file) === "v2.ts") {
        found = true;
        errors.push(...auditV2Source(text, true));
        continue;
      }
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const check = (node: ts.Node) => {
        let owner: ts.Node | undefined = node.parent;
        let withinCapabilityGate = false;
        while (owner) {
          if (ts.isFunctionDeclaration(owner) && owner.name?.text === "requirePairedHost") {
            withinCapabilityGate = true;
            break;
          }
          owner = owner.parent;
        }
        if (
          (ts.isIdentifier(node) || ts.isStringLiteral(node)) &&
          node.text === "admitSynthetic" &&
          !(
            relative(root, file) === "v2-capabilities.ts" &&
            ((ts.isMethodSignature(node.parent) && node.parent.name === node) ||
              withinCapabilityGate)
          )
        )
          errors.push(`native admission outside reviewed adapter: ${relative(root, file)}`);
        ts.forEachChild(node, check);
      };
      check(source);
    }
  };
  visit(root);
  if (!found) errors.push("missing reviewed V2 adapter");
  return errors;
}
