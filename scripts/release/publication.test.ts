import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PackageArtifact, parseReleaseConfig, readReleaseConfig } from "./config";
import {
  type PublicationIO,
  assertTrustedPublishingVersions,
  compareReleaseVersions,
  npmEnvironment,
  prepareNpmConfig,
  publishRelease,
  trustedRuntimePaths,
  versionAtLeast,
} from "./publication";

test("channel ordering follows supported SemVer, including arbitrarily large numeric prereleases", () => {
  const ordered = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.10",
    "1.0.0-beta.a",
    "1.0.0-rc.900719925474099200",
    "1.0.0-rc.900719925474099201",
    "1.0.0",
    "1.0.1-alpha",
    "1.0.1",
    "1.1.0",
    "2.0.0",
  ];
  for (const [leftIndex, left] of ordered.entries()) {
    for (const [rightIndex, right] of ordered.entries()) {
      const expected = leftIndex === rightIndex ? 0 : leftIndex < rightIndex ? -1 : 1;
      expect(compareReleaseVersions(left, right)).toBe(expected);
    }
  }
  for (const bad of [
    "1.0",
    "01.0.0",
    "1.0.0+build",
    "1.0.0-beta.01",
    "9007199254740992.0.0",
    "1.0.0\n",
  ])
    expect(() => compareReleaseVersions("1.0.0", bad)).toThrow("Unsupported");
});

test("trusted publishing version minima compare numeric stable semver", () => {
  for (const [node, npm] of [
    ["v22.14.0", "11.5.1"],
    ["24.1.0", "11.10.0"],
    ["24.0.0", "12.0.0"],
  ])
    expect(() => assertTrustedPublishingVersions(node ?? "", npm ?? "")).not.toThrow();
  for (const [node, npm] of [
    ["22.13.9", "12.2.0"],
    ["21.99.99", "12.2.0"],
    ["24.0.0", "11.5.0"],
    ["24.0.0", "10.99.99"],
    ["24.0.0-rc.1", "12.2.0"],
    ["24.0.0", "11.5.1-beta.1"],
  ])
    expect(() => assertTrustedPublishingVersions(node ?? "", npm ?? "")).toThrow();
  expect(versionAtLeast("11.10.0", [11, 5, 1])).toBe(true);
  for (const bad of [
    "11.5",
    "011.5.1",
    "11.5.1;id",
    "11.5.1\n",
    "11.5.1+build",
    "9007199254740992.0.0",
  ])
    expect(versionAtLeast(bad, [11, 5, 1])).toBe(false);
});

test("runtime paths are confined to the official Node tool cache, never downloaded tools", () => {
  const cache = "/opt/hostedtoolcache";
  const node = `${cache}/node/24.1.0/x64/bin/node`;
  expect(trustedRuntimePaths(cache, node)).toEqual({
    node,
    npmCli: `${cache}/node/24.1.0/x64/lib/node_modules/npm/bin/npm-cli.js`,
  });
  for (const bad of [
    "/workspace/release-artifacts/node",
    "/workspace/node_modules/.bin/node",
    `${cache}/node/24.1.0/x64/bin/../bin/node`,
    `${cache}/../untrusted/node`,
    `${cache}/node/24.1.0/x64/lib/node_modules/npm/bin/npm-cli.js`,
    `${cache}/node/24.1.0-rc.1/x64/bin/node`,
    `${cache}-other/node/24.1.0/x64/bin/node`,
    "node",
  ])
    expect(() => trustedRuntimePaths(cache, bad)).toThrow("tool cache");
  expect(() => trustedRuntimePaths("", node)).toThrow();
});

test("version probes have no ambient authority; only trusted publication gets OIDC", () => {
  const source = {
    GH_TOKEN: "github-secret",
    GITHUB_TOKEN: "another-secret",
    NPM_TOKEN: "npm-secret",
    NODE_AUTH_TOKEN: "npm-auth",
    NODE_OPTIONS: "--require=untrusted",
    NODE_PATH: "/untrusted",
    PATH: "/workspace/node_modules/.bin",
    npm_config_userconfig: "/untrusted/.npmrc",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-secret",
    GITHUB_REPOSITORY: "atacama-dev/opencode-agentbus",
    GITHUB_ACTIONS: "true",
  };
  for (const publish of [false, true]) {
    const env = npmEnvironment(
      source,
      "/opt/hostedtoolcache/node/24.1.0/x64/bin/node",
      "/isolated",
      publish,
    );
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "NPM_TOKEN",
      "NODE_AUTH_TOKEN",
      "NODE_OPTIONS",
      "NODE_PATH",
      "npm_config_userconfig",
    ])
      expect(env[key]).toBeUndefined();
    expect(env.PATH).toBe("/opt/hostedtoolcache/node/24.1.0/x64/bin:/usr/bin:/bin");
    expect(env.HOME).toBe("/isolated");
    expect(env.GITHUB_REPOSITORY).toBe(source.GITHUB_REPOSITORY);
    if (publish) {
      expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe(source.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
      expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBe(source.ACTIONS_ID_TOKEN_REQUEST_URL);
    } else {
      expect(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
      expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
    }
  }
});

test("real npm version probe accepts the same isolated config flags as publication", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agentbus-npm-config-test-"));
  try {
    prepareNpmConfig(cwd);
    const { input, io, state } = fixture("0.1.0", "v2", cwd);
    await publishRelease(input, io);
    const flags = state.publishCalls[0]?.filter((arg) =>
      /^--(?:userconfig|globalconfig)=/u.test(arg),
    );
    expect(flags).toHaveLength(2);
    const nodePath = Bun.which("node");
    const npmPath = Bun.which("npm");
    if (!nodePath || !npmPath || !flags) throw new Error("Installed Node/npm required.");
    const node = realpathSync(nodePath);
    const npm = realpathSync(npmPath);
    const env = npmEnvironment(
      { NPM_CONFIG_USERCONFIG: "/untrusted/user", NPM_CONFIG_GLOBALCONFIG: "/untrusted/global" },
      node,
      cwd,
      false,
    );
    const user = flags?.find((flag) => flag.startsWith("--userconfig="))?.slice(13);
    const global = flags?.find((flag) => flag.startsWith("--globalconfig="))?.slice(15);
    if (!user || !global) throw new Error("Both npm config flags required.");
    for (const [args, configEnv] of [
      [[npm, "--version"], env],
      [
        [npm, "--version", ...flags],
        { ...env, NPM_CONFIG_USERCONFIG: undefined, NPM_CONFIG_GLOBALCONFIG: undefined },
      ],
      [[npm, "--version", ...flags], env],
    ] as const)
      expect(
        execFileSync(node, args, {
          cwd,
          env: configEnv,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim(),
      ).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/u);
    expect(env.NPM_CONFIG_USERCONFIG).toBe(user);
    expect(env.NPM_CONFIG_GLOBALCONFIG).toBe(global);
    expect(user).not.toBe(global);
    expect(global.startsWith(`${cwd}/`)).toBe(true);
    expect(lstatSync(global).isFile()).toBe(true);
    expect(readFileSync(global, "utf8")).toBe("");
    expect(lstatSync(global).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function fixture(version = "0.1.0", line: "v1" | "v2" = "v2", npmConfigDir = "/isolated") {
  const config = parseReleaseConfig({
    ...readReleaseConfig(),
    releaseLine: line,
    version,
    supportedLines: ["v1", "v2"],
    readiness: { v1: true, v2: true },
    publishEnabled: true,
  });
  const bytes = new TextEncoder().encode("exact tested archive bytes");
  const sourceCommit = "a".repeat(40);
  const manifest: PackageArtifact = {
    schemaVersion: 1,
    line,
    packageName: config.packageNames[line],
    version: config.version,
    tarball: "agentbus.tgz",
    sourceCommit,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const event = {
    action: "published",
    repository: { full_name: "atacama-dev/opencode-agentbus", private: false },
    release: {
      id: 7,
      tag_name: `opencode-${line}/v${version}`,
      draft: false,
      prerelease: version.includes("-"),
    },
  };
  const audit = {
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      dependencies: { prod: 3 },
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
    },
  };
  const input = { config, event, eventName: "release", manifest, bytes, sourceCommit, audit };
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const state = {
    npm: undefined as string | undefined,
    publishCalls: [] as string[][],
    writes: [] as string[],
    reads: [] as string[],
    assets: new Map<string, Uint8Array>(),
    failUpload: false,
    failPublish: false,
    privateRepository: false,
    movedTag: false,
    moveAfterPrecheck: false,
    badRegistry: false,
    protectedBranch: true,
    ancestor: true,
    registryName: manifest.packageName,
    channel: undefined as unknown,
    channelStatus: undefined as number | undefined,
    malformedChannel: false,
    channelReads: 0,
    effects: [] as string[],
  };
  const response = (value: unknown, status = 200) => Response.json(value, { status });
  const io: PublicationIO = {
    npmConfigDir,
    github: async (url, init) => {
      if (init?.method === "POST") {
        state.writes.push(url);
        if (state.failUpload) {
          state.failUpload = false;
          return response({}, 500);
        }
        const name = new URL(url).searchParams.get("name");
        if (!name || !(init.body instanceof Blob)) throw new Error("Bad test upload");
        state.assets.set(name, new Uint8Array(await init.body.arrayBuffer()));
        return response({ id: 1 }, 201);
      }
      state.reads.push(url);
      state.effects.push("github");
      if (url.endsWith("/opencode-agentbus"))
        return response({ ...event.repository, private: state.privateRepository });
      if (url.endsWith("/releases/7")) return response(event.release);
      if (url.includes("/git/ref/tags/"))
        return response({ object: { type: "tag", sha: "b".repeat(40) } });
      if (url.includes("/git/tags/"))
        return response({
          tag: event.release.tag_name,
          object: {
            type: "commit",
            sha: state.movedTag ? "c".repeat(40) : sourceCommit,
          },
        });
      if (url.includes("/branches/"))
        return response({
          name: decodeURIComponent(url.split("/").at(-1) ?? ""),
          protected: state.protectedBranch,
          commit: { sha: sourceCommit },
        });
      if (url.includes("/compare/"))
        return response({
          status: state.ancestor ? "identical" : "diverged",
          merge_base_commit: { sha: state.ancestor ? sourceCommit : "d".repeat(40) },
        });
      if (url.includes("/releases/7/assets?"))
        return response([...state.assets.keys()].map((name, index) => ({ name, id: index + 1 })));
      if (url.includes("/releases/assets/")) {
        const index = Number(url.split("/").at(-1)) - 1;
        return new Response([...state.assets.values()][index]);
      }
      throw new Error(`Unexpected fixture request ${url}`);
    },
    registry: async (url) => {
      const packageUrl = `https://registry.npmjs.org/${encodeURIComponent(manifest.packageName)}`;
      if (url === `${packageUrl}/${version.includes("-") ? "next" : "latest"}`) {
        state.channelReads++;
        state.effects.push("channel");
        if (state.malformedChannel) return new Response("not JSON", { status: 200 });
        return response(
          state.channel ?? {},
          state.channelStatus ?? (state.channel === undefined ? 404 : 200),
        );
      }
      expect(url).toBe(`${packageUrl}/${manifest.version}`);
      state.effects.push("version");
      if (state.moveAfterPrecheck) state.movedTag = true;
      if (state.badRegistry) return response({}, 503);
      return state.npm === undefined
        ? response({}, 404)
        : response({
            name: state.registryName,
            version: manifest.version,
            dist: { integrity: state.npm },
          });
    },
    publish: async (args) => {
      state.effects.push("publish");
      state.publishCalls.push([...args]);
      if (state.failPublish) throw new Error("simulated npm failure");
      state.npm = integrity;
      state.channel = { name: manifest.packageName, version: manifest.version };
    },
  };
  return { input, state, io, integrity };
}

test("publication uses exact tgz, OIDC-compatible CLI flags and existing release only", async () => {
  const { input, state, io } = fixture();
  expect(await publishRelease(input, io)).toEqual({ alreadyPublished: false, uploadedAssets: 4 });
  expect(state.publishCalls).toHaveLength(1);
  expect(state.channelReads).toBe(1); // Missing channel (404) permits a first publication.
  expect(state.publishCalls[0]).toEqual([
    "publish",
    "agentbus.tgz",
    "--ignore-scripts",
    "--access",
    "public",
    "--tag",
    "latest",
    "--provenance",
    "--registry=https://registry.npmjs.org",
    "--userconfig=/dev/null",
    "--globalconfig=/isolated/.npmrc-global",
  ]);
  expect([...state.assets.keys()]).toEqual([
    "agentbus.tgz",
    "manifest.json",
    "audit.json",
    "SHA256SUMS",
  ]);
  expect(state.assets.get("agentbus.tgz")).toEqual(input.bytes);
  expect(
    state.writes.every((url) =>
      url.startsWith(
        "https://uploads.github.com/repos/atacama-dev/opencode-agentbus/releases/7/assets?name=",
      ),
    ),
  ).toBe(true);
});

test("an identical immutable npm version is skipped without moving old latest", async () => {
  const { input, state, io, integrity } = fixture();
  state.npm = integrity;
  state.channel = { name: input.manifest.packageName, version: "2.0.0" };
  state.channelStatus = 503; // Asset-only retries do not even need to read the channel.
  expect(await publishRelease(input, io)).toMatchObject({ alreadyPublished: true });
  expect(state.publishCalls).toHaveLength(0);
  expect(state.channelReads).toBe(0);
});

test("absent older or inconsistently equal versions cannot roll back latest or next", async () => {
  for (const [candidate, current] of [
    ["0.1.0", "0.2.0"],
    ["0.1.0", "0.1.0"],
    ["0.1.0-beta.2", "0.1.0-beta.10"],
    ["0.1.0-rc.1", "0.1.0"],
    ["0.1.0-beta.900719925474099200", "0.1.0-beta.900719925474099201"],
  ]) {
    const { input, state, io } = fixture(candidate);
    state.channel = { name: input.manifest.packageName, version: current };
    await expect(publishRelease(input, io)).rejects.toThrow("would not advance");
    expect(state.npm).toBeUndefined();
    expect(state.publishCalls).toHaveLength(0);
    expect(state.writes).toHaveLength(0);
    expect(state.channelReads).toBe(1);
  }
});

test("newer versions advance the channel only after live verification and an adjacent channel read", async () => {
  for (const [candidate, current] of [
    ["0.2.0", "0.1.0"],
    ["0.1.0", "0.1.0-rc.1"],
    ["0.1.0-beta.10", "0.1.0-beta.2"],
    ["0.2.0-alpha", "0.1.0"],
  ]) {
    const { input, state, io } = fixture(candidate);
    state.channel = { name: input.manifest.packageName, version: current };
    await publishRelease(input, io);
    expect(state.publishCalls).toHaveLength(1);
    const publicationIndex = state.effects.indexOf("publish");
    expect(state.effects.slice(publicationIndex - 2, publicationIndex + 1)).toEqual([
      "github",
      "channel",
      "publish",
    ]);
    expect(
      state.effects.slice(state.effects.indexOf("version") + 1, publicationIndex - 1),
    ).toContain("github");
  }
});

test("channel read errors and unsupported or mismatched metadata block all writes", async () => {
  for (const bad of [
    { name: "@wrong/package", version: "0.0.1" },
    { name: "@atacama-dev/opencode-agentbus-v2", version: "0.0.1+build" },
    { name: "@atacama-dev/opencode-agentbus-v2", version: "0.0.1-beta.01" },
    { name: "@atacama-dev/opencode-agentbus-v2", version: 1 },
    {},
    [],
    "unexpected JSON",
  ]) {
    const { input, state, io } = fixture();
    state.channel = bad;
    await expect(publishRelease(input, io)).rejects.toThrow();
    expect(state.publishCalls).toHaveLength(0);
    expect(state.writes).toHaveLength(0);
  }
  for (const reason of ["unavailable", "forbidden", "malformed"]) {
    const { input, state, io } = fixture();
    state.channelStatus = reason === "forbidden" ? 403 : 503;
    state.malformedChannel = reason === "malformed";
    await expect(publishRelease(input, io)).rejects.toThrow();
    expect(state.publishCalls).toHaveLength(0);
    expect(state.writes).toHaveLength(0);
  }
});

test("prereleases publish exclusively to next, never latest", async () => {
  const { input, state, io } = fixture("0.1.0-rc.1");
  await publishRelease(input, io);
  expect(state.publishCalls[0]?.slice(5, 7)).toEqual(["--tag", "next"]);
  expect(state.publishCalls[0]).not.toContain("latest");
});

test("wrong npm integrity or identity and unavailable registry block all writes", async () => {
  for (const reason of ["integrity", "identity", "unavailable"]) {
    const { input, state, io, integrity } = fixture();
    state.npm = reason === "integrity" ? "sha512-different" : integrity;
    if (reason === "identity") state.registryName = "@wrong/name";
    if (reason === "unavailable") state.badRegistry = true;
    await expect(publishRelease(input, io)).rejects.toThrow();
    expect(state.publishCalls).toHaveLength(0);
    expect(state.writes).toHaveLength(0);
  }
});

test("npm success and asset failure retry reuses bytes and never republishes", async () => {
  const { input, state, io } = fixture();
  state.failUpload = true;
  await expect(publishRelease(input, io)).rejects.toThrow("retry this job");
  expect(state.publishCalls).toHaveLength(1);
  expect(await publishRelease(input, io)).toEqual({ alreadyPublished: true, uploadedAssets: 4 });
  expect(state.publishCalls).toHaveLength(1);
  expect(await publishRelease(input, io)).toEqual({ alreadyPublished: true, uploadedAssets: 0 });
  expect(state.publishCalls).toHaveLength(1);
});

test("different existing GitHub asset fails before npm, without clobber", async () => {
  const { input, state, io } = fixture();
  state.assets.set("agentbus.tgz", new TextEncoder().encode("different archive"));
  await expect(publishRelease(input, io)).rejects.toThrow("differs");
  expect(state.publishCalls).toHaveLength(0);
  expect(state.writes).toHaveLength(0);
});

test("npm failure cannot attach release assets", async () => {
  const { input, state, io } = fixture();
  state.failPublish = true;
  await expect(publishRelease(input, io)).rejects.toThrow("simulated npm failure");
  expect(state.writes).toHaveLength(0);
});

test("tag movement, including after registry precheck, blocks writes", async () => {
  for (const afterPrecheck of [false, true]) {
    const { input, state, io } = fixture();
    state.movedTag = !afterPrecheck;
    state.moveAfterPrecheck = afterPrecheck;
    await expect(publishRelease(input, io)).rejects.toThrow("verified source commit");
    expect(state.publishCalls).toHaveLength(0);
    expect(state.writes).toHaveLength(0);
  }
});

test("live private repository blocks writes even with a stale public event", async () => {
  const { input, state, io } = fixture();
  state.privateRepository = true;
  await expect(publishRelease(input, io)).rejects.toThrow("canonical and public");
  expect(state.publishCalls).toHaveLength(0);
  expect(state.writes).toHaveLength(0);
});

test("live protected branch ancestry is required even after local source proof", async () => {
  for (const reason of ["unprotected", "diverged"]) {
    const { input, state, io } = fixture();
    if (reason === "unprotected") state.protectedBranch = false;
    if (reason === "diverged") state.ancestor = false;
    await expect(publishRelease(input, io)).rejects.toThrow("allowed protected branch");
    expect(state.publishCalls).toHaveLength(0);
    expect(state.writes).toHaveLength(0);
  }
});

test("readiness, disabled publication, audit findings and digest corruption stop before external access", async () => {
  for (const reason of ["readiness", "disabled", "audit", "digest", "source", "fork"]) {
    const { input, state, io } = fixture();
    if (reason === "readiness")
      input.config = { ...input.config, readiness: { v1: true, v2: false } };
    if (reason === "disabled") input.config = { ...input.config, publishEnabled: false };
    if (reason === "audit") input.audit.metadata.vulnerabilities.high = 1;
    if (reason === "digest") input.bytes = new TextEncoder().encode("corrupt archive");
    if (reason === "source") input.sourceCommit = "d".repeat(40);
    if (reason === "fork") input.event.repository.full_name = "fork/opencode-agentbus";
    await expect(publishRelease(input, io)).rejects.toThrow();
    expect(state.reads).toHaveLength(0);
    expect(state.writes).toHaveLength(0);
    expect(state.publishCalls).toHaveLength(0);
  }
});

function temporaryRiskFixture() {
  const { input, state, io } = fixture("0.1.0", "v1");
  const name = "zod";
  const chain = ["@opencode-ai/plugin@1.18.19", "zod@4.1.8"];
  const manifest = input.manifest;
  const identity = {
    line: manifest.line,
    packageName: manifest.packageName,
    version: manifest.version,
    sha256: manifest.sha256,
    sourceCommit: manifest.sourceCommit,
  };
  const report = {
    auditReportVersion: 2,
    vulnerabilities: {
      zod: {
        name,
        severity: "high",
        via: [
          {
            url: "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5",
            name,
            dependency: name,
            severity: "high",
            range: "<4.6.6",
          },
        ],
        nodes: ["node_modules/zod"],
      },
    },
    metadata: {
      dependencies: { prod: 2 },
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
    },
  };
  const auditContext = {
    schemaVersion: 1 as const,
    profile: "production" as const,
    sourceCommit: input.sourceCommit,
    manifest: identity,
    nodes: [{ path: "node_modules/zod", name, version: "4.1.8", chains: [chain] }],
  };
  return { input: { ...input, audit: report, auditContext, auditExit: 1 }, state, io };
}

test("an expired temporary exception blocks publication before any network or registry access", async () => {
  const { input, state, io } = temporaryRiskFixture();
  const originalDate = globalThis.Date;
  globalThis.Date = class extends originalDate {
    constructor(value?: string | number) {
      super(value ?? "2026-12-16T00:00:00.000Z");
    }
  } as DateConstructor;
  try {
    await expect(publishRelease(input, io)).rejects.toThrow("date");
  } finally {
    globalThis.Date = originalDate;
  }
  expect(state.reads).toHaveLength(0);
  expect(state.writes).toHaveLength(0);
  expect(state.publishCalls).toHaveLength(0);
});

test("temporary risk acceptance is rechecked at every publication write boundary", async () => {
  const OriginalDate = globalThis.Date;
  let clock = "2026-12-14T23:59:59.999Z";
  globalThis.Date = class extends OriginalDate {
    constructor(value?: string | number) {
      super(value ?? clock);
    }
  } as DateConstructor;
  try {
    for (const boundary of ["none", "npm", "first-asset", "next-asset"]) {
      clock = "2026-12-14T23:59:59.999Z";
      const { input, state, io } = temporaryRiskFixture();
      const wrapped: PublicationIO = {
        ...io,
        registry: async (url) => {
          const response = await io.registry(url);
          if (boundary === "npm" && url.endsWith("/latest")) clock = "2026-12-15T00:00:00Z";
          return response;
        },
        publish: async (args) => {
          await io.publish(args);
          if (boundary === "first-asset") clock = "2026-12-15T00:00:00Z";
        },
        github: async (url, init) => {
          const response = await io.github(url, init);
          if (boundary === "next-asset" && init?.method === "POST") clock = "2026-12-15T00:00:00Z";
          return response;
        },
      };
      if (boundary === "none") {
        expect(await publishRelease(input, wrapped)).toEqual({
          alreadyPublished: false,
          uploadedAssets: 7,
        });
      } else {
        await expect(publishRelease(input, wrapped)).rejects.toThrow("date");
      }
      expect(state.publishCalls).toHaveLength(boundary === "npm" ? 0 : 1);
      expect(state.writes).toHaveLength(
        boundary === "none" ? 7 : boundary === "next-asset" ? 1 : 0,
      );
    }
  } finally {
    globalThis.Date = OriginalDate;
  }
});
