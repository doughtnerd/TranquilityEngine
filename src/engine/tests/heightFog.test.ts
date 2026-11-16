// ADR 0110: height fog on the Babylon backend, headless.
import { describe, expect, it } from "vitest";

describe("height fog (ADR 0110)", () => {
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
