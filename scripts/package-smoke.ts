import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const rootDirectory = resolve(import.meta.dir, "..");

interface PackageExport {
  readonly types?: string;
  readonly import?: string;
  readonly default?: string;
}

interface PackageManifest {
  readonly name?: string;
  readonly main?: string;
  readonly types?: string;
  readonly exports?: Record<string, PackageExport | string>;
  readonly bin?: Record<string, string>;
  readonly files?: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
}

interface RunningBrokerDaemon {
  readonly endpoint: string;
  stop(): Promise<void>;
}

interface BrokerCliModule {
  launchBrokerDaemon(
    config: {
      readonly databasePath: string;
      readonly credentialFilePath: string;
      readonly hostname: "127.0.0.1";
      readonly port: number;
    },
    logger: { info(): void; warn(): void; error(): void },
  ): Promise<RunningBrokerDaemon>;
}

const packageDirectories = {
  broker: resolve(rootDirectory, "packages/broker"),
  plugin: resolve(rootDirectory, "packages/plugin"),
  protocol: resolve(rootDirectory, "packages/protocol"),
} as const;

function readManifest(packageDirectory: string): PackageManifest {
  return JSON.parse(
    readFileSync(resolve(packageDirectory, "package.json"), "utf8"),
  ) as PackageManifest;
}

function manifestFile(packageDirectory: string, declaredPath: string): string {
  const absolutePath = resolve(packageDirectory, declaredPath);
  const packageRelativePath = relative(packageDirectory, absolutePath);
  if (packageRelativePath.startsWith("..") || packageRelativePath === "") {
    throw new Error(`Unsafe package path declaration: ${declaredPath}`);
  }
  return absolutePath;
}

function assertDeclaredFilesExist(packageDirectory: string, manifest: PackageManifest): void {
  const declaredPaths = new Set<string>();
  if (manifest.main) declaredPaths.add(manifest.main);
  if (manifest.types) declaredPaths.add(manifest.types);
  for (const packageExport of Object.values(manifest.exports ?? {})) {
    if (typeof packageExport === "string") declaredPaths.add(packageExport);
    else {
      if (packageExport.types) declaredPaths.add(packageExport.types);
      if (packageExport.import) declaredPaths.add(packageExport.import);
      if (packageExport.default) declaredPaths.add(packageExport.default);
    }
  }
  for (const executable of Object.values(manifest.bin ?? {})) declaredPaths.add(executable);
  for (const declaredPath of declaredPaths) {
    if (!existsSync(manifestFile(packageDirectory, declaredPath))) {
      throw new Error(`${manifest.name ?? packageDirectory} declares missing file ${declaredPath}`);
    }
  }
}

function assertBuiltExport(
  packageName: string,
  manifest: PackageManifest,
  subpath: string,
  outputName: string,
): void {
  const packageExport = manifest.exports?.[subpath];
  if (
    typeof packageExport === "string" ||
    packageExport?.types !== `./dist/${outputName}.d.ts` ||
    packageExport.import !== `./dist/${outputName}.js` ||
    packageExport.default !== `./dist/${outputName}.js`
  ) {
    throw new Error(`${packageName} ${subpath} does not expose built JS and declarations.`);
  }
}

function resolvePackageExport(packageDirectory: string, specifier: string): string {
  return createRequire(resolve(packageDirectory, "package.json")).resolve(specifier);
}

async function importBuiltModule(resolvedPath: string): Promise<Record<string, unknown>> {
  return (await import(`${pathToFileURL(resolvedPath).href}?smoke=${Date.now()}`)) as Record<
    string,
    unknown
  >;
}

const manifests = {
  broker: readManifest(packageDirectories.broker),
  plugin: readManifest(packageDirectories.plugin),
  protocol: readManifest(packageDirectories.protocol),
};

for (const [packageName, packageDirectory] of Object.entries(packageDirectories)) {
  const manifest = manifests[packageName as keyof typeof manifests];
  if (!manifest.files?.includes("dist")) {
    throw new Error(`${packageName} package does not declare built dist files.`);
  }
  assertDeclaredFilesExist(packageDirectory, manifest);
}
assertBuiltExport("protocol", manifests.protocol, ".", "index");
assertBuiltExport("broker", manifests.broker, ".", "index");
assertBuiltExport("broker", manifests.broker, "./cli", "cli");
assertBuiltExport("plugin", manifests.plugin, ".", "index");

const protocolEntry = resolvePackageExport(
  packageDirectories.broker,
  "@opencode-agentbus/protocol",
);
if (!protocolEntry.endsWith("/packages/protocol/dist/index.js")) {
  throw new Error(`Protocol workspace import resolved an unexpected entry: ${protocolEntry}`);
}
const protocol = await importBuiltModule(protocolEntry);
if (protocol.PROTOCOL_VERSION !== 1 || typeof protocol.bodySha256 !== "function") {
  throw new Error("Protocol package import did not expose the versioned runtime contract.");
}

const brokerRootEntry = resolvePackageExport(
  packageDirectories.broker,
  "@opencode-agentbus/broker",
);
const brokerCliEntry = resolvePackageExport(
  packageDirectories.broker,
  "@opencode-agentbus/broker/cli",
);
if (!brokerRootEntry.endsWith("/packages/broker/dist/index.js")) {
  throw new Error(`Broker root resolved an unexpected entry: ${brokerRootEntry}`);
}
if (!brokerCliEntry.endsWith("/packages/broker/dist/cli.js")) {
  throw new Error(`Broker CLI resolved an unexpected entry: ${brokerCliEntry}`);
}
await importBuiltModule(brokerRootEntry);
const brokerCli = await importBuiltModule(brokerCliEntry);
if (typeof brokerCli.launchBrokerDaemon !== "function") {
  throw new Error("Built broker CLI does not expose launchBrokerDaemon.");
}

const brokerBin = manifests.broker.bin?.["opencode-agentbus-broker"];
if (brokerBin !== "./dist/cli.js") {
  throw new Error("Broker bin must map opencode-agentbus-broker to ./dist/cli.js.");
}
if (manifests.broker.scripts?.start !== "bun ./dist/cli.js") {
  throw new Error("Broker start script must execute the already-built daemon CLI.");
}
const brokerCliFile = manifestFile(packageDirectories.broker, brokerBin);
if (!readFileSync(brokerCliFile, "utf8").startsWith("#!/usr/bin/env bun\n")) {
  throw new Error("Built broker CLI did not preserve the Bun shebang.");
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), "agentbus-package-smoke-"));
let daemon: RunningBrokerDaemon | undefined;
try {
  const databasePath = join(temporaryDirectory, "broker.sqlite");
  const credentialFilePath = join(temporaryDirectory, "credential.json");
  daemon = await (brokerCli as unknown as BrokerCliModule).launchBrokerDaemon(
    {
      databasePath,
      credentialFilePath,
      hostname: "127.0.0.1",
      port: 0,
    },
    { info() {}, warn() {}, error() {} },
  );
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/u.test(daemon.endpoint)) {
    throw new Error(`Built broker exposed an invalid endpoint: ${daemon.endpoint}`);
  }
  const response = await fetch(`${daemon.endpoint}/mcp`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (response.status !== 401)
    throw new Error("Built broker did not expose its authenticated MCP endpoint.");
  if (!existsSync(databasePath) || !existsSync(credentialFilePath)) {
    throw new Error("Built broker did not create isolated database and credential state.");
  }
  await daemon.stop();
  daemon = undefined;
} finally {
  if (daemon) await daemon.stop().catch(() => undefined);
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

const pluginEntry = resolvePackageExport(packageDirectories.plugin, "@opencode-agentbus/plugin");
if (!pluginEntry.endsWith("/packages/plugin/dist/index.js")) {
  throw new Error(`Plugin root resolved an unexpected entry: ${pluginEntry}`);
}
const plugin = await importBuiltModule(pluginEntry);
if (JSON.stringify(Object.keys(plugin).sort()) !== JSON.stringify(["default"])) {
  throw new Error(`Plugin package exposes unexpected exports: ${Object.keys(plugin).join(", ")}`);
}
if (typeof plugin.default !== "function") {
  throw new Error("Plugin default export must be a function.");
}

const expectedDependencies: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  broker: {
    "@modelcontextprotocol/sdk": "1.30.0",
    "@opencode-agentbus/protocol": "workspace:0.1.0",
    zod: "3.25.76",
  },
  plugin: {
    "@modelcontextprotocol/sdk": "1.30.0",
    "@opencode-agentbus/protocol": "workspace:0.1.0",
    "@opencode-ai/plugin": "1.18.19",
  },
  protocol: {
    zod: "3.25.76",
  },
};

const lifecycleScripts = new Set([
  "install",
  "pack",
  "postinstall",
  "postpack",
  "postpublish",
  "postversion",
  "preinstall",
  "prepack",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "preversion",
  "publish",
  "version",
]);

for (const [packageName, expected] of Object.entries(expectedDependencies)) {
  const manifest = manifests[packageName as keyof typeof manifests];
  if (JSON.stringify(manifest.dependencies) !== JSON.stringify(expected)) {
    throw new Error(`${packageName} dependencies are not the foundation-owned exact set.`);
  }
  if (Object.keys(manifest.scripts ?? {}).some((name) => lifecycleScripts.has(name))) {
    throw new Error(`${packageName} must not define package lifecycle scripts.`);
  }
}

const rootManifest = readManifest(rootDirectory);
if (Object.keys(rootManifest.scripts ?? {}).some((name) => lifecycleScripts.has(name))) {
  throw new Error("Root package must not define package lifecycle scripts.");
}

console.log(
  "Package smoke passed: protocol, broker root/CLI daemon, and default-only plugin built seams.",
);
