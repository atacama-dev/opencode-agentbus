import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { describe, expect, test } from "bun:test";
import { BrokerService } from "../src/service";
import { createHarness, type Harness } from "./helpers";

function restart(harness: Harness): BrokerService {
  return BrokerService.open({
    databasePath: harness.databasePath,
    credentialFilePath: harness.credentialFilePath,
    clock: harness.clock,
    random: harness.random,
  });
}

describe("database file security", () => {
  for (const mode of [0o640, 0o604]) {
    test(`rejects an existing database with mode ${mode.toString(8)}`, () => {
      const harness = createHarness();
      try {
        harness.service.close();
        chmodSync(harness.databasePath, mode);

        expect(() => restart(harness)).toThrow(/mode 0600/);
        expect(lstatSync(harness.databasePath).mode & 0o7777).toBe(mode);
      } finally {
        harness.close();
      }
    });
  }

  test("does not rescue an insecure database through another process descriptor", () => {
    const harness = createHarness();
    harness.service.close();
    const descriptor = openSync(harness.databasePath, constants.O_RDONLY);
    try {
      chmodSync(harness.databasePath, 0o644);

      expect(() => restart(harness)).toThrow(/mode 0600/);
      expect(fstatSync(descriptor).mode & 0o777).toBe(0o644);
    } finally {
      closeSync(descriptor);
      harness.close();
    }
  });

  test("rejects hard-linked and symlinked database paths", () => {
    const hardlinkHarness = createHarness();
    try {
      hardlinkHarness.service.close();
      linkSync(hardlinkHarness.databasePath, `${hardlinkHarness.databasePath}.link`);
      expect(() => restart(hardlinkHarness)).toThrow(/one link/);
    } finally {
      hardlinkHarness.close();
    }

    const symlinkHarness = createHarness();
    try {
      symlinkHarness.service.close();
      const target = `${symlinkHarness.databasePath}.target`;
      renameSync(symlinkHarness.databasePath, target);
      symlinkSync(target, symlinkHarness.databasePath);
      expect(() => restart(symlinkHarness)).toThrow(/regular file/);
      expect(lstatSync(target).mode & 0o777).toBe(0o600);
    } finally {
      symlinkHarness.close();
    }
  });

  test("rejects a non-regular database path", () => {
    const harness = createHarness();
    try {
      harness.service.close();
      unlinkSync(harness.databasePath);
      mkdirSync(harness.databasePath, { mode: 0o700 });
      expect(() => restart(harness)).toThrow(/regular file/);
    } finally {
      harness.close();
    }
  });

  for (const suffix of ["-wal", "-shm"]) {
    test(`rejects an insecure pre-existing ${suffix} sidecar without repairing it`, () => {
      const harness = createHarness();
      try {
        harness.service.close();
        const sidecarPath = `${harness.databasePath}${suffix}`;
        writeFileSync(sidecarPath, "", { mode: 0o600 });
        chmodSync(sidecarPath, 0o644);

        expect(() => restart(harness)).toThrow(/mode 0600/);
        expect(lstatSync(sidecarPath).mode & 0o777).toBe(0o644);
      } finally {
        harness.close();
      }
    });
  }

  test("rejects linked pre-existing sidecars", () => {
    const symlinkHarness = createHarness();
    try {
      symlinkHarness.service.close();
      const target = `${symlinkHarness.databasePath}.wal-target`;
      writeFileSync(target, "", { mode: 0o600 });
      symlinkSync(target, `${symlinkHarness.databasePath}-wal`);
      expect(() => restart(symlinkHarness)).toThrow(/regular file/);
    } finally {
      symlinkHarness.close();
    }

    const hardlinkHarness = createHarness();
    try {
      hardlinkHarness.service.close();
      const target = `${hardlinkHarness.databasePath}.shm-target`;
      writeFileSync(target, "", { mode: 0o600 });
      linkSync(target, `${hardlinkHarness.databasePath}-shm`);
      expect(() => restart(hardlinkHarness)).toThrow(/one link/);
    } finally {
      hardlinkHarness.close();
    }
  });

  const ownerTest = process.geteuid?.() === 0 ? test : test.skip;
  ownerTest("rejects an existing database owned by another user", () => {
    const harness = createHarness();
    try {
      harness.service.close();
      chownSync(harness.databasePath, 1, -1);
      expect(() => restart(harness)).toThrow(/current user/);
    } finally {
      harness.close();
    }
  });

  test("preserves fresh creation and secure existing restart", () => {
    const harness = createHarness();
    try {
      expect(lstatSync(harness.databasePath).mode & 0o777).toBe(0o600);
      harness.service.close();
      for (const suffix of ["-wal", "-shm"]) {
        writeFileSync(`${harness.databasePath}${suffix}`, "", { mode: 0o600 });
      }

      const restarted = restart(harness);
      try {
        expect(lstatSync(harness.databasePath).mode & 0o777).toBe(0o600);
        for (const suffix of ["-wal", "-shm"]) {
          const stat = lstatSync(`${harness.databasePath}${suffix}`);
          expect(stat.isFile()).toBe(true);
          expect(stat.mode & 0o777).toBe(0o600);
          expect(stat.nlink).toBe(1);
        }
      } finally {
        restarted.close();
      }
    } finally {
      harness.close();
    }
  });
});
