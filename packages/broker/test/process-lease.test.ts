import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BROKER_CLI_EXIT_CODES } from "@opencode-agentbus/protocol";

import {
  BrokerLeaseContentionError,
  acquireBrokerProcessLease,
  brokerProcessLeaseName,
} from "../src/process-lease";

describe("broker process lease", () => {
  test("allows only one CLI owner and releases the kernel lease", async () => {
    const address = { hostname: "127.0.0.1", port: 49_521 } as const;
    const first = await acquireBrokerProcessLease(address);
    try {
      await expect(acquireBrokerProcessLease(address)).rejects.toBeInstanceOf(
        BrokerLeaseContentionError,
      );
      expect(brokerProcessLeaseName(address)).toBe(
        `\0opencode-agentbus-${process.geteuid?.() ?? process.getuid?.()}-ipv4-49521`,
      );
    } finally {
      await first.release();
    }

    const next = await acquireBrokerProcessLease(address);
    await next.release();
  });

  test("CLI reports lease contention with the stable body-free exit code", async () => {
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const port = reservation.port;
    await reservation.stop(true);
    const lease = await acquireBrokerProcessLease({ hostname: "127.0.0.1", port });
    const directory = mkdtempSync(join(tmpdir(), "agentbus-process-lease-cli-"));
    try {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts")], {
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          OPENCODE_AGENTBUS_DB_PATH: join(directory, "broker.sqlite"),
          OPENCODE_AGENTBUS_CREDENTIAL_FILE: join(directory, "credential.json"),
          OPENCODE_AGENTBUS_HOST: "127.0.0.1",
          OPENCODE_AGENTBUS_PORT: String(port),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(BROKER_CLI_EXIT_CODES.LEASE_CONTENTION);
      expect(await new Response(child.stderr).text()).toBe("");
    } finally {
      await lease.release();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("allows only one holder across simultaneously released processes", async () => {
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const port = reservation.port;
    await reservation.stop(true);
    const directory = mkdtempSync(join(tmpdir(), "agentbus-process-lease-race-"));
    const gatePath = join(directory, "start");
    const children = Array.from({ length: 3 }, (_, index) =>
      Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "fixtures", "process-lease-holder.ts"),
          String(port),
          gatePath,
          join(directory, `ready-${index}`),
          join(directory, `acquired-${index}`),
        ],
        { stdout: "ignore", stderr: "ignore" },
      ),
    );
    const exited = new Set<number>();
    for (const [index, child] of children.entries()) {
      void child.exited.then(() => exited.add(index));
    }
    try {
      const readyDeadline = Date.now() + 3_000;
      while (
        Date.now() < readyDeadline &&
        !children.every((_child, index) => existsSync(join(directory, `ready-${index}`)))
      ) {
        await Bun.sleep(10);
      }
      expect(children.every((_child, index) => existsSync(join(directory, `ready-${index}`)))).toBe(
        true,
      );
      writeFileSync(gatePath, "start", { mode: 0o600 });

      const acquireDeadline = Date.now() + 3_000;
      while (Date.now() < acquireDeadline && exited.size < 2) await Bun.sleep(10);
      const acquired = children
        .map((_child, index) => join(directory, `acquired-${index}`))
        .filter(existsSync);
      expect(acquired).toHaveLength(1);
      expect(exited.size).toBe(2);
    } finally {
      for (const child of children) {
        if (child.pid !== undefined) {
          try {
            process.kill(child.pid, "SIGTERM");
          } catch {
            // Losing lease contenders may already have exited.
          }
        }
      }
      await Promise.all(children.map((child) => child.exited));
      rmSync(directory, { recursive: true, force: true });
    }
  }, 8_000);
});
