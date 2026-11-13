import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReleaseConfig, readReleaseConfig } from "./config";
import {
  assertCleanAudit,
  assertPublicationAllowed,
  readArtifact,
  releaseEvent,
  validateManifest,
  verifySource,
} from "./policy";

const config = parseReleaseConfig({
  ...readReleaseConfig(),
  releaseLine: "v2",
  supportedLines: ["v1", "v2"],
  version: "0.1.0",
  readiness: { v1: true, v2: true },
  publishEnabled: true,
});
const sourceCommit = "a".repeat(40);
const event = {
  action: "published",
  repository: { full_name: "atacama-dev/opencode-agentbus", private: false },
  release: { id: 7, tag_name: "opencode-v2/v0.1.0", draft: false, prerelease: false },
};
const cleanAudit = {
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    dependencies: { prod: 4 },
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
  },
};

test("release policy accepts only canonical published, matching releases", () => {
  expect(releaseEvent("release", event, config)).toMatchObject({ line: "v2", npmTag: "latest" });
  for (const name of ["push", "pull_request", "workflow_dispatch"])
    expect(() => releaseEvent(name, event, config)).toThrow();
  for (const bad of [
    { ...event, action: "created" },
    { ...event, repository: { ...event.repository, full_name: "fork/opencode-agentbus" } },
    { ...event, repository: { full_name: event.repository.full_name } },
    { ...event, release: { ...event.release, draft: true } },
    { ...event, release: { ...event.release, prerelease: true } },
    { ...event, release: { ...event.release, id: -1 } },
    { ...event, release: { ...event.release, tag_name: "opencode-v1/v0.1.0" } },
    { ...event, release: { ...event.release, tag_name: "opencode-v2/v9.9.9" } },
    { ...event, release: { ...event.release, tag_name: "opencode-v2/v0.1.0;echo" } },
  ])
    expect(() => releaseEvent("release", bad, config)).toThrow();
  const beta = { ...config, version: "0.1.0-rc.1" };
  expect(
    releaseEvent(
      "release",
      {
        ...event,
        release: { ...event.release, tag_name: "opencode-v2/v0.1.0-rc.1", prerelease: true },
      },
      beta,
    ),
  ).toMatchObject({ prerelease: true, npmTag: "next" });
});

test("readiness, publication switch, and public-provenance policy fail closed independently", () => {
  const release = releaseEvent("release", event, config);
  expect(() => assertPublicationAllowed(config, release)).not.toThrow();
  expect(() =>
    assertPublicationAllowed({ ...config, readiness: { v1: true, v2: false } }, release),
  ).toThrow("readiness");
  expect(() => assertPublicationAllowed({ ...config, publishEnabled: false }, release)).toThrow(
    "disabled",
  );
  expect(() => assertPublicationAllowed(config, { ...release, privateRepository: true })).toThrow(
    "repository policy",
  );
});

test("production audit rejects every severity, malformed reports, empty graphs and API failures", () => {
  expect(() => assertCleanAudit(cleanAudit)).not.toThrow();
  for (const key of ["info", "low", "moderate", "high", "critical", "total"])
    expect(() =>
      assertCleanAudit({
        ...cleanAudit,
        metadata: {
          ...cleanAudit.metadata,
          vulnerabilities: { ...cleanAudit.metadata.vulnerabilities, [key]: 1 },
        },
      }),
    ).toThrow();
  for (const bad of [
    {},
    { ...cleanAudit, error: {} },
    { ...cleanAudit, auditReportVersion: 1 },
    { ...cleanAudit, vulnerabilities: { hidden: {} } },
    { ...cleanAudit, metadata: { ...cleanAudit.metadata, dependencies: { prod: 0 } } },
    { ...cleanAudit, metadata: { ...cleanAudit.metadata, vulnerabilities: { total: 0 } } },
  ])
    expect(() => assertCleanAudit(bad)).toThrow();
});

test("manifest rejects traversal, wrong identity, digest and source commit", () => {
  const manifest = {
    schemaVersion: 1,
    line: "v2",
    packageName: config.packageNames.v2,
    version: config.version,
    tarball: "agentbus.tgz",
    sha256: "b".repeat(64),
    sourceCommit,
  } as const;
  expect(validateManifest(manifest, config, "v2", sourceCommit)).toEqual(manifest);
  for (const change of [
    { tarball: "../agentbus.tgz" },
    { tarball: "/agentbus.tgz" },
    { tarball: "dir/agentbus.tgz" },
    { tarball: "x\\agentbus.tgz" },
    { tarball: "--option.tgz" },
    { tarball: "x.tgz\n" },
    { sha256: "cafe" },
    { sourceCommit: "c".repeat(40) },
    { line: "v1" },
    { packageName: config.packageNames.v1 },
    { version: "0.2.0" },
    { unexpected: true },
  ])
    expect(() =>
      validateManifest({ ...manifest, ...change }, config, "v2", sourceCommit),
    ).toThrow();
});

test("actual archive digest, regular-file containment and package metadata are rechecked", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbus-artifact-policy-"));
  try {
    mkdirSync(join(root, "package"));
    const metadata = join(root, "package/package.json");
    writeFileSync(
      metadata,
      JSON.stringify({ name: config.packageNames.v2, version: config.version }),
    );
    const tarball = join(root, "agentbus.tgz");
    execFileSync("tar", ["-czf", tarball, "-C", root, "package"]);
    const manifest = {
      schemaVersion: 1,
      line: "v2",
      packageName: config.packageNames.v2,
      version: config.version,
      tarball: "agentbus.tgz",
      sourceCommit,
      sha256: createHash("sha256")
        .update(new Uint8Array(readFileSync(tarball)))
        .digest("hex"),
    } as const;
    const path = join(root, "manifest.json");
    writeFileSync(path, JSON.stringify(manifest));
    expect(readArtifact(path, config, "v2", sourceCommit).manifest).toEqual(manifest);
    writeFileSync(tarball, "corrupt");
    expect(() => readArtifact(path, config, "v2", sourceCommit)).toThrow("SHA-256");
    writeFileSync(metadata, JSON.stringify({ name: "@wrong/name", version: config.version }));
    execFileSync("tar", ["-czf", tarball, "-C", root, "package"]);
    writeFileSync(
      path,
      JSON.stringify({
        ...manifest,
        sha256: createHash("sha256")
          .update(new Uint8Array(readFileSync(tarball)))
          .digest("hex"),
      }),
    );
    expect(() => readArtifact(path, config, "v2", sourceCommit)).toThrow("package metadata");
    rmSync(tarball);
    symlinkSync(metadata, tarball);
    expect(() => readArtifact(path, config, "v2", sourceCommit)).toThrow("regular file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source proof requires annotated tag, exact HEAD, clean tree and protected-branch ancestry", () => {
  // All refs below exist only inside this disposable fixture, never in the checkout.
  const root = mkdtempSync(join(tmpdir(), "agentbus-source-policy-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const tag = "opencode-v2/v0.1.0";
  try {
    git("init", "--initial-branch=main");
    writeFileSync(join(root, "source"), "fixture");
    git("add", "source");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    const commit = git("rev-parse", "HEAD");
    git("tag", tag);
    git("update-ref", "refs/remotes/origin/main", commit);
    expect(() => verifySource(root, tag, "v2")).toThrow("annotated");
    git("tag", "-d", tag);
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "tag",
      "-a",
      tag,
      "-m",
      "fixture",
    );
    expect(verifySource(root, tag, "v2")).toBe(commit);
    expect(() => verifySource(root, tag, "v2", "a".repeat(40))).toThrow();
    writeFileSync(join(root, "source"), "changed");
    expect(() => verifySource(root, tag, "v2")).toThrow("clean");
    writeFileSync(join(root, "source"), "fixture");
    git("update-ref", "-d", "refs/remotes/origin/main");
    expect(() => verifySource(root, tag, "v2")).toThrow("protected branch");
    git("update-ref", "refs/remotes/origin/maintenance/opencode-v1", commit);
    expect(() => verifySource(root, tag, "v2")).toThrow("protected branch");
    git("update-ref", "refs/remotes/origin/maintenance/opencode-v2", commit);
    expect(verifySource(root, tag, "v2")).toBe(commit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
