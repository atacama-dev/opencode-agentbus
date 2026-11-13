import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("a clean package build makes declared CLI entries owner-executable", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentbus-build-bin-"));
  try {
    mkdirSync(join(directory, "src"));
    writeFileSync(
      join(directory, "src/cli.ts"),
      "#!/usr/bin/env bun\nexport const fixture: boolean = true;\n",
    );
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: "build-fixture", private: true, bin: { fixture: "./dist/cli.js" } }),
    );
    writeFileSync(
      join(directory, "tsconfig.build.json"),
      JSON.stringify({
        // Exercise CLI output permissions without loading unrelated browser declarations.
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          outDir: "dist",
          lib: ["ES2022"],
          types: [],
        },
        include: ["src/**/*.ts"],
      }),
    );
    const executable = join(directory, "dist/cli.js");
    for (let build = 0; build < 2; build++) {
      if (build > 0) chmodSync(executable, 0o600);
      const result = Bun.spawnSync(
        [process.execPath, resolve(import.meta.dir, "run-package-tsc.ts"), "build"],
        { cwd: directory, stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(statSync(executable).mode & 0o100).toBe(0o100);
      expect(readFileSync(executable, "utf8")).toStartWith("#!/usr/bin/env bun\n");
      expect(readFileSync(executable, "utf8")).toContain("export const fixture = true;");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
