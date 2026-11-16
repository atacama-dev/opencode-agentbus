import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type PackageArtifact,
  REPOSITORY_ROOT,
  type ReleaseConfig,
  isReleaseVersion,
  readReleaseConfig,
} from "./config";
import {
  RELEASE_REPOSITORY,
  assertCleanAudit,
  assertAuditedArtifact,
  assertPublicationAllowed,
  eventFromEnvironment,
  readArtifact,
  record,
  releaseEvent,
  validateManifest,
  verifySource,
} from "./policy";
import type { AuditContext } from "../security/audit";

interface PublicationInput {
  config: ReleaseConfig;
  event: unknown;
  eventName: string;
  manifest: PackageArtifact;
  bytes: Uint8Array;
  audit: unknown;
  auditContext?: AuditContext;
  auditExit?: number;
  sourceCommit: string;
}

export interface PublicationIO {
  github(url: string, init?: RequestInit): Promise<Response>;
  registry(url: string): Promise<Response>;
  publish(args: readonly string[]): Promise<void>;
  npmConfigDir: string;
}

const API = `https://api.github.com/repos/${RELEASE_REPOSITORY}`;
const UPLOADS = `https://uploads.github.com/repos/${RELEASE_REPOSITORY}`;

export function compareReleaseVersions(left: string, right: string): -1 | 0 | 1 {
  if (!isReleaseVersion(left) || !isReleaseVersion(right))
    throw new Error("Unsupported release version in npm channel metadata.");
  const parts = (version: string) => {
    const separator = version.indexOf("-");
    return {
      core: (separator < 0 ? version : version.slice(0, separator)).split("."),
      prerelease: separator < 0 ? undefined : version.slice(separator + 1).split("."),
    };
  };
  const compareParts = (a: string[], b: string[]): -1 | 0 | 1 => {
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const first = a[index];
      const second = b[index];
      if (first === undefined) return -1;
      if (second === undefined) return 1;
      if (first === second) continue;
      const numericFirst = /^[0-9]+$/u.test(first);
      const numericSecond = /^[0-9]+$/u.test(second);
      if (numericFirst && numericSecond) return BigInt(first) < BigInt(second) ? -1 : 1;
      if (numericFirst !== numericSecond) return numericFirst ? -1 : 1;
      return first < second ? -1 : 1;
    }
    return 0;
  };
  const a = parts(left);
  const b = parts(right);
  const core = compareParts(a.core, b.core);
  if (core !== 0) return core;
  if (!a.prerelease) return b.prerelease ? 1 : 0;
  if (!b.prerelease) return -1;
  return compareParts(a.prerelease, b.prerelease);
}

export function versionAtLeast(value: string, minimum: readonly [number, number, number]) {
  const match = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(value);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return false;
  for (let index = 0; index < 3; index++) {
    if (parts[index] !== minimum[index]) return (parts[index] ?? -1) > (minimum[index] ?? 0);
  }
  return true;
}

export function assertTrustedPublishingVersions(node: string, npm: string) {
  if (!versionAtLeast(node, [22, 14, 0]) || !versionAtLeast(npm, [11, 5, 1]))
    throw new Error("Trusted publication requires stable Node >=22.14.0 and npm >=11.5.1.");
}

/** Only the official setup-node tool-cache layout is executable, never a build artifact. */
export function trustedRuntimePaths(toolCache: string, node: string) {
  if (
    !isAbsolute(toolCache) ||
    resolve(toolCache) !== toolCache ||
    !isAbsolute(node) ||
    resolve(node) !== node ||
    !/^node\/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\/x64\/bin\/node$/u.test(
      relative(toolCache, node),
    )
  )
    throw new Error("Publication runtime must come from the official setup-node tool cache.");
  return { node, npmCli: join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js") };
}

function npmConfigPaths(cwd: string) {
  return { user: "/dev/null", global: join(cwd, ".npmrc-global") };
}

export function npmConfigArgs(cwd: string): [string, string] {
  const config = npmConfigPaths(cwd);
  return [`--userconfig=${config.user}`, `--globalconfig=${config.global}`];
}

export function prepareNpmConfig(cwd: string) {
  writeFileSync(npmConfigPaths(cwd).global, "", { flag: "wx", mode: 0o600 });
}

/** Version probes get no credentials; only the real publish receives short-lived OIDC authority. */
export function npmEnvironment(
  source: NodeJS.ProcessEnv,
  node: string,
  cwd: string,
  publish: boolean,
): NodeJS.ProcessEnv {
  const config = npmConfigPaths(cwd);
  const env: NodeJS.ProcessEnv = {
    PATH: `${dirname(node)}:/usr/bin:/bin`,
    HOME: cwd,
    npm_config_cache: join(cwd, ".npm-cache"),
    NPM_CONFIG_USERCONFIG: config.user,
    NPM_CONFIG_GLOBALCONFIG: config.global,
    CI: "true",
  };
  for (const key of [
    "GITHUB_ACTIONS",
    "GITHUB_SERVER_URL",
    "GITHUB_REPOSITORY",
    "GITHUB_REPOSITORY_ID",
    "GITHUB_REPOSITORY_OWNER",
    "GITHUB_REPOSITORY_OWNER_ID",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_WORKFLOW_SHA",
    "GITHUB_WORKFLOW",
    "GITHUB_JOB",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_SHA",
    "GITHUB_REF",
    "GITHUB_EVENT_NAME",
    "RUNNER_ENVIRONMENT",
    ...(publish ? ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"] : []),
  ]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function json(response: Response) {
  if (!response.ok) throw new Error(`Release API request failed (HTTP ${response.status}).`);
  return record(await response.json());
}

function id(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new Error("Invalid GitHub resource ID.");
  return value as number;
}

/** All external effects are injectable; tests never invoke npm or GitHub writes. */
export async function publishRelease(input: PublicationInput, io: PublicationIO) {
  const release = releaseEvent(input.eventName, input.event, input.config);
  assertPublicationAllowed(input.config, release);
  const verifyAudit = () => {
    if (input.auditContext !== undefined)
      return assertAuditedArtifact(
        input.manifest,
        input.config,
        input.sourceCommit,
        input.audit,
        input.auditContext,
        input.auditExit as number,
        JSON.parse(readFileSync(join(REPOSITORY_ROOT, "security/audit-exceptions.json"), "utf8")),
      );
    assertCleanAudit(input.audit);
  };
  const auditDecision = verifyAudit();
  const manifest = validateManifest(input.manifest, input.config, release.line, input.sourceCommit);
  if (sha256(input.bytes) !== manifest.sha256) throw new Error("Archive digest mismatch.");
  const integrity = `sha512-${createHash("sha512").update(input.bytes).digest("base64")}`;
  const assets = [
    { name: manifest.tarball, bytes: input.bytes, contentType: "application/octet-stream" },
    {
      name: "manifest.json",
      bytes: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
      contentType: "application/json",
    },
    {
      name: "audit.json",
      bytes: new TextEncoder().encode(`${JSON.stringify(input.audit, null, 2)}\n`),
      contentType: "application/json",
    },
    {
      name: "SHA256SUMS",
      bytes: new TextEncoder().encode(`${manifest.sha256}  ${manifest.tarball}\n`),
      contentType: "text/plain",
    },
  ];
  if (input.auditContext !== undefined && auditDecision !== undefined) {
    for (const [name, value] of [
      ["audit-context.json", input.auditContext],
      ["audit-exit.json", { exitCode: input.auditExit }],
      ["audit-decision.json", auditDecision],
    ] as const)
      assets.push({
        name,
        bytes: new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`),
        contentType: "application/json",
      });
  }

  const verifyLive = async () => {
    const repository = await json(await io.github(API));
    if (repository.full_name !== RELEASE_REPOSITORY || repository.private !== false)
      throw new Error("Live repository must be canonical and public before any release write.");
    const current = await json(await io.github(`${API}/releases/${release.releaseId}`));
    const live = releaseEvent(
      "release",
      { action: "published", repository, release: current },
      input.config,
    );
    if (live.releaseId !== release.releaseId || live.tag !== release.tag)
      throw new Error("Published release identity changed.");
    const reference = await json(
      await io.github(`${API}/git/ref/tags/${encodeURIComponent(release.tag)}`),
    );
    const tagObject = record(reference.object);
    if (tagObject.type !== "tag" || !/^[a-f0-9]{40}$/u.test(String(tagObject.sha)))
      throw new Error("Release reference must still be an annotated tag.");
    const tag = await json(await io.github(`${API}/git/tags/${tagObject.sha}`));
    const target = record(tag.object);
    if (tag.tag !== release.tag || target.type !== "commit" || target.sha !== input.sourceCommit)
      throw new Error("Annotated release tag no longer points to the verified source commit.");
    let protectedAncestor = false;
    for (const name of ["main", `maintenance/opencode-${release.line}`]) {
      const response = await io.github(`${API}/branches/${encodeURIComponent(name)}`);
      if (response.status === 404) continue;
      const branch = await json(response);
      if (branch.name !== name || branch.protected !== true) continue;
      const tip = record(branch.commit).sha;
      if (typeof tip !== "string" || !/^[a-f0-9]{40}$/u.test(tip))
        throw new Error("Invalid protected branch commit.");
      const comparison = await json(
        await io.github(`${API}/compare/${input.sourceCommit}...${tip}`),
      );
      if (
        ["ahead", "identical"].includes(String(comparison.status)) &&
        record(comparison.merge_base_commit).sha === input.sourceCommit
      ) {
        protectedAncestor = true;
        break;
      }
    }
    if (!protectedAncestor)
      throw new Error("Live source ancestry on an allowed protected branch is required.");
  };
  await verifyLive();

  // Preflight *all* existing assets before the first immutable npm write.
  const existing: Record<string, number> = {};
  for (let page = 1; ; page++) {
    if (page > 10) throw new Error("Too many release assets; manual inspection required.");
    const response = await io.github(
      `${API}/releases/${release.releaseId}/assets?per_page=100&page=${page}`,
    );
    if (!response.ok) throw new Error("Cannot list existing release assets.");
    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) throw new Error("Malformed release asset list.");
    for (const value of rows) {
      const asset = record(value);
      if (typeof asset.name !== "string") throw new Error("Malformed release asset name.");
      if (!assets.some((item) => item.name === asset.name)) continue;
      if (Object.hasOwn(existing, asset.name)) throw new Error("Duplicate release asset name.");
      existing[asset.name] = id(asset.id);
    }
    if (rows.length < 100) break;
  }
  for (const asset of assets) {
    if (!Object.hasOwn(existing, asset.name)) continue;
    const response = await io.github(`${API}/releases/assets/${existing[asset.name]}`, {
      headers: { Accept: "application/octet-stream" },
    });
    if (
      !response.ok ||
      sha256(new Uint8Array(await response.arrayBuffer())) !== sha256(asset.bytes)
    )
      throw new Error(
        "Existing release asset differs; never overwrite an immutable release asset.",
      );
  }

  const version = await io.registry(
    `https://registry.npmjs.org/${encodeURIComponent(manifest.packageName)}/${encodeURIComponent(manifest.version)}`,
  );
  let alreadyPublished = false;
  if (version.status === 200) {
    const entry = await json(version);
    if (
      entry.name !== manifest.packageName ||
      entry.version !== manifest.version ||
      record(entry.dist).integrity !== integrity
    )
      throw new Error(
        "npm version already exists with different integrity; operator intervention required.",
      );
    alreadyPublished = true;
  } else if (version.status !== 404) {
    throw new Error("Unable to establish npm name/version state; refusing publication.");
  }
  if (!alreadyPublished) {
    await verifyLive();
    // The per-line workflow lock serializes our publishers, not external npm administrators.
    // Keep this channel read immediately adjacent to publish; npm offers no registry CAS.
    const channel = await io.registry(
      `https://registry.npmjs.org/${encodeURIComponent(manifest.packageName)}/${release.npmTag}`,
    );
    if (channel.status === 200) {
      const current = await json(channel);
      if (
        current.name !== manifest.packageName ||
        !isReleaseVersion(current.version) ||
        compareReleaseVersions(manifest.version, current.version) <= 0
      )
        throw new Error(
          "npm channel identity/version is invalid or publication would not advance it.",
        );
    } else if (channel.status !== 404) {
      throw new Error("Unable to establish the current npm channel; refusing publication.");
    }
    verifyAudit();
    await io.publish([
      "publish",
      manifest.tarball,
      "--ignore-scripts",
      "--access",
      "public",
      "--tag",
      release.npmTag,
      "--provenance",
      "--registry=https://registry.npmjs.org",
      ...npmConfigArgs(io.npmConfigDir),
    ]);
    const published = await json(
      await io.registry(
        `https://registry.npmjs.org/${encodeURIComponent(manifest.packageName)}/${encodeURIComponent(manifest.version)}`,
      ),
    );
    if (
      published.name !== manifest.packageName ||
      published.version !== manifest.version ||
      record(published.dist).integrity !== integrity
    )
      throw new Error(
        "Published npm integrity did not match the tested archive; stop and investigate.",
      );
  }
  // A retry after npm success only attaches missing matching assets; it never moves old dist-tags.
  for (const asset of assets) {
    if (Object.hasOwn(existing, asset.name)) continue;
    await verifyLive();
    verifyAudit();
    const response = await io.github(
      `${UPLOADS}/releases/${release.releaseId}/assets?name=${encodeURIComponent(asset.name)}`,
      {
        method: "POST",
        headers: { "Content-Type": asset.contentType },
        body: new Blob([asset.bytes]),
      },
    );
    if (!response.ok)
      throw new Error("Release asset upload failed; retry this job with the same tested artifact.");
  }
  return {
    alreadyPublished,
    uploadedAssets: assets.filter((asset) => !Object.hasOwn(existing, asset.name)).length,
  };
}

if (import.meta.main) {
  const [flag, manifestPath] = process.argv.slice(2);
  if (flag !== "--manifest" || !manifestPath || process.argv.length !== 4)
    throw new Error("Usage: publication.ts --manifest <tested-manifest.json>");
  const config = readReleaseConfig();
  const release = eventFromEnvironment(config);
  assertPublicationAllowed(config, release);
  const expectedCommit = process.env.RELEASE_SOURCE_COMMIT;
  if (!expectedCommit || !/^[a-f0-9]{40}$/u.test(expectedCommit))
    throw new Error("The verified source job's exact commit is required.");
  const sourceCommit = verifySource(REPOSITORY_ROOT, release.tag, release.line, expectedCommit);
  const artifact = readArtifact(resolve(manifestPath), config, release.line, sourceCommit);
  const audit = JSON.parse(
    readFileSync(join(dirname(resolve(manifestPath)), "audit.json"), "utf8"),
  );
  const auditContext = JSON.parse(
    readFileSync(join(dirname(resolve(manifestPath)), "audit-context.json"), "utf8"),
  );
  const auditExit = record(
    JSON.parse(readFileSync(join(dirname(resolve(manifestPath)), "audit-exit.json"), "utf8")),
  ).exitCode as number;
  const token = process.env.GH_TOKEN;
  if (!token || process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN)
    throw new Error("GitHub token required; long-lived npm tokens are forbidden.");
  const tools = trustedRuntimePaths(
    process.env.RUNNER_TOOL_CACHE ?? "",
    process.env.RELEASE_NODE_BINARY ?? "",
  );
  for (const path of [tools.node, tools.npmCli]) {
    if (!lstatSync(path).isFile() || realpathSync(path) !== path)
      throw new Error("Trusted Node/npm files must be regular, canonical tool-cache files.");
  }
  const cwd = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "agentbus-publish-"));
  prepareNpmConfig(cwd);
  const probeOptions = {
    cwd,
    env: npmEnvironment(process.env, tools.node, cwd, false),
    encoding: "utf8" as const,
    stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
  };
  assertTrustedPublishingVersions(
    execFileSync(tools.node, ["--version"], probeOptions).trim(),
    execFileSync(
      tools.node,
      [tools.npmCli, "--version", ...npmConfigArgs(cwd)],
      probeOptions,
    ).trim(),
  );
  await publishRelease(
    {
      config,
      event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")),
      eventName: process.env.GITHUB_EVENT_NAME ?? "",
      manifest: artifact.manifest,
      bytes: new Uint8Array(artifact.bytes),
      sourceCommit,
      audit,
      auditContext,
      auditExit,
    },
    {
      npmConfigDir: cwd,
      github: (url, init) => {
        if (!url.startsWith(`${API}/`) && url !== API && !url.startsWith(`${UPLOADS}/`))
          throw new Error("Unexpected GitHub endpoint.");
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${token}`);
        if (!headers.has("Accept")) headers.set("Accept", "application/vnd.github+json");
        headers.set("X-GitHub-Api-Version", "2022-11-28");
        return fetch(url, { ...init, headers });
      },
      registry: (url) => {
        if (!url.startsWith("https://registry.npmjs.org/")) throw new Error("Unexpected registry.");
        return fetch(url, { redirect: "error" });
      },
      publish: async (args) => {
        const absolute = [...args];
        absolute[1] = artifact.tarballPath;
        try {
          execFileSync(tools.node, [tools.npmCli, ...absolute], {
            cwd,
            stdio: "ignore",
            env: npmEnvironment(process.env, tools.node, cwd, true),
          });
        } catch {
          throw new Error(
            "npm trusted publication failed; retry the same archive after checking registry state.",
          );
        }
      },
    },
  );
}
