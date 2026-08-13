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
  // Port 1 is privileged and never serves a debug endpoint.
  it("explains how to start the app when nothing is listening", async () => {
    await expect(desktopTargets({ port: 1 })).rejects.toThrow(DesktopError);
    await expect(desktopTargets({ port: 1 })).rejects.toThrow(
      /--remote-debugging-port/,
    );
  });

  it("names the port it tried", async () => {
    await expect(desktopTargets({ port: 1 })).rejects.toThrow(/localhost:1/);
  });
});
