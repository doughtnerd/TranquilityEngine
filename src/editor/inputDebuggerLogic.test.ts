// The Input debugger panel's wording (ADR 0336, 0337).
import { describe, expect, it } from "vitest";
import type { InputLogEntry } from "../engine/editor";
import { formatValue, logText, pickWorld, seconds, sourceLabel, splitPhases, valueMagnitude } from "./inputDebuggerLogic";

describe("the Input debugger's text", () => {
  it("follows the picked World while it plays, else the first that takes input", () => {
    const worlds = [
      { name: "Server", takesInput: false },
      { name: "Client 1", takesInput: true },
    ];
    expect(pickWorld(worlds, null)).toBe("Client 1");
    expect(pickWorld(worlds, "Server")).toBe("Server");
    expect(pickWorld(worlds, "Gone")).toBe("Client 1");
    expect(pickWorld([{ name: "Server", takesInput: false }], null)).toBe("Server");
    expect(pickWorld([], null)).toBeNull();
  });

  it("formats values, their size and seconds", () => {
    expect(formatValue([0.754])).toBe("0.75");
    expect(formatValue([1, -0.001])).toBe("(1.00, 0)");
    expect(valueMagnitude([3, 4])).toBe(1);
    expect(valueMagnitude([0.5])).toBe(0.5);
    expect(seconds(0.4)).toBe("0.40 s");
    expect(seconds(Infinity)).toBe("—");
  });

  it("splits phase flags into levels and edges", () => {
    expect(splitPhases(["held", "pressed", "started", "triggered", "performed"])).toEqual({ levels: ["held", "triggered"], edges: ["pressed", "started", "performed"] });
  });

  it("names the mapping that produced a value", () => {
    expect(sourceLabel(null)).toBe("—");
    expect(sourceLabel({ context: "default", mapping: 0, composite: "single", controls: ["<Gamepad>/buttonSouth"] })).toBe("default #1 · <Gamepad>/buttonSouth");
    expect(sourceLabel({ context: "onFoot", mapping: 1, composite: "dpad", controls: ["<Keyboard>/w", "<Keyboard>/s", "<Keyboard>/a", "<Keyboard>/d"] })).toBe("onFoot #2 · w/s/a/d (dpad)");
    expect(sourceLabel({ context: "c", mapping: 2, composite: "modifier", controls: ["<Keyboard>/shift", "<Keyboard>/b"] })).toBe("c #3 · shift+b (chord)");
  });

  it("writes one line per logged event", () => {
    const at = { frame: 1, time: 0 };
    const lines = ([
      { ...at, kind: "action", player: 0, set: "s", action: "jump", phase: "performed", value: 1 },
      { ...at, kind: "device", device: "Keyboard", control: "<Keyboard>/space", value: 1 },
      { ...at, kind: "joined", player: 1 },
      { ...at, kind: "rebind", player: 0, action: "jump", control: "<Keyboard>/k", canceled: false, conflicts: ["default: fire"] },
      { ...at, kind: "rebind", player: 0, action: "jump", control: null, canceled: true, conflicts: [] },
    ] as InputLogEntry[]).map(logText);
    expect(lines).toEqual([
      "P0 jump performed (1.00)",
      "Keyboard <Keyboard>/space 1.00",
      "Player 1 joined",
      "P0 rebind jump → <Keyboard>/k (conflicts: default: fire)",
      "P0 rebind jump canceled",
    ]);
  });
});
