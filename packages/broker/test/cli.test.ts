import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadCredentialFile } from "../src/credentials";
import { launchBrokerDaemon, parseBrokerEnvironment } from "../src/cli";
import { BROKER_DEFAULTS } from "../src/server";

describe("broker CLI configuration", () => {
  test("keeps the library root import side-effect free", async () => {
    const library = await import(`../src/index?side-effect-check=${Date.now()}`);
    expect(library.BrokerDaemon).toBeDefined();
  });

  test("parses safe explicit daemon environment", () => {
    const parsed = parseBrokerEnvironment(
      {
        HOME: "/tmp/agentbus-home",
        OPENCODE_AGENTBUS_DB_PATH: "/tmp/agentbus-home/state.sqlite",
        OPENCODE_AGENTBUS_CREDENTIAL_FILE: "/tmp/agentbus-home/credential.json",
        OPENCODE_AGENTBUS_HOST: "::1",
        OPENCODE_AGENTBUS_PORT: "4100",
      },
      "/fallback-home",
    );
    expect(parsed).toEqual({
      databasePath: "/tmp/agentbus-home/state.sqlite",
      credentialFilePath: "/tmp/agentbus-home/credential.json",
      hostname: "::1",
      port: 4100,
    });
  });

  test("uses non-secret defaults and rejects remote hosts or invalid ports", () => {
    const home = "/tmp/agentbus-default-home";
    expect(parseBrokerEnvironment({}, home)).toEqual({
      databasePath: join(home, ".local", "state", "opencode-agentbus", "broker.sqlite"),
      credentialFilePath: join(home, ".config", "opencode-agentbus", "credential.json"),
      hostname: BROKER_DEFAULTS.hostname,
      port: BROKER_DEFAULTS.port,
    });
    expect(() => parseBrokerEnvironment({ OPENCODE_AGENTBUS_HOST: "0.0.0.0" }, home)).toThrow();
    expect(() => parseBrokerEnvironment({ OPENCODE_AGENTBUS_PORT: "0" }, home)).toThrow();
    expect(() => parseBrokerEnvironment({ OPENCODE_AGENTBUS_PORT: "65536" }, home)).toThrow();
  });

  test("exposes a launch API suitable for a packaged startup smoke test", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentbus-cli-test-"));
    const credentialFilePath = join(directory, "credential.json");
    const daemon = await launchBrokerDaemon(
      {
        databasePath: join(directory, "broker.sqlite"),
        credentialFilePath,
        hostname: "127.0.0.1",
        port: 0,
      },
      { info() {}, warn() {}, error() {} },
    );
    try {
      expect(daemon.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/);
      expect(loadCredentialFile(credentialFilePath).token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    } finally {
      await daemon.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
