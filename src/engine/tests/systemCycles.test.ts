import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine, defineSystem } from "../index";
import { _undefineBuiltinSystem, _undefineSystem, defineBuiltinSystem, listSystemCatalog, type BuiltinSystem } from "../core/systems";

const defined: string[] = [];
const builtins: BuiltinSystem[] = [];

afterEach(() => {
  for (const name of defined.splice(0)) _undefineSystem(name);
  for (const b of builtins.splice(0)) _undefineBuiltinSystem(b);
  vi.restoreAllMocks();
});

function system(name: string, order: { after?: string[]; before?: string[] }, ran?: string[]) {
  defined.push(name);
  defineSystem({ name, phase: "update", ...order, run: () => void ran?.push(name) });
}

describe("system ordering cycles (ADR 0397)", () => {
  it("a script loop is logged once, broken at its most recent constraint, and the World keeps stepping", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const ran: string[] = [];
    system("test.cycle.A", { after: ["test.cycle.B"] }, ran);
    expect(errors).not.toHaveBeenCalled();
    system("test.cycle.B", { after: ["test.cycle.A"] }, ran);
    const loopLogs = () => errors.mock.calls.filter((c) => String(c[0]).includes("System ordering cycle"));
    expect(loopLogs()).toHaveLength(1);
    const message = String(loopLogs()[0][0]);
    expect(message).toMatch(/test\.cycle\.A → test\.cycle\.B → test\.cycle\.A|test\.cycle\.B → test\.cycle\.A → test\.cycle\.B/);
    // B's `after: [A]` is the most recent constraint, so it's the one ignored: A still runs after B.
    expect(message).toContain('Ignoring "test.cycle.A" before "test.cycle.B"');

    const engine = await Engine.create({ headless: true });
    expect(() => engine.step(1 / 60)).not.toThrow();
    expect(() => engine.step(1 / 60)).not.toThrow();
    expect(ran).toEqual(["test.cycle.B", "test.cycle.A", "test.cycle.B", "test.cycle.A"]);
    const order = engine.world.scheduler.order("update");
    expect(order.indexOf("test.cycle.B")).toBeLessThan(order.indexOf("test.cycle.A"));

    // Another catalog change doesn't log the standing loop again.
    system("test.cycle.Other", {});
    engine.step(1 / 60);
    expect(loopLogs()).toHaveLength(1);
  });

  it("a script loop through an engine built-in breaks the script's constraint, never the built-in's", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    system("test.cycle.Around", { after: ["engine.UpdateScripts"], before: ["engine.UpdateScripts"] });
    expect(errors.mock.calls.some((c) => String(c[0]).includes("engine.UpdateScripts → test.cycle.Around") || String(c[0]).includes("test.cycle.Around → engine.UpdateScripts"))).toBe(true);
    const engine = await Engine.create({ headless: true });
    expect(() => engine.step(1 / 60)).not.toThrow();
  });

  it("fixing the loop (redefining or removing a system) restores the full order", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    system("test.cycle.P", { before: ["test.cycle.Q"] });
    system("test.cycle.Q", { before: ["test.cycle.P"] });
    _undefineSystem("test.cycle.Q");
    defined.splice(defined.indexOf("test.cycle.Q"), 1);
    system("test.cycle.Q", { after: ["test.cycle.P"] });
    const engine = await Engine.create({ headless: true });
    const order = engine.world.scheduler.order("update");
    expect(order.indexOf("test.cycle.P")).toBeLessThan(order.indexOf("test.cycle.Q"));
  });

  it("an engine built-in that closes a loop is refused when it's defined, naming the loop", () => {
    const x: BuiltinSystem = { name: "test.cycle.EngineX", phase: "lateUpdate", before: ["test.cycle.EngineY"], run() {} };
    const y: BuiltinSystem = { name: "test.cycle.EngineY", phase: "lateUpdate", before: ["test.cycle.EngineX"], run() {} };
    defineBuiltinSystem(x);
    builtins.push(x);
    expect(() => defineBuiltinSystem(y)).toThrow(/test\.cycle\.Engine(X|Y) → test\.cycle\.Engine(X|Y) → test\.cycle\.Engine(X|Y)/);
    // Nothing was added: Y without the loop then goes in once.
    const fixed: BuiltinSystem = { ...y, before: [] };
    defineBuiltinSystem(fixed);
    builtins.push(fixed);
    expect(listSystemCatalog().filter((s) => s.name === "test.cycle.EngineY")).toHaveLength(1);
  });
});
