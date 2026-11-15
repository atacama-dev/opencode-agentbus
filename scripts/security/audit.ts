import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

type Json = Record<string, unknown>;
export interface AuditNode {
  path: string;
  name: string;
  version: string;
  chains: string[][];
}
export interface AuditContext {
  schemaVersion: 1;
  profile: "workspace" | "production";
  sourceCommit: string;
  manifest?: {
    line: string;
    packageName: string;
    version: string;
    sha256: string;
    sourceCommit: string;
  };
  nodes: AuditNode[];
}
interface Exception {
  id: string;
  severity: string;
  package: string;
  version: string;
  profile: string;
  line?: "v1" | "v2";
  chain: string[];
  acceptedOn: string;
  expiresOn: string;
  responsible: string;
  reason: string;
  evidence: string[];
}
const levels = ["info", "low", "moderate", "high", "critical"];
const ghsa = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/u;
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u;
const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9a-zA-Z.-]+)?$/u;
const key = (chain: string[]) => JSON.stringify(chain);
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid audit JSON object");
  return value as Json;
}
function date(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error("Invalid audit exception date");
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value)
    throw new Error("Invalid audit exception date");
  return time;
}
function exceptions(value: unknown, now: Date): Exception[] {
  const observed = now.getTime();
  if (!Number.isFinite(observed)) throw new Error("Invalid audit policy clock");
  const source = object(value);
  if (source.schemaVersion !== 1 || !Array.isArray(source.exceptions))
    throw new Error("Invalid audit exception ledger");
  const seen = new Set<string>();
  const ids = new Set<string>();
  return source.exceptions.flatMap((entry: unknown) => {
    const e = object(entry);
    if (
      typeof e.id !== "string" ||
      !ghsa.test(e.id) ||
      ids.has(e.id) ||
      typeof e.severity !== "string" ||
      !levels.includes(e.severity) ||
      e.severity === "critical" ||
      typeof e.package !== "string" ||
      !packageName.test(e.package) ||
      e.responsible !== "Julien Tesson" ||
      typeof e.acceptedOn !== "string" ||
      typeof e.expiresOn !== "string" ||
      typeof e.reason !== "string" ||
      !e.reason.trim() ||
      !Array.isArray(e.evidence) ||
      e.evidence.length === 0 ||
      e.evidence.some((item) => typeof item !== "string" || !item.trim()) ||
      !Array.isArray(e.scopes) ||
      e.scopes.length === 0
    )
      throw new Error("Invalid audit exception scope or documentation");
    ids.add(e.id);
    const start = date(e.acceptedOn);
    const end = date(e.expiresOn);
    if (end <= start || end - start > 30 * 86_400_000 || observed < start || observed >= end)
      throw new Error(`Audit exception date outside active 30-day window: ${e.id}`);
    return e.scopes.flatMap((scope: unknown) => {
      const s = object(scope);
      if (
        typeof s.profile !== "string" ||
        !["workspace", "production"].includes(s.profile) ||
        (s.profile === "production" && s.line !== "v1" && s.line !== "v2") ||
        (s.profile === "workspace" && Object.hasOwn(s, "line")) ||
        typeof s.version !== "string" ||
        !version.test(s.version) ||
        !Array.isArray(s.chains) ||
        s.chains.length === 0
      )
        throw new Error("Invalid audit exception version/profile");
      return s.chains.map((chain: unknown) => {
        if (
          !Array.isArray(chain) ||
          chain.length < 2 ||
          chain.some(
            (part) =>
              typeof part !== "string" ||
              !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9a-zA-Z.-]+)?$/u.test(
                part,
              ),
          ) ||
          chain.at(-1) !== `${e.package}@${s.version}` ||
          !["@opencode-ai/plugin@1.18.19", "@opencode/plugin@2.2.7"].includes(chain[0])
        )
          throw new Error("Invalid audit exception dependency chain");
        const identity = key([
          s.profile as string,
          String(s.line ?? ""),
          e.id as string,
          s.version as string,
          ...chain,
        ]);
        if (seen.has(identity)) throw new Error("Duplicate audit exception chain");
        seen.add(identity);
        return { ...e, ...s, chain } as Exception;
      });
    });
  });
}

/** Capture physical installed versions and all logical first-party-to-leaf routes. No foreign code is executed. */
export function installedContext(
  root: string,
  profile: AuditContext["profile"],
  sourceCommit: string,
  manifest?: AuditContext["manifest"],
): AuditContext {
  const base = resolve(root);
  if (
    profile === "workspace" &&
    JSON.stringify(
      object(JSON.parse(readFileSync(join(base, "package.json"), "utf8"))).workspaces,
    ) !== JSON.stringify(["packages/*"])
  )
    throw new Error("Unreviewed workspace layout for dependency audit");
  const roots =
    profile === "workspace"
      ? [
          ".",
          ...readdirSync(join(base, "packages"), { withFileTypes: true })
            .filter((entry) => {
              if (entry.isSymbolicLink())
                throw new Error("Symlinked workspace package is not auditable");
              return (
                entry.isDirectory() &&
                existsSync(join(base, "packages", entry.name, "package.json"))
              );
            })
            .map((entry) => `packages/${entry.name}`),
        ]
      : [`node_modules/${manifest?.packageName}`];
  const entries = new Map<string, AuditNode>();
  let traversals = 0;
  function visit(path: string, chain: string[], ancestors: Set<string>) {
    if (++traversals > 200_000 || chain.length > 50)
      throw new Error("Installed dependency graph exceeds bounded audit traversal");
    const file = join(base, path, "package.json");
    if (!existsSync(file)) throw new Error(`Missing installed dependency metadata: ${path}`);
    const canonical = realpathSync(file);
    if (!canonical.startsWith(`${base}/`))
      throw new Error("Installed dependency escaped workspace");
    const pkg = object(JSON.parse(readFileSync(canonical, "utf8")));
    if (
      typeof pkg.name !== "string" ||
      !packageName.test(pkg.name) ||
      typeof pkg.version !== "string" ||
      !version.test(pkg.version)
    )
      throw new Error("Invalid installed package identity");
    const logical = [...chain, `${pkg.name}@${pkg.version}`];
    let node = entries.get(path);
    if (!node) {
      node = { path, name: pkg.name, version: pkg.version, chains: [] };
      entries.set(path, node);
    }
    if (node.name !== pkg.name || node.version !== pkg.version)
      throw new Error("Installed path identity changed");
    const sdkIndex = logical.findIndex(
      (p) => p.startsWith("@opencode-ai/plugin@") || p.startsWith("@opencode/plugin@"),
    );
    const trustedRoot =
      profile === "workspace"
        ? "@opencode-agentbus/plugin@0.1.0"
        : `${manifest?.packageName}@${manifest?.version}`;
    const reviewedPath = sdkIndex === 1 && logical[0] === trustedRoot ? logical.slice(1) : logical;
    if (!node.chains.some((c) => key(c) === key(reviewedPath))) node.chains.push(reviewedPath);
    if (ancestors.has(canonical)) return; // Peer cycles never produce a new dependency path.
    const next = new Set(ancestors);
    next.add(canonical);
    const peers = object(pkg.peerDependencies ?? {});
    const peerMeta = object(pkg.peerDependenciesMeta ?? {});
    for (const [name, value] of Object.entries(peerMeta)) {
      if (!packageName.test(name) || typeof object(value).optional !== "boolean")
        throw new Error("Invalid installed peer metadata");
    }
    const deps = {
      ...object(pkg.dependencies ?? {}),
      ...object(pkg.optionalDependencies ?? {}),
      ...(profile === "workspace" && roots.includes(path) ? object(pkg.devDependencies ?? {}) : {}),
      ...peers,
    };
    for (const name of Object.keys(deps).sort()) {
      if (!packageName.test(name)) throw new Error("Invalid installed dependency name");
      let parent = dirname(canonical);
      let candidate: string | undefined;
      while (parent.startsWith(base)) {
        const local = join(parent, "node_modules", name);
        if (existsSync(join(local, "package.json"))) {
          candidate = relative(base, local);
          break;
        }
        if (parent === base) break;
        parent = dirname(parent);
      }
      if (!candidate) {
        // Optional dependencies may be omitted by platform, but mandatory ones must resolve.
        if (
          Object.hasOwn(object(pkg.dependencies ?? {}), name) ||
          (Object.hasOwn(peers, name) &&
            object(peerMeta[name] ?? { optional: false }).optional !== true)
        )
          throw new Error(`Unresolved installed dependency ${name} from ${path}`);
        continue;
      }
      visit(candidate, logical, next);
    }
  }
  for (const path of roots) visit(path, [], new Set());
  return {
    schemaVersion: 1,
    profile,
    sourceCommit,
    ...(manifest ? { manifest } : {}),
    nodes: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function evaluateAudit(
  report: unknown,
  context: AuditContext,
  ledger: unknown,
  options: {
    now?: Date;
    exitCode?: number;
    expected: {
      sourceCommit: string;
      line?: string;
      packageName?: string;
      version?: string;
      sha256?: string;
    };
    profile?: AuditContext["profile"];
  },
) {
  const now = options.now ?? new Date();
  const allowed = exceptions(ledger, now);
  if (
    context.schemaVersion !== 1 ||
    context.profile !== (options.profile ?? "production") ||
    context.sourceCommit !== options.expected.sourceCommit ||
    !/^[a-f0-9]{40}$/u.test(context.sourceCommit) ||
    (context.profile === "production" &&
      JSON.stringify(context.manifest) !== JSON.stringify(options.expected))
  )
    throw new Error("Audit context profile/source/manifest mismatch");
  const audit = object(report);
  const vulnerabilities = context.profile === "workspace" ? audit : object(audit.vulnerabilities);
  const metadata = context.profile === "workspace" ? {} : object(audit.metadata);
  const counts = context.profile === "workspace" ? {} : object(metadata.vulnerabilities);
  if (
    audit.error !== undefined ||
    (context.profile === "production" && audit.auditReportVersion !== 2) ||
    (context.profile === "production" &&
      (!Number.isSafeInteger(object(metadata.dependencies).prod) ||
        Number(object(metadata.dependencies).prod) < 1))
  )
    throw new Error("Missing, malformed or error audit report");
  if (context.profile === "production") {
    if (
      Number(counts.critical) !== 0 ||
      levels.some((level) => !Number.isSafeInteger(counts[level]) || Number(counts[level]) < 0) ||
      counts.total !== levels.reduce((n, level) => n + Number(counts[level]), 0) ||
      Object.keys(vulnerabilities).length !== counts.total ||
      levels.some(
        (level) =>
          Object.values(vulnerabilities).filter((row) => object(row).severity === level).length !==
          counts[level],
      ) ||
      (options.exitCode !== undefined &&
        ((options.exitCode !== 0 && options.exitCode !== 1) ||
          (options.exitCode === 0) !== (counts.total === 0)))
    )
      throw new Error("npm audit counts or exit status disagree");
  }
  if (
    context.profile === "workspace" &&
    ((options.exitCode !== 0 && options.exitCode !== 1) ||
      (options.exitCode === 0) !== (Object.keys(vulnerabilities).length === 0))
  )
    throw new Error("Bun audit exit status and findings disagree");
  if (!Array.isArray(context.nodes)) throw new Error("Missing installed audit nodes");
  const nodes = new Map<string, AuditNode>();
  for (const node of context.nodes) {
    if (
      typeof node.path !== "string" ||
      node.path.startsWith("/") ||
      node.path.includes("..") ||
      !packageName.test(node.name) ||
      !version.test(node.version) ||
      nodes.has(node.path) ||
      !Array.isArray(node.chains) ||
      node.chains.some(
        (chain) =>
          !Array.isArray(chain) ||
          chain.at(-1) !== `${node.name}@${node.version}` ||
          chain.some(
            (part) =>
              typeof part !== "string" ||
              !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9a-zA-Z.-]+)?$/u.test(
                part,
              ),
          ),
      )
    )
      throw new Error("Invalid installed audit node");
    nodes.set(node.path, node);
  }
  const accepted: {
    id: string;
    package: string;
    version: string;
    path: string;
    chain: string[];
    expiresOn: string;
  }[] = [];
  const leaves = new Set<string>();
  const advisoryIds = new Set<string>();
  const refs = new Map<string, string[]>();
  for (const [name, raw] of Object.entries(vulnerabilities)) {
    if (!packageName.test(name)) throw new Error("Invalid audit package name");
    const entry = context.profile === "workspace" ? raw : object(raw).via;
    if (
      !Array.isArray(entry) ||
      (context.profile === "workspace" && entry.length === 0) ||
      (context.profile === "production" &&
        (!Array.isArray(object(raw).nodes) ||
          object(raw).name !== name ||
          !levels.includes(String(object(raw).severity)) ||
          object(raw).severity === "critical"))
    )
      throw new Error("Malformed audit vulnerability");
    const dependencies: string[] = [];
    for (const item of entry) {
      if (typeof item === "string" && context.profile === "production") {
        dependencies.push(item);
        continue;
      }
      const advisory = object(item);
      const id = String(advisory.url ?? "").replace("https://github.com/advisories/", "");
      const range = context.profile === "workspace" ? advisory.vulnerable_versions : advisory.range;
      if (
        !ghsa.test(id) ||
        advisory.url !== `https://github.com/advisories/${id}` ||
        advisory.severity === "critical" ||
        !levels.includes(String(advisory.severity)) ||
        typeof range !== "string" ||
        !range ||
        (context.profile === "production" &&
          (advisory.name !== name || advisory.dependency !== name))
      )
        throw new Error("Malformed or critical audit advisory");
      if (advisoryIds.has(`${name}:${id}`)) throw new Error("Duplicate audit advisory");
      advisoryIds.add(`${name}:${id}`);
      if (
        context.profile === "production" &&
        levels.indexOf(String(object(raw).severity)) < levels.indexOf(String(advisory.severity))
      )
        throw new Error("npm audit severity contradicts leaf advisory");
      leaves.add(name);
      const instances =
        context.profile === "workspace"
          ? [...nodes.values()].filter((node) => node.name === name)
          : (object(raw).nodes as string[]).map((path) => nodes.get(path));
      if (instances.length === 0 || instances.some((node) => !node || node.name !== name))
        throw new Error("Missing installed audit instance");
      if (context.profile === "production") {
        const reported = new Set(object(raw).nodes as string[]);
        if (
          reported.size !== (object(raw).nodes as string[]).length ||
          [...nodes.values()].some(
            (node) =>
              node.name === name &&
              node.chains.length > 0 &&
              Bun.semver.satisfies(node.version, range) &&
              !reported.has(node.path),
          )
        )
          throw new Error(`npm audit omitted an affected installed instance: ${name}`);
      }
      let matched = 0;
      for (const node of instances) {
        if (!node || !Bun.semver.satisfies(node.version, range)) continue;
        matched++;
        if (!node.chains.length)
          throw new Error(`Unreviewed affected instance: ${name}@${node.version}`);
        for (const chain of node.chains) {
          const waiver = allowed.find(
            (e) =>
              e.profile === context.profile &&
              (context.profile === "workspace" || e.line === context.manifest?.line) &&
              e.id === id &&
              e.severity === advisory.severity &&
              e.package === name &&
              e.version === node.version &&
              key(e.chain) === key(chain),
          );
          if (!waiver)
            throw new Error(`Uncovered ${id} ${name}@${node.version} via ${chain.join(" > ")}`);
          accepted.push({
            id,
            package: name,
            version: node.version,
            path: node.path,
            chain,
            expiresOn: waiver.expiresOn,
          });
        }
      }
      if (!matched) throw new Error(`No affected installed instance for ${id}`);
    }
    refs.set(name, dependencies);
  }
  if (context.profile === "production") {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const resolves = (name: string): boolean => {
      if (visiting.has(name)) throw new Error("Cyclic npm audit via references");
      if (visited.has(name)) return true;
      if (!refs.has(name)) throw new Error(`Unresolved npm audit via: ${name}`);
      visiting.add(name);
      for (const dependency of refs.get(name) ?? []) resolves(dependency);
      visiting.delete(name);
      visited.add(name);
      return leaves.has(name) || (refs.get(name)?.length ?? 0) > 0;
    };
    for (const [name, raw] of Object.entries(vulnerabilities)) {
      if (!resolves(name)) throw new Error(`Orphan npm audit entry: ${name}`);
      for (const path of object(raw).nodes as string[])
        if (nodes.get(path)?.name !== name) throw new Error(`Unresolved npm audit node: ${path}`);
      for (const dependency of refs.get(name) ?? []) {
        if (
          levels.indexOf(String(object(raw).severity)) <
          levels.indexOf(String(object(vulnerabilities[dependency]).severity))
        )
          throw new Error("npm audit ancestor severity contradicts dependency");
        if (
          !(
            name === options.expected.packageName &&
            [...nodes.values()].some((node) =>
              node.chains.some((chain) => chain[0]?.startsWith(`${dependency}@`)),
            )
          ) &&
          ![...nodes.values()].some((node) =>
            node.chains.some((chain) =>
              chain.some(
                (part, index) =>
                  part.startsWith(`${name}@`) && chain[index + 1]?.startsWith(`${dependency}@`),
              ),
            ),
          )
        )
          throw new Error(
            `npm audit via edge absent from installed graph: ${name} -> ${dependency}`,
          );
      }
    }
  }
  return {
    profile: context.profile,
    rawAffectedPackages: Object.keys(vulnerabilities).length,
    rawAdvisories: [...new Set(accepted.map((row) => row.id))],
    accepted,
    uncovered: 0,
    status: accepted.length ? "accepted-temporary-risk" : "no-findings",
  };
}
