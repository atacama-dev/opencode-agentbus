import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { auditProductTree } from "./audit-plugin-source-lib";
import { auditV2ProductTree } from "./audit-v2";

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginSourceDirectory = resolve(rootDirectory, "packages/plugin/src");
const report = auditProductTree(pluginSourceDirectory);
const v2Violations = auditV2ProductTree(pluginSourceDirectory);
if (v2Violations.length) {
  console.error("V2 host/fixed-admission audit failed:", v2Violations);
  process.exitCode = 1;
}

if (report.violations.length > 0) {
  console.error(
    "Static audit failed. Plugin product code must not use prompt/synthetic APIs, forbidden clients, or executable symlinks:",
  );
  for (const violation of report.violations) {
    console.error(
      `- ${relative(rootDirectory, pluginSourceDirectory)}/${violation.file}:${violation.line}:${violation.column}: ${violation.rule} (${violation.detail})`,
    );
  }
  process.exitCode = 1;
} else {
  console.log(`Static audit passed: scanned ${report.scannedFiles} plugin product files.`);
}
