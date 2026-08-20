import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { auditProductTree } from "./audit-plugin-source-lib";

const fixtureRoot = resolve(import.meta.dir, "fixtures/auditor");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("plugin source auditor", () => {
  test("accepts safe ToolContext/custom-tool product code", () => {
    expect(auditProductTree(resolve(fixtureRoot, "safe"))).toEqual({
      scannedFiles: 1,
      violations: [],
    });
  });

  for (const fixture of ["direct", "destructured", "aliased", "computed", "imported"]) {
    test(`rejects ${fixture} forbidden API usage`, () => {
      const report = auditProductTree(resolve(fixtureRoot, fixture));
      expect(report.scannedFiles).toBe(1);
      expect(report.violations.length).toBeGreaterThan(0);
    });
  }

  test("scans generated executable product paths", () => {
    const report = auditProductTree(resolve(fixtureRoot, "generated"));
    expect(report.scannedFiles).toBe(1);
    expect(
      report.violations.some((violation) => violation.file.includes("generated/client.ts")),
    ).toBe(true);
  });

  test("scans src/test executable files included by the plugin build", () => {
    const report = auditProductTree(resolve(fixtureRoot, "src-test", "src"));
    expect(report.scannedFiles).toBe(1);
    expect(report.violations.some((violation) => violation.file === "test/forbidden.ts")).toBe(
      true,
    );
  });

  test("rejects executable symlinks instead of following them", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "agentbus-auditor-"));
    temporaryDirectories.push(directory);
    const target = resolve(directory, "target.ts");
    writeFileSync(target, "export const safe = true;\n", "utf8");
    symlinkSync(target, resolve(directory, "linked.ts"));

    const report = auditProductTree(directory);
    expect(report.violations.some((violation) => violation.rule === "executable-symlink")).toBe(
      true,
    );
  });
});
