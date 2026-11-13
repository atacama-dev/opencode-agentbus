import { expect, test } from "bun:test";
import { isReleaseVersion, parseReleaseConfig, parseReleaseTag, readReleaseConfig } from "./config";

test("release versions reject ambiguous tags and shell/control characters", () => {
  for (const version of ["0.1.0", "1.2.3-beta.1", "2.0.0-rc.0", "1.0.0-beta-test"])
    expect(isReleaseVersion(version)).toBe(true);
  for (const version of [
    "01.0.0",
    "1.0",
    "1.0.0-",
    "1.0.0-01",
    "1.0.0-a..b",
    "1.0.0+local",
    "1.0.0\n",
    "1.0.0;id",
    "999999999999999999999.0.0",
  ])
    expect(isReleaseVersion(version)).toBe(false);
});

test("source release line, exact version and prerelease channel are explicit", () => {
  const config = readReleaseConfig();
  const v1 = parseReleaseConfig({ ...config, releaseLine: "v1", supportedLines: ["v1"] });
  expect(parseReleaseTag(`opencode-v1/v${v1.version}`, v1)).toMatchObject({
    line: "v1",
    npmTag: "latest",
    packageName: v1.packageNames.v1,
  });
  expect(() => parseReleaseTag(`opencode-v2/v${v1.version}`, v1)).toThrow();
  expect(() => parseReleaseTag("opencode-v1/v99.0.0", v1)).toThrow();
  const beta = parseReleaseConfig({ ...config, version: "0.1.0-beta.1" });
  expect(parseReleaseTag(`opencode-${beta.releaseLine}/v${beta.version}`, beta)).toMatchObject({
    prerelease: true,
    npmTag: "next",
  });
});

test("publication is not enabled by absent, extra or malformed configuration", () => {
  const config = parseReleaseConfig({
    ...readReleaseConfig(),
    readiness: { v1: false, v2: false },
    publishEnabled: false,
  });
  expect(config.publishEnabled).toBe(false);
  expect(Object.values(config.readiness)).toEqual([false, false]);
  for (const malformed of [
    { ...config, publishEnabled: "true" },
    { ...config, token: "not-a-config-field" },
    { ...config, packageNames: { ...config.packageNames, v2: config.packageNames.v1 } },
    { ...config, supportedLines: ["v1", "v1"] },
    { ...config, readiness: { v1: true } },
  ])
    expect(() => parseReleaseConfig(malformed)).toThrow();
});
