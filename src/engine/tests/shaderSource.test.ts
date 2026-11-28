// ADR 0250: one shader source (KSL) with WGSL, GLSL and JavaScript outputs. The language is checked
// through `shaderSource`; the kernel hashes and noise run as JavaScript from the very KSL the particle
// shaders compile and are compared with the JavaScript executor's (`kernelMath.ts`).
import { describe, expect, it } from "vitest";
import { shaderSource } from "../render/shaderSource/shaderSource";
import { srgbToLinear } from "../core/colorSpace";
import { hsv, krand, noise3, particleSeed, valueNoise, KERNEL_MATH_SHADER } from "../render/particles/gpu/kernelMath";

describe("the shader source language (KSL)", () => {
  const src = shaderSource(/* KSL */ `
UNIFORM(KV4, tint);
TEXTURE2D(ramp);
CONST(KF, HALF) = 0.5;
FN(KV3, shade, KV3 c, KF t) {
  VAR(KV3[2], pair) = KV3[2](c, KV3(1.0));
  VAR(KF, k) = select(0.0, 1.0, t > HALF);
  return mix(pair[0], pair[1], k) * UNI(tint).xyz + KTEX(ramp, KV2(t, 0.0)).xyz;
}
FN(KF, angle, KF y, KF x) {
  return atan2(y, x);
}
`);

  it("spells types, declarations, uniforms, textures, arrays and select in WGSL", () => {
    const w = src.text("wgsl");
    expect(w).toContain("uniform tint: vec4f;");
    expect(w).toContain("var rampSampler: sampler;\nvar ramp: texture_2d<f32>;");
    expect(w).toContain("const HALF: f32 = 0.5;");
    expect(w).toContain("fn shade(c: vec3f, t: f32) -> vec3f {");
    expect(w).toContain("var pair: array<vec3f, 2> = array<vec3f, 2>(c, vec3f(1.0));");
    expect(w).toContain("select(0.0, 1.0, t > HALF)");
    expect(w).toContain("uniforms.tint.xyz + textureSampleLevel(ramp, rampSampler, vec2f(t, 0.0), 0.0).xyz");
    expect(w).toContain("atan2(y, x)");
  });

  it("spells them in GLSL", () => {
    const g = src.text("glsl");
    expect(g).toContain("uniform vec4 tint;");
    expect(g).toContain("uniform sampler2D ramp;");
    expect(g).toContain("const float HALF = 0.5;");
    expect(g).toContain("vec3 shade(vec3 c, float t) {");
    expect(g).toContain("vec3 pair[2] = vec3[2](c, vec3(1.0));");
    expect(g).toContain("((t > HALF) ? (1.0) : (0.0))");
    expect(g).toContain("tint.xyz + texture2D(ramp, vec2(t, 0.0)).xyz");
    expect(g).toContain("atan(y, x)");
  });

  it("leaves declarations out for a material plugin's uniform buffer", () => {
    for (const d of ["wgsl", "glsl"] as const) {
      const t = src.text(d, { declarations: "omit" });
      expect(t).not.toMatch(/^(uniform |var \w+: (sampler|texture))/m);
      expect(t).toContain(d === "wgsl" ? "uniforms.tint" : "* tint.xyz");
    }
  });

  it("runs as JavaScript with the uniforms and textures given", () => {
    const uniforms = { tint: [1, 0.5, 2, 1] };
    const p = src.js({ uniforms, textures: { ramp: (uv) => [uv[0], 0, 0, 1] } });
    expect(p.fn("shade")([0.2, 0.4, 0.6], 0.25)).toEqual([0.2 + 0.25, 0.2, 1.2]);
    expect(p.fn("shade")([0.2, 0.4, 0.6], 0.75)).toEqual([1 + 0.75, 0.5, 2]);
    uniforms.tint = [0, 0, 0, 1]; // read at each call
    expect(p.fn("shade")([0.2, 0.4, 0.6], 0.75)).toEqual([0.75, 0, 0]);
    expect(p.fn("angle")(1, -1)).toBeCloseTo((3 * Math.PI) / 4, 12);
  });

  it("wraps integers as the GPU does, and keeps vectors values", () => {
    const p = shaderSource(/* KSL */ `
FN(KU, mulU, KU a, KU b) { return a * b; }
FN(KI, divI, KI a, KI b) { return a / b; }
FN(KU, shr, KU a) { return a >> 28u; }
FN(KI, toInt, KF x) { return KI(x); }
FN(KU, toUint, KF x) { return KU(x); }
FN(KV3, aliasing, KV3 a) {
  VAR(KV3, b) = a;
  b.x = 9.0;
  return a + b;
}
`).js();
    expect(p.fn("mulU")(0xffffffff, 3)).toBe(0xfffffffd);
    expect(p.fn("divI")(-7, 2)).toBe(-3);
    expect(p.fn("shr")(0xf0000000)).toBe(15);
    expect(p.fn("toInt")(-2.7)).toBe(-2);
    expect(p.fn("toUint")(-2.7)).toBe(0);
    expect(p.fn("aliasing")([1, 2, 3])).toEqual([10, 4, 6]);
  });

  it("runs only the preprocessor branches the defines select", () => {
    const fog = shaderSource(/* KSL */ `
FN(KF, amount) {
#if defined(A) && !defined(B)
  return 1.0;
#else
  return 0.0;
#endif
}
`);
    expect(fog.js({ defines: ["A"] }).fn("amount")()).toBe(1);
    expect(fog.js({ defines: ["A", "B"] }).fn("amount")()).toBe(0);
    expect(fog.text("glsl")).toContain("#if defined(A) && !defined(B)"); // Babylon runs it on the GPU side
  });

  it("refuses what isn't KSL with the reason", () => {
    expect(() => shaderSource("FN(KF, f, KF x) { return x + 1; }").js().fn("f")).toThrow(/f \+ i/);
    expect(() => shaderSource("FN(KF, f, KV3 v) { VAR(KV3, w) = v; w.xy = KV2(0.0); return w.x; }").js().fn("f")).toThrow(/swizzle writes/);
  });
});

describe("the kernel hashes and noise: one KSL text for the shaders and the JavaScript executor (ADR 0094, 0250)", () => {
  const k = KERNEL_MATH_SHADER.js();

  it("draws the same random numbers", () => {
    for (const [seed, salt] of [[0, 0], [0.123, 900], [0.999, 3001], [0.5, 4000]]) expect(k.fn("k_rand")(seed, salt)).toBe(krand(seed, salt));
    for (const [i, f, s] of [[0, 0, 0], [17, 3, 42], [4095, 1000, 7]]) expect(k.fn("k_seed")(i, f, s)).toBe(particleSeed(i, f, s));
  });

  it("makes the same noise", () => {
    for (const [x, y, z] of [[0.1, 0.2, 0.3], [-4.7, 12.25, 0.5], [31.7, -17.3, 99.9]]) expect(k.fn("k_noise3")(x, y, z)).toBeCloseTo(noise3(x, y, z), 12);
    for (const [x, s] of [[0.3, 1], [-2.6, 7], [150.25, 3]]) expect(k.fn("k_vnoise")(x, s)).toBeCloseTo(valueNoise(x, s), 12);
  });

  it("converts colour the same way", () => {
    for (const h of [0, 0.1, 0.45, 0.7, 0.99]) {
      const got = k.fn("k_hsv")(h, 0.8, 0.9, 1) as number[];
      hsv(h, 0.8, 0.9, 1).forEach((v, i) => expect(got[i]).toBeCloseTo(v, 12));
    }
    for (const c of [0, 0.02, 0.5, 1]) expect(k.fn("k_lin")(c)).toBeCloseTo(srgbToLinear(c), 12);
  });
});
