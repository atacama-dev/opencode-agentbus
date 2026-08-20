import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, isAbsolute } from "node:path";

const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const MAX_SECURE_FILE_BYTES = 16 * 1024;

function currentUserId(): number | undefined {
  if (typeof process.geteuid === "function") return process.geteuid();
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertOwned(stat: ReturnType<typeof fstatSync>, kind: string): void {
  const uid = currentUserId();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${kind} must be owned by the current user.`);
  }
}

function assertSecureDatabaseDescriptor(descriptor: number, kind: string): void {
  const stat = fstatSync(descriptor);
  if (!stat.isFile()) throw new Error(`${kind} must be a regular file.`);
  assertOwned(stat, kind);
  if (stat.nlink !== 1) throw new Error(`${kind} must have one link.`);
  if ((stat.mode & 0o7777) !== OWNER_ONLY_FILE_MODE) {
    throw new Error(`${kind} must have mode 0600.`);
  }
}

function validateExistingDatabasePath(path: string, kind: string, required: boolean): void {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (!required && code === "ENOENT") return;
    if (code === "ELOOP") throw new Error(`${kind} must be a regular file.`);
    throw error;
  }
  try {
    assertSecureDatabaseDescriptor(descriptor, kind);
  } finally {
    closeSync(descriptor);
  }
}

function pathComponents(path: string): string[] {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new Error("Secure file paths must be absolute.");
  }
  const components = path.split("/").filter((component) => component.length > 0);
  if (components.some((component) => component === "." || component === "..")) {
    throw new Error("Secure file paths must not contain relative components.");
  }
  if (components.length === 0) {
    throw new Error("Secure file path must name a file.");
  }
  return components;
}

function descriptorPath(descriptor: number, child?: string): string {
  const base = `/proc/self/fd/${descriptor}`;
  return child === undefined ? base : `${base}/${child}`;
}

export interface SecureParentHandle {
  readonly descriptor: number;
  readonly fileName: string;
  readonly filePath: string;
  close(): void;
}

export function openSecureParent(path: string, create: boolean): SecureParentHandle {
  const components = pathComponents(path);
  const fileName = components.pop();
  if (!fileName || fileName !== basename(path)) {
    throw new Error("Secure file path is invalid.");
  }

  let descriptor = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of components) {
      const childPath = descriptorPath(descriptor, component);
      let childDescriptor: number;
      try {
        childDescriptor = openSync(
          childPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (!create || !(error instanceof Error) || !Object.hasOwn(error, "code")) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw error;
        mkdirSync(childPath, { mode: OWNER_ONLY_DIRECTORY_MODE });
        childDescriptor = openSync(
          childPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      }
      closeSync(descriptor);
      descriptor = childDescriptor;
    }

    const parentStat = fstatSync(descriptor);
    if (!parentStat.isDirectory()) throw new Error("Secure parent must be a directory.");
    assertOwned(parentStat, "Secure parent directory");
    if ((parentStat.mode & 0o022) !== 0) {
      throw new Error("Secure parent directory must not be group/world writable.");
    }

    let closed = false;
    return {
      descriptor,
      fileName,
      filePath: descriptorPath(descriptor, fileName),
      close() {
        if (!closed) {
          closeSync(descriptor);
          closed = true;
        }
      },
    };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export function readSecureOwnerFile(path: string): string {
  const parent = openSecureParent(path, false);
  try {
    const descriptor = openSync(parent.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("Secure file must be a regular file.");
      }
      assertOwned(stat, "Secure file");
      if ((stat.mode & 0o777) !== OWNER_ONLY_FILE_MODE || stat.nlink !== 1) {
        throw new Error("Secure file must have mode 0600 and one link.");
      }
      if (stat.size > MAX_SECURE_FILE_BYTES) {
        throw new Error("Secure file is unexpectedly large.");
      }
      return readFileSync(descriptor, "utf8");
    } finally {
      closeSync(descriptor);
    }
  } finally {
    parent.close();
  }
}

function writeAll(descriptor: number, contents: string): void {
  const bytes = new TextEncoder().encode(contents);
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
  }
}

function createTemporaryFile(parent: SecureParentHandle, suffix: string, contents: string): string {
  const temporaryName = `.${parent.fileName}.${suffix}.tmp`;
  const temporaryPath = descriptorPath(parent.descriptor, temporaryName);
  const descriptor = openSync(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    OWNER_ONLY_FILE_MODE,
  );
  try {
    fchmodSync(descriptor, OWNER_ONLY_FILE_MODE);
    writeAll(descriptor, contents);
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Best-effort cleanup of an unpublished temporary file.
    }
    throw error;
  }
  closeSync(descriptor);
  return temporaryPath;
}

export function createSecureOwnerFile(path: string, contents: string, suffix: string): boolean {
  const parent = openSecureParent(path, true);
  let temporaryPath: string | undefined;
  try {
    temporaryPath = createTemporaryFile(parent, suffix, contents);
    try {
      linkSync(temporaryPath, parent.filePath);
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      return false;
    }
    unlinkSync(temporaryPath);
    temporaryPath = undefined;
    fsyncSync(parent.descriptor);
    return true;
  } finally {
    if (temporaryPath !== undefined) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Best-effort cleanup of an unpublished temporary file.
      }
    }
    parent.close();
  }
}

export function replaceSecureOwnerFile(path: string, contents: string, suffix: string): void {
  const parent = openSecureParent(path, false);
  let temporaryPath: string | undefined;
  try {
    temporaryPath = createTemporaryFile(parent, suffix, contents);
    renameSync(temporaryPath, parent.filePath);
    temporaryPath = undefined;
    fsyncSync(parent.descriptor);
  } finally {
    if (temporaryPath !== undefined) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Best-effort cleanup of an unpublished temporary file.
      }
    }
    parent.close();
  }
}

export function ensureSecureDatabaseFile(path: string): SecureParentHandle {
  const parent = openSecureParent(path, true);
  try {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        parent.filePath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        OWNER_ONLY_FILE_MODE,
      );
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      validateExistingDatabasePath(parent.filePath, "Broker database", true);
    }
    if (descriptor !== undefined) {
      try {
        assertSecureDatabaseDescriptor(descriptor, "Broker database");
      } finally {
        closeSync(descriptor);
      }
    }
    validateExistingDatabasePath(`${parent.filePath}-wal`, "Broker database WAL sidecar", false);
    validateExistingDatabasePath(`${parent.filePath}-shm`, "Broker database SHM sidecar", false);
    return parent;
  } catch (error) {
    parent.close();
    throw error;
  }
}

export function assertSecureDatabaseFiles(parent: SecureParentHandle): void {
  validateExistingDatabasePath(parent.filePath, "Broker database", true);
  validateExistingDatabasePath(`${parent.filePath}-wal`, "Broker database WAL sidecar", false);
  validateExistingDatabasePath(`${parent.filePath}-shm`, "Broker database SHM sidecar", false);
}
