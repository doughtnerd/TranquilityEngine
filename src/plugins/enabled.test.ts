import { describe, expect, it } from "vitest";
import { pluginDependencies, pluginDependents, resolveEnabledPlugins, setPluginEnabled, unknownPlugins } from "./enabled";

const m = (name: string, ...deps: string[]) => ({ name, dependencies: Object.fromEntries(deps.map((d) => [d, "1.0.0"])) });
const set = [m("a"), m("b", "a"), m("c", "b"), m("d")];

describe("resolveEnabledPlugins", () => {
  it("enables everything by default", () => {
    expect([...resolveEnabledPlugins(set)]).toEqual(["a", "b", "c", "d"]);
    expect([...resolveEnabledPlugins(set, [])]).toEqual(["a", "b", "c", "d"]);
  });
  it("turns off listed plugins and everything that depends on them", () => {
    expect([...resolveEnabledPlugins(set, ["a"])]).toEqual(["d"]);
    expect([...resolveEnabledPlugins(set, ["b"])]).toEqual(["a", "d"]);
    expect([...resolveEnabledPlugins(set, ["d"])]).toEqual(["a", "b", "c"]);
  });
  it("ignores unknown names and works in any order", () => {
    expect([...resolveEnabledPlugins([m("c", "b"), m("b", "a"), m("a")], ["x", "a"])]).toEqual([]);
    expect(unknownPlugins(set, ["x", "a"])).toEqual(["x"]);
  });
  it("turns off a plugin whose dependency is missing", () => {
    expect([...resolveEnabledPlugins([m("e", "zzz"), m("d")])]).toEqual(["d"]);
  });
});

describe("dependency walks and toggling", () => {
  it("lists dependents and dependencies transitively", () => {
    expect(pluginDependents(set, "a")).toEqual(["b", "c"]);
    expect(pluginDependencies(set, "c")).toEqual(["a", "b"]);
  });
  it("turning off adds the dependents; turning on removes what it needs", () => {
    const off = setPluginEnabled(set, ["x"], "a", false);
    expect(off).toEqual({ disabled: ["x", "a", "b", "c"], affected: ["b", "c"] });
    const on = setPluginEnabled(set, off.disabled, "c", true);
    expect(on).toEqual({ disabled: ["x"], affected: ["a", "b"] });
  });
});
