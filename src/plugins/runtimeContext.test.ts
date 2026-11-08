// Runtime halves (ADR 0135): activation through a context that records Components, systems, World
// services and render features, in dependency order, undone by deactivation.
import { afterEach, describe, expect, it } from "vitest";
import { Component } from "../engine/core/Component";
import { component, getComponentClass, listComponentIds } from "../engine/core/registry";
import { listSystemCatalog } from "../engine/core/systems";
import { _worldServiceIds } from "../engine/core/worldServices";
import { _registeredRenderFeatures } from "../engine/render/renderFeatures";
import type { PluginManifest } from "./manifest";
import { RUNTIME_PLUGINS } from "./runtime";
import { activateRuntimePlugins, deactivateRuntimePlugin, isRuntimePluginActive, type RuntimePlugin } from "./runtimeContext";
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
  for (const n of names.splice(0)) deactivateRuntimePlugin(n);
  deactivateRuntimePlugin("myco.sky");
  activateRuntimePlugins([skyRuntimePlugin]); // as the rest of the suite expects
  log.length = 0;
});

describe("runtime plugin activation (ADR 0135)", () => {
  it("activates in dependency order, once", () => {
    const b = plugin("t.b", { dependencies: { "t.a": "1.0.0" } });
    const a = plugin("t.a");
    activateRuntimePlugins([b, a]);
    activateRuntimePlugins([b, a]);
    expect(log).toEqual(["t.a", "t.b"]);
    expect(isRuntimePluginActive("t.b")).toBe(true);
  });

  it("claims Components, and unregisters them when deactivated so scenes load them as missing", () => {
    activateRuntimePlugins([plugin("t.c", {}, (ctx) => ctx.registerComponents([Thing]))]);
    expect(getComponentClass("test.rt.Thing")).toBe(Thing);
    deactivateRuntimePlugin("t.c");
    expect(getComponentClass("test.rt.Thing")).toBeUndefined();
    expect(listComponentIds()).not.toContain("test.rt.Thing");
    activateRuntimePlugins([plugin("t.c2", {}, (ctx) => ctx.registerComponents([Thing]))]); // registered again
    expect(getComponentClass("test.rt.Thing")).toBe(Thing);
  });

  it("adds systems, World services and render features, and removes them all", () => {
    const p = plugin("t.all", {}, (ctx) => {
      ctx.registerSystems([{ name: "t.all.System", phase: "update", run: () => {} }]);
      ctx.registerWorldService({ id: "t.all.service", neededBy: {}, load: async () => 1, create: () => ({}), dispose: () => {} });
      ctx.registerRenderFeature({ spec: { name: "t.all.feature", phase: "effects", types: [], lazy: true }, after: ["particles"], load: async () => () => ({}) });
    });
    activateRuntimePlugins([p]);
    expect(listSystemCatalog().map((s) => s.name)).toContain("t.all.System");
    expect(_worldServiceIds()).toContain("t.all.service");
    expect(_registeredRenderFeatures().find((r) => r.spec.name === "t.all.feature")?.spec.after).toEqual(["particles"]);
    deactivateRuntimePlugin("t.all");
    expect(listSystemCatalog().map((s) => s.name)).not.toContain("t.all.System");
    expect(_worldServiceIds()).not.toContain("t.all.service");
    expect(_registeredRenderFeatures().some((r) => r.spec.name === "t.all.feature")).toBe(false);
  });

  it("rolls back a plugin that throws", () => {
    const p = plugin("t.bad", {}, (ctx) => {
      ctx.registerSystems([{ name: "t.bad.System", phase: "update", run: () => {} }]);
      throw new Error("boom");
    });
    expect(() => activateRuntimePlugins([p])).toThrow("boom");
    expect(isRuntimePluginActive("t.bad")).toBe(false);
    expect(listSystemCatalog().map((s) => s.name)).not.toContain("t.bad.System");
  });

  it("leaves out disabled plugins, unregistering their Components, and server: false ones on the server", () => {
    deactivateRuntimePlugin("myco.sky");
    const shared = plugin("t.shared");
    activateRuntimePlugins([...RUNTIME_PLUGINS, shared], { server: true });
    expect(isRuntimePluginActive("myco.sky")).toBe(false); // drawing only
    expect(isRuntimePluginActive("t.shared")).toBe(true);
    expect(getComponentClass("engine.Sky")).toBeUndefined();
    expect(_registeredRenderFeatures().some((r) => r.spec.name === "sky")).toBe(false);
    activateRuntimePlugins(RUNTIME_PLUGINS, { enabled: ["myco.materials", "myco.sky"] });
    expect(getComponentClass("engine.Sky")).toBe(Sky);
    deactivateRuntimePlugin("myco.sky");
    activateRuntimePlugins([skyRuntimePlugin], { enabled: [] });
    expect(getComponentClass("engine.Sky")).toBeUndefined();
  });

  it("the Sky plugin registers the Sky component and its render feature, before the lights", async () => {
    activateRuntimePlugins(RUNTIME_PLUGINS);
    expect(getComponentClass("engine.Sky")).toBe(Sky);
    const sky = _registeredRenderFeatures().find((r) => r.spec.name === "sky")!;
    expect(sky.spec).toMatchObject(SKY_SPEC);
    expect(typeof (await sky.load())).toBe("function");
  });
});
