import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, basename } from "node:path";
import {
  readReleaseConfig,
  releaseLine,
  REPOSITORY_ROOT,
  type PackageArtifact,
  type ReleaseConfig,
  type ReleaseLine,
} from "./config";

const internalVersion = "0.1.0";
const common = { "@modelcontextprotocol/sdk": "1.32.2", zod: "4.6.7" };
const internal = {
  "@opencode-agentbus/broker": internalVersion,
  "@opencode-agentbus/protocol": internalVersion,
};
const lifecycle = /^(pre|post)?(install|pack|publish|version)$|^prepare$|^prepublishOnly$/u;
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));

/** Covers literal static/dynamic imports and require calls, not computed runtime specifiers. */
export function assertDeclaredBundleImports(
  bundle: string,
  dependencies: Readonly<Record<string, string>>,
): void {
  for (const item of new Bun.Transpiler({ loader: "js" }).scanImports(bundle)) {
    const specifier = item.path;
    if (specifier.startsWith("node:") || specifier.startsWith("bun:") || builtins.has(specifier))
      continue;
    const parts = specifier.split("/");
    const packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    if (!packageName || !Object.hasOwn(dependencies, packageName))
      throw new Error(`Undeclared bundled JS import: ${specifier}`);
  }
}

export function assertPackageLine(config: ReleaseConfig, input: unknown): ReleaseLine {
  const line = releaseLine(input);
  if (!config.supportedLines.includes(line)) throw new Error(`Unsupported release line: ${line}`);
  return line;
}

function runtimeDependencies(line: ReleaseLine): Record<string, string> {
  return line === "v1"
    ? { ...common, "@opencode-ai/plugin": "1.18.19" }
    : {
        ...common,
        "@opencode/plugin": "2.2.7",
        "@opencode/client": "2.2.7",
        "@opencode/schema": "2.2.7",
        effect: "4.1.0",
      };
}

export function publicDependencies(line: ReleaseLine): Record<string, string> {
  return {
    ...runtimeDependencies(line),
    // The public V2 SDK exposes JSON Schema types without declaring this dependency.
    ...(line === "v2" ? { "@types/json-schema": "7.0.15" } : {}),
  };
}

export function assertSourcePins(
  line: ReleaseLine,
  plugin: { dependencies?: Record<string, string> },
  broker: { dependencies?: Record<string, string> },
  protocol: { dependencies?: Record<string, string> },
): void {
  if (
    Object.entries(runtimeDependencies(line)).some(
      ([name, version]) =>
        !(line === "v1" && name === "zod" && plugin.dependencies?.zod === undefined) &&
        plugin.dependencies?.[name] !== version,
    ) ||
    Object.entries(common).some(([name, version]) => broker.dependencies?.[name] !== version) ||
    protocol.dependencies?.zod !== common.zod
  )
    throw new Error("Release dependency pins differ from the tested source manifests.");
}

export function validatePackedManifest(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid package manifest");
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string")
    throw new Error("Invalid package identity");
  for (const section of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ] as const) {
    const deps = manifest[section];
    if (deps === undefined) continue;
    if (!deps || typeof deps !== "object" || Array.isArray(deps))
      throw new Error("Invalid dependencies");
    for (const version of Object.values(deps))
      if (
        typeof version !== "string" ||
        /^(?:workspace|file|link):/u.test(version) ||
        version.startsWith("/") ||
        version.startsWith(".")
      )
        throw new Error("Local/workspace dependency forbidden");
  }
  if (
    manifest.scripts &&
    (typeof manifest.scripts !== "object" ||
      Object.keys(manifest.scripts).some((key) => lifecycle.test(key)))
  )
    throw new Error("Lifecycle scripts forbidden");
}

function checkedDist(root: string, destination: string): void {
  const source = join(root, "dist");
  if (!existsSync(source)) throw new Error(`Build required: ${source}`);
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-z0-9-]+\.(?:js|d\.ts)$/u.test(entry.name)) continue;
    const content = readFileSync(join(source, entry.name), "utf8").replace(
      /^\/\/# sourceMappingURL=.*$/gmu,
      "",
    );
    writeFileSync(join(destination, entry.name), content, {
      mode: entry.name === "cli.js" ? 0o755 : 0o644,
    });
    if (entry.name === "cli.js") chmodSync(join(destination, entry.name), 0o755);
  }
}

function internalManifest(name: "broker" | "protocol") {
  const source = JSON.parse(
    readFileSync(join(REPOSITORY_ROOT, "packages", name, "package.json"), "utf8"),
  );
  if (source.version !== internalVersion) throw new Error(`Unexpected ${name} internal version`);
  const { main, types, exports, bin } = source;
  const result = {
    name: `@opencode-agentbus/${name}`,
    version: internalVersion,
    license: "GPL-3.0-or-later",
    type: "module",
    main,
    types,
    exports,
    ...(bin ? { bin } : {}),
    dependencies:
      name === "broker"
        ? { ...common, "@opencode-agentbus/protocol": internalVersion }
        : { zod: "4.6.7" },
  };
  validatePackedManifest(result);
  return result;
}

function stageInternal(stage: string, name: "broker" | "protocol"): void {
  const target = join(stage, "node_modules", "@opencode-agentbus", name);
  checkedDist(join(REPOSITORY_ROOT, "packages", name), join(target, "dist"));
  writeFileSync(
    join(target, "package.json"),
    `${JSON.stringify(internalManifest(name), null, 2)}\n`,
  );
  copyFileSync(join(REPOSITORY_ROOT, "LICENSE"), join(target, "LICENSE"));
}

function stageManifest(line: ReleaseLine, config: ReleaseConfig) {
  const result = {
    name: config.packageNames[line],
    version: config.version,
    license: "GPL-3.0-or-later",
    author: { name: "Julien Tesson", email: "julien@atacama.tech" },
    type: "module",
    description: `OpenCode Agent Bus ${line.toUpperCase()} adapter${line === "v2" ? " (experimental stock Effect)" : ""}`,
    repository: { type: "git", url: "https://github.com/atacama-dev/opencode-agentbus.git" },
    os: ["linux"],
    engines: { bun: ">=1.3.9" },
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js", default: "./dist/index.js" },
    },
    files: ["dist", "node_modules/@opencode-agentbus", "LICENSE", "README.md"],
    bundledDependencies: ["@opencode-agentbus/broker", "@opencode-agentbus/protocol"],
    dependencies: { ...publicDependencies(line), ...internal },
    ...(line === "v2"
      ? { experimental: true, experimentalStock: true, focusOnReceiveApproval: false }
      : {}),
  };
  validatePackedManifest(result);
  return result;
}

async function checkedCommand(command: string[], cwd: string): Promise<string> {
  const process = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: processEnvPath(),
      HOME: join(cwd, ".npm-home"),
      npm_config_cache: join(cwd, ".npm-cache"),
    },
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exit !== 0) throw new Error(`${command[0]} failed (${exit}): ${stderr.slice(0, 2000)}`);
  return stdout.trim();
}
function processEnvPath(): string {
  return process.env.PATH ?? "/usr/bin:/bin";
}

export async function packageLine(
  lineInput: unknown,
  outputRoot: string,
  root = REPOSITORY_ROOT,
): Promise<PackageArtifact> {
  if (resolve(root) !== REPOSITORY_ROOT)
    throw new Error("Packaging a different source root is not supported");
  const config = readReleaseConfig(root);
  const line = assertPackageLine(config, lineInput);
  const sourceManifest = (name: "plugin" | "broker" | "protocol") =>
    JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8"));
  assertSourcePins(
    line,
    sourceManifest("plugin"),
    sourceManifest("broker"),
    sourceManifest("protocol"),
  );
  const destination = resolve(outputRoot, line);
  const sourceCommit = (await checkedCommand(["git", "rev-parse", "HEAD"], root)).trim();
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error("Invalid source commit");
  mkdirSync("/tmp/opencode", { recursive: true, mode: 0o700 });
  const stage = mkdtempSync("/tmp/opencode/agentbus-pack-");
  try {
    const built = await Bun.build({
      entrypoints: [join(root, "packages/plugin/src", line === "v1" ? "index.ts" : "stock-v2.ts")],
      packages: "external",
      target: "bun",
      format: "esm",
      outdir: join(stage, "dist"),
      naming: "index.js",
    });
    if (!built.success) throw new Error(`Bun bundle failed: ${built.logs.map(String).join("; ")}`);
    const bundle = readFileSync(join(stage, "dist/index.js"), "utf8");
    if (
      line === "v1" &&
      /@opencode\/(?:plugin|client|schema)|agentbus-stock-experimental/u.test(bundle)
    )
      throw new Error("V2 runtime in V1 bundle");
    if (line === "v2" && /@opencode-ai\/plugin|createAgentBusPlugin\(/u.test(bundle))
      throw new Error("V1 runtime in V2 bundle");
    const declaration = readFileSync(
      join(root, "packages/plugin/dist", line === "v1" ? "index.d.ts" : "stock-v2.d.ts"),
      "utf8",
    ).replace(/^\/\/# sourceMappingURL=.*$/gmu, "");
    writeFileSync(join(stage, "dist/index.d.ts"), declaration);
    for (const name of ["protocol", "broker"] as const) stageInternal(stage, name);
    writeFileSync(
      join(stage, "package.json"),
      `${JSON.stringify(stageManifest(line, config), null, 2)}\n`,
    );
    assertDeclaredBundleImports(bundle, stageManifest(line, config).dependencies);
    copyFileSync(join(root, "LICENSE"), join(stage, "LICENSE"));
    writeFileSync(
      join(stage, "README.md"),
      `# OpenCode Agent Bus ${line.toUpperCase()}\n\nGPL-3.0-or-later. Requires Linux, Bun >=1.3.9 and OpenCode ${line === "v1" ? "1.18.19" : "2.2.7"}.\n\n${line === "v2" ? "EXPERIMENTAL stock V2 Effect plugin only: supply experimentalStock: true; focusOnReceiveApproval: false. This is not the paired server/TUI/RPC adapter. Native approval is required before receiving peer bodies. Native cross-project always approval can re-prompt.\n\n" : "V1 default async plugin. Native disclosure/search approvals are required. Cross-project always grants and manual attached-client acceptance remain outstanding.\n\n"}Publication, dependency-audit remediation and manual native-host acceptance remain gated; this archive is not a security certification. The bundled broker starts via its declared CLI; do not bypass native approval.\n\nCopyright (C) 2026 Julien Tesson <julien@atacama.tech>. You may redistribute and modify this program under the GNU GPL version 3 or, at your option, any later version. It comes without any warranty; see LICENSE for the full terms.\n\nPartly developed using [Roster](https://github.com/mathiasbourgoin/roster).\n`,
    );
    const packedOutput = JSON.parse(
      await checkedCommand(
        ["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", stage],
        stage,
      ),
    );
    const packed = Array.isArray(packedOutput)
      ? packedOutput[0]
      : packedOutput?.[config.packageNames[line]];
    if (
      typeof packed?.filename !== "string" ||
      !Array.isArray(packed.bundled) ||
      !["@opencode-agentbus/broker", "@opencode-agentbus/protocol"].every((name) =>
        packed.bundled.includes(name),
      )
    )
      throw new Error(
        `Invalid npm pack result or missing bundled dependencies: ${JSON.stringify(packedOutput).slice(0, 1200)}`,
      );
    const archive = join(stage, packed.filename);
    if (!existsSync(archive)) throw new Error("npm pack did not create archive");
    const sha256 = createHash("sha256")
      .update(new Uint8Array(readFileSync(archive)))
      .digest("hex");
    const manifest: PackageArtifact = {
      schemaVersion: 1,
      line,
      packageName: config.packageNames[line],
      version: config.version,
      tarball: basename(archive),
      sha256,
      sourceCommit,
    };
    mkdirSync(destination, { recursive: true });
    const target = join(destination, manifest.tarball);
    if (
      existsSync(target) &&
      createHash("sha256")
        .update(new Uint8Array(readFileSync(target)))
        .digest("hex") !== sha256
    )
      throw new Error("Different archive already exists; use a new output directory");
    const oldManifest = join(destination, "manifest.json");
    if (
      existsSync(oldManifest) &&
      readFileSync(oldManifest, "utf8") !== `${JSON.stringify(manifest, null, 2)}\n`
    )
      throw new Error("Different manifest already exists; use a new output directory");
    if (!existsSync(target)) copyFileSync(archive, target);
    writeFileSync(oldManifest, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--line" || args[2] !== "--out" || !args[3])
    throw new Error("Usage: bun scripts/release/package.ts --line v1|v2 --out release-artifacts");
  console.log(JSON.stringify(await packageLine(args[1], args[3]), null, 2));
}
