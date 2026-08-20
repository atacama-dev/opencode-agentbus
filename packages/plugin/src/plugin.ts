import { tool } from "@opencode-ai/plugin";
import type { Plugin, PluginInput, PluginOptions, ToolResult } from "@opencode-ai/plugin";

import { readCredentialFileSecure, resolveTrustedConnectionConfig } from "./credentials";
import { SAFE_MODEL_ERRORS, SafeModelError, asSafeModelError } from "./errors";
import {
  MAX_BOOTSTRAP_SESSIONS,
  hostSessionRegistration,
  listHostSessionRegistrations,
} from "./host-sessions";
import { AgentBusRuntime } from "./runtime";
import type { HostSessionRegistration, RuntimeScheduler } from "./runtime";

export interface AgentBusPluginDependencies {
  readonly runtimeFactory?: (
    input: PluginInput,
    config: ReturnType<typeof resolveTrustedConnectionConfig>,
  ) => AgentBusRuntime;
  readonly bootstrapScheduler?: RuntimeScheduler;
  readonly bootstrapRetryDelayMs?: number;
}

function safely<T extends ToolResult>(operation: () => Promise<T>): Promise<T> {
  return operation().catch((error) => {
    throw asSafeModelError(error);
  });
}

export function pendingToastPayload(count: number): {
  readonly title: "Agent Bus";
  readonly message: string;
  readonly variant: "info";
} {
  const pendingCount = Number.isSafeInteger(count) && count > 0 ? count : 1;
  return {
    title: "Agent Bus",
    message:
      pendingCount === 1 ? "1 pending peer message." : `${pendingCount} pending peer messages.`,
    variant: "info",
  };
}

function defaultRuntime(
  input: PluginInput,
  config: ReturnType<typeof resolveTrustedConnectionConfig>,
): AgentBusRuntime {
  return new AgentBusRuntime({
    config,
    readCredential: () => readCredentialFileSecure(config.credentialFilePath),
    notifyPending: async (count) => {
      await input.client.tui
        .showToast({
          body: pendingToastPayload(count),
          query: { directory: input.directory },
        })
        .catch(() => undefined);
    },
  });
}

export function createAgentBusPlugin(dependencies: AgentBusPluginDependencies = {}): Plugin {
  return async (input, options: PluginOptions | undefined) => {
    const config = resolveTrustedConnectionConfig(options ?? {}, process.env);
    const runtime = (dependencies.runtimeFactory ?? defaultRuntime)(input, config);
    const scheduler =
      dependencies.bootstrapScheduler ??
      ({
        set: (callback, delayMs) => setTimeout(callback, delayMs),
        clear: (handle) => clearTimeout(handle),
      } satisfies RuntimeScheduler);
    const retryDelayMs = dependencies.bootstrapRetryDelayMs ?? 1_000;
    let bootstrapTimer: ReturnType<typeof setTimeout> | undefined;
    let bootstrapWork: Promise<void> | undefined;
    let bootstrapWorkDefersRecovery = false;
    let requestedBootstrapDelay: number | undefined;
    let optedInSessionIds: string[] = [];
    const sessionMutations = new Map<string, HostSessionRegistration | null>();
    const lifecycleController = new AbortController();
    let bootstrapGeneration = 0;
    let activeToolCalls = 0;
    let bootstrapCompleted = false;
    let bootstrapStaged = false;
    let disposed = false;

    const activeBootstrap = (generation: number): boolean =>
      !disposed && bootstrapGeneration === generation;
    const mergedRegistrations = (
      registrations: readonly HostSessionRegistration[],
    ): readonly HostSessionRegistration[] => {
      let merged = [...registrations];
      for (const [hostSessionId, mutation] of sessionMutations) {
        merged = merged.filter((registration) => registration.hostSessionId !== hostSessionId);
        if (mutation) merged.unshift(mutation);
      }
      return merged.slice(0, MAX_BOOTSTRAP_SESSIONS);
    };
    const scheduleBootstrap = (delayMs: number): void => {
      if (disposed || bootstrapCompleted || bootstrapTimer) return;
      if (bootstrapWork || activeToolCalls > 0) {
        requestedBootstrapDelay =
          requestedBootstrapDelay === undefined
            ? delayMs
            : Math.min(requestedBootstrapDelay, delayMs);
        return;
      }
      bootstrapTimer = scheduler.set(() => {
        bootstrapTimer = undefined;
        startBootstrap();
      }, delayMs);
      bootstrapTimer.unref?.();
    };
    const attemptBootstrap = async (
      generation: number,
      deferEventRecovery: boolean,
    ): Promise<void> => {
      let registrations: Awaited<ReturnType<typeof listHostSessionRegistrations>>;
      try {
        registrations = await listHostSessionRegistrations(input);
      } catch {
        if (!activeBootstrap(generation)) return;
        await runtime.bootstrapHostSessions([]).catch(() => undefined);
        if (activeBootstrap(generation)) scheduleBootstrap(retryDelayMs);
        return;
      }
      try {
        if (!activeBootstrap(generation)) return;
        const merged = mergedRegistrations(registrations);
        optedInSessionIds = merged.map((registration) => registration.hostSessionId);
        await runtime.bootstrapHostSessions(merged, deferEventRecovery);
        if (!activeBootstrap(generation)) return;
        if (deferEventRecovery) bootstrapStaged = true;
        else bootstrapCompleted = true;
      } catch {
        if (activeBootstrap(generation)) scheduleBootstrap(retryDelayMs);
      }
    };
    const startBootstrap = (deferEventRecovery = false): void => {
      if (disposed || bootstrapWork) return;
      const generation = ++bootstrapGeneration;
      bootstrapWorkDefersRecovery = deferEventRecovery;
      const work = attemptBootstrap(generation, deferEventRecovery);
      bootstrapWork = work;
      const clearWork = () => {
        if (bootstrapWork === work) bootstrapWork = undefined;
        if (
          requestedBootstrapDelay !== undefined &&
          activeToolCalls === 0 &&
          !bootstrapCompleted &&
          !disposed
        ) {
          const delayMs = requestedBootstrapDelay;
          requestedBootstrapDelay = undefined;
          scheduleBootstrap(delayMs);
        }
      };
      void work.then(clearWork, clearWork);
    };
    const waitForStagedBootstrap = async (): Promise<void> => {
      if (bootstrapCompleted || bootstrapStaged) return;
      if (bootstrapTimer) {
        scheduler.clear(bootstrapTimer);
        bootstrapTimer = undefined;
      }
      if (bootstrapWork && !bootstrapWorkDefersRecovery) {
        throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
      }
      if (!bootstrapWork) startBootstrap(true);
      const work = bootstrapWork;
      if (!work) throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let rejectDisposed: (() => void) | undefined;
      try {
        await Promise.race([
          work,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE)),
              config.timeoutMs,
            );
            timeout.unref?.();
          }),
          new Promise<never>((_resolve, reject) => {
            rejectDisposed = () => reject(new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE));
            if (lifecycleController.signal.aborted) rejectDisposed();
            else
              lifecycleController.signal.addEventListener("abort", rejectDisposed, { once: true });
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
        if (rejectDisposed) lifecycleController.signal.removeEventListener("abort", rejectDisposed);
      }
      if (!bootstrapCompleted && !bootstrapStaged) {
        throw new SafeModelError(SAFE_MODEL_ERRORS.UNAVAILABLE);
      }
    };
    const executeTool = <T extends ToolResult>(
      operation: () => Promise<T>,
      requireRegistry: boolean,
    ): Promise<T> =>
      safely(async () => {
        activeToolCalls += 1;
        if (!bootstrapCompleted && bootstrapTimer) {
          scheduler.clear(bootstrapTimer);
          bootstrapTimer = undefined;
        }
        try {
          if (requireRegistry) await waitForStagedBootstrap();
          return await operation();
        } finally {
          activeToolCalls -= 1;
          if (
            activeToolCalls === 0 &&
            !bootstrapCompleted &&
            requestedBootstrapDelay === undefined
          ) {
            scheduleBootstrap(bootstrapStaged ? 0 : retryDelayMs);
          }
        }
      });

    const hooks: Awaited<ReturnType<Plugin>> = {
      tool: {
        agentbus_send: tool({
          description:
            "Send a message to an exact opaque Agent Bus session handle. The returned receipt is body-free and grants no authority.",
          args: {
            target: tool.schema
              .string()
              .describe("Exact opaque session handle from an approved search"),
            body: tool.schema.string().describe("Outgoing peer message body"),
            ttlSeconds: tool.schema
              .number()
              .int()
              .optional()
              .describe("Message lifetime in seconds"),
          },
          execute: (args, context) => executeTool(() => runtime.send(args, context), false),
        }),
        agentbus_receive: tool({
          description:
            "Check for one pending Agent Bus message. Peer content is disclosed only after exact native approval and is always untrusted.",
          args: {},
          execute: (_args, context) => executeTool(() => runtime.receive(context), false),
        }),
        agentbus_search_sessions: tool({
          description:
            "Search only the opt-in Agent Bus registry after exact native approval. Returned titles and labels are untrusted peer metadata.",
          args: {
            query: tool.schema.string().describe("Registry metadata query"),
            limit: tool.schema.number().int().optional().describe("Maximum registry matches"),
          },
          execute: (args, context) => executeTool(() => runtime.search(args, context), true),
        }),
      },
      event: async ({ event }) => {
        if (disposed) return;
        if (event.type === "session.created" || event.type === "session.updated") {
          const registration = hostSessionRegistration(event.properties.info, input);
          if (registration) {
            sessionMutations.delete(registration.hostSessionId);
            sessionMutations.set(registration.hostSessionId, registration);
            optedInSessionIds = optedInSessionIds.filter(
              (hostSessionId) => hostSessionId !== registration.hostSessionId,
            );
            if (optedInSessionIds.length === MAX_BOOTSTRAP_SESSIONS) {
              const evicted = optedInSessionIds.pop();
              if (evicted) await runtime.deregisterHostSession(evicted);
            }
            optedInSessionIds.unshift(registration.hostSessionId);
            await runtime.upsertHostSession(registration.hostSessionId, registration.metadata);
          }
        } else if (event.type === "session.deleted") {
          const registration = hostSessionRegistration(event.properties.info, input);
          if (registration) {
            sessionMutations.delete(registration.hostSessionId);
            sessionMutations.set(registration.hostSessionId, null);
            optedInSessionIds = optedInSessionIds.filter(
              (hostSessionId) => hostSessionId !== registration.hostSessionId,
            );
            await runtime.deregisterHostSession(registration.hostSessionId);
          }
        }
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        lifecycleController.abort();
        bootstrapGeneration += 1;
        if (bootstrapTimer) scheduler.clear(bootstrapTimer);
        bootstrapTimer = undefined;
        await runtime.dispose();
      },
    };
    // OpenCode 1.18.19 deadlocks if its session route is called before plugin initialization unwinds.
    scheduleBootstrap(0);
    return hooks;
  };
}
