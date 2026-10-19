import { describe, expect, it } from "vitest";
import { DesktopError, desktopRuntimeProblem, desktopTargets } from "../src/desktop.js";

describe("desktopRuntimeProblem", () => {
  it("passes on a runtime that has a global WebSocket", () => {
    // The suite runs on the same Node the server does, and package.json allows
    // Node 20, where WebSocket is absent. Assert against the actual runtime
    // rather than pinning one answer.
    const problem = desktopRuntimeProblem();
    if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
      expect(problem).toMatch(/Node 22/);
    } else {
      expect(problem).toBeNull();
    }
  });
});

describe("desktopTargets", () => {
  const supportsDesktop =
    typeof (globalThis as { WebSocket?: unknown }).WebSocket !== "undefined";

  // Port 1 is privileged and never serves a debug endpoint.
  it("explains the runtime requirement or how to start the app", async () => {
    await expect(desktopTargets({ port: 1 })).rejects.toThrow(DesktopError);
    await expect(desktopTargets({ port: 1 })).rejects.toThrow(
      supportsDesktop ? /--remote-debugging-port/ : /Node 22 or newer/,
    );
  });

  it("names the port on supported runtimes or explains the runtime requirement", async () => {
    await expect(desktopTargets({ port: 1 })).rejects.toThrow(
      supportsDesktop ? /localhost:1/ : /Node 22 or newer/,
    );
  });
});
