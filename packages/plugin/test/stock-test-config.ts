import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { LoopbackBrokerEndpointSchema } from "@opencode-agentbus/protocol";

type Environment = Readonly<Record<string, string | undefined>>;

function required(environment: Environment, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`Set ${name} for a dedicated, disposable stock-host test.`);
  return value;
}

function absolutePath(environment: Environment, name: string): string {
  const value = required(environment, name);
  if (!isAbsolute(value) || /[\p{Cc}\p{Cf}]/u.test(value))
    throw new Error(`${name} must be an absolute test path without control characters.`);
  return value;
}

export function stockTestConfig(environment: Environment = process.env, wake = false) {
  if (environment.AGENTBUS_STOCK_TEST_MODE !== "isolated")
    throw new Error(
      "Set AGENTBUS_STOCK_TEST_MODE=isolated; never target a shared OpenCode server.",
    );
  const serverUrl = LoopbackBrokerEndpointSchema.parse(
    required(environment, "AGENTBUS_STOCK_SERVER_URL"),
  );
  const serverLog = absolutePath(environment, "AGENTBUS_STOCK_SERVER_LOG");
  const directory = absolutePath(environment, "AGENTBUS_STOCK_PROJECT");
  const otherDirectory = wake
    ? absolutePath(environment, "AGENTBUS_STOCK_OTHER_PROJECT")
    : undefined;
  if (wake && otherDirectory === directory)
    throw new Error("The wake test needs two distinct disposable project directories.");
  const providerUrl = wake
    ? LoopbackBrokerEndpointSchema.parse(required(environment, "AGENTBUS_STOCK_PROVIDER_URL"))
    : undefined;
  return { serverUrl, serverLog, directory, otherDirectory, providerUrl };
}

export function stockTestAuthorization(serverLog: string): string {
  const password = /^server password (.+)$/mu.exec(readFileSync(serverLog, "utf8"))?.[1];
  if (!password) throw new Error("The isolated test server log has no startup password line.");
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}
