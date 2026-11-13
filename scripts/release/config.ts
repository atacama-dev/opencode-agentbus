import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ReleaseLine = "v1" | "v2";

export interface ReleaseConfig {
  readonly schemaVersion: 1;
  readonly releaseLine: ReleaseLine;
  readonly version: string;
  readonly supportedLines: readonly ReleaseLine[];
  readonly packageNames: Readonly<Record<ReleaseLine, string>>;
  readonly readiness: Readonly<Record<ReleaseLine, boolean>>;
  readonly publishEnabled: boolean;
}

export interface PackageArtifact {
  readonly schemaVersion: 1;
  readonly line: ReleaseLine;
  readonly packageName: string;
  readonly version: string;
  readonly tarball: string;
  readonly sha256: string;
  readonly sourceCommit: string;
}

export const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Release configuration must contain JSON objects.");
  return value as Record<string, unknown>;
}

export function releaseLine(value: unknown): ReleaseLine {
  if (value !== "v1" && value !== "v2") throw new Error("Release line must be v1 or v2.");
  return value;
}

export function isReleaseVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128 || !/^[0-9A-Za-z.-]+$/u.test(value))
    return false;
  const separator = value.indexOf("-");
  const core = separator < 0 ? value : value.slice(0, separator);
  const prerelease = separator < 0 ? undefined : value.slice(separator + 1);
  return (
    core.split(".").length === 3 &&
    core
      .split(".")
      .every((part) => /^(0|[1-9][0-9]*)$/u.test(part) && Number.isSafeInteger(Number(part))) &&
    (prerelease === undefined ||
      prerelease
        .split(".")
        .every(
          (part) =>
            /^[0-9A-Za-z-]+$/u.test(part) &&
            (!/^[0-9]+$/u.test(part) || /^(0|[1-9][0-9]*)$/u.test(part)),
        ))
  );
}

export function parseReleaseConfig(value: unknown): ReleaseConfig {
  const data = object(value);
  const keys = [
    "schemaVersion",
    "releaseLine",
    "version",
    "supportedLines",
    "packageNames",
    "readiness",
    "publishEnabled",
  ];
  if (
    Object.keys(data).length !== keys.length ||
    Object.keys(data).some((key) => !keys.includes(key))
  )
    throw new Error("Unexpected or missing release configuration field.");
  const line = releaseLine(data.releaseLine);
  const names = object(data.packageNames);
  const ready = object(data.readiness);
  if (
    data.schemaVersion !== 1 ||
    !isReleaseVersion(data.version) ||
    !Array.isArray(data.supportedLines) ||
    data.supportedLines.length < 1 ||
    data.supportedLines.length > 2 ||
    new Set(data.supportedLines).size !== data.supportedLines.length ||
    !data.supportedLines.includes(line) ||
    data.supportedLines.some((item) => item !== "v1" && item !== "v2") ||
    Object.keys(names).sort().join(",") !== "v1,v2" ||
    Object.keys(ready).sort().join(",") !== "v1,v2" ||
    names.v1 === names.v2 ||
    [names.v1, names.v2].some(
      (name) =>
        typeof name !== "string" || !/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u.test(name),
    ) ||
    typeof ready.v1 !== "boolean" ||
    typeof ready.v2 !== "boolean" ||
    typeof data.publishEnabled !== "boolean"
  )
    throw new Error("Invalid release configuration.");
  return data as unknown as ReleaseConfig;
}

export function readReleaseConfig(root = REPOSITORY_ROOT): ReleaseConfig {
  return parseReleaseConfig(JSON.parse(readFileSync(resolve(root, "release.config.json"), "utf8")));
}

export function parseReleaseTag(tag: string, config: ReleaseConfig) {
  const match = /^opencode-(v[12])\/v(.+)$/u.exec(tag);
  if (!match || !isReleaseVersion(match[2])) throw new Error("Invalid Agent Bus release tag.");
  const line = releaseLine(match[1]);
  const version = match[2];
  if (
    line !== config.releaseLine ||
    !config.supportedLines.includes(line) ||
    version !== config.version
  )
    throw new Error("Release tag does not match this source's release line and version.");
  return {
    line,
    version,
    packageName: config.packageNames[line],
    prerelease: version.includes("-"),
    npmTag: version.includes("-") ? "next" : "latest",
  } as const;
}
