import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateAudit, installedContext, type AuditContext } from "./audit";

const commit = "a".repeat(40);
const manifest = {
  line: "v2",
  packageName: "@atacama-dev/opencode-agentbus-v2",
  version: "0.1.0",
  sha256: "b".repeat(64),
  sourceCommit: commit,
};
const chain = ["@opencode/plugin@2.2.7", "@opencode/util@2.2.7", "glob@13.0.5"];
const context: AuditContext = {
  schemaVersion: 1,
  profile: "production",
  sourceCommit: commit,
  manifest,
  nodes: [{ path: "node_modules/glob", name: "glob", version: "13.0.5", chains: [chain] }],
};
const advisory = {
  url: "https://github.com/advisories/GHSA-3g3m-2fjr-6pw4",
  name: "glob",
  severity: "moderate",
  range: ">=9.0.0 <=14.0.1",
};
const via = { ...advisory, source: 1, dependency: "glob", title: "test" };
const npmReport = {
  auditReportVersion: 2,
  vulnerabilities: {
    glob: { name: "glob", severity: "moderate", via: [via], nodes: ["node_modules/glob"] },
  },
  metadata: {
    dependencies: { prod: 3 },
    vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0, total: 1 },
  },
};
const ledger = {
  schemaVersion: 1,
  exceptions: [
    {
      id: "GHSA-3g3m-2fjr-6pw4",
      severity: "moderate",
      package: "glob",
      scopes: [{ version: "13.0.5", profile: "production", line: "v2", chains: [chain] }],
      acceptedOn: "2026-11-15",
      expiresOn: "2026-12-15",
      responsible: "Julien Tesson",
      reason: "SDK installed but own code does not invoke glob",
      evidence: ["packages/plugin/test/advisory-exposure.test.ts"],
    },
  ],
};
const now = new Date("2026-11-15T12:00:00Z");

test("specific production leaf is a visible accepted risk, not a clean audit", () => {
  expect(
    evaluateAudit(npmReport, context, ledger, { now, exitCode: 1, expected: manifest }).accepted,
  ).toHaveLength(1);
});
test("exception expiry is an exclusive UTC instant, never an inclusive extra day", () => {
  const check = (time: Date) =>
    evaluateAudit(npmReport, context, ledger, { now: time, exitCode: 1, expected: manifest });
  expect(() => check(new Date("2026-12-14T23:59:59.999Z"))).not.toThrow();
  expect(() => check(new Date("2026-12-15T00:00:00.000Z"))).toThrow("date");
  expect(() => check(new Date(Number.NaN))).toThrow("clock");
  const sameDay = {
    ...ledger,
    exceptions: [{ ...ledger.exceptions[0], expiresOn: "2026-11-15" }],
  };
  expect(() =>
    evaluateAudit(npmReport, context, sameDay, { now, exitCode: 1, expected: manifest }),
  ).toThrow("date");
});
test("Bun workspace JSON requires genuine advisory objects and matching observed exit status", () => {
  const exception = ledger.exceptions.at(0);
  if (!exception) throw new Error("Missing test exception");
  const { line: _line, ...scope } = { ...exception.scopes[0], profile: "workspace" };
  const workspaceLedger = {
    ...ledger,
    exceptions: [{ ...exception, scopes: [scope] }],
  };
  const workspaceContext: AuditContext = {
    schemaVersion: 1,
    profile: "workspace",
    sourceCommit: commit,
    nodes: context.nodes,
  };
  const finding = {
    url: advisory.url,
    severity: advisory.severity,
    vulnerable_versions: advisory.range,
  };
  const evaluate = (report: unknown, exitCode: number) =>
    evaluateAudit(report, workspaceContext, workspaceLedger, {
      now,
      exitCode,
      expected: { sourceCommit: commit },
      profile: "workspace",
    });
  expect(evaluate({ glob: [finding] }, 1).rawAdvisories).toEqual(["GHSA-3g3m-2fjr-6pw4"]);
  expect(evaluate({}, 0).status).toBe("no-findings");
  for (const [report, exit] of [
    [{}, 1],
    [{ glob: [finding] }, 0],
    [{ glob: [finding] }, 2],
    [{ glob: ["glob"] }, 1],
    [{ glob: [] }, 1],
    [{ error: { message: "registry offline" } }, 1],
  ] as const)
    expect(() => evaluate(report, exit)).toThrow();
});
test("unknown, escalated, changed version/path, critical and incomplete evidence block", () => {
  for (const report of [
    {
      ...npmReport,
      vulnerabilities: {
        glob: {
          ...npmReport.vulnerabilities.glob,
          via: [{ ...via, url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" }],
        },
      },
    },
    {
      ...npmReport,
      vulnerabilities: {
        glob: { ...npmReport.vulnerabilities.glob, via: [{ ...via, severity: "high" }] },
      },
    },
    {
      ...npmReport,
      vulnerabilities: {
        glob: { ...npmReport.vulnerabilities.glob, via: [{ ...via, severity: "critical" }] },
      },
    },
    {
      ...npmReport,
      vulnerabilities: { glob: { ...npmReport.vulnerabilities.glob, severity: "critical" } },
    },
    {
      ...npmReport,
      vulnerabilities: { glob: { ...npmReport.vulnerabilities.glob, via: ["unknown"] } },
    },
    {
      ...npmReport,
      vulnerabilities: {
        glob: { ...npmReport.vulnerabilities.glob, nodes: ["node_modules/other"] },
      },
    },
    { ...npmReport, error: { message: "offline" } },
  ])
    expect(() =>
      evaluateAudit(report, context, ledger, { now, exitCode: 1, expected: manifest }),
    ).toThrow();
  const baseline = context.nodes.at(0);
  if (!baseline) throw new Error("Missing test instance");
  for (const node of [
    { ...baseline, version: "13.0.4" },
    { ...baseline, chains: [["@other/sdk@2.2.7", "glob@13.0.5"]] },
  ])
    expect(() =>
      evaluateAudit(npmReport, { ...context, nodes: [node] }, ledger, {
        now,
        exitCode: 1,
        expected: manifest,
      }),
    ).toThrow();
});
test("ledger dates, wildcard scope, duplicates and identity are strict", () => {
  for (const change of [
    { expiresOn: "2026-12-16" },
    { acceptedOn: "2026-11-16" },
    { expiresOn: "2026-11-14" },
    { expiresOn: "2026-13-01" },
    { acceptedOn: ["2026-11-15"] },
    { responsible: "unknown" },
    { scopes: [{ version: "*", profile: "production", line: "v2", chains: [chain] }] },
    { scopes: [{ version: "13.0.5", profile: ["production"], line: "v2", chains: [chain] }] },
    { scopes: [{ version: "13.0.5", profile: "production", line: "v2", chains: [["*"]] }] },
    { severity: "critical" },
  ])
    expect(() =>
      evaluateAudit(
        npmReport,
        context,
        { ...ledger, exceptions: [{ ...ledger.exceptions[0], ...change }] },
        { now, exitCode: 1, expected: manifest },
      ),
    ).toThrow();
  expect(() =>
    evaluateAudit(
      npmReport,
      context,
      { ...ledger, exceptions: [...ledger.exceptions, ledger.exceptions[0]] },
      { now, exitCode: 1, expected: manifest },
    ),
  ).toThrow();
  expect(() =>
    evaluateAudit(npmReport, { ...context, sourceCommit: "c".repeat(40) }, ledger, {
      now,
      exitCode: 1,
      expected: manifest,
    }),
  ).toThrow();
  expect(() =>
    evaluateAudit(npmReport, context, ledger, { now, exitCode: 0, expected: manifest }),
  ).toThrow();
  expect(() =>
    evaluateAudit(npmReport, context, ledger, { now, exitCode: 2, expected: manifest }),
  ).toThrow();
});

test("production exceptions require an exact release line; workspace scopes forbid a line", () => {
  const source = ledger.exceptions[0];
  if (!source) throw new Error("Missing test exception");
  const production = source.scopes[0];
  if (!production) throw new Error("Missing test scope");
  for (const scope of [
    { ...production, line: undefined },
    { ...production, line: "*" },
    { ...production, line: "v1" },
  ])
    expect(() =>
      evaluateAudit(
        npmReport,
        context,
        {
          ...ledger,
          exceptions: [{ ...source, scopes: [scope] }],
        },
        { now, exitCode: 1, expected: manifest },
      ),
    ).toThrow();
  const workspaceContext: AuditContext = {
    schemaVersion: 1,
    profile: "workspace",
    sourceCommit: commit,
    nodes: context.nodes,
  };
  const report = {
    glob: [{ url: advisory.url, severity: advisory.severity, vulnerable_versions: advisory.range }],
  };
  const workspaceScope = { ...production, profile: "workspace", line: "v2" };
  expect(() =>
    evaluateAudit(
      report,
      workspaceContext,
      {
        ...ledger,
        exceptions: [{ ...source, scopes: [workspaceScope] }],
      },
      { now, exitCode: 1, expected: { sourceCommit: commit }, profile: "workspace" },
    ),
  ).toThrow();
});

test("a V1 legacy SDK exception cannot authorize the identical installed chain in V2 production", () => {
  const zod = reviewed.exceptions.find(
    (entry: { id: string }) => entry.id === "GHSA-mrhx-c7xc-m3w5",
  );
  if (!zod) throw new Error("Missing reviewed legacy advisory");
  const legacyManifest = {
    ...manifest,
    line: "v1",
    packageName: "@atacama-dev/opencode-agentbus-v1",
  };
  const legacyContext: AuditContext = {
    schemaVersion: 1,
    profile: "production",
    sourceCommit: commit,
    manifest: legacyManifest,
    nodes: [
      {
        path: "node_modules/zod",
        name: "zod",
        version: "4.1.8",
        chains: [["@opencode-ai/plugin@1.18.19", "zod@4.1.8"]],
      },
    ],
  };
  const report = {
    auditReportVersion: 2,
    vulnerabilities: {
      zod: {
        name: "zod",
        severity: "high",
        via: [
          {
            url: "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5",
            name: "zod",
            dependency: "zod",
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
  expect(() =>
    evaluateAudit(
      report,
      legacyContext,
      { schemaVersion: 1, exceptions: [zod] },
      { now, exitCode: 1, expected: legacyManifest },
    ),
  ).not.toThrow();
  const wrongManifest = {
    ...legacyManifest,
    line: "v2",
    packageName: "@atacama-dev/opencode-agentbus-v2",
  };
  expect(() =>
    evaluateAudit(
      report,
      { ...legacyContext, manifest: wrongManifest },
      { schemaVersion: 1, exceptions: [zod] },
      { now, exitCode: 1, expected: wrongManifest },
    ),
  ).toThrow("Uncovered");
});

const reviewed = JSON.parse(
  readFileSync(new URL("../../security/audit-exceptions.json", import.meta.url), "utf8"),
);
const ranges: Record<string, string> = {
  effect: ">=4.0.0-beta.0 <4.0.0-beta.103",
  toml: "<=5.0.0",
  zod: "<4.6.6",
  glob: ">=9.0.0 <=14.0.1",
  minimatch: ">=7.0.0 <11.0.1",
};
test("workspace ledger names exactly six legacy advisories; no wildcard covers unknown IDs", () => {
  const nodes = new Map<string, AuditContext["nodes"][number]>();
  const report: Record<string, unknown[]> = {};
  for (const entry of reviewed.exceptions) {
    const scope = entry.scopes.find((scope: { profile: string }) => scope.profile === "workspace");
    const name = entry.package;
    const path = `node_modules/${name}`;
    if (!nodes.has(name))
      nodes.set(name, { path, name, version: scope.version, chains: [scope.chains[0]] });
    if (!report[name]) report[name] = [];
    report[name].push({
      url: `https://github.com/advisories/${entry.id}`,
      severity: entry.severity,
      vulnerable_versions: ranges[name],
    });
  }
  expect(reviewed.exceptions).toHaveLength(6);
  const result = evaluateAudit(
    report,
    { schemaVersion: 1, profile: "workspace", sourceCommit: commit, nodes: [...nodes.values()] },
    reviewed,
    { now, exitCode: 1, expected: { sourceCommit: commit }, profile: "workspace" },
  );
  expect(result.rawAdvisories).toHaveLength(6);
  expect(result.accepted).toHaveLength(6);
  expect(() =>
    evaluateAudit(
      {
        ...report,
        unexpected: [
          {
            url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
            severity: "high",
            vulnerable_versions: "*",
          },
        ],
      },
      {
        schemaVersion: 1,
        profile: "workspace",
        sourceCommit: commit,
        nodes: [
          ...nodes.values(),
          {
            path: "node_modules/unexpected",
            name: "unexpected",
            version: "1.0.0",
            chains: [["@opencode/plugin@2.2.7", "unexpected@1.0.0"]],
          },
        ],
      },
      reviewed,
      { now, exitCode: 1, expected: { sourceCommit: commit }, profile: "workspace" },
    ),
  ).toThrow("Uncovered");
});

test("npm ancestor propagation resolves six leaf advisories, distinguishes patched and vulnerable copies", () => {
  const first = (name: string) =>
    reviewed.exceptions.find((entry: { package: string }) => entry.package === name);
  const leaf = (name: string, version: string, path: string, chain: string[]) => ({
    path,
    name,
    version,
    chains: [chain],
  });
  const zod = first("zod");
  const effect = first("effect");
  const tomlEntries = reviewed.exceptions.filter(
    (entry: { package: string }) => entry.package === "toml",
  );
  const sdk = "@opencode-ai/plugin";
  const manifestV1 = { ...manifest, line: "v1", packageName: "@atacama-dev/opencode-agentbus-v1" };
  const nodes = [
    leaf(manifestV1.packageName, "0.1.0", `node_modules/${manifestV1.packageName}`, [
      `${manifestV1.packageName}@0.1.0`,
    ]),
    leaf(sdk, "1.18.19", `node_modules/${sdk}`, [`${sdk}@1.18.19`]),
    leaf("effect", "4.0.0-beta.83", "node_modules/effect", [
      `${sdk}@1.18.19`,
      "effect@4.0.0-beta.83",
    ]),
    leaf("toml", "4.3.0", "node_modules/toml", [
      `${sdk}@1.18.19`,
      "effect@4.0.0-beta.83",
      "toml@4.3.0",
    ]),
    leaf("zod", "4.1.8", "node_modules/legacy/zod", [`${sdk}@1.18.19`, "zod@4.1.8"]),
    leaf("zod", "4.6.7", "node_modules/zod", ["@opencode-agentbus/broker@0.1.0", "zod@4.6.7"]),
  ];
  const advisory = (entry: { id: string; package: string; severity: string }) => ({
    url: `https://github.com/advisories/${entry.id}`,
    name: entry.package,
    dependency: entry.package,
    severity: entry.severity,
    range: ranges[entry.package],
  });
  const report = {
    auditReportVersion: 2,
    vulnerabilities: {
      [manifestV1.packageName]: {
        name: manifestV1.packageName,
        severity: "high",
        via: [sdk],
        nodes: [`node_modules/${manifestV1.packageName}`],
      },
      [sdk]: {
        name: sdk,
        severity: "high",
        via: ["effect", "zod"],
        nodes: [`node_modules/${sdk}`],
      },
      effect: {
        name: "effect",
        severity: "high",
        via: [advisory(effect), "toml"],
        nodes: ["node_modules/effect"],
      },
      toml: {
        name: "toml",
        severity: "high",
        via: tomlEntries.map(advisory),
        nodes: ["node_modules/toml"],
      },
      zod: {
        name: "zod",
        severity: "high",
        via: [advisory(zod)],
        nodes: ["node_modules/legacy/zod"],
      },
    },
    metadata: {
      dependencies: { prod: 20 },
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 5, critical: 0, total: 5 },
    },
  };
  const contextV1: AuditContext = {
    schemaVersion: 1,
    profile: "production",
    sourceCommit: commit,
    manifest: manifestV1,
    nodes,
  };
  expect(
    evaluateAudit(report, contextV1, reviewed, { now, expected: manifestV1, exitCode: 1 })
      .rawAdvisories,
  ).toHaveLength(6);
  expect(() =>
    evaluateAudit(
      report,
      {
        ...contextV1,
        nodes: [
          ...nodes,
          leaf("zod", "4.1.8", "node_modules/new/zod", [`${sdk}@1.18.19`, "zod@4.1.8"]),
        ],
      },
      reviewed,
      { now, expected: manifestV1, exitCode: 1 },
    ),
  ).toThrow("omitted");
  expect(() =>
    evaluateAudit(
      {
        ...report,
        vulnerabilities: {
          ...report.vulnerabilities,
          [sdk]: { ...report.vulnerabilities[sdk], via: ["missing"] },
        },
      },
      contextV1,
      reviewed,
      { now, expected: manifestV1, exitCode: 1 },
    ),
  ).toThrow();
  expect(() =>
    evaluateAudit(report, { ...contextV1, manifest }, reviewed, {
      now,
      expected: manifestV1,
      exitCode: 1,
    }),
  ).toThrow("mismatch");
});

test("context capture retains an additional first-party dependency route even if the same physical copy is already reachable through the SDK", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbus-audit-graph-"));
  const writePackage = (
    path: string,
    name: string,
    version: string,
    dependencies: Record<string, string>,
  ) => {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(
      join(root, path, "package.json"),
      JSON.stringify({ name, version, dependencies }),
    );
  };
  try {
    writePackage(`node_modules/${manifest.packageName}`, manifest.packageName, manifest.version, {
      "@opencode/plugin": "2.2.7",
      glob: "13.0.5",
    });
    writePackage("node_modules/@opencode/plugin", "@opencode/plugin", "2.2.7", { glob: "13.0.5" });
    writePackage("node_modules/glob", "glob", "13.0.5", {});
    const captured = installedContext(root, "production", commit, manifest);
    const node = captured.nodes.find((entry) => entry.name === "glob");
    expect(node?.chains).toEqual(
      expect.arrayContaining([
        ["@opencode/plugin@2.2.7", "glob@13.0.5"],
        [`${manifest.packageName}@0.1.0`, "glob@13.0.5"],
      ]),
    );
    expect(() =>
      evaluateAudit(npmReport, captured, ledger, { now, exitCode: 1, expected: manifest }),
    ).toThrow("Uncovered");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("installed required peer reaches the same physical vulnerable copy through a new first-party route", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbus-audit-peers-"));
  const writePackage = (path: string, value: Record<string, unknown>) => {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, "package.json"), JSON.stringify(value));
  };
  try {
    writePackage(`node_modules/${manifest.packageName}`, {
      name: manifest.packageName,
      version: manifest.version,
      dependencies: { "@opencode/plugin": "2.2.7" },
      peerDependencies: { glob: "13.0.5" },
    });
    writePackage("node_modules/@opencode/plugin", {
      name: "@opencode/plugin",
      version: "2.2.7",
      dependencies: { "@opencode/util": "2.2.7" },
    });
    writePackage("node_modules/@opencode/util", {
      name: "@opencode/util",
      version: "2.2.7",
      dependencies: { glob: "13.0.5" },
    });
    writePackage("node_modules/glob", { name: "glob", version: "13.0.5" });
    const captured = installedContext(root, "production", commit, manifest);
    expect(captured.nodes.find((node) => node.name === "glob")?.chains).toEqual(
      expect.arrayContaining([chain, [`${manifest.packageName}@0.1.0`, "glob@13.0.5"]]),
    );
    expect(() =>
      evaluateAudit(npmReport, captured, ledger, { now, exitCode: 1, expected: manifest }),
    ).toThrow("Uncovered");
    writePackage(`node_modules/${manifest.packageName}`, {
      name: manifest.packageName,
      version: manifest.version,
      dependencies: { "@opencode/plugin": "2.2.7" },
      peerDependencies: { missing: "1.0.0" },
    });
    expect(() => installedContext(root, "production", commit, manifest)).toThrow("Unresolved");
    writePackage(`node_modules/${manifest.packageName}`, {
      name: manifest.packageName,
      version: manifest.version,
      dependencies: { "@opencode/plugin": "2.2.7" },
      peerDependencies: { missing: "1.0.0" },
      peerDependenciesMeta: { missing: { optional: true } },
    });
    expect(() => installedContext(root, "production", commit, manifest)).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("npm propagation reports two SDK leaves rather than counting dependent ancestors as new advisories", () => {
  const names = ["glob", "minimatch"];
  // Synthetic engine-only public-SDK graph; V1's committed ledger has no public-SDK exceptions.
  const globException = ledger.exceptions.at(0);
  if (!globException) throw new Error("Missing synthetic public exception");
  const entries = [
    globException,
    {
      ...globException,
      id: "GHSA-g3hv-75wg-m249",
      package: "minimatch",
      scopes: [
        {
          profile: "production",
          line: "v2",
          version: "10.2.5",
          chains: [["@opencode/plugin@2.2.7", "@opencode/util@2.2.7", "minimatch@10.2.5"]],
        },
      ],
    },
  ];
  const nodes = [
    {
      path: "node_modules/@opencode/plugin",
      name: "@opencode/plugin",
      version: "2.2.7",
      chains: [["@opencode/plugin@2.2.7"]],
    },
    {
      path: "node_modules/@opencode/util",
      name: "@opencode/util",
      version: "2.2.7",
      chains: [["@opencode/plugin@2.2.7", "@opencode/util@2.2.7"]],
    },
    ...entries.map((entry: { package: string }) => ({
      path: `node_modules/${entry.package}`,
      name: entry.package,
      version: entry.package === "glob" ? "13.0.5" : "10.2.5",
      chains: [
        [
          "@opencode/plugin@2.2.7",
          "@opencode/util@2.2.7",
          `${entry.package}@${entry.package === "glob" ? "13.0.5" : "10.2.5"}`,
        ],
      ],
    })),
  ];
  const vulnerabilities: Record<string, unknown> = {
    "@opencode/plugin": {
      name: "@opencode/plugin",
      severity: "moderate",
      via: ["@opencode/util"],
      nodes: ["node_modules/@opencode/plugin"],
    },
    "@opencode/util": {
      name: "@opencode/util",
      severity: "moderate",
      via: names,
      nodes: ["node_modules/@opencode/util"],
    },
  };
  for (const entry of entries)
    vulnerabilities[entry.package] = {
      name: entry.package,
      severity: "moderate",
      nodes: [`node_modules/${entry.package}`],
      via: [
        {
          url: `https://github.com/advisories/${entry.id}`,
          name: entry.package,
          dependency: entry.package,
          severity: "moderate",
          range: ranges[entry.package],
        },
      ],
    };
  const report = {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      dependencies: { prod: 5 },
      vulnerabilities: { info: 0, low: 0, moderate: 4, high: 0, critical: 0, total: 4 },
    },
  };
  const decision = evaluateAudit(
    report,
    { schemaVersion: 1, profile: "production", sourceCommit: commit, manifest, nodes },
    { schemaVersion: 1, exceptions: entries },
    { now, expected: manifest, exitCode: 1 },
  );
  expect(decision.rawAffectedPackages).toBe(4);
  expect(decision.rawAdvisories).toHaveLength(2);
  expect(decision.uncovered).toBe(0);
});
