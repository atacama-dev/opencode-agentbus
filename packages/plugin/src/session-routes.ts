export interface TrustedForegroundRoute {
  readonly directory: string;
  readonly worktree: string;
}

interface TrustedSessionRoute {
  readonly directory: string;
  readonly worktree?: string;
}

export class TrustedSessionRouteMap {
  private readonly routes = new Map<string, TrustedSessionRoute>();
  private readonly maxEntries: number;

  constructor(maxEntries: number) {
    this.maxEntries = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : 1;
  }

  get size(): number {
    return this.routes.size;
  }

  setForeground(hostSessionId: string, route: TrustedForegroundRoute): void {
    this.set(hostSessionId, route);
  }

  setLifecycle(hostSessionId: string, directory: string): void {
    const worktree = this.routes.get(hostSessionId)?.worktree;
    this.set(hostSessionId, worktree === undefined ? { directory } : { directory, worktree });
  }

  directory(hostSessionId: string): string | undefined {
    return this.routes.get(hostSessionId)?.directory;
  }

  worktree(hostSessionId: string): string | undefined {
    return this.routes.get(hostSessionId)?.worktree;
  }

  delete(hostSessionId: string): void {
    this.routes.delete(hostSessionId);
  }

  clear(): void {
    this.routes.clear();
  }

  private set(hostSessionId: string, route: TrustedSessionRoute): void {
    this.routes.delete(hostSessionId);
    while (this.routes.size >= this.maxEntries) {
      const oldest = this.routes.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.routes.delete(oldest);
    }
    this.routes.set(hostSessionId, route);
  }
}
