/**
 * Internal (ADR 0370 "Rendering"): `mycoSkin`, the engine's one skinning model, written once in KSL
 * (`render/shaderSource`) and run as an item kernel (`render/gpuKernels/itemKernel.ts`), one item per
 * vertex: WGSL compute on WebGPU, a transform-feedback vertex pass on WebGL2, JavaScript on the CPU and
 * in tests. It applies morph deltas, then linear blend skinning of position, normal and tangent with 4
 * or 8 influences (ADR 0371); normals and tangents are re-normalised, the tangent keeps its handedness.
 *
 * Input tables (vec4 rows; four inputs, so with the item count and the output it binds six storage
 * buffers, within WebGPU's guaranteed eight per stage):
 * - `verts`: per vertex `skinVertexRows(influences)` rows: position (xyz), normal (xyz), tangent (xyzw),
 *   then joints and weights as vec4 pairs (one pair for 4 influences, two for 8). Joint indices are floats
 *   (exact below 2^24).
 * - `morphs`: per target, per vertex, two rows: the position delta and the normal delta (row
 *   `(target * vertices + vertex) * 2`).
 * - `bones`: bone palettes, three rows per joint: a row-major 3×4 matrix (D10: translation in the fourth
 *   column), model × inverse bind. One table holds every skeleton's palette (`bindInput`); a mesh's
 *   skeleton starts at joint `params[0].z`.
 * - `params`: row 0 = (vertices, morph targets, first joint of the skeleton in `bones`, 0); then the
 *   morph weights, four per row.
 *
 * Outputs (D87: one vec4 each, interleaved, 48 bytes a vertex): `position` (xyz, 1), `normal` (xyz, 0),
 * `tangent` (xyz, w). Weights are divided by their sum; a vertex whose weights are all zero keeps its
 * morphed rest position (a mesh without a skin draws its rest pose).
 */
import { shaderSource, type ShaderSource } from "../shaderSource/shaderSource";
import type { ItemKernelSpec } from "../gpuKernels/itemKernel";
import { vertexCount, type SkinGeometry, type SkinInfluences } from "./skinData";

/** Floats per joint in a palette (three vec4 rows, D10). */
export const PALETTE_FLOATS = 12;

/** The kernel's outputs, in order: what a mesh draws as its position, normal and tangent (offsets 0, 16, 32). */
export const SKIN_OUTPUTS = ["position", "normal", "tangent"] as const;

/** Bytes per skinned vertex in the output (the vertex buffer's stride). */
export const SKIN_STRIDE = SKIN_OUTPUTS.length * 16;

/** The `mycoSkin` function and its helpers (KSL). Needs the constants `SKIN_INFLUENCES` and `SKIN_VERTEX_ROWS`, and the tables above. */
export const MYCO_SKIN: ShaderSource = shaderSource(/* KSL */ `
GLOBAL(KV4, skinPosition);
GLOBAL(KV4, skinNormal);
GLOBAL(KV4, skinTangent);
GLOBAL(KV4, skinRow0);
GLOBAL(KV4, skinRow1);
GLOBAL(KV4, skinRow2);
GLOBAL(KF, skinWeight);
GLOBAL(KI, skinBase);

FN(void, skinInfluence, KF joint, KF weight) {
  if (weight != 0.0) {
    VAR(KI, b) = (KI(joint) + skinBase) * 3;
    skinRow0 = skinRow0 + in_bones(b) * weight;
    skinRow1 = skinRow1 + in_bones(b + 1) * weight;
    skinRow2 = skinRow2 + in_bones(b + 2) * weight;
    skinWeight = skinWeight + weight;
  }
}

FN(void, skinInfluences, KV4 joints, KV4 weights) {
  skinInfluence(joints.x, weights.x);
  skinInfluence(joints.y, weights.y);
  skinInfluence(joints.z, weights.z);
  skinInfluence(joints.w, weights.w);
}

FN(KF, skinMorphWeight, KI t) {
  VAR(KV4, w) = in_params(1 + t / 4);
  VAR(KI, c) = t - (t / 4) * 4;
  if (c == 1) {
    return w.y;
  }
  if (c == 2) {
    return w.z;
  }
  if (c == 3) {
    return w.w;
  }
  return w.x;
}

FN(KV3, skinLinear, KV3 v) {
  return KV3(dot(skinRow0.xyz, v), dot(skinRow1.xyz, v), dot(skinRow2.xyz, v));
}

FN(KV3, skinUnit, KV3 v) {
  VAR(KF, l) = length(v);
  if (l > 1e-20) {
    return v * (1.0 / l);
  }
  return v;
}

FN(void, mycoSkin, KI v) {
  VAR(KI, base) = v * SKIN_VERTEX_ROWS;
  VAR(KV3, p) = in_verts(base).xyz;
  VAR(KV3, n) = in_verts(base + 1).xyz;
  VAR(KV4, t) = in_verts(base + 2);
  VAR(KV4, info) = in_params(0);
  VAR(KI, vertices) = KI(info.x);
  VAR(KI, targets) = KI(info.y);
  skinBase = KI(info.z);
  for (VAR(KI, m) = 0; m < targets; m++) {
    VAR(KF, w) = skinMorphWeight(m);
    if (w != 0.0) {
      VAR(KI, d) = (m * vertices + v) * 2;
      p = p + in_morphs(d).xyz * w;
      n = n + in_morphs(d + 1).xyz * w;
    }
  }
  skinRow0 = KV4(0.0);
  skinRow1 = KV4(0.0);
  skinRow2 = KV4(0.0);
  skinWeight = 0.0;
  skinInfluences(in_verts(base + 3), in_verts(base + 4));
  if (SKIN_INFLUENCES > 4) {
    skinInfluences(in_verts(base + 5), in_verts(base + 6));
  }
  if (skinWeight > 1e-6) {
    VAR(KF, s) = 1.0 / skinWeight;
    skinRow0 = skinRow0 * s;
    skinRow1 = skinRow1 * s;
    skinRow2 = skinRow2 * s;
  } else {
    skinRow0 = KV4(1.0, 0.0, 0.0, 0.0);
    skinRow1 = KV4(0.0, 1.0, 0.0, 0.0);
    skinRow2 = KV4(0.0, 0.0, 1.0, 0.0);
  }
  VAR(KV4, p1) = KV4(p, 1.0);
  skinPosition = KV4(dot(skinRow0, p1), dot(skinRow1, p1), dot(skinRow2, p1), 1.0);
  skinNormal = KV4(skinUnit(skinLinear(n)), 0.0);
  skinTangent = KV4(skinUnit(skinLinear(t.xyz)), t.w);
}
`);

/** Rows per vertex in the `verts` table. */
export function skinVertexRows(influences: SkinInfluences): number {
  return influences === 8 ? 7 : 5;
}

const specs = new Map<SkinInfluences, ItemKernelSpec>();

/** The skinning item kernel for 4 or 8 influences: `MYCO_SKIN` with its constants, writing the three outputs. */
export function skinKernelSpec(influences: SkinInfluences): ItemKernelSpec {
  let spec = specs.get(influences);
  if (!spec) {
    const constants = `CONST(KI, SKIN_INFLUENCES) = ${influences};\nCONST(KI, SKIN_VERTEX_ROWS) = ${skinVertexRows(influences)};\n`;
    const entry = `
FN(void, kernelItem, KI i) {
  mycoSkin(i);
  out_position = skinPosition;
  out_normal = skinNormal;
  out_tangent = skinTangent;
}
`;
    spec = { name: `mycoSkin${influences}`, inputs: ["verts", "morphs", "bones", "params"], outputs: SKIN_OUTPUTS, body: shaderSource(constants, MYCO_SKIN, entry) };
    specs.set(influences, spec);
  }
  return spec;
}

/** The influences a geometry is skinned with (its skin's, else 4). */
export function influencesOf(g: SkinGeometry): SkinInfluences {
  return g.skin?.influences === 8 ? 8 : 4;
}

/** The `verts` table of a geometry (rows as the module doc says). Missing normals and tangents are zero. */
export function packSkinVertices(g: SkinGeometry): Float32Array {
  const n = vertexCount(g);
  const influences = influencesOf(g);
  const rows = skinVertexRows(influences);
  const out = new Float32Array(Math.max(1, n * rows) * 4);
  const skin = g.skin;
  for (let v = 0; v < n; v++) {
    const o = v * rows * 4;
    out[o] = g.positions[v * 3];
    out[o + 1] = g.positions[v * 3 + 1];
    out[o + 2] = g.positions[v * 3 + 2];
    if (g.normals) {
      out[o + 4] = g.normals[v * 3];
      out[o + 5] = g.normals[v * 3 + 1];
      out[o + 6] = g.normals[v * 3 + 2];
    }
    if (g.tangents) for (let k = 0; k < 4; k++) out[o + 8 + k] = g.tangents[v * 4 + k];
    if (!skin) continue;
    for (let pair = 0; pair < influences / 4; pair++) {
      for (let k = 0; k < 4; k++) {
        const s = v * influences + pair * 4 + k;
        out[o + 12 + pair * 8 + k] = skin.joints[s];
        out[o + 16 + pair * 8 + k] = skin.weights[s];
      }
    }
  }
  return out;
}

/** The `morphs` table of a geometry (two rows per target and vertex); one zero row without targets. */
export function packMorphTargets(g: SkinGeometry): Float32Array {
  const n = vertexCount(g);
  const targets = g.morphTargets;
  const out = new Float32Array(Math.max(1, targets.length * n * 2) * 4);
  targets.forEach((t, m) => {
    for (let v = 0; v < n; v++) {
      const o = (m * n + v) * 8;
      for (let k = 0; k < 3; k++) {
        if (t.positions) out[o + k] = t.positions[v * 3 + k];
        if (t.normals) out[o + 4 + k] = t.normals[v * 3 + k];
      }
    }
  });
  return out;
}

/**
 * The `params` table: the vertex and target counts, the skeleton's first joint in the `bones` table
 * (`base`), then `weights` (missing weights are zero). Reuses `out` when it fits.
 */
export function packSkinParams(vertices: number, targets: number, weights: ArrayLike<number>, out?: Float32Array, base = 0): Float32Array {
  const floats = (1 + Math.ceil(targets / 4)) * 4;
  const p = out && out.length === floats ? out : new Float32Array(floats);
  p[0] = vertices;
  p[1] = targets;
  p[2] = base;
  p[3] = 0;
  for (let t = 0; t < targets; t++) p[4 + t] = t < weights.length ? Number(weights[t]) || 0 : 0;
  return p;
}

/** A palette of `joints` identity matrices (the bind pose: model × inverse bind is the identity there). */
export function identityPalette(joints: number): Float32Array {
  const out = new Float32Array(Math.max(1, joints) * PALETTE_FLOATS);
  for (let j = 0; j < Math.max(1, joints); j++) {
    out[j * PALETTE_FLOATS] = 1;
    out[j * PALETTE_FLOATS + 5] = 1;
    out[j * PALETTE_FLOATS + 10] = 1;
  }
  return out;
}

/**
 * The palette to upload: `matrices` (12 floats a joint) when it covers `joints` entries, else a copy
 * padded with identities (a skeleton with fewer bones than a mesh names; no pose yet: all identities).
 */
export function paletteFor(matrices: Float32Array | null, joints: number): Float32Array {
  const need = Math.max(1, joints) * PALETTE_FLOATS;
  if (matrices && matrices.length >= need) return matrices;
  const out = identityPalette(Math.max(1, joints));
  if (matrices) out.set(matrices.subarray(0, Math.min(matrices.length, need)));
  return out;
}
