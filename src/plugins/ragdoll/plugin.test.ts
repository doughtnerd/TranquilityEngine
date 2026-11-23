// The Ragdoll plugin activates only with its dependencies, Physics and Animation (ADR 0375), and is gone cleanly
// (no Component, no systems) when either is disabled.
import { describe, expect, it } from "vitest";
import { Engine } from "../../myco";
import { getComponentClass } from "../../engine/core/registry";
import { isRuntimePluginActive } from "../runtime";
import { applyTestPlugins } from "../testPlugins";
import { Ragdoll } from "./runtime";

const project = { physics: { gravity: [0, -10] as [number, number], layers: ["Default"] } };
const dt = 1 / 60;

describe("the Ragdoll plugin's dependencies (ADR 0375)", () => {
  it("is active with physics and animation, and off (its Component and systems gone) when either is disabled", async () => {
    expect(isRuntimePluginActive("myco.ragdoll")).toBe(true);
    for (const off of ["myco.physics", "myco.animation"]) {
      applyTestPlugins([off]);
      try {
        expect(isRuntimePluginActive("myco.ragdoll"), off).toBe(false);
        expect(getComponentClass("engine.Ragdoll"), off).toBeUndefined();
        const e = await Engine.create({ headless: true, project });
        expect(e.world.scheduler.order("fixedUpdate").filter((s) => s.startsWith("ragdoll."))).toEqual([]);
        for (let i = 0; i < 5; i++) e.step(dt);
        e.dispose();
      } finally {
        applyTestPlugins();
      }
    }
    expect(getComponentClass("engine.Ragdoll")).toBe(Ragdoll);
  });
});
