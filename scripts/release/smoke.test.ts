import { expect, test } from "bun:test";
import { parseArtifact, validateArchiveNames, validateAuditEvidence } from "./smoke";

const artifact = {
  schemaVersion: 1 as const,
  line: "v1" as const,
  packageName: "@atacama-dev/opencode-agentbus-v1",
  version: "0.1.0",
  tarball: "archive.tgz",
  sha256: "a".repeat(64),
  sourceCommit: "b".repeat(40),
};
test("manifest forbids traversal and malformed hashes", () => {
  expect(parseArtifact(artifact)).toEqual(artifact);
  expect(() => parseArtifact({ ...artifact, tarball: "../archive.tgz" })).toThrow();
  expect(() => parseArtifact({ ...artifact, sha256: "bad" })).toThrow();
});

test("audit evidence rejects errors, missing or inconsistent counts, malformed JSON and mismatched status", () => {
  const counts = { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 };
  const report = {
    auditReportVersion: 2,
    vulnerabilities: { zod: { severity: "high" } },
    metadata: { vulnerabilities: counts },
  };
  expect(validateAuditEvidence(JSON.stringify(report), 1)).toEqual(counts);
  expect(() =>
    validateAuditEvidence(JSON.stringify({ ...report, error: { message: "registry offline" } }), 1),
  ).toThrow();
  expect(() => validateAuditEvidence(JSON.stringify({ ...report, metadata: {} }), 1)).toThrow();
  expect(() =>
    validateAuditEvidence(
      JSON.stringify({ ...report, metadata: { vulnerabilities: { ...counts, total: "1" } } }),
      1,
    ),
  ).toThrow();
  expect(() =>
    validateAuditEvidence(
      JSON.stringify({ ...report, metadata: { vulnerabilities: { ...counts, total: 2 } } }),
      1,
    ),
  ).toThrow();
  expect(() => validateAuditEvidence("not JSON", 1)).toThrow();
  expect(() => validateAuditEvidence(JSON.stringify(report), 0)).toThrow();
  expect(() => validateAuditEvidence(JSON.stringify(report), 2)).toThrow();
  const clean = {
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
  };
  expect(validateAuditEvidence(JSON.stringify(clean), 0).total).toBe(0);
  expect(() => validateAuditEvidence(JSON.stringify(clean), 1)).toThrow();
});
test("archive allowlist rejects symlinks, credentials and extra package entries", () => {
  const contents = [
    "package/package.json",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/LICENSE",
    "package/README.md",
    "package/node_modules/@opencode-agentbus/broker/package.json",
    "package/node_modules/@opencode-agentbus/protocol/package.json",
  ];
  expect(() => validateArchiveNames(contents)).not.toThrow();
  expect(() => validateArchiveNames([...contents, "package/.env"])).toThrow();
  expect(() => validateArchiveNames([...contents, "package/package.json"])).toThrow("Duplicate");
  expect(() => validateArchiveNames([...contents, "package/dist/private.test.js"])).toThrow();
});
