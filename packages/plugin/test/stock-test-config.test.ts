import { expect, test } from "bun:test";
import { stockTestConfig } from "./stock-test-config";

const environment = {
  AGENTBUS_STOCK_TEST_MODE: "isolated",
  AGENTBUS_STOCK_SERVER_URL: "http://127.0.0.1:44001",
  AGENTBUS_STOCK_SERVER_LOG: "/isolated/state/server.log",
  AGENTBUS_STOCK_PROJECT: "/isolated/project-a",
  AGENTBUS_STOCK_OTHER_PROJECT: "/isolated/project-b",
  AGENTBUS_STOCK_PROVIDER_URL: "http://127.0.0.1:44002",
};

test("manual native probes require explicit isolated configuration before reading credentials", () => {
  expect(() => stockTestConfig({})).toThrow("AGENTBUS_STOCK_TEST_MODE=isolated");
  for (const name of Object.keys(environment))
    expect(() => stockTestConfig({ ...environment, [name]: undefined }, true)).toThrow();
  expect(stockTestConfig(environment, true)).toMatchObject({
    directory: "/isolated/project-a",
    otherDirectory: "/isolated/project-b",
  });
});

test("manual native probes reject non-loopback endpoints, relative paths and identical projects", () => {
  for (const url of [
    "https://127.0.0.1:44001",
    "http://example.com:44001",
    "http://localhost:44001",
  ])
    expect(() => stockTestConfig({ ...environment, AGENTBUS_STOCK_SERVER_URL: url })).toThrow();
  expect(() =>
    stockTestConfig({ ...environment, AGENTBUS_STOCK_SERVER_LOG: "state/server.log" }),
  ).toThrow();
  expect(() =>
    stockTestConfig(
      { ...environment, AGENTBUS_STOCK_OTHER_PROJECT: environment.AGENTBUS_STOCK_PROJECT },
      true,
    ),
  ).toThrow();
});
