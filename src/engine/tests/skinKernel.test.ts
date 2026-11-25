// ADR 0370 "Rendering" (T16): the `mycoSkin` kernel's JavaScript output (the very KSL the GPU compiles),
// run through the executor's `JsItemKernel`, against a straightforward reference skinning written here
// (morph deltas, then linear blend skinning with the weights normalised, as anim-offline's reference
// does), with 4 and 8 influences and morph targets; and the WGSL / GLSL glue as text.
// Tolerance 1e-5: the kernel's JavaScript runs in doubles like the reference, so the only difference is
// the order of additions; the inputs pass through Float32Array tables (f32 rounding of ~1e-7 relative).
import { describe, expect, it } from "vitest";
import { JsItemKernel, itemKernelGlsl, itemKernelGlslFeedback, itemKernelWgsl } from "../render/gpuKernels/itemKernel";
import { identityPalette, packMorphTargets, packSkinParams, packSkinVertices, paletteFor, PALETTE_FLOATS, SKIN_STRIDE, skinKernelSpec, skinVertexRows } from "../render/skinning/skinKernel";
import { jointsNeeded, skinnedSourceOf, usedJoints, type SkinGeometry, type SkinInfluences } from "../render/skinning/skinData";
import type { ModelMesh } from "../scene/models";

/** A seeded pseudo-random source (mulberry32), so failures repeat. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A row-major 3×4 matrix: a rotation about an axis, a non-uniform scale and a translation. */
function boneMatrix(r: () => number): number[] {
  const ax = [r() - 0.5, r() - 0.5, r() - 0.5];
  const l = Math.hypot(...ax);
  const [x, y, z] = ax.map((c) => c / l);
  const a = r() * Math.PI * 2;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const t = 1 - c;
  const rot = [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
  const scale = [0.5 + r(), 0.5 + r(), 0.5 + r()];
  const out: number[] = [];
  for (let row = 0; row < 3; row++) out.push(rot[row][0] * scale[0], rot[row][1] * scale[1], rot[row][2] * scale[2], (r() - 0.5) * 4);
  return out;
}

function geometry(vertices: number, joints: number, influences: SkinInfluences, targets: number, seed: number): SkinGeometry {
  const r = rng(seed);
  const vec = (n: number, k: number) => Float32Array.from({ length: n * k }, () => (r() - 0.5) * 2);
  const normals = new Float32Array(vertices * 3);
  const tangents = new Float32Array(vertices * 4);
  for (let v = 0; v < vertices; v++) {
    const n = [r() - 0.5, r() - 0.5, r() - 0.5];
    const l = Math.hypot(...n);
    for (let k = 0; k < 3; k++) normals[v * 3 + k] = n[k] / l;
    const t = [r() - 0.5, r() - 0.5, r() - 0.5];
    const lt = Math.hypot(...t);
    for (let k = 0; k < 3; k++) tangents[v * 4 + k] = t[k] / lt;
    tangents[v * 4 + 3] = r() < 0.5 ? -1 : 1;
  }
  const jointIdx = new Uint16Array(vertices * influences);
  const weights = new Float32Array(vertices * influences);
  for (let v = 0; v < vertices; v++) {
    let sum = 0;
    for (let k = 0; k < influences; k++) {
      jointIdx[v * influences + k] = Math.floor(r() * joints);
      const w = k > 0 && r() < 0.3 ? 0 : r(); // some unused influences
      weights[v * influences + k] = w;
      sum += w;
    }
    for (let k = 0; k < influences; k++) weights[v * influences + k] /= sum || 1;
  }
  return {
    positions: vec(vertices, 3),
    normals,
    tangents,
    skin: { influences, joints: jointIdx, weights },
    morphTargets: Array.from({ length: targets }, (_, i) => ({ name: `t${i}`, positions: vec(vertices, 3), normals: i % 2 ? null : vec(vertices, 3) })),
  };
}

/** The reference: morph, blend the influences' matrices by their normalised weights, transform; unit normal and tangent. */
function referenceSkin(g: SkinGeometry, palette: Float32Array, morphWeights: readonly number[]): Float32Array {
  const n = g.positions.length / 3;
  const out = new Float32Array(n * 12);
  const unit = (v: number[]) => {
    const l = Math.hypot(...v);
    return l > 1e-20 ? v.map((c) => c / l) : v;
  };
  for (let v = 0; v < n; v++) {
    const p = [0, 1, 2].map((k) => g.positions[v * 3 + k]);
    const nm = [0, 1, 2].map((k) => g.normals?.[v * 3 + k] ?? 0);
    g.morphTargets.forEach((t, m) => {
      const w = morphWeights[m] ?? 0;
      for (let k = 0; k < 3; k++) {
        p[k] += (t.positions?.[v * 3 + k] ?? 0) * w;
        nm[k] += (t.normals?.[v * 3 + k] ?? 0) * w;
      }
    });
    const M = new Array<number>(12).fill(0);
    let sum = 0;
    const skin = g.skin;
    if (skin) {
      for (let k = 0; k < skin.influences; k++) {
        const w = skin.weights[v * skin.influences + k];
        const j = skin.joints[v * skin.influences + k];
        for (let e = 0; e < 12; e++) M[e] += palette[j * PALETTE_FLOATS + e] * w;
        sum += w;
      }
    }
    if (sum > 1e-6) for (let e = 0; e < 12; e++) M[e] /= sum;
    else M.splice(0, 12, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);
    const lin = (x: number[]) => [0, 1, 2].map((row) => M[row * 4] * x[0] + M[row * 4 + 1] * x[1] + M[row * 4 + 2] * x[2]);
    const pos = lin(p).map((c, row) => c + M[row * 4 + 3]);
    const tan = [0, 1, 2].map((k) => g.tangents?.[v * 4 + k] ?? 0);
    out.set([...pos, 1, ...unit(lin(nm)), 0, ...unit(lin(tan)), g.tangents?.[v * 4 + 3] ?? 0], v * 12);
  }
  return out;
}

function runKernel(g: SkinGeometry, palette: Float32Array, morphWeights: readonly number[]): Float32Array {
  const influences = g.skin?.influences ?? 4;
  const n = g.positions.length / 3;
  const k = new JsItemKernel(skinKernelSpec(influences), n);
  k.setInput("verts", packSkinVertices(g));
  k.setInput("morphs", packMorphTargets(g));
  k.setInput("bones", palette);
  k.setInput("params", packSkinParams(n, g.morphTargets.length, morphWeights));
  k.dispatch();
  return k.output;
}

function expectClose(a: Float32Array, b: Float32Array, tol = 1e-5): void {
  expect(a.length).toBe(b.length);
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  expect(worst).toBeLessThan(tol);
}

function randomPalette(joints: number, seed: number): Float32Array {
  const r = rng(seed);
  return Float32Array.from(Array.from({ length: joints }, () => boneMatrix(r)).flat());
}

describe("mycoSkin through the executor's JavaScript output (ADR 0370)", () => {
  for (const influences of [4, 8] as const) {
    it(`matches the reference skinning with ${influences} influences`, () => {
      const g = geometry(40, 6, influences, 0, influences);
      const palette = randomPalette(6, 99 + influences);
      expectClose(runKernel(g, palette, []), referenceSkin(g, palette, []));
    });

    it(`applies morph targets before skinning with ${influences} influences`, () => {
      const g = geometry(25, 5, influences, 6, 7 + influences);
      const palette = randomPalette(5, 3);
      const weights = [0.5, 0, 1, -0.25, 0.75, 2]; // six targets: two rows of weights, a zero one skipped
      expectClose(runKernel(g, palette, weights), referenceSkin(g, palette, weights));
      // A weight change moves the result; missing weights count as zero.
      expectClose(runKernel(g, palette, [0.5]), referenceSkin(g, palette, [0.5]));
    });
  }

  it("is the identity at the bind pose, and keeps unskinned vertices at their morphed rest position", () => {
    const g = geometry(10, 4, 4, 1, 21);
    const out = runKernel(g, identityPalette(4), [0]);
    for (let v = 0; v < 10; v++) for (let k = 0; k < 3; k++) expect(out[v * 12 + k]).toBeCloseTo(g.positions[v * 3 + k], 5);
    const rest: SkinGeometry = { ...g, skin: null };
    const moved = runKernel(rest, randomPalette(4, 1), [1]);
    for (let k = 0; k < 3; k++) expect(moved[k]).toBeCloseTo(g.positions[k] + g.morphTargets[0].positions![k], 5);
    expect(moved[3]).toBe(1);
  });

  it("re-normalises normals and tangents, keeping the tangent's handedness", () => {
    const g = geometry(12, 3, 4, 0, 5);
    const out = runKernel(g, randomPalette(3, 8), []);
    for (let v = 0; v < 12; v++) {
      expect(Math.hypot(out[v * 12 + 4], out[v * 12 + 5], out[v * 12 + 6])).toBeCloseTo(1, 5);
      expect(Math.hypot(out[v * 12 + 8], out[v * 12 + 9], out[v * 12 + 10])).toBeCloseTo(1, 5);
      expect(out[v * 12 + 11]).toBe(g.tangents![v * 4 + 3]);
    }
  });

  it("reads its skeleton's palette from a shared table at the params' first joint, with the same result", () => {
    for (const influences of [4, 8] as const) {
      const g = geometry(30, 5, influences, 2, 40 + influences);
      const palette = randomPalette(5, 17);
      const before = randomPalette(7, 2); // another skeleton's palette ahead of it in the table
      const table = new Float32Array((7 + 5 + 3) * PALETTE_FLOATS);
      table.set(before);
      table.set(palette, 7 * PALETTE_FLOATS);
      table.set(randomPalette(3, 5), 12 * PALETTE_FLOATS); // and one after
      const n = g.positions.length / 3;
      const k = new JsItemKernel(skinKernelSpec(influences), n);
      k.setInput("verts", packSkinVertices(g));
      k.setInput("morphs", packMorphTargets(g));
      k.setInput("bones", table);
      k.setInput("params", packSkinParams(n, 2, [0.25, 1], undefined, 7));
      k.dispatch();
      expect(Array.from(k.output)).toEqual(Array.from(runKernel(g, palette, [0.25, 1])));
    }
  });

  it("divides by the weights' sum (weights that don't add to one)", () => {
    const g = geometry(8, 3, 4, 0, 13);
    const w = Float32Array.from(g.skin!.weights, (x) => x * 0.5);
    const half: SkinGeometry = { ...g, skin: { ...g.skin!, weights: w } };
    const palette = randomPalette(3, 4);
    expectClose(runKernel(half, palette, []), referenceSkin(g, palette, []));
  });
});

describe("skin tables", () => {
  it("lays out vertices with one joint/weight pair per four influences", () => {
    expect(skinVertexRows(4)).toBe(5);
    expect(skinVertexRows(8)).toBe(7);
    const g = geometry(2, 9, 8, 0, 1);
    const t = packSkinVertices(g);
    expect(t.length).toBe(2 * 7 * 4);
    expect(Array.from(t.subarray(7 * 4 + 12, 7 * 4 + 16))).toEqual(Array.from(g.skin!.joints).slice(8, 12));
    expect(Array.from(t.subarray(7 * 4 + 20, 7 * 4 + 24))).toEqual(Array.from(g.skin!.joints).slice(12, 16));
  });

  it("packs morph weights four to a row after the counts", () => {
    expect(Array.from(packSkinParams(10, 5, [1, 2, 3]))).toEqual([10, 5, 0, 0, 1, 2, 3, 0, 0, 0, 0, 0]);
    const reuse = new Float32Array(8);
    expect(packSkinParams(3, 1, [0.5], reuse)).toBe(reuse);
    expect(Array.from(packSkinParams(4, 0, [], undefined, 160))).toEqual([4, 0, 160, 0]); // the skeleton's first joint in the shared table
  });

  it("pads a short palette with identities, and passes a long enough one through", () => {
    const m = randomPalette(2, 1);
    expect(paletteFor(m, 2)).toBe(m);
    const padded = paletteFor(m, 3);
    expect(Array.from(padded.subarray(0, 24))).toEqual(Array.from(m));
    expect(Array.from(padded.subarray(24))).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    expect(Array.from(paletteFor(null, 1))).toEqual(Array.from(identityPalette(1)));
  });

  it("finds the joints a skin uses", () => {
    const g: SkinGeometry = { positions: new Float32Array(6), normals: null, tangents: null, morphTargets: [], skin: { influences: 4, joints: [3, 1, 7, 0, 3, 2, 0, 0], weights: [0.5, 0.5, 0, 0, 1, 0, 0, 0] } };
    expect(usedJoints(g)).toEqual([1, 3]);
    expect(jointsNeeded(g)).toBe(4);
    expect(jointsNeeded({ ...g, skin: null })).toBe(0);
  });

  it("reads a model mesh's skin fields (absent: the rest pose)", () => {
    const data = { positions: new Float32Array(3), normals: null, uvs: null, indices: new Uint32Array(0), groups: [] };
    const plain = { name: "m", materials: [], data, surfaces: [] } as unknown as ModelMesh;
    expect(skinnedSourceOf(plain).geometry.skin).toBeNull();
    const skin = { influences: 4 as const, joints: [0, 0, 0, 0], weights: [1, 0, 0, 0] };
    const skinned = { ...plain, skin, morphTargets: [{ name: "a", positions: null, normals: null }] } as unknown as ModelMesh;
    expect(skinnedSourceOf(skinned).geometry.skin).toBe(skin);
    expect(skinnedSourceOf(skinned).geometry.morphTargets).toHaveLength(1);
  });
});

describe("mycoSkin glue (WGSL, GLSL)", () => {
  for (const influences of [4, 8] as const) {
    const spec = skinKernelSpec(influences);
    it(`binds four tables and writes three outputs (${influences} influences)`, () => {
      const wgsl = itemKernelWgsl(spec);
      for (const [i, name] of ["verts", "morphs", "bones", "params"].entries()) expect(wgsl).toContain(`@group(0) @binding(${i + 1}) var<storage, read> kin_${name}: array<vec4f>;`);
      expect(wgsl).toContain("@group(0) @binding(5) var<storage, read_write> kout: array<vec4f>;");
      expect(wgsl).toContain(`const SKIN_INFLUENCES: i32 = ${influences};`);
      expect(wgsl).toContain("fn mycoSkin(v: i32)");
      expect(wgsl).toContain("kout[i * 3u + 2u] = out_tangent;");
      expect(SKIN_STRIDE).toBe(48);
      const frag = itemKernelGlsl(spec);
      expect(frag).toContain("layout(location = 2) out vec4 kout2;");
      expect(frag).toContain("void mycoSkin(int v)");
      const tf = itemKernelGlslFeedback(spec);
      expect(tf).toContain("uniform sampler2D kin_bones;");
      expect(tf).toContain("out vec4 kout0;\nout vec4 kout1;\nout vec4 kout2;");
      expect(tf).toContain("kernelItem(gl_VertexID);");
      expect(tf).not.toContain("gl_FragCoord");
      expect(tf).toContain(`const int SKIN_INFLUENCES = ${influences};`);
    });
  }
});
