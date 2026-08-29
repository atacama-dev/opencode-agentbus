import {
  AUTH_CHALLENGE_CLIENT_NONCE_HEADER,
  AUTH_CHALLENGE_CONTENT_TYPE,
  AUTH_CHALLENGE_ENDPOINT,
  AuthChallengeResponseSchema,
  BrokerServerIdentitySchema,
  generateAuthChallengeNonce,
  verifyAuthChallengeResponse,
  verifyAuthChallengeResponseVersion,
} from "@opencode-agentbus/protocol";
import type {
  BrokerServerIdentity,
  CredentialFile,
  TrustedConnectionConfig,
} from "@opencode-agentbus/protocol";

import { SAFE_MODEL_ERRORS, BrokerProtocolMismatchError, SafeModelError } from "./errors";

export type PluginFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;
type ChallengeReader = Pick<
  ReadableStreamDefaultReader<Uint8Array>,
  "read" | "cancel" | "releaseLock"
>;

const MAX_AUTH_CHALLENGE_RESPONSE_BYTES = 4_096;

interface HeaderFetchInput {
  readonly controller: AbortController;
  readonly fetchImplementation: PluginFetch;
  readonly init: RequestInit;
  readonly timeoutMs: number;
  readonly url: string;
}

export async function fetchResponseHeaders(input: HeaderFetchInput): Promise<Response> {
  const timeout = setTimeout(() => input.controller.abort(), input.timeoutMs);
  timeout.unref?.();
  try {
    const response = await input.fetchImplementation(input.url, {
      ...input.init,
      signal: input.controller.signal,
    });
    if (input.controller.signal.aborted) {
      try {
        await response.body?.cancel();
      } catch {
        // Header-race cleanup is intentionally transport-detail-free.
      }
      throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
    }
    return response;
  } catch {
    throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
  } finally {
    clearTimeout(timeout);
  }
}

export interface AuthenticateBrokerListenerInput {
  readonly config: TrustedConnectionConfig;
  readonly controller: AbortController;
  readonly credential: CredentialFile;
  readonly fetchImplementation: PluginFetch;
}

function cancelWithoutDisclosure(cancel: () => Promise<void>): void {
  try {
    void cancel().catch(() => undefined);
  } catch {
    // Cleanup failures are transport details and must never escape.
  }
}

function readWithAbort(
  reader: ChallengeReader,
  signal: AbortSignal,
): ReturnType<ChallengeReader["read"]> {
  if (signal.aborted) return Promise.reject(new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE));
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        reject(new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE));
      },
    );
  });
}

async function readBoundedChallengeBody(response: Response, signal: AbortSignal): Promise<unknown> {
  let reader: ChallengeReader | undefined;
  let reachedEof = false;
  try {
    reader = response.body?.getReader();
    if (!reader) throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!/^(0|[1-9][0-9]*)$/u.test(declaredLength) ||
        BigInt(declaredLength) > BigInt(MAX_AUTH_CHALLENGE_RESPONSE_BYTES))
    ) {
      throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
    }

    const decoder = new TextDecoder("utf-8", { fatal: true });
    let byteLength = 0;
    let json = "";
    while (true) {
      const chunk = await readWithAbort(reader, signal);
      if (chunk.done) {
        reachedEof = true;
        break;
      }
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_AUTH_CHALLENGE_RESPONSE_BYTES) {
        throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
      }
      json += decoder.decode(chunk.value, { stream: true });
    }
    json += decoder.decode();
    if (byteLength === 0) throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
    return JSON.parse(json) as unknown;
  } catch {
    throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
  } finally {
    if (reader) {
      const activeReader = reader;
      if (!reachedEof) cancelWithoutDisclosure(() => activeReader.cancel());
      try {
        reader.releaseLock();
      } catch {
        // Cleanup failures are transport details and must never escape.
      }
    }
  }
}

export async function authenticateBrokerListener(
  input: AuthenticateBrokerListenerInput,
): Promise<BrokerServerIdentity> {
  const clientNonce = generateAuthChallengeNonce();
  let response: Response | undefined;
  let readerHandled = false;
  const timeout = setTimeout(() => input.controller.abort(), input.config.timeoutMs);
  timeout.unref?.();
  try {
    response = await input.fetchImplementation(
      `${input.config.endpoint}${AUTH_CHALLENGE_ENDPOINT}`,
      {
        method: "GET",
        headers: {
          Accept: AUTH_CHALLENGE_CONTENT_TYPE,
          [AUTH_CHALLENGE_CLIENT_NONCE_HEADER]: clientNonce,
        },
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: input.controller.signal,
      },
    );
    if (input.controller.signal.aborted) {
      throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
    }
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (!response.ok || contentType !== AUTH_CHALLENGE_CONTENT_TYPE) {
      throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
    }
    readerHandled = true;
    const candidate = await readBoundedChallengeBody(response, input.controller.signal);
    const challenge = AuthChallengeResponseSchema.safeParse(candidate);
    const verificationInput = {
      token: input.credential.token,
      expectedServerId: input.credential.serverId,
      expectedClientNonce: clientNonce,
      response: candidate,
    } as const;
    if (!challenge.success) {
      if (verifyAuthChallengeResponseVersion(verificationInput, 1)) {
        throw new BrokerProtocolMismatchError();
      }
      throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
    }
    if (
      !verifyAuthChallengeResponse({
        token: input.credential.token,
        expectedServerId: input.credential.serverId,
        expectedClientNonce: clientNonce,
        response: challenge.data,
      })
    ) {
      throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
    }
    const broker = BrokerServerIdentitySchema.parse({
      brokerId: challenge.data.brokerId,
      serverId: challenge.data.serverId,
    });
    if (input.controller.signal.aborted) {
      throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
    }
    return broker;
  } catch (error) {
    if (error instanceof BrokerProtocolMismatchError) throw error;
    throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
  } finally {
    clearTimeout(timeout);
    const body = response?.body;
    if (!readerHandled && body) {
      cancelWithoutDisclosure(() => body.cancel());
    }
  }
}
