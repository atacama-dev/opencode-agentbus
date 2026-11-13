import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  readReleaseConfig,
  REPOSITORY_ROOT,
  type PackageArtifact,
  type ReleaseLine,
} from "./config";
import { publicDependencies, validatePackedManifest } from "./package";

export function parseArtifact(value: unknown): PackageArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid artifact manifest");
  const obj = value as Record<string, unknown>;
  if (
    Object.keys(obj).sort().join(",") !==
      "line,packageName,schemaVersion,sha256,sourceCommit,tarball,version" ||
    obj.schemaVersion !== 1 ||
    (obj.line !== "v1" && obj.line !== "v2") ||
    typeof obj.packageName !== "string" ||
    typeof obj.version !== "string" ||
    typeof obj.tarball !== "string" ||
    !/^[a-z0-9][a-z0-9.-]*\.tgz$/u.test(obj.tarball) ||
    basename(obj.tarball) !== obj.tarball ||
    typeof obj.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(obj.sha256) ||
    typeof obj.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(obj.sourceCommit)
  )
    throw new Error("Invalid artifact manifest fields");
  return obj as unknown as PackageArtifact;
}

export function validateArchiveNames(names: string[]): void {
  if (new Set(names).size !== names.length) throw new Error("Duplicate archive entries");
  const required = [
    "package/package.json",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/LICENSE",
    "package/README.md",
    "package/node_modules/@opencode-agentbus/broker/package.json",
    "package/node_modules/@opencode-agentbus/protocol/package.json",
  ];
  if (!required.every((name) => names.includes(name))) throw new Error("Missing archive entries");
  for (const name of names) {
    if (required.includes(name)) continue;
    if (
      !/^package\/node_modules\/@opencode-agentbus\/(?:broker|protocol)\/(?:dist\/[a-z0-9-]+\.(?:js|d\.ts)|LICENSE)$/u.test(
        name,
      )
    )
      throw new Error(`Forbidden archive entry: ${name}`);
  }
}

export interface AuditCounts {
  readonly info: number;
  readonly low: number;
  readonly moderate: number;
  readonly high: number;
  readonly critical: number;
  readonly total: number;
}

export function validateAuditEvidence(output: string, exitCode: number): AuditCounts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Invalid npm audit JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid npm audit report");
  const report = parsed as Record<string, unknown>;
  const metadata = report.metadata as Record<string, unknown> | undefined;
  const counts = metadata?.vulnerabilities as Record<string, unknown> | undefined;
  const vulnerabilities = report.vulnerabilities;
  if (
    report.error !== undefined ||
    report.auditReportVersion !== 2 ||
    !vulnerabilities ||
    typeof vulnerabilities !== "object" ||
    Array.isArray(vulnerabilities) ||
    !counts ||
    typeof counts !== "object" ||
    Array.isArray(counts)
  )
    throw new Error("npm audit returned an error or incomplete evidence");
  const levels = ["info", "low", "moderate", "high", "critical"] as const;
  if (
    [...levels, "total"].some(
      (key) => !Number.isSafeInteger(counts[key]) || (counts[key] as number) < 0,
    )
  )
    throw new Error("npm audit returned invalid vulnerability counts");
  const total = levels.reduce((sum, level) => sum + (counts[level] as number), 0);
  if (
    counts.total !== total ||
    Object.keys(vulnerabilities).length !== total ||
    (exitCode !== 0 && exitCode !== 1) ||
    (exitCode === 0) !== (total === 0)
  )
    throw new Error("npm audit exit status and vulnerability counts disagree");
  return counts as unknown as AuditCounts;
}

async function typecheckConsumer(
  scratch: string,
  consumer: string,
  installedRoot: string,
  packageName: string,
  line: ReleaseLine,
): Promise<{ exitCode: number; output: string }> {
  const compiler = join(REPOSITORY_ROOT, "node_modules/typescript/bin/tsc");
  const compilerVersion = JSON.parse(
    readFileSync(join(REPOSITORY_ROOT, "node_modules/typescript/package.json"), "utf8"),
  ).version;
  if (compilerVersion !== "5.7.2" || !existsSync(compiler))
    throw new Error("Pinned TypeScript 5.7.2 build tool is unavailable");
  const tooling = join(scratch, "type-toolchain");
  mkdirSync(tooling);
  writeFileSync(
    join(tooling, "package.json"),
    JSON.stringify({
      private: true,
      name: "agentbus-type-toolchain",
      version: "0.0.0",
      devDependencies: { "@types/node": "22.15.30" },
    }),
  );
  await command(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"], tooling);
  writeFileSync(
    join(consumer, "type-consumer.ts"),
    line === "v1"
      ? `import entry from "${packageName}";\nimport type { Plugin } from "@opencode-ai/plugin";\nconst plugin: Plugin = entry;\nvoid plugin;\n`
      : `import entry from "${packageName}";\nimport type { Plugin } from "@opencode/plugin/effect";\nconst plugin: Plugin.Plugin<import("effect/Scope").Scope> = entry;\nvoid plugin;\n`,
  );
  const internalFixture = join(installedRoot, "__type_probe__.ts");
  writeFileSync(
    internalFixture,
    'import type { BrokerDaemon } from "@opencode-agentbus/broker";\nimport { launchBrokerDaemon } from "@opencode-agentbus/broker/cli";\nconst launch: typeof launchBrokerDaemon = launchBrokerDaemon;\nconst daemon: BrokerDaemon | undefined = undefined;\nvoid launch; void daemon;\n',
  );
  writeFileSync(
    join(consumer, "tsconfig.release-smoke.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        skipLibCheck: false,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ES2022", "DOM"],
        types: ["node"],
        typeRoots: [join(consumer, "node_modules/@types"), join(tooling, "node_modules/@types")],
      },
      files: ["./type-consumer.ts", internalFixture],
    }),
  );
  const check = await command(
    ["node", compiler, "--project", "tsconfig.release-smoke.json", "--pretty", "false"],
    consumer,
    true,
  );
  return { exitCode: check.code, output: check.output };
}

async function command(
  argv: string[],
  cwd: string,
  allowFailure = false,
): Promise<{ output: string; code: number }> {
  const child = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: join(cwd, ".npm-home"),
      npm_config_cache: join(cwd, ".npm-cache"),
      TMPDIR: "/tmp/opencode",
    },
  });
  const [output, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (!allowFailure && code !== 0)
    throw new Error(
      `${argv[0]} failed (${code}): ${stderr.slice(0, 2500)} ${output.slice(0, 1000)}`,
    );
  return { output, code };
}

export async function smokeArchive(manifestPath: string): Promise<void> {
  const absolute = resolve(manifestPath);
  const artifact = parseArtifact(JSON.parse(readFileSync(absolute, "utf8")));
  const config = readReleaseConfig();
  if (
    artifact.packageName !== config.packageNames[artifact.line] ||
    artifact.version !== config.version ||
    !config.supportedLines.includes(artifact.line)
  )
    throw new Error("Artifact identity does not match release config");
  const archive = join(dirname(absolute), artifact.tarball);
  if (
    createHash("sha256")
      .update(new Uint8Array(readFileSync(archive)))
      .digest("hex") !== artifact.sha256
  )
    throw new Error("Archive SHA-256 mismatch");
  mkdirSync("/tmp/opencode", { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync("/tmp/opencode/agentbus-consumer-");
  try {
    const listing = (await command(["tar", "-tzf", archive], scratch)).output.trim().split("\n");
    validateArchiveNames(listing);
    const verbose = (await command(["tar", "-tvzf", archive], scratch)).output.trim().split("\n");
    if (verbose.some((row) => !/^[\-d]/u.test(row)))
      throw new Error("Archive has symlinks or nonstandard entries");
    const unpack = join(scratch, "unpacked");
    mkdirSync(unpack);
    await command(["tar", "-xzf", archive, "-C", unpack], scratch);
    const packedRoot = join(unpack, "package");
    const rootManifest = JSON.parse(readFileSync(join(packedRoot, "package.json"), "utf8"));
    if (
      rootManifest.main !== "./dist/index.js" ||
      rootManifest.types !== "./dist/index.d.ts" ||
      rootManifest.exports?.["."]?.types !== rootManifest.types ||
      rootManifest.exports?.["."]?.import !== rootManifest.main ||
      rootManifest.exports?.["."].default !== rootManifest.main
    )
      throw new Error("Incorrect root JS/type export");
    const declarations = readFileSync(join(packedRoot, "dist/index.d.ts"), "utf8");
    if (
      declarations.includes("sourceMappingURL") ||
      /\bfrom ["']\./u.test(declarations) ||
      (artifact.line === "v1" &&
        (!declarations.includes("@opencode-ai/plugin") ||
          declarations.includes("@opencode/plugin"))) ||
      (artifact.line === "v2" &&
        (!declarations.includes("@opencode/plugin/effect") ||
          !declarations.includes("effect/Scope") ||
          declarations.includes("@opencode-ai/plugin")))
    )
      throw new Error("Incorrect or dangling root declarations");
    const expected = artifact.line === "v1" ? "@opencode-ai/plugin" : "@opencode/plugin";
    const unwanted =
      artifact.line === "v1"
        ? ["@opencode/plugin", "@opencode/client", "@opencode/schema", "effect"]
        : ["@opencode-ai/plugin"];
    if (
      rootManifest.name !== artifact.packageName ||
      rootManifest.version !== artifact.version ||
      Object.keys(rootManifest.exports ?? {}).join(",") !== "." ||
      Object.keys(rootManifest.dependencies ?? {})
        .sort()
        .join(",") !==
        [
          ...Object.keys(publicDependencies(artifact.line)),
          "@opencode-agentbus/broker",
          "@opencode-agentbus/protocol",
        ]
          .sort()
          .join(",") ||
      !rootManifest.dependencies?.[expected] ||
      unwanted.some((name) => name in rootManifest.dependencies) ||
      Object.entries(publicDependencies(artifact.line)).some(
        ([name, version]) => rootManifest.dependencies[name] !== version,
      ) ||
      JSON.stringify(rootManifest.bundledDependencies?.slice().sort()) !==
        JSON.stringify(["@opencode-agentbus/broker", "@opencode-agentbus/protocol"].sort())
    )
      throw new Error("Wrong packed dependency profile");
    for (const name of [
      "",
      "node_modules/@opencode-agentbus/broker",
      "node_modules/@opencode-agentbus/protocol",
    ])
      validatePackedManifest(
        JSON.parse(readFileSync(join(packedRoot, name, "package.json"), "utf8")),
      );
    if (
      artifact.line === "v2" &&
      (rootManifest.experimentalStock !== true ||
        rootManifest.focusOnReceiveApproval !== false ||
        Object.keys(rootManifest.exports).join(",") !== ".")
    )
      throw new Error("V2 stock experiment metadata invalid");
    const consumer = join(scratch, "consumer");
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "agentbus-independent-consumer",
        private: true,
        type: "module",
        dependencies: { [artifact.packageName]: archive },
      }),
    );
    await command(
      ["npm", "install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"],
      consumer,
    );
    const installedRoot = join(consumer, "node_modules", ...artifact.packageName.split("/"));
    if (!existsSync(join(installedRoot, "node_modules/@opencode-agentbus/broker/dist/cli.js")))
      throw new Error("Bundled broker not installed");
    copyFileSync(join(import.meta.dir, "fixtures/probe.ts"), join(consumer, "probe.ts"));
    await command(["bun", "probe.ts", artifact.packageName, artifact.line], consumer);
    const graph = await command(["npm", "ls", "--all", "--json"], consumer, true);
    writeFileSync(join(dirname(absolute), "consumer-graph.json"), graph.output);
    if (graph.code !== 0) throw new Error("Installed production dependency graph is invalid");
    const audit = await command(["npm", "audit", "--omit=dev", "--json"], consumer, true);
    writeFileSync(join(dirname(absolute), "audit.json"), audit.output);
    const vulnerabilities = validateAuditEvidence(audit.output, audit.code);
    const types = await typecheckConsumer(
      scratch,
      consumer,
      installedRoot,
      artifact.packageName,
      artifact.line,
    );
    writeFileSync(
      join(dirname(absolute), "typecheck.json"),
      JSON.stringify(
        { compiler: "TypeScript 5.7.2", strict: true, skipLibCheck: false, ...types },
        null,
        2,
      ),
    );
    if (types.exitCode !== 0)
      throw new Error(
        `Independent consumer strict typecheck failed: ${types.output.slice(0, 3500)}`,
      );
    console.log(
      JSON.stringify(
        {
          line: artifact.line,
          package: artifact.packageName,
          archive: artifact.tarball,
          sha256: artifact.sha256,
          runtime: "passed",
          hostAcceptance: "not tested (isolated fixture)",
          auditExit: audit.code,
          vulnerabilities,
          graphExit: graph.code,
          typecheck: "passed (strict, skipLibCheck:false)",
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--manifest")
    throw new Error("Usage: bun scripts/release/smoke.ts --manifest <line>/manifest.json");
  await smokeArchive(args[1] as string);
}
