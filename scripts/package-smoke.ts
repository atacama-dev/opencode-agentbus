import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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
      readonly maxActiveSessionsPerPrincipal: number;
      readonly port: number;
    },
    logger: { info(): void; warn(): void; error(): void },
  ): Promise<RunningBrokerDaemon>;
}

interface SpawnedBrokerProcess {
  readonly pid: number | undefined;
  readonly exited: Promise<number | null>;
}

interface InstalledBootstrapModule {
  readonly BrokerBootstrap: new (
    config: Record<string, unknown>,
    dependencies?: Record<string, unknown>,
  ) => { ensureReady(): Promise<void> };
  launchBundledBroker(input: {
    readonly hostname: "127.0.0.1";
    readonly port: number;
    readonly credentialFilePath: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly maxActiveSessionsPerPrincipal: number;
  }): SpawnedBrokerProcess;
  brokerChildEnvironment(input: {
    readonly hostname: "127.0.0.1";
    readonly port: number;
    readonly credentialFilePath: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly maxActiveSessionsPerPrincipal: number;
  }): Readonly<Record<string, string>>;
  resolveBundledBrokerCli(): string;
}

interface PluginHooks {
  readonly tool?: Readonly<
    Record<
      string,
      {
        execute(args: Record<string, unknown>, context: Record<string, unknown>): Promise<unknown>;
      }
    >
  >;
  readonly dispose?: () => Promise<void>;
}

type PluginFactory = (
  input: Record<string, unknown>,
  options: Record<string, unknown>,
) => Promise<PluginHooks>;

interface SmokeToolResult {
  readonly output: string;
}

async function eventually<T>(operation: () => Promise<T>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let failure: unknown;
  while (Date.now() < deadline) {
    try {
      return await operation();
    } catch (error) {
      failure = error;
      await Bun.sleep(25);
    }
  }
  throw failure instanceof Error ? failure : new Error("Installed package operation timed out.");
}

function smokeHost(sessionId: string, title: string): Record<string, unknown> {
  const directory = "/package-smoke";
  return {
    client: {
      session: {
        list: async () => ({
          data: [
            {
              id: sessionId,
              projectID: "package_smoke",
              directory,
              title,
              version: "1.18.19",
              time: { created: 1, updated: 1 },
            },
          ],
        }),
        status: async () => ({ data: { [sessionId]: { type: "idle" } } }),
      },
      project: {
        current: async () => ({
          data: { id: "package_smoke", worktree: directory, time: { created: 1 } },
        }),
      },
      tui: {
        showToast: async () => ({ data: true }),
        publish: async () => ({ data: true }),
      },
    },
    directory,
    worktree: directory,
    serverUrl: new URL("http://127.0.0.1:4096"),
    project: { id: "package_smoke", worktree: directory, time: { created: 1 } },
    experimental_workspace: { register: () => undefined },
    $: {},
  };
}

function smokeContext(sessionId: string, permissions: string[]): Record<string, unknown> {
  return {
    sessionID: sessionId,
    messageID: `message_${sessionId}`,
    agent: "build",
    directory: "/package-smoke",
    worktree: "/package-smoke",
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async (input: { permission?: unknown }) => {
      permissions.push(String(input.permission));
    },
  };
}

async function executeSmokeTool(
  hooks: PluginHooks,
  name: string,
  args: Record<string, unknown>,
  context: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const definition = hooks.tool?.[name];
  if (!definition) throw new Error(`Installed plugin is missing ${name}.`);
  const result = await definition.execute(args, context);
  if (typeof result !== "object" || result === null || !("output" in result)) {
    throw new Error(`Installed ${name} returned an invalid tool result.`);
  }
  return JSON.parse((result as SmokeToolResult).output) as Record<string, unknown>;
}

async function assertReplyCapablePlugin(pluginFactory: PluginFactory): Promise<void> {
  const hooks = await pluginFactory(
    {
      client: {
        session: { list: async () => ({ data: [] }) },
        project: { current: async () => ({ data: undefined }) },
        tui: {
          showToast: async () => ({ data: true }),
          publish: async () => ({ data: true }),
        },
      },
      directory: "/package-smoke",
      worktree: "/package-smoke",
      serverUrl: new URL("http://127.0.0.1:4096"),
      project: {
        id: "package_smoke",
        worktree: "/package-smoke",
        time: { created: 1 },
      },
      experimental_workspace: { register: () => undefined },
      $: {},
    },
    {
      credentialFilePath: "/does/not/connect/in/package-smoke",
      autoStartBroker: false,
    },
  );
  try {
    const toolNames = Object.keys(hooks.tool ?? {}).sort();
    if (
      JSON.stringify(toolNames) !==
      JSON.stringify([
        "agentbus_receive",
        "agentbus_reply",
        "agentbus_search_sessions",
        "agentbus_send",
      ])
    ) {
      throw new Error(`Plugin package exposes unexpected model tools: ${toolNames.join(", ")}`);
    }
  } finally {
    await hooks.dispose?.();
  }
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

async function reserveLoopbackPort(): Promise<number> {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 503 }),
  });
  const port = reservation.port;
  await reservation.stop(true);
  return port;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopSpawnedBroker(child: SpawnedBrokerProcess): Promise<void> {
  const pid = child.pid;
  if (pid !== undefined && processIsAlive(pid)) process.kill(pid, "SIGTERM");
  await Promise.race([child.exited, Bun.sleep(2_000)]);
  if (pid !== undefined && processIsAlive(pid)) {
    process.kill(pid, "SIGKILL");
    await Promise.race([child.exited, Bun.sleep(2_000)]);
  }
  if (pid !== undefined && processIsAlive(pid)) {
    throw new Error("Installed-shape broker process did not stop.");
  }
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
if (protocol.PROTOCOL_VERSION !== 2 || typeof protocol.bodySha256 !== "function") {
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
      maxActiveSessionsPerPrincipal: 300,
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
await assertReplyCapablePlugin(plugin.default as PluginFactory);

const installedShapeDirectory = mkdtempSync(join(rootDirectory, ".agentbus-installed-smoke-"));
let installedBrokerProcess: SpawnedBrokerProcess | undefined;
const installedHooks: PluginHooks[] = [];
try {
  const installedNodeModules = join(installedShapeDirectory, "node_modules", "@opencode-agentbus");
  mkdirSync(installedNodeModules, { recursive: true });
  for (const [packageName, packageDirectory] of Object.entries(packageDirectories)) {
    const installedPackage = join(installedNodeModules, packageName);
    mkdirSync(installedPackage, { recursive: true });
    cpSync(join(packageDirectory, "dist"), join(installedPackage, "dist"), { recursive: true });
    cpSync(join(packageDirectory, "package.json"), join(installedPackage, "package.json"));
  }
  for (const [specifier, source] of Object.entries({
    "@modelcontextprotocol/sdk": join(
      packageDirectories.plugin,
      "node_modules",
      "@modelcontextprotocol",
      "sdk",
    ),
    "@opencode-ai/plugin": join(
      packageDirectories.plugin,
      "node_modules",
      "@opencode-ai",
      "plugin",
    ),
    zod: join(packageDirectories.protocol, "node_modules", "zod"),
  })) {
    const destination = join(installedShapeDirectory, "node_modules", ...specifier.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(realpathSync(source), destination, "dir");
  }
  const consumerDirectory = join(installedShapeDirectory, "consumer");
  mkdirSync(consumerDirectory);
  writeFileSync(join(consumerDirectory, "package.json"), '{"type":"module"}\n', "utf8");
  const installedPluginEntry = resolvePackageExport(consumerDirectory, "@opencode-agentbus/plugin");
  const installedBrokerCliEntry = resolvePackageExport(
    consumerDirectory,
    "@opencode-agentbus/broker/cli",
  );
  const installedPlugin = await importBuiltModule(installedPluginEntry);
  if (JSON.stringify(Object.keys(installedPlugin).sort()) !== JSON.stringify(["default"])) {
    throw new Error("Installed-shape plugin package must expose only its default export.");
  }
  await assertReplyCapablePlugin(installedPlugin.default as PluginFactory);
  const bootstrap = (await importBuiltModule(
    join(dirname(installedPluginEntry), "broker-bootstrap.js"),
  )) as unknown as InstalledBootstrapModule;
  if (
    typeof bootstrap.resolveBundledBrokerCli !== "function" ||
    bootstrap.resolveBundledBrokerCli() !== installedBrokerCliEntry
  ) {
    throw new Error("Installed-shape plugin did not resolve its bundled broker CLI dependency.");
  }

  const installedStateDirectory = join(installedShapeDirectory, "state");
  mkdirSync(installedStateDirectory, { mode: 0o700 });
  const installedDatabasePath = join(installedStateDirectory, "broker.sqlite");
  const installedCredentialFilePath = join(installedStateDirectory, "credential.json");
  const installedPort = await reserveLoopbackPort();
  const installedEnvironment = {
    PATH: process.env.PATH,
    HOME: installedStateDirectory,
    OPENCODE_AGENTBUS_DB_PATH: installedDatabasePath,
    OPENCODE_AGENTBUS_MAX_ACTIVE_SESSIONS_PER_PRINCIPAL: "1",
    OPENAI_API_KEY: "must-not-be-inherited",
    NODE_OPTIONS: "--require=/must-not-be-inherited.js",
    BUN_OPTIONS: "--preload=/must-not-be-inherited.ts",
  };
  const installedLaunchInput = {
    hostname: "127.0.0.1",
    port: installedPort,
    credentialFilePath: installedCredentialFilePath,
    environment: installedEnvironment,
    maxActiveSessionsPerPrincipal: 300,
  } as const;
  const installedChildEnvironment = bootstrap.brokerChildEnvironment(installedLaunchInput);
  if (
    installedChildEnvironment.OPENCODE_AGENTBUS_MAX_ACTIVE_SESSIONS_PER_PRINCIPAL !== "300" ||
    "OPENAI_API_KEY" in installedChildEnvironment ||
    "NODE_OPTIONS" in installedChildEnvironment ||
    "BUN_OPTIONS" in installedChildEnvironment
  ) {
    throw new Error("Installed plugin did not propagate the explicit bounded broker capacity.");
  }
  installedBrokerProcess = bootstrap.launchBundledBroker(installedLaunchInput);
  const installedReadiness = new bootstrap.BrokerBootstrap(
    {
      endpoint: `http://127.0.0.1:${installedPort}`,
      timeoutMs: 250,
      credentialFilePath: installedCredentialFilePath,
      autoStartBroker: false,
      brokerStartupTimeoutMs: 5_000,
      maxActiveSessionsPerPrincipal: 300,
    },
    { environment: installedEnvironment },
  );
  await Promise.race([
    eventually(() => installedReadiness.ensureReady()),
    installedBrokerProcess.exited.then((code) => {
      throw new Error(`Installed-shape broker CLI exited before readiness (${String(code)}).`);
    }),
  ]);
  if (!existsSync(installedDatabasePath) || !existsSync(installedCredentialFilePath)) {
    throw new Error("Installed-shape broker CLI did not create isolated persistent state.");
  }

  const installedPluginFactory = installedPlugin.default as PluginFactory;
  const installedOptions = {
    endpoint: `http://127.0.0.1:${installedPort}`,
    timeoutMs: 500,
    credentialFilePath: installedCredentialFilePath,
    autoStartBroker: false,
    maxActiveSessionsPerPrincipal: 300,
  };
  const hooksA = await installedPluginFactory(
    smokeHost("installed_host_a", "Installed A"),
    installedOptions,
  );
  const hooksB = await installedPluginFactory(
    smokeHost("installed_host_b", "Installed B"),
    installedOptions,
  );
  installedHooks.push(hooksA, hooksB);
  const permissionsA: string[] = [];
  const permissionsB: string[] = [];
  const contextA = smokeContext("installed_host_a", permissionsA);
  const contextB = smokeContext("installed_host_b", permissionsB);

  const targetHandle = await eventually(async () => {
    const registry = await executeSmokeTool(
      hooksA,
      "agentbus_search_sessions",
      { query: "Installed B", limit: 1 },
      contextA,
    );
    const match = Array.isArray(registry.matches)
      ? (registry.matches[0] as { handle?: unknown } | undefined)
      : undefined;
    if (typeof match?.handle !== "string") {
      throw new Error("Installed plugin search did not return B's target handle.");
    }
    return match.handle;
  });
  const sent = await executeSmokeTool(
    hooksA,
    "agentbus_send",
    { target: targetHandle, body: "installed A to B", ttlSeconds: 60 },
    contextA,
  );
  if (typeof sent.messageId !== "string" || "body" in sent) {
    throw new Error("Installed send receipt is invalid or contains a body.");
  }
  const delivered = await eventually(() =>
    executeSmokeTool(hooksB, "agentbus_receive", {}, contextB),
  );
  if (
    delivered.messageId !== sent.messageId ||
    delivered.body !== "installed A to B" ||
    "replyToMessageId" in delivered
  ) {
    throw new Error("Installed plugin did not deliver A to B.");
  }
  const replied = await executeSmokeTool(
    hooksB,
    "agentbus_reply",
    { messageId: delivered.messageId, body: "installed B to A", ttlSeconds: 60 },
    contextB,
  );
  if (
    typeof replied.messageId !== "string" ||
    replied.messageId === sent.messageId ||
    replied.replyToMessageId !== sent.messageId ||
    "body" in replied
  ) {
    throw new Error("Installed reply receipt correlation is invalid.");
  }
  const deliveredReply = await eventually(() =>
    executeSmokeTool(hooksA, "agentbus_receive", {}, contextA),
  );
  if (
    deliveredReply.messageId !== replied.messageId ||
    deliveredReply.replyToMessageId !== sent.messageId ||
    deliveredReply.body !== "installed B to A"
  ) {
    throw new Error("Installed plugin did not deliver the correlated reply to A.");
  }
  if (
    !permissionsA.includes("agentbus_search_sessions") ||
    !permissionsA.includes("agentbus_receive") ||
    !permissionsB.includes("agentbus_receive")
  ) {
    throw new Error("Installed end-to-end flow did not traverse native approval hooks.");
  }

  await Promise.all(installedHooks.splice(0).map((hooks) => hooks.dispose?.()));
  await stopSpawnedBroker(installedBrokerProcess);
  installedBrokerProcess = undefined;
} finally {
  await Promise.all(
    installedHooks.splice(0).map((hooks) => hooks.dispose?.().catch(() => undefined)),
  );
  if (installedBrokerProcess) await stopSpawnedBroker(installedBrokerProcess);
  rmSync(installedShapeDirectory, { recursive: true, force: true });
}

const expectedDependencies: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  broker: {
    "@modelcontextprotocol/sdk": "1.30.0",
    "@opencode-agentbus/protocol": "workspace:0.1.0",
    zod: "3.25.76",
  },
  plugin: {
    "@modelcontextprotocol/sdk": "1.30.0",
    "@opencode-agentbus/broker": "workspace:0.1.0",
    "@opencode-agentbus/protocol": "workspace:0.1.0",
    "@opencode-ai/plugin": "1.18.19",
    "@opencode/plugin": "2.2.7",
    "@opencode/client": "2.2.7",
    "@opencode/schema": "2.2.7",
    effect: "4.1.0",
    zod: "3.25.76",
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
  "Package smoke passed: protocol v2, installed broker/plugin A-to-B send, delivery, correlated reply, and return delivery.",
);
