// Runtime halves (ADR 0135): activation through a context that records Components, systems, World
// services and render features, undone by deactivation, as plugin sets drive it (`runtimeActivator`, ADR 0144;
// the order, the enabled set and the server's choice are the plugin set's, tested in pluginSet.test.ts).
import { afterEach, describe, expect, it } from "vitest";
import { Component } from "../engine/core/Component";
import { component, getComponentClass, listComponentIds } from "../engine/core/registry";
import { listSystemCatalog } from "../engine/core/systems";
import { _worldServiceIds } from "../engine/core/worldServices";
import { _registeredRenderFeatures } from "../engine/render/renderFeatures";
import type { PluginManifest } from "./manifest";
import { RUNTIME_PLUGINS } from "./runtime";
import { isRuntimePluginActive, runtimeActivator, type RuntimePlugin } from "./runtimeContext";
import { SKY_SPEC, Sky, skyRuntimePlugin } from "./sky/runtime";

@component("test.rt.Thing")
class Thing extends Component {}

const log: string[] = [];
const names: string[] = [];

function plugin(name: string, extra: Partial<PluginManifest> = {}, activate: RuntimePlugin["activate"] = () => {}): RuntimePlugin {
  names.push(name);
  return { manifest: { name, version: "1.0.0", ...extra }, activate: (ctx) => (log.push(name), activate(ctx)) };
}

afterEach(() => {
  for (const n of names.splice(0)) runtimeActivator.deactivate(n);
  runtimeActivator.deactivate("myco.sky");
  runtimeActivator.activate(skyRuntimePlugin); // as the rest of the suite expects
  log.length = 0;
});

describe("runtime plugin activation (ADR 0135)", () => {
  it("activates once", () => {
    const a = plugin("t.a");
    runtimeActivator.activate(a);
    runtimeActivator.activate(a);
    expect(log).toEqual(["t.a"]);
    expect(isRuntimePluginActive("t.a")).toBe(true);
  });

  it("claims Components, and unregisters them when deactivated so scenes load them as missing", () => {
    runtimeActivator.activate(plugin("t.c", {}, (ctx) => ctx.registerComponents([Thing])));
    expect(getComponentClass("test.rt.Thing")).toBe(Thing);
    runtimeActivator.deactivate("t.c");
    expect(getComponentClass("test.rt.Thing")).toBeUndefined();
    expect(listComponentIds()).not.toContain("test.rt.Thing");
    runtimeActivator.activate(plugin("t.c2", {}, (ctx) => ctx.registerComponents([Thing]))); // registered again
    expect(getComponentClass("test.rt.Thing")).toBe(Thing);
  });

  it("adds systems, World services and render features, and removes them all", () => {
    const p = plugin("t.all", {}, (ctx) => {
      ctx.registerSystems([{ name: "t.all.System", phase: "update", run: () => {} }]);
      ctx.registerWorldService({ id: "t.all.service", neededBy: {}, load: async () => 1, create: () => ({}), dispose: () => {} });
      ctx.registerRenderFeature({ spec: { name: "t.all.feature", phase: "effects", types: [], lazy: true }, after: ["particles"], load: async () => () => ({}) });
    });
    runtimeActivator.activate(p);
    expect(listSystemCatalog().map((s) => s.name)).toContain("t.all.System");
    expect(_worldServiceIds()).toContain("t.all.service");
    expect(_registeredRenderFeatures().find((r) => r.spec.name === "t.all.feature")?.spec.after).toEqual(["particles"]);
    runtimeActivator.deactivate("t.all");
    expect(listSystemCatalog().map((s) => s.name)).not.toContain("t.all.System");
    expect(_worldServiceIds()).not.toContain("t.all.service");
    expect(_registeredRenderFeatures().some((r) => r.spec.name === "t.all.feature")).toBe(false);
  });

  it("rolls back a plugin that throws", () => {
    const p = plugin("t.bad", {}, (ctx) => {
      ctx.registerSystems([{ name: "t.bad.System", phase: "update", run: () => {} }]);
      throw new Error("boom");
    });
    expect(() => runtimeActivator.activate(p)).toThrow("boom");
    expect(isRuntimePluginActive("t.bad")).toBe(false);
    expect(listSystemCatalog().map((s) => s.name)).not.toContain("t.bad.System");
  });

  it("disables a plugin by unregistering its Components, until it's activated", () => {
    runtimeActivator.deactivate("myco.sky");
    runtimeActivator.disable!(skyRuntimePlugin);
    expect(isRuntimePluginActive("myco.sky")).toBe(false);
    expect(getComponentClass("engine.Sky")).toBeUndefined();
    expect(_registeredRenderFeatures().some((r) => r.spec.name === "sky")).toBe(false);
    runtimeActivator.activate(skyRuntimePlugin);
    expect(getComponentClass("engine.Sky")).toBe(Sky);
    runtimeActivator.disable!(skyRuntimePlugin); // nothing happens to an active plugin
    expect(getComponentClass("engine.Sky")).toBe(Sky);
  });

  it("the Sky plugin registers the Sky component and its render feature, before the lights", async () => {
    for (const p of RUNTIME_PLUGINS) runtimeActivator.activate(p);
    expect(getComponentClass("engine.Sky")).toBe(Sky);
    const sky = _registeredRenderFeatures().find((r) => r.spec.name === "sky")!;
    expect(sky.spec).toMatchObject(SKY_SPEC);
    expect(typeof (await sky.load())).toBe("function");
  });
});
