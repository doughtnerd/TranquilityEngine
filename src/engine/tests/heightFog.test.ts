// ADR 0110: height fog on the Babylon backend, headless. The fog maths is checked by running the shader
// code the custom-shader hook hands out (`heightFogShader`, the same function the material plugin
// splices in) on the CPU, in both shading languages.
import { describe, expect, it } from "vitest";
import { heightFogShader } from "../render/babylon/heightFog";
import { runShader, vec } from "./shaderMaths";

const fog = { density: 0.1, base: 0, falloff: 0.5 };
const ON = ["MYCO_HEIGHT_FOG"];

/** The fog amount each language's shader computes from an eye at height `eyeY` to a point `distance` metres away at height `pointY`. */
function amounts(eyeY: number, pointY: number, distance: number, defines = ON): number[] {
  const dy = pointY - eyeY;
  const eye = vec(3, 0, eyeY, 0);
  const p = vec(3, Math.sqrt(Math.max(0, distance * distance - dy * dy)), pointY, 0);
  const uniform = vec(4, fog.density, fog.base, fog.falloff, 1);
  return [
    runShader(heightFogShader("glsl").decl, { defines, env: { mycoHeightFog: uniform, p, eye }, result: "mycoHeightFogFactor(p, eye)" }) as number,
    runShader(heightFogShader("wgsl").decl, { defines, env: { uniforms: { mycoHeightFog: uniform }, p, eye }, result: "mycoHeightFogFactor(p, eye)" }) as number,
  ];
}
/** The amount, the same in both languages. */
function amount(eyeY: number, pointY: number, distance: number): number {
  const [glsl, wgsl] = amounts(eyeY, pointY, distance);
  expect(wgsl).toBeCloseTo(glsl, 9);
  return glsl;
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
    const env = { mycoHeightFog: vec(4, fog.density, fog.base, fog.falloff, 1), mycoHeightFogColor: vec(4, 1, 0, 0, 1), c: vec(3, 0, 0, 1), p: vec(3, 10, 0, 0), eye: vec(3, 0, 0, 0) };
    const fogged = runShader(heightFogShader("glsl").decl, { defines: ON, env, result: "mycoApplyHeightFog(c, p, eye)" }) as { c: number[] };
    const t = 1 - Math.exp(-1);
    fogged.c.forEach((v, i) => expect(v).toBeCloseTo([t, 0, 1 - t][i]!, 9));
    expect(amounts(0, 0, 10, [])).toEqual([0, 0]);
    expect((runShader(heightFogShader("glsl").decl, { env, result: "mycoApplyHeightFog(c, p, eye)" }) as { c: number[] }).c).toEqual([0, 0, 1]);
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
