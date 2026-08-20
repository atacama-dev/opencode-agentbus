import { Buffer } from "node:buffer";
import {
  CredentialFilePathSchema,
  CredentialFileSchema,
  type CredentialFile,
} from "@opencode-agentbus/protocol";
import { createSecureOwnerFile, readSecureOwnerFile, replaceSecureOwnerFile } from "./secure-files";

export interface CredentialRandomSource {
  bytes(length: number): Uint8Array;
}

const systemCredentialRandom: CredentialRandomSource = {
  bytes(length) {
    return crypto.getRandomValues(new Uint8Array(length));
  },
};

function encodedRandom(random: CredentialRandomSource, length = 32): string {
  const bytes = random.bytes(length);
  if (bytes.byteLength !== length) throw new Error("Random source returned an invalid byte count.");
  return Buffer.from(bytes).toString("base64url");
}

function newCredential(random: CredentialRandomSource): CredentialFile {
  return CredentialFileSchema.parse({
    version: 1,
    principalId: encodedRandom(random),
    serverId: encodedRandom(random),
    token: encodedRandom(random),
  });
}

function serializeCredential(credential: CredentialFile): string {
  return `${JSON.stringify(CredentialFileSchema.parse(credential))}\n`;
}

function safeSuffix(random: CredentialRandomSource): string {
  return encodedRandom(random, 12);
}

export function loadCredentialFile(path: string): CredentialFile {
  const parsedPath = CredentialFilePathSchema.parse(path);
  const contents = readSecureOwnerFile(parsedPath);
  let candidate: unknown;
  try {
    candidate = JSON.parse(contents);
  } catch {
    throw new Error("Credential file is invalid.");
  }
  return CredentialFileSchema.parse(candidate);
}

export function loadOrCreateCredential(
  path: string,
  random: CredentialRandomSource = systemCredentialRandom,
): CredentialFile {
  const parsedPath = CredentialFilePathSchema.parse(path);
  try {
    return loadCredentialFile(parsedPath);
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const credential = newCredential(random);
  const created = createSecureOwnerFile(
    parsedPath,
    serializeCredential(credential),
    safeSuffix(random),
  );
  return created ? credential : loadCredentialFile(parsedPath);
}

export function rotateCredentialFile(
  path: string,
  random: CredentialRandomSource = systemCredentialRandom,
): CredentialFile {
  const parsedPath = CredentialFilePathSchema.parse(path);
  const current = loadCredentialFile(parsedPath);
  const replacement = CredentialFileSchema.parse({
    ...current,
    token: encodedRandom(random),
  });
  replaceSecureOwnerFile(parsedPath, serializeCredential(replacement), safeSuffix(random));
  return replacement;
}
