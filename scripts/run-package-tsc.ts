import { chmodSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const mode = Bun.argv[2];
if (mode !== "typecheck" && mode !== "build") {
  throw new TypeError("Expected package TypeScript mode: typecheck or build.");
}

const packageDirectory = process.cwd();
const sourceDirectory = resolve(packageDirectory, "src");
const testDirectories = [resolve(packageDirectory, "test"), resolve(packageDirectory, "tests")];

function hasTypeScriptSource(directory: string): boolean {
  if (!existsSync(directory)) return false;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && hasTypeScriptSource(path)) return true;
    if (entry.isFile() && /\.[cm]?tsx?$/u.test(entry.name)) return true;
  }
  return false;
}

const hasInputs =
  hasTypeScriptSource(sourceDirectory) ||
  (mode === "typecheck" && testDirectories.some(hasTypeScriptSource));

if (!hasInputs) {
  console.log(`${mode}: skipped (package has no product source yet)`);
} else {
  const config = mode === "build" ? "tsconfig.build.json" : "tsconfig.json";
  const tsc = resolve(import.meta.dir, "../node_modules/typescript/bin/tsc");
  const command = ["bun", tsc, ...(mode === "typecheck" ? ["--noEmit"] : []), "-p", config];
  const result = Bun.spawnSync(command, {
    cwd: packageDirectory,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!result.success) process.exitCode = result.exitCode;
  else if (mode === "build") {
    const manifest = JSON.parse(
      readFileSync(resolve(packageDirectory, "package.json"), "utf8"),
    ) as { bin?: Readonly<Record<string, string>> };
    for (const entry of Object.values(manifest.bin ?? {})) {
      const executable = resolve(packageDirectory, entry);
      chmodSync(executable, statSync(executable).mode | 0o100);
    }
  }
}
