import sharp from "sharp";

// Assets for the animation specs (ADR 0370–0373), built here from numbers (CC0: written for this project).
//
// - `bendGltf()`: a skinned column, 2 m tall, on two bones (Root at the origin, Upper 1 m above it), and one clip,
//   "Bend", that turns Upper 90° about z and back over 2 s. The column's lower half follows Root, its middle ring both,
//   its upper half Upper, so a pose shows as the column bending sideways in a camera looking along +z.
// - `sheetPng()`: a 4-frame sprite sheet (32 × 32 px frames, a different colour each) and `SHEET_META`, its sidecar with
//   four slices and a flipbook.
// - Scene helpers: nodes with a Transform, a camera and lights, so a scene reads as a list of what it shows.

type Typed = Float32Array | Uint16Array | Uint8Array;
const TYPES: Record<number, string> = { 1: "SCALAR", 3: "VEC3", 4: "VEC4", 16: "MAT4" };

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

/** The column's rings (y) and each ring's weights on [Root, Upper]. */
const RINGS: [number, number, number][] = [
  [0, 1, 0],
  [0.5, 1, 0],
  [1, 0.5, 0.5],
  [1.5, 0, 1],
  [2, 0, 1],
];
const HALF = 0.3;

/** The skinned column as `.gltf` JSON with an embedded buffer (see the file's header). */
export function bendGltf(): string {
  const b = new Buffers();
  const pos: number[] = [];
  const nrm: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  const idx: number[] = [];
  // Four sides, each a strip of quads up the rings, with its own normal.
  const sides: { corner: (s: number) => [number, number]; normal: [number, number, number] }[] = [
    { corner: (s) => [s ? HALF : -HALF, -HALF], normal: [0, 0, -1] },
    { corner: (s) => [HALF, s ? HALF : -HALF], normal: [1, 0, 0] },
    { corner: (s) => [s ? -HALF : HALF, HALF], normal: [0, 0, 1] },
    { corner: (s) => [-HALF, s ? -HALF : HALF], normal: [-1, 0, 0] },
  ];
  for (const side of sides) {
    const base = pos.length / 3;
    for (const [y, w0, w1] of RINGS) {
      for (const s of [0, 1]) {
        const [x, z] = side.corner(s);
        pos.push(x, y, z);
        nrm.push(...side.normal);
        joints.push(0, 1, 0, 0);
        weights.push(w0, w1, 0, 0);
      }
    }
    for (let r = 0; r + 1 < RINGS.length; r++) {
      const a = base + r * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
  const positions = b.add(new Float32Array(pos), 3, { min: [-HALF, 0, -HALF], max: [HALF, 2, HALF] });
  const normals = b.add(new Float32Array(nrm), 3);
  const joints0 = b.add(new Uint8Array(joints), 4);
  const weights0 = b.add(new Float32Array(weights), 4);
  const indices = b.add(new Uint16Array(idx), 1);
  // Inverse binds: Root at the origin, Upper 1 m up (column-major 4×4).
  const ibms = b.add(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1]), 16);
  const times = b.add(new Float32Array([0, 1, 2]), 1, { min: [0], max: [2] });
  const q = Math.SQRT1_2;
  const bend = b.add(new Float32Array([0, 0, 0, 1, 0, 0, q, q, 0, 0, 0, 1]), 4);
  const bytes = b.bytes();
  return JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: "Armature", children: [1, 3] },
      { name: "Root", children: [2] },
      { name: "Upper", translation: [0, 1, 0] },
      { name: "Body", mesh: 0, skin: 0 },
    ],
    skins: [{ joints: [1, 2], inverseBindMatrices: ibms }],
    meshes: [{ name: "Body", primitives: [{ attributes: { POSITION: positions, NORMAL: normals, JOINTS_0: joints0, WEIGHTS_0: weights0 }, indices, material: 0 }] }],
    materials: [{ name: "Paint", pbrMetallicRoughness: { baseColorFactor: [1, 0.35, 0.1, 1], metallicFactor: 0, roughnessFactor: 0.6 } }],
    animations: [{ name: "Bend", channels: [{ sampler: 0, target: { node: 2, path: "rotation" } }], samplers: [{ input: times, output: bend }] }],
    accessors: b.accessors,
    bufferViews: b.views,
    buffers: [{ uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`, byteLength: bytes.length }],
  });
}

/** The model's sidecar: its one take as the looping clip "Bend". */
export const BEND_META = JSON.stringify({ format: "myco.import@1", animation: { clips: { Bend: [{ name: "Bend", from: 0, to: 2, loop: true }] } } });

/** The sheet's frame colours, left to right. */
const FRAMES: [number, number, number][] = [
  [230, 40, 40],
  [40, 200, 60],
  [40, 80, 230],
  [240, 220, 40],
];

/** The 4-frame sprite sheet (128 × 32 px) as PNG bytes. */
export async function sheetPng(): Promise<Uint8Array> {
  const w = 32 * FRAMES.length;
  const data = Buffer.alloc(w * 32 * 4);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, bl] = FRAMES[Math.floor(x / 32)]!;
      data.set([r, g, bl, 255], (y * w + x) * 4);
    }
  }
  return new Uint8Array(await sharp(data, { raw: { width: w, height: 32, channels: 4 } }).png().toBuffer());
}

/** The sheet's slices `f0`…`f3`. */
export const SHEET_SLICES = FRAMES.map((_, i) => ({ name: `f${i}`, rect: [i * 32, 0, 32, 32], pivot: [0.5, 0.5] }));

/** The sheet's sidecar: four slices, and the flipbook `cycle` over them at 4 frames a second, looping. */
export const SHEET_META = JSON.stringify({ format: "myco.import@1", pixelsPerUnit: 16, sprites: SHEET_SLICES, flipbooks: { cycle: { slices: SHEET_SLICES.map((s) => s.name), fps: 4, loop: true } } });

// --- Scenes ---------------------------------------------------------------------------------------------------------

type Component = { type: string; data?: Record<string, unknown> };
export type SceneNode = { id: string; name: string; parent?: string; components: Component[] };

/** A node with a Transform at `position` and `components`. */
export const node = (id: string, name: string, position: number[], components: Component[] = [], extra: { parent?: string; rotation?: number[]; scale?: number[] } = {}): SceneNode => ({
  id,
  name,
  ...(extra.parent ? { parent: extra.parent } : {}),
  components: [{ type: "engine.Transform", data: { position, ...(extra.rotation ? { rotation: extra.rotation } : {}), ...(extra.scale ? { scale: extra.scale } : {}) } }, ...components],
});

/** A perspective camera at (0, 1, -6) looking along +z, a sun and an ambient light. */
export const stage = (): SceneNode[] => [
  node("camera", "Camera", [0, 1, -6], [{ type: "engine.Camera", data: { projection: "perspective", fieldOfView: 50 } }]),
  node("sun", "Sun", [0, 6, -4], [{ type: "engine.Light", data: { type: "directional", intensity: 1.4 } }], { rotation: [0.3826834, 0, 0, 0.9238795] }),
  node("ambient", "Ambient", [0, 0, 0], [{ type: "engine.Light", data: { type: "ambient", intensity: 0.5 } }]),
];

/** A scene file of `nodes` (3D). */
export const scene = (nodes: SceneNode[]): string => JSON.stringify({ format: "myco.scene@5", settings: { physics: "3d" }, nodes });

/** The skinned column with its Skeleton and an Animator playing "Bend" on start, at `position`. */
export const bender = (position: number[] = [0, 0, 0]): SceneNode[] => [
  node("bender", "Bender", position, [
    { type: "engine.Skeleton", data: { skeleton: "asset:models/bend.gltf#Skeleton" } },
    { type: "engine.Animator", data: { defaultClip: "asset:models/bend.gltf#Anim/Bend" } },
  ]),
  node("bender-body", "Body", [0, 0, 0], [{ type: "engine.SkinnedMeshRenderer", data: { mesh: "asset:models/bend.gltf" } }], { parent: "bender" }),
];

/** The files the skinned column needs. */
export const benderFiles = (): Record<string, string | Uint8Array> => ({ "models/bend.gltf": new TextEncoder().encode(bendGltf()), "models/bend.gltf.meta.json": BEND_META });
