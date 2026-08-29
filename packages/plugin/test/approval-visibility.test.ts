import { describe, expect, test } from "bun:test";

import type { PluginInput } from "@opencode-ai/plugin";

import { showAgentBusReceiveApproval } from "../src/approval-visibility";

async function settleVisibility(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function visibilityInput(tui: object): Pick<PluginInput, "client" | "directory"> {
  return {
    client: { tui } as unknown as PluginInput["client"],
    directory: "/home/julien",
  };
}

describe("receive approval visibility", () => {
  test("preserves real SDK class-method receivers and selects before showing the toast", async () => {
    const trace: string[] = [];
    const requests: unknown[] = [];
    class ClassMethodTui {
      publish(request: unknown): Promise<unknown> {
        expect(this === tui).toBe(true);
        trace.push("select");
        requests.push(structuredClone(request));
        return Promise.resolve({ data: true });
      }

      showToast(request: unknown): Promise<unknown> {
        expect(this === tui).toBe(true);
        trace.push("toast");
        requests.push(structuredClone(request));
        return Promise.resolve({ data: true });
      }
    }
    const tui = new ClassMethodTui();

    expect(() =>
      showAgentBusReceiveApproval(visibilityInput(tui), "host_child", "/workspace/A"),
    ).not.toThrow();
    await settleVisibility();

    expect(trace).toEqual(["select", "toast"]);
    expect(requests).toEqual([
      {
        body: {
          type: "tui.session.select",
          properties: { sessionID: "host_child" },
        },
        query: { directory: "/workspace/A" },
      },
      {
        body: {
          title: "Agent Bus approval",
          message: "Agent Bus receive approval is waiting in this session.",
          variant: "warning",
          duration: 300_000,
        },
        query: { directory: "/workspace/A" },
      },
    ]);
  });

  test("guards absent publish and still shows the fixed toast", async () => {
    const toasts: unknown[] = [];
    const tui = {
      showToast(request: unknown) {
        toasts.push(structuredClone(request));
        return Promise.resolve({ data: true });
      },
    };

    expect(() =>
      showAgentBusReceiveApproval(visibilityInput(tui), "host_no_publish"),
    ).not.toThrow();
    await settleVisibility();

    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      body: { title: "Agent Bus approval" },
      query: { directory: "/home/julien" },
    });
  });

  for (const selectionFailure of ["sync", "async"] as const) {
    test(`contains ${selectionFailure} selection failure and shows the toast afterward`, async () => {
      const trace: string[] = [];
      const tui = {
        publish() {
          trace.push("select");
          if (selectionFailure === "sync") throw new Error("private synchronous route failure");
          return Promise.reject(new Error("private asynchronous route failure"));
        },
        showToast() {
          trace.push("toast");
          return Promise.resolve({ data: true });
        },
      };

      expect(() =>
        showAgentBusReceiveApproval(visibilityInput(tui), `host_${selectionFailure}`),
      ).not.toThrow();
      await settleVisibility();

      expect(trace).toEqual(["select", "toast"]);
    });
  }

  for (const toastFailure of ["sync", "async"] as const) {
    test(`contains ${toastFailure} toast failure after selection`, async () => {
      const trace: string[] = [];
      const tui = {
        publish() {
          trace.push("select");
          return Promise.resolve({ data: true });
        },
        showToast() {
          trace.push("toast");
          if (toastFailure === "sync") throw new Error("private synchronous toast failure");
          return Promise.reject(new Error("private asynchronous toast failure"));
        },
      };

      expect(() =>
        showAgentBusReceiveApproval(visibilityInput(tui), `host_toast_${toastFailure}`),
      ).not.toThrow();
      await settleVisibility();

      expect(trace).toEqual(["select", "toast"]);
    });
  }
});
