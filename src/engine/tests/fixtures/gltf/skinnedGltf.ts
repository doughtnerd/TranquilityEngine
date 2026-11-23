// Animated glTF fixtures for the T14 import tests (ADR 0371), built here from numbers (CC0: written for this project,
// no third-party data). One rig, a chain of six joints listed in the skin out of parents-first order:
//
//   Armature ─┬─ Hips ── Spine ── Chest ── Neck ── Head ── Jaw     (joints; skin order: Head, Hips, Spine, Jaw, Chest, Neck)
//             ├─ Body   (skinned quad, 2 morph targets "Smile" / "Blink" with normal and tangent deltas, material Skin)
//             ├─ Prop   (a triangle, material Sticker with an animated texture transform; KHR_node_visibility hidden)
//             └─ Lamp   (a KHR_lights_punctual spot light)
//
// Animations: "Walk" (LINEAR: Hips translation, Spine rotation, morph weights), "Wave" (STEP Head rotation and pointer
// channels: base colour, texture offset, light intensity and outer cone, Lamp visibility, two unmapped pointers) and
// "Bounce" (CUBICSPLINE Hips translation and morph weights).

type Typed = Float32Array | Uint16Array | Uint8Array;

const TYPES: Record<number, string> = { 1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4", 16: "MAT4" };

/** A glTF buffer and its accessors, built by appending typed arrays. */
class Buffers {
  readonly accessors: Record<string, unknown>[] = [];
  readonly views: Record<string, unknown>[] = [];
  private chunks: Uint8Array[] = [];
  private length = 0;

  add(data: Typed, size: number, extra: Record<string, unknown> = {}): number {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.views.push({ buffer: 0, byteOffset: this.length, byteLength: bytes.length });
    this.chunks.push(bytes);
    this.length += bytes.length;
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.chunks.push(new Uint8Array(pad));
      this.length += pad;
    }
    const componentType = data instanceof Float32Array ? 5126 : data instanceof Uint16Array ? 5123 : 5121;
    this.accessors.push({ bufferView: this.views.length - 1, componentType, count: data.length / size, type: TYPES[size], ...extra });
    return this.accessors.length - 1;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

/** Joint names in skin order, and their parents and translations (each joint 0.5 above its parent; Hips at y = 1). */
export const SKIN_ORDER = ["Head", "Hips", "Spine", "Jaw", "Chest", "Neck"] as const;
const CHAIN = ["Hips", "Spine", "Chest", "Neck", "Head", "Jaw"];
/** World y of each joint. */
export const JOINT_Y: Record<string, number> = { Hips: 1, Spine: 1.5, Chest: 2, Neck: 2.5, Head: 3, Jaw: 3.5 };

export interface SkinnedGltfOptions {
  /** Give vertex 0 six influences through JOINTS_1 / WEIGHTS_1. */
  readonly eight?: boolean;
}

/** The fixture as `.gltf` JSON with an embedded buffer. */
export function skinnedGltf(options: SkinnedGltfOptions = {}): string {
  const b = new Buffers();
  const skinIndex = (name: string) => SKIN_ORDER.indexOf(name as (typeof SKIN_ORDER)[number]);
  // Body: a quad of 4 vertices at x 1 (so the handedness mirror shows), y 1 … 3.
  const positions = b.add(new Float32Array([1, 1, 0, 2, 1, 0, 2, 3, 0, 1, 3, 0]), 3, { min: [1, 1, 0], max: [2, 3, 0] });
  const normals = b.add(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3);
  const tangents = b.add(new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]), 4);
  const indices = b.add(new Uint16Array([0, 1, 2, 0, 2, 3]), 1);
  // Vertex 0: Hips 2, Spine 1, Chest 1 (unnormalised: 0.5, 0.25, 0.25); others fully on one joint.
  const h = skinIndex("Hips"), s = skinIndex("Spine"), c = skinIndex("Chest"), n = skinIndex("Neck"), hd = skinIndex("Head"), j = skinIndex("Jaw");
  const joints0 = b.add(new Uint8Array([h, s, c, n, h, 0, 0, 0, hd, 0, 0, 0, j, 0, 0, 0]), 4);
  const weights0 = b.add(new Float32Array(options.eight ? [0.3, 0.2, 0.15, 0.1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] : [2, 1, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4);
  const extra: Record<string, number> = {};
  if (options.eight) {
    extra.JOINTS_1 = b.add(new Uint8Array([hd, j, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 4);
    extra.WEIGHTS_1 = b.add(new Float32Array([0.15, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 4);
  }
  // Morph targets: Smile moves vertex 2 up by 0.5; Blink moves vertex 3 in z by 1 (normals and tangents tilt).
  const smile = b.add(new Float32Array([0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0]), 3);
  const blink = b.add(new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), 3);
  const smileN = b.add(new Float32Array([0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0]), 3);
  const blinkN = b.add(new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0]), 3);
  const smileT = b.add(new Float32Array([0, 0, 0, 0, 0, 0, 0, 0.25, 0, 0, 0, 0]), 3);
  const blinkT = b.add(new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.25]), 3);
  // Prop: one triangle with UVs.
  const propPos = b.add(new Float32Array([0, 0, 1, 1, 0, 1, 0, 1, 1]), 3, { min: [0, 0, 1], max: [1, 1, 1] });
  const propUv = b.add(new Float32Array([0, 0, 1, 0, 0, 1]), 2);
  // Inverse binds: each joint's world translation negated, in skin order (column-major 4×4).
  const ibm = new Float32Array(SKIN_ORDER.flatMap((name) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -JOINT_Y[name], 0, 1]));
  const ibms = b.add(ibm, 16);
  // Animations.
  const t01 = b.add(new Float32Array([0, 1]), 1, { min: [0], max: [1] });
  const hipsWalk = b.add(new Float32Array([0, 1, 0, 1, 1, 0]), 3); // x 0 → 1
  const q90 = Math.SQRT1_2;
  const spineWalk = b.add(new Float32Array([0, 0, 0, 1, 0, q90, 0, q90]), 4); // 0 → 90° about y
  const walkWeights = b.add(new Float32Array([0, 0, 1, 0.5]), 1);
  const t3 = b.add(new Float32Array([0, 0.5, 2]), 1, { min: [0], max: [2] });
  const headStep = b.add(new Float32Array([0, 0, 0, 1, q90, 0, 0, q90, 0, 0, 0, 1]), 4);
  const colour = b.add(new Float32Array([1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1]), 4);
  const offset = b.add(new Float32Array([0, 0, 0.5, 0, 1, 0]), 2);
  const intensity = b.add(new Float32Array([1, 4, 2]), 1);
  const outer = b.add(new Float32Array([0.5, 0.25, 0.5]), 1);
  const visible = b.add(new Float32Array([1, 0, 1]), 1);
  const scalar3 = b.add(new Float32Array([0, 1, 2]), 1);
  // CUBICSPLINE: per key [in, value, out]. Hips x from 0 to 1 with out-tangent 3 at key 0 and in-tangent 0 at key 1.
  const hipsCubic = b.add(new Float32Array([0, 0, 0, 0, 1, 0, 3, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0]), 3);
  // Weights: 2 targets per element; key 0 [in(2), value(2), out(2)], key 1 likewise.
  const weightsCubic = b.add(new Float32Array([0, 0, 0, 0, 2, 0, 0, 0, 1, 1, 0, 0]), 1);

  const prim = { attributes: { POSITION: positions, NORMAL: normals, TANGENT: tangents, JOINTS_0: joints0, WEIGHTS_0: weights0, ...extra }, indices, material: 0, targets: [
    { POSITION: smile, NORMAL: smileN, TANGENT: smileT },
    { POSITION: blink, NORMAL: blinkN, TANGENT: blinkT },
  ] };
  const nodeOf = (name: string) => ({ Armature: 0, Body: 7, Prop: 8, Lamp: 9 } as Record<string, number>)[name] ?? 1 + CHAIN.indexOf(name);
  const pointer = (p: string) => ({ path: "pointer", extensions: { KHR_animation_pointer: { pointer: p } } });
  const json = {
    asset: { version: "2.0" },
    extensionsUsed: ["KHR_lights_punctual", "KHR_animation_pointer", "KHR_node_visibility", "KHR_texture_transform"],
    extensions: { KHR_lights_punctual: { lights: [{ type: "spot", color: [1, 1, 1], intensity: 1, spot: { innerConeAngle: 0.25, outerConeAngle: 0.5 } }] } },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: "Armature", children: [1, 7, 8, 9] },
      ...CHAIN.map((name, i) => ({ name, translation: [0, i === 0 ? 1 : 0.5, 0], ...(i + 1 < CHAIN.length ? { children: [2 + i] } : {}) })),
      { name: "Body", mesh: 0, skin: 0 },
      { name: "Prop", mesh: 1, extensions: { KHR_node_visibility: { visible: false } } },
      { name: "Lamp", translation: [0, 4, 0], extensions: { KHR_lights_punctual: { light: 0 } } },
    ],
    skins: [{ joints: SKIN_ORDER.map(nodeOf), inverseBindMatrices: ibms }],
    meshes: [
      { name: "BodyMesh", extras: { targetNames: ["Smile", "Blink"] }, weights: [0, 0], primitives: [prim] },
      { name: "PropMesh", primitives: [{ attributes: { POSITION: propPos, TEXCOORD_0: propUv }, material: 1 }] },
    ],
    materials: [
      { name: "Skin", pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } },
      { name: "Sticker", pbrMetallicRoughness: { baseColorTexture: { index: 0, extensions: { KHR_texture_transform: { offset: [0.25, 0], scale: [2, 2] } } } } },
    ],
    textures: [{ source: 0 }],
    images: [{ uri: `data:image/png;base64,${PNG}` }],
    animations: [
      {
        name: "Walk",
        channels: [
          { sampler: 0, target: { node: nodeOf("Hips"), path: "translation" } },
          { sampler: 1, target: { node: nodeOf("Spine"), path: "rotation" } },
          { sampler: 2, target: { node: nodeOf("Body"), path: "weights" } },
        ],
        samplers: [
          { input: t01, output: hipsWalk },
          { input: t01, output: spineWalk },
          { input: t01, output: walkWeights },
        ],
      },
      {
        name: "Wave",
        channels: [
          { sampler: 0, target: { node: nodeOf("Head"), path: "rotation" } },
          { sampler: 1, target: pointer("/materials/0/pbrMetallicRoughness/baseColorFactor") },
          { sampler: 2, target: pointer("/materials/1/pbrMetallicRoughness/baseColorTexture/extensions/KHR_texture_transform/offset") },
          { sampler: 3, target: pointer("/extensions/KHR_lights_punctual/lights/0/intensity") },
          { sampler: 4, target: pointer("/extensions/KHR_lights_punctual/lights/0/spot/outerConeAngle") },
          { sampler: 5, target: pointer(`/nodes/${nodeOf("Lamp")}/extensions/KHR_node_visibility/visible`) },
          { sampler: 6, target: pointer("/materials/0/extensions/KHR_materials_unknown/factor") },
          { sampler: 6, target: pointer("/asset/version") },
        ],
        samplers: [
          { input: t3, output: headStep, interpolation: "STEP" },
          { input: t3, output: colour },
          { input: t3, output: offset },
          { input: t3, output: intensity },
          { input: t3, output: outer },
          { input: t3, output: visible, interpolation: "STEP" },
          { input: t3, output: scalar3 },
        ],
      },
      {
        name: "Bounce",
        channels: [
          { sampler: 0, target: { node: nodeOf("Hips"), path: "translation" } },
          { sampler: 1, target: { node: nodeOf("Body"), path: "weights" } },
        ],
        samplers: [
          { input: t01, output: hipsCubic, interpolation: "CUBICSPLINE" },
          { input: t01, output: weightsCubic, interpolation: "CUBICSPLINE" },
        ],
      },
    ],
    accessors: b.accessors,
    bufferViews: b.views,
    buffers: [{ uri: `data:application/octet-stream;base64,${Buffer.from(b.bytes()).toString("base64")}`, byteLength: b.bytes().length }],
  };
  return JSON.stringify(json);
}
