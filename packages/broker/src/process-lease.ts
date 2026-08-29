import { createServer } from "node:net";

export interface BrokerProcessLease {
  release(): Promise<void>;
}

export interface BrokerProcessLeaseAddress {
  readonly hostname: "127.0.0.1" | "::1";
  readonly port: number;
}

export class BrokerLeaseContentionError extends Error {
  readonly code = "BROKER_LEASE_CONTENTION" as const;

  constructor() {
    super("The broker endpoint process lease is already held.");
    this.name = "BrokerLeaseContentionError";
  }
}

export function brokerProcessLeaseName(address: BrokerProcessLeaseAddress): string {
  const getuid = process.geteuid ?? process.getuid;
  if (!getuid) throw new Error("Broker process ownership is unavailable.");
  const hostKey = address.hostname === "::1" ? "ipv6" : "ipv4";
  return `\0opencode-agentbus-${getuid()}-${hostKey}-${address.port}`;
}

export async function acquireBrokerProcessLease(
  address: BrokerProcessLeaseAddress,
): Promise<BrokerProcessLease> {
  // Linux abstract sockets are exclusive and disappear on process death, including SIGKILL.
  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ path: brokerProcessLeaseName(address), exclusive: true }, resolve);
    });
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new BrokerLeaseContentionError();
    }
    throw error;
  }
  server.unref();

  let releaseWork: Promise<void> | undefined;
  return {
    release() {
      releaseWork ??= new Promise<void>((resolve) => server.close(() => resolve()));
      return releaseWork;
    },
  };
}
