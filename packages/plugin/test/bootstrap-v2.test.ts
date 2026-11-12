import { expect, test } from "bun:test";
import { BrokerBootstrap } from "../src/broker-bootstrap";
import { CONFIG, credentialSnapshot } from "./helpers";
import { TrustedConnectionConfigSchema } from "@opencode-agentbus/protocol";

for (const phase of ["credential", "probe"] as const) {
  test(`generation cancellation during ${phase} prevents late broker probe/launch and preserves reason`, async () => {
    const controller = new AbortController();
    const reason = { _tag: "Generation.Interrupted" };
    let probes = 0;
    let launches = 0;
    let entered = false;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bootstrap = new BrokerBootstrap(
      { ...CONFIG, autoStartBroker: true, brokerStartupTimeoutMs: 5000 },
      {
        signal: controller.signal,
        readCredential: async () => {
          if (phase === "credential") {
            entered = true;
            await barrier;
          }
          return undefined;
        },
        probeEndpoint: async () => {
          probes++;
          if (phase === "probe") {
            entered = true;
            await barrier;
          }
          return "unused";
        },
        launchBroker: () => {
          launches++;
          return { pid: undefined, exited: Promise.resolve(1) };
        },
      },
    );
    const work = bootstrap.ensureReady().catch((error) => error);
    for (let attempt = 0; !entered && attempt < 100; attempt++) await Bun.sleep(1);
    expect(entered).toBe(true);
    controller.abort(reason);
    release();
    expect(await work).toBe(reason);
    expect(probes).toBe(phase === "probe" ? 1 : 0);
    expect(launches).toBe(0);
  });
}

test("generation cancellation aborts real readiness HTTP authentication before probe or launch", async () => {
  const controller = new AbortController();
  const reason = { _tag: "Generation.Interrupted" };
  let requested = false;
  let requestAborted = false;
  let launches = 0;
  let probes = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requested = true;
      expect(request.headers.get("authorization")).toBeNull();
      return new Promise<Response>((resolve) =>
        request.signal.addEventListener(
          "abort",
          () => {
            requestAborted = true;
            resolve(new Response(null, { status: 499 }));
          },
          { once: true },
        ),
      );
    },
  });
  const config = TrustedConnectionConfigSchema.parse({
    ...CONFIG,
    endpoint: server.url.origin,
    timeoutMs: 5000,
    brokerStartupTimeoutMs: 5000,
    autoStartBroker: true,
  });
  const bootstrap = new BrokerBootstrap(config, {
    signal: controller.signal,
    readCredential: async () => credentialSnapshot(),
    probeEndpoint: async () => {
      probes++;
      return "unused";
    },
    launchBroker: () => {
      launches++;
      return undefined;
    },
  });
  const work = bootstrap.ensureReady().catch((error) => error);
  try {
    for (let attempt = 0; !requested && attempt < 100; attempt++) await Bun.sleep(1);
    expect(requested).toBe(true);
    controller.abort(reason);
    const result = await Promise.race([work, Bun.sleep(500).then(() => "not-cancelled")]);
    expect(result).toBe(reason);
    for (let attempt = 0; !requestAborted && attempt < 100; attempt++) await Bun.sleep(1);
    expect(requestAborted).toBe(true);
    expect(probes).toBe(0);
    expect(launches).toBe(0);
  } finally {
    controller.abort(reason);
    await server.stop(true);
    await work;
  }
});
