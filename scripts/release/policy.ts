import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type PackageArtifact,
  REPOSITORY_ROOT,
  type ReleaseConfig,
  type ReleaseLine,
  parseReleaseTag,
  readReleaseConfig,
} from "./config";
import { evaluateAudit, type AuditContext } from "../security/audit";

export const RELEASE_REPOSITORY = "atacama-dev/opencode-agentbus";

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
}

export function releaseEvent(eventName: string, value: unknown, config: ReleaseConfig) {
  const event = record(value);
  const repository = record(event.repository);
  const release = record(event.release);
  if (
    eventName !== "release" ||
    event.action !== "published" ||
    repository.full_name !== RELEASE_REPOSITORY ||
    typeof repository.private !== "boolean" ||
    release.draft !== false ||
    !Number.isSafeInteger(release.id) ||
    (release.id as number) <= 0 ||
    typeof release.tag_name !== "string"
  )
    throw new Error("Only an existing published release in the canonical repository is eligible.");
  const parsed = parseReleaseTag(release.tag_name, config);
  if (release.prerelease !== parsed.prerelease)
    throw new Error("GitHub prerelease status must match the semantic version.");
  return {
    ...parsed,
    tag: release.tag_name,
    releaseId: release.id as number,
    privateRepository: repository.private,
  };
}

export function assertPublicationAllowed(
  config: ReleaseConfig,
  release: ReturnType<typeof releaseEvent>,
) {
  if (!config.readiness[release.line])
    throw new Error("Release readiness is false; building evidence is not release approval.");
  if (!config.publishEnabled) throw new Error("Publication is disabled in release.config.json.");
  if (release.privateRepository)
    throw new Error(
      "Public publication is blocked by repository policy until the repository is public (provenance).",
    );
}

export function assertCleanAudit(value: unknown) {
  const audit = record(value);
  const metadata = record(audit.metadata);
  const dependencies = record(metadata.dependencies);
  const counts = record(metadata.vulnerabilities);
  if (
    audit.auditReportVersion !== 2 ||
    "error" in audit ||
    !Number.isSafeInteger(dependencies.prod) ||
    (dependencies.prod as number) < 1 ||
    Object.keys(record(audit.vulnerabilities)).length !== 0 ||
    ["info", "low", "moderate", "high", "critical", "total"].some((key) => counts[key] !== 0)
  )
    throw new Error("Production install audit is missing, malformed, or contains vulnerabilities.");
}

/** Recompute from raw evidence, never trust an artifact's prior verdict. */
export function assertAuditedArtifact(
  manifest: PackageArtifact,
  config: ReleaseConfig,
  sourceCommit: string,
  audit: unknown,
  context: AuditContext,
  exitCode: number,
  ledger: unknown,
) {
  validateManifest(manifest, config, manifest.line, sourceCommit);
  if (!Number.isSafeInteger(exitCode) || (exitCode !== 0 && exitCode !== 1))
    throw new Error("Missing or invalid raw npm audit exit status");
  const expected = {
    line: manifest.line,
    packageName: manifest.packageName,
    version: manifest.version,
    sha256: manifest.sha256,
    sourceCommit: manifest.sourceCommit,
  };
  return evaluateAudit(audit, context, ledger, { expected, profile: "production", exitCode });
}

export function validateManifest(
  value: unknown,
  config: ReleaseConfig,
  line: ReleaseLine,
  sourceCommit: string,
): PackageArtifact {
  const data = record(value);
  if (
    Object.keys(data).sort().join(",") !==
      "line,packageName,schemaVersion,sha256,sourceCommit,tarball,version" ||
    data.schemaVersion !== 1 ||
    data.line !== line ||
    !config.supportedLines.includes(line) ||
    data.packageName !== config.packageNames[line] ||
    data.version !== config.version ||
    typeof data.tarball !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/u.test(data.tarball) ||
    typeof data.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(data.sha256) ||
    !/^[a-f0-9]{40}$/u.test(sourceCommit) ||
    data.sourceCommit !== sourceCommit
  )
    throw new Error("Artifact manifest does not match the verified source, line, name or version.");
  return data as unknown as PackageArtifact;
}

export function readArtifact(
  manifestPath: string,
  config: ReleaseConfig,
  line: ReleaseLine,
  sourceCommit: string,
) {
  const manifest = validateManifest(
    JSON.parse(readFileSync(manifestPath, "utf8")),
    config,
    line,
    sourceCommit,
  );
  const folder = realpathSync(dirname(manifestPath));
  const tarballPath = resolve(folder, manifest.tarball);
  if (!lstatSync(tarballPath).isFile() || realpathSync(tarballPath) !== tarballPath)
    throw new Error("Archive must be a regular file inside the artifact directory.");
  const bytes = readFileSync(tarballPath);
  if (createHash("sha256").update(new Uint8Array(bytes)).digest("hex") !== manifest.sha256)
    throw new Error("Archive SHA-256 does not match the tested manifest.");
  const metadata = JSON.parse(
    execFileSync("tar", ["-xOf", tarballPath, "package/package.json"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }),
  );
  if (metadata.name !== manifest.packageName || metadata.version !== manifest.version)
    throw new Error("Archive package metadata differs from the manifest.");
  return { manifest, tarballPath, bytes };
}

export function verifySource(root: string, tag: string, line: ReleaseLine, expected?: string) {
  if (!/^opencode-v[12]\/v[0-9A-Za-z.-]+$/u.test(tag)) throw new Error("Invalid tag.");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const commit = git("rev-parse", "HEAD");
  if (
    !/^[a-f0-9]{40}$/u.test(commit) ||
    (expected !== undefined && commit !== expected) ||
    git("cat-file", "-t", `refs/tags/${tag}`) !== "tag" ||
    git("rev-parse", `refs/tags/${tag}^{commit}`) !== commit ||
    git("status", "--porcelain", "--untracked-files=normal") !== ""
  )
    throw new Error("Release requires a clean checkout of the exact annotated tag commit.");
  const allowed = ["refs/remotes/origin/main", `refs/remotes/origin/maintenance/opencode-${line}`];
  const reachable = allowed.some((branch) => {
    try {
      git("merge-base", "--is-ancestor", commit, branch);
      return true;
    } catch {
      return false;
    }
  });
  if (!reachable) throw new Error("Release source is not on an allowed protected branch.");
  return commit;
}

export function eventFromEnvironment(config: ReleaseConfig) {
  return releaseEvent(
    process.env.GITHUB_EVENT_NAME ?? "",
    JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")),
    config,
  );
}

if (import.meta.main) {
  const config = readReleaseConfig();
  const args = process.argv.slice(2);
  const [command, path] = args;
  if (command === "matrix" && args.length === 1) {
    console.log(JSON.stringify(config.supportedLines));
  } else if (command === "audit" && path && args.length === 2) {
    const folder = dirname(resolve(path));
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    }).trim();
    const decision = assertAuditedArtifact(
      manifest,
      config,
      commit,
      JSON.parse(readFileSync(resolve(folder, "audit.json"), "utf8")),
      JSON.parse(readFileSync(resolve(folder, "audit-context.json"), "utf8")),
      record(JSON.parse(readFileSync(resolve(folder, "audit-exit.json"), "utf8")))
        .exitCode as number,
      JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, "security/audit-exceptions.json"), "utf8")),
    );
    console.log(
      JSON.stringify({
        status: decision.status,
        rawAffectedPackages: decision.rawAffectedPackages,
        rawAdvisories: decision.rawAdvisories,
        acceptedRoutes: decision.accepted.length,
      }),
    );
  } else if (command === "authorize" && args.length === 1) {
    assertPublicationAllowed(config, eventFromEnvironment(config));
  } else if (command === "source" && args.length === 1) {
    const release = eventFromEnvironment(config);
    const sourceCommit = verifySource(REPOSITORY_ROOT, release.tag, release.line);
    const output = process.env.GITHUB_OUTPUT;
    if (!output) throw new Error("GITHUB_OUTPUT is required.");
    appendFileSync(
      output,
      `line=${release.line}\nsourceCommit=${sourceCommit}\nenvironment=npm-${release.line}\n`,
    );
  } else {
    throw new Error("Usage: policy.ts matrix | source | authorize | audit <tested-manifest.json>");
  }
}
