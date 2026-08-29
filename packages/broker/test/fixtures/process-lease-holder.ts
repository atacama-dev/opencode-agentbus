import { existsSync, writeFileSync } from "node:fs";

import { acquireBrokerProcessLease } from "../../src/process-lease";

const [portInput, gatePath, readyPath, acquiredPath] = process.argv.slice(2);
const port = Number(portInput);
if (!Number.isInteger(port) || !gatePath || !readyPath || !acquiredPath) process.exit(2);

writeFileSync(readyPath, "ready", { mode: 0o600 });
while (!existsSync(gatePath)) await Bun.sleep(1);

let lease: Awaited<ReturnType<typeof acquireBrokerProcessLease>>;
try {
  lease = await acquireBrokerProcessLease({ hostname: "127.0.0.1", port });
} catch {
  process.exit(1);
}
writeFileSync(acquiredPath, "acquired", { mode: 0o600 });

const shutdown = async () => {
  await lease.release();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
setInterval(() => undefined, 60_000);
