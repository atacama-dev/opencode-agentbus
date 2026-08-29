import { writeFile } from "node:fs/promises";

import { TrustedConnectionConfigSchema } from "../../../packages/protocol/src";

import {
  BrokerBootstrap,
  launchBundledBroker,
} from "../../../packages/plugin/src/broker-bootstrap";

const [endpoint, credentialFilePath, databasePath, pidFilePath] = process.argv.slice(2);
if (!endpoint || !credentialFilePath || !databasePath || !pidFilePath) process.exit(2);

const config = TrustedConnectionConfigSchema.parse({
  endpoint,
  credentialFilePath,
  timeoutMs: 250,
  autoStartBroker: true,
  brokerStartupTimeoutMs: 5_000,
});
const bootstrap = new BrokerBootstrap(config, {
  environment: { ...process.env, OPENCODE_AGENTBUS_DB_PATH: databasePath },
  launchBroker: (input) => {
    const child = launchBundledBroker(input);
    if (child.pid === undefined) throw new Error("Detached broker PID is unavailable.");
    void writeFile(pidFilePath, String(child.pid), { mode: 0o600 });
    return child;
  },
});

await bootstrap.ensureReady();
