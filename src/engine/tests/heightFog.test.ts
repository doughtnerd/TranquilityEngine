// ADR 0110: height fog on the Babylon backend, headless. The fog maths is checked by running the shader
// source the custom-shader hook hands out (`heightFogShader`, KSL, whose WGSL and GLSL outputs the
// material plugin and custom shaders compile, ADR 0250) as JavaScript.
import { describe, expect, it } from "vitest";
import { heightFogShader } from "../render/babylon/heightFog";

const fog = { density: 0.1, base: 0, falloff: 0.5 };
const ON = ["MYCO_HEIGHT_FOG"];

/** The hook's code as JavaScript, with the fog's uniforms. */
function hook(defines = ON, color = [1, 1, 1, 1]) {
  return heightFogShader().source.js({ defines, uniforms: { mycoHeightFog: [fog.density, fog.base, fog.falloff, 1], mycoHeightFogColor: color } });
}

/** The fog amount from an eye at height `eyeY` to a point `distance` metres away at height `pointY`. */
function amount(eyeY: number, pointY: number, distance: number, defines = ON): number {
  const dy = pointY - eyeY;
  const p = [Math.sqrt(Math.max(0, distance * distance - dy * dy)), pointY, 0];
  return hook(defines).fn("mycoHeightFogFactor")(p, [0, eyeY, 0]) as number;
}

describe("height fog (ADR 0110)", () => {
  it("is thicker low down than high up, and grows with distance", () => {
    expect(amount(0, 0, 20)).toBeGreaterThan(amount(10, 10, 20));
    expect(amount(0, 0, 40)).toBeGreaterThan(amount(0, 0, 20));
    expect(amount(0, 0, 0)).toBe(0);
  });

  it("matches plain exponential fog along a level ray at the base height", () => {
    expect(amount(0, 0, 10)).toBeCloseTo(1 - Math.exp(-0.1 * 10), 6);
  });

  it("integrates along a sloped ray: looking down into fog fogs more than looking up out of it", () => {
    const down = amount(5, 0, 20);
    const up = amount(5, 10, 20);
    expect(down).toBeGreaterThan(up);
    // Exactly the integral of d·e^(−f(y−base)) along the ray, from y=5 to y=0 over 20 m.
    const steps = 10000;
    let sum = 0;
    for (let i = 0; i < steps; i++) sum += 0.1 * Math.exp(-0.5 * (5 - 5 * ((i + 0.5) / steps))) * (20 / steps);
    expect(down).toBeCloseTo(1 - Math.exp(-sum), 4);
  });

  it("fogs a custom shader's colour towards the fog colour, and does nothing with the define off", () => {
    const fogged = hook(ON, [1, 0, 0, 1]).fn("mycoApplyHeightFog")([0, 0, 1], [10, 0, 0], [0, 0, 0]) as number[];
    const t = 1 - Math.exp(-1);
    fogged.forEach((v, i) => expect(v).toBeCloseTo([t, 0, 1 - t][i]!, 9));
    expect(amount(0, 0, 10, [])).toBe(0);
    expect(hook([], [1, 0, 0, 1]).fn("mycoApplyHeightFog")([0, 0, 1], [10, 0, 0], [0, 0, 0])).toEqual([0, 0, 1]);
  });

  it("hands custom shaders the same source in WGSL and GLSL, declaring its uniforms", () => {
    const { source, uniforms } = heightFogShader();
    expect(source.text("wgsl")).toContain("uniform mycoHeightFog: vec4f;");
    expect(source.text("wgsl")).toContain("fn mycoApplyHeightFog(c: vec3f, p: vec3f, eye: vec3f) -> vec3f {");
    expect(source.text("glsl")).toContain("uniform vec4 mycoHeightFogColor;");
    expect(source.text("glsl")).toContain("vec3 mycoApplyHeightFog(vec3 c, vec3 p, vec3 eye) {");
    expect(uniforms).toEqual(["mycoHeightFog", "mycoHeightFogColor"]);
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
