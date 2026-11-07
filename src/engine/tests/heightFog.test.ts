// ADR 0110: height fog on the Babylon backend, headless.
import { describe, expect, it } from "vitest";
import { heightFogAmount } from "../render/babylon/heightFog";

describe("height fog (ADR 0110)", () => {
  const fog = { density: 0.1, base: 0, falloff: 0.5 };

  it("is thicker low down than high up, and grows with distance", () => {
    expect(heightFogAmount(fog, 0, 0, 20)).toBeGreaterThan(heightFogAmount(fog, 10, 10, 20));
    expect(heightFogAmount(fog, 0, 0, 40)).toBeGreaterThan(heightFogAmount(fog, 0, 0, 20));
    expect(heightFogAmount(fog, 0, 0, 0)).toBe(0);
  });

  it("matches plain exponential fog along a level ray at the base height", () => {
    expect(heightFogAmount(fog, 0, 0, 10)).toBeCloseTo(1 - Math.exp(-0.1 * 10), 6);
  });

  it("integrates along a sloped ray: looking down into fog fogs more than looking up out of it", () => {
    const down = heightFogAmount(fog, 5, 0, 20);
    const up = heightFogAmount(fog, 5, 10, 20);
    expect(down).toBeGreaterThan(up);
    // Exactly the integral of d·e^(−f(y−base)) along the ray, from y=5 to y=0 over 20 m.
    const steps = 10000;
    let sum = 0;
    for (let i = 0; i < steps; i++) sum += 0.1 * Math.exp(-0.5 * (5 - 5 * ((i + 0.5) / steps))) * (20 / steps);
    expect(down).toBeCloseTo(1 - Math.exp(-sum), 4);
  });

  it("compiles in only where the scene has it and the mesh takes fog", async () => {
    const { NullEngine } = await import("@babylonjs/core/Engines/nullEngine.js");
    const { Scene } = await import("@babylonjs/core/scene.js");
    const { PBRMaterial } = await import("@babylonjs/core/Materials/PBR/pbrMaterial.js");
    const { Mesh } = await import("@babylonjs/core/Meshes/mesh.js");
    const { setHeightFog } = await import("../render/babylon/heightFog");
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const m = new PBRMaterial("m", scene);
    const plugin = m.pluginManager!.getPlugin("MycoHeightFog") as unknown as { prepareDefines(d: { MYCO_HEIGHT_FOG: boolean }, s: unknown, mesh: unknown): void };
    expect(plugin).toBeTruthy(); // every PBR material carries it
    const mesh = new Mesh("a", scene);
    const d = { MYCO_HEIGHT_FOG: true };
    plugin.prepareDefines(d, scene, mesh);
    expect(d.MYCO_HEIGHT_FOG).toBe(false);
    setHeightFog(scene, { on: true, density: 0.1, base: 0, falloff: 0.5, color: [1, 1, 1] });
    plugin.prepareDefines(d, scene, mesh);
    expect(d.MYCO_HEIGHT_FOG).toBe(true);
    mesh.applyFog = false; // a material asset with "fog": false
    plugin.prepareDefines(d, scene, mesh);
    expect(d.MYCO_HEIGHT_FOG).toBe(false);
    scene.dispose();
    engine.dispose();
  });
});
