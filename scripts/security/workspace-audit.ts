import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateAudit, installedContext } from "./audit";

if (import.meta.main) {
  const [flag, directory] = process.argv.slice(2);
  if (flag !== "--out" || !directory || process.argv.length !== 4)
    throw new Error("Usage: workspace-audit.ts --out <evidence-directory>");
  const root = resolve(import.meta.dir, "../..");
  const output = resolve(directory);
  mkdirSync(output, { recursive: true });
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const result = Bun.spawnSync(["bun", "audit", "--json"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const raw = result.stdout.toString();
  writeFileSync(resolve(output, "audit.json"), raw);
  writeFileSync(resolve(output, "audit.stderr"), result.stderr.toString());
  writeFileSync(resolve(output, "audit-exit.json"), JSON.stringify({ exitCode: result.exitCode }));
  const context = installedContext(root, "workspace", sourceCommit);
  writeFileSync(resolve(output, "audit-context.json"), JSON.stringify(context, null, 2));
  try {
    if (result.exitCode !== 0 && result.exitCode !== 1)
      throw new Error(`bun audit failed (${result.exitCode})`);
    const decision = evaluateAudit(
      JSON.parse(raw),
      context,
      JSON.parse(readFileSync(resolve(root, "security/audit-exceptions.json"), "utf8")),
      { expected: { sourceCommit }, profile: "workspace", exitCode: result.exitCode },
    );
    writeFileSync(resolve(output, "audit-decision.json"), JSON.stringify(decision, null, 2));
    console.log(
      JSON.stringify(
        {
          status: decision.status,
          rawAffectedPackages: decision.rawAffectedPackages,
          rawAdvisories: decision.rawAdvisories,
          acceptedRoutes: decision.accepted.length,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    writeFileSync(
      resolve(output, "audit-decision.json"),
      JSON.stringify({ status: "blocked", reason: String(error) }, null, 2),
    );
    throw error;
  }
}
