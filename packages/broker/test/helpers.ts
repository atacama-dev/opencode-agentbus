import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  METHODS,
  PROTOCOL_VERSION,
  RequestIdSchema,
  type ApplicationResponseEnvelope,
  type ErrorCode,
  type RequestId,
  type SessionIdentity,
} from "@opencode-agentbus/protocol";
import { BrokerService, type BrokerLimits, type Clock, type RandomSource } from "../src/service";

export class TestClock implements Clock {
  constructor(public value = Date.parse("2026-08-20T12:00:00.000Z")) {}

  now(): number {
    return this.value;
  }

  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

export class TestRandom implements RandomSource {
  private counter = 1;

  bytes(length: number): Uint8Array {
    const result = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      result[index] = (this.counter + index) % 256;
    }
    this.counter += 1;
    return result;
  }
}

export interface Harness {
  readonly directory: string;
  readonly databasePath: string;
  readonly credentialFilePath: string;
  readonly clock: TestClock;
  readonly random: TestRandom;
  readonly service: BrokerService;
  close(): void;
}

export function createHarness(
  options: {
    limits?: Partial<BrokerLimits>;
    statementObserver?: (sql: string) => void;
    logger?: {
      info(message: string): void;
      warn(message: string): void;
      error(message: string): void;
    };
  } = {},
): Harness {
  const directory = mkdtempSync(join(tmpdir(), "agentbus-broker-test-"));
  const databasePath = join(directory, "state", "broker.sqlite");
  const credentialFilePath = join(directory, "config", "credential.json");
  const clock = new TestClock();
  const random = new TestRandom();
  const service = BrokerService.open({
    databasePath,
    credentialFilePath,
    clock,
    random,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.statementObserver === undefined
      ? {}
      : { statementObserver: options.statementObserver }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  return {
    directory,
    databasePath,
    credentialFilePath,
    clock,
    random,
    service,
    close() {
      service.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

let requestSequence = 0;

export function requestId(prefix = "request"): RequestId {
  requestSequence += 1;
  return RequestIdSchema.parse(`${prefix}-${requestSequence}`);
}

export function registerRequest(hostSessionId: string, title = hostSessionId, labels = ["test"]) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId("register"),
    method: METHODS.REGISTER_SESSION,
    params: { hostSessionId, optIn: true, metadata: { title, labels } },
  } as const;
}

export function claimRequest(
  method:
    | typeof METHODS.HEARTBEAT_SESSION
    | typeof METHODS.DEREGISTER_SESSION
    | typeof METHODS.PEEK_NEXT_MESSAGE,
  session: SessionIdentity,
) {
  const claim = method === METHODS.PEEK_NEXT_MESSAGE ? { target: session } : { session };
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId("claim"),
    method,
    params: claim,
  };
}

export function enqueueRequest(
  source: SessionIdentity,
  target: SessionIdentity,
  body: string,
  ttlSeconds = 60,
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId("enqueue"),
    method: METHODS.ENQUEUE_MESSAGE,
    params: { source, target, body, ttlSeconds },
  } as const;
}

export function replyRequest(
  source: SessionIdentity,
  messageId: string,
  body: string,
  ttlSeconds = 60,
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId("reply"),
    method: METHODS.REPLY_MESSAGE,
    params: { source, messageId, body, ttlSeconds },
  } as const;
}

export function expectedMessageRequest(
  method: typeof METHODS.CONSUME_MESSAGE | typeof METHODS.REJECT_MESSAGE,
  messageId: string,
  target: SessionIdentity,
  expectedBodyHash: string,
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId("message"),
    method,
    params: { messageId, target, expectedBodyHash },
  } as const;
}

export function expectSuccess<T>(response: ApplicationResponseEnvelope): T {
  if (!response.ok) {
    throw new Error(`Expected success, received ${response.error.code}`);
  }
  return response.result as T;
}

export function expectError(response: ApplicationResponseEnvelope, code: ErrorCode): void {
  if (response.ok) {
    throw new Error("Expected an application error.");
  }
  if (response.error.code !== code) {
    throw new Error(`Expected ${code}, received ${response.error.code}`);
  }
}
