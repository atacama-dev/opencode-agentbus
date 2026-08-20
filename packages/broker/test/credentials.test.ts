import { chmodSync, existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { CredentialFileSchema } from "@opencode-agentbus/protocol";
import {
  loadOrCreateCredential,
  rotateCredentialFile,
  type CredentialRandomSource,
} from "../src/credentials";
import { createHarness, TestRandom, type Harness } from "./helpers";

describe("credential provisioning", () => {
  let harness: Harness | undefined;

  afterEach(() => {
    harness?.close();
    harness = undefined;
  });

  test("creates a stable 256-bit credential in an owner-only regular file", () => {
    harness = createHarness();

    const first = loadOrCreateCredential(harness.credentialFilePath, new TestRandom());
    const second = loadOrCreateCredential(harness.credentialFilePath, new TestRandom());
    const stat = lstatSync(harness.credentialFilePath);

    expect(CredentialFileSchema.parse(first)).toEqual(first);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toEqual(first);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.nlink).toBe(1);
  });

  test("rejects symlink credentials and insecure existing modes", () => {
    harness = createHarness();
    harness.service.close();

    const parent = join(harness.directory, "unsafe");
    mkdirSync(parent, { mode: 0o700 });
    const target = join(parent, "target.json");
    const link = join(parent, "link.json");
    writeFileSync(target, "{}", { mode: 0o600 });
    symlinkSync(target, link);

    expect(() => loadOrCreateCredential(link, new TestRandom())).toThrow();

    const insecure = join(parent, "insecure.json");
    const valid = loadOrCreateCredential(insecure, new TestRandom());
    expect(valid.version).toBe(1);
    chmodSync(insecure, 0o644);
    expect(() => loadOrCreateCredential(insecure, new TestRandom())).toThrow();
  });

  test("rotates atomically while preserving principal and server identities", () => {
    harness = createHarness();
    const before = loadOrCreateCredential(harness.credentialFilePath, new TestRandom());
    const after = rotateCredentialFile(
      harness.credentialFilePath,
      new TestRandom() satisfies CredentialRandomSource,
    );

    expect(after.token).not.toBe(before.token);
    expect(after.principalId).toBe(before.principalId);
    expect(after.serverId).toBe(before.serverId);
    expect(lstatSync(harness.credentialFilePath).mode & 0o777).toBe(0o600);
    expect(loadOrCreateCredential(harness.credentialFilePath, new TestRandom())).toEqual(after);
  });

  test("keeps the database and any WAL sidecars owner-only", () => {
    harness = createHarness();
    for (const path of [
      harness.databasePath,
      `${harness.databasePath}-wal`,
      `${harness.databasePath}-shm`,
    ]) {
      if (existsSync(path)) expect(lstatSync(path).mode & 0o777).toBe(0o600);
    }
  });
});
