import { describe, expect, it } from "vitest";
import { migrateDisabledPlugins, pluginDependencies, pluginDependents, resolveEnabledPlugins, setPluginEnabled, unknownPlugins } from "./enabled";

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

describe("renamed plugins (ADR 0137)", () => {
  const physics = [m("myco.physics"), m("myco.physics-rapier", "myco.physics"), m("myco.sky")];
  it("maps the old physics plugins' names in plugins.disabled to myco.physics", () => {
    expect([...resolveEnabledPlugins(physics, ["myco.physics2d"])]).toEqual(["myco.sky"]);
    expect([...resolveEnabledPlugins(physics, ["myco.physics3d"])]).toEqual(["myco.sky"]);
    expect(migrateDisabledPlugins(["myco.physics2d", "myco.sky", "myco.physics3d"])).toEqual(["myco.physics", "myco.sky"]);
    expect(unknownPlugins(physics, ["myco.physics2d", "gone"])).toEqual(["gone"]);
  });
  it("rewrites old names when a plugin is toggled", () => {
    expect(setPluginEnabled(physics, ["myco.physics2d", "myco.physics3d"], "myco.physics", true)).toEqual({ disabled: [], affected: [] });
    expect(setPluginEnabled(physics, ["myco.physics3d"], "myco.sky", false).disabled).toEqual(["myco.physics", "myco.sky"]);
  });
});
