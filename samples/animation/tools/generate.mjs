#!/usr/bin/env node
// Generates the Animation sample's data (ADR 0370–0373): the skinned "Sprout" model, the critter sprite sheet, the
// clips, the animation graph, the timeline, the materials and both scenes. Plain Node, no dependencies; everything is
// built from numbers (CC0: written for this project), so running it again rewrites the same files.
//
//   node samples/animation/tools/generate.mjs
//
// The scripts in scripts/ and the HUD in ui/ are written by hand; this writes only data. Coordinates are today's
// (myco.scene@5: Unity's left-handed, +z forward); the glTF model is right-handed as the format says, and its loader
// converts it.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function write(path, content) {
  const file = join(ROOT, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : content);
}
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const r4 = (x) => Math.round(x * 10000) / 10000;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------------------------- the Sprout model

// A potted sprout: a square stalk on four bones (Root, Stem1, Stem2, Stem3), a head on a fifth (Head), and two eyes on
// the head's glTF -z face, which the loader's z mirror turns towards the scene's camera (at z = -7.6, looking along +z).
const BONES = ["Root", "Stem1", "Stem2", "Stem3", "Head"];
const SEG = 0.45; // bone k sits at y = k * SEG
const HEAD_TOP = 2.4;

class Buffers {
  accessors = [];
  views = [];
  chunks = [];
  length = 0;
  add(data, type, extra = {}) {
    const size = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.views.push({ buffer: 0, byteOffset: this.length, byteLength: bytes.length });
    this.chunks.push(bytes);
    this.length += bytes.length;
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) (this.chunks.push(new Uint8Array(pad)), (this.length += pad));
    const componentType = data instanceof Float32Array ? 5126 : data instanceof Uint16Array ? 5123 : 5121;
    this.accessors.push({ bufferView: this.views.length - 1, componentType, count: data.length / size, type, ...extra });
    return this.accessors.length - 1;
  }
  bytes() {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const c of this.chunks) (out.set(c, at), (at += c.length));
    return out;
  }
}

/** A primitive being built: positions, normals, joints, weights, indices. */
class Mesh {
  pos = [];
  nrm = [];
  joints = [];
  weights = [];
  idx = [];
  vertex(p, n, j, w) {
    this.pos.push(...p);
    this.nrm.push(...n);
    this.joints.push(...j);
    this.weights.push(...w);
    return this.pos.length / 3 - 1;
  }
  /** A quad a, b, c, d counter-clockwise seen from its normal (glTF front faces). */
  quad(a, b, c, d) {
    this.idx.push(a, b, c, a, c, d);
  }
  /** A box centred on `c` with half sizes `h`, every vertex on bone `bone`. */
  box(c, h, bone) {
    // Each face: normal n and in-plane axes u, v with u × v = n, so the corners -u-v, +u-v, +u+v, -u+v run counter-clockwise.
    const faces = [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
      [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
      [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
      [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
    ];
    for (const [n, u, v] of faces) {
      const corner = (su, sv) => [0, 1, 2].map((k) => c[k] + n[k] * h[k] + su * u[k] * h[k] + sv * v[k] * h[k]);
      const vs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => this.vertex(corner(su, sv), n, [bone, 0, 0, 0], [1, 0, 0, 0]));
      this.quad(...vs);
    }
  }
  bounds() {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.pos.length; i += 3) for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], this.pos[i + k])), (max[k] = Math.max(max[k], this.pos[i + k]));
    return { min: min.map(r4), max: max.map(r4) };
  }
}

function sproutGltf() {
  // The stalk: rings every half segment. A ring on a joint is shared half and half by the bones either side of it; a
  // ring between joints belongs to the bone below. It tapers from 0.2 to 0.13 half-width.
  const stalk = new Mesh();
  const rings = [];
  for (let k = 0; k <= 8; k++) {
    const y = (k * SEG) / 2;
    const half = 0.2 - 0.07 * (y / (4 * SEG));
    const j = k / 2;
    const [joints, weights] = k === 0 ? [[0, 0, 0, 0], [1, 0, 0, 0]] : k % 2 === 0 ? [[j - 1, j, 0, 0], [0.5, 0.5, 0, 0]] : [[(k - 1) / 2, 0, 0, 0], [1, 0, 0, 0]];
    rings.push({ y, half, joints, weights });
  }
  // Four sides: normal n and the in-plane axis u with u × +y = n.
  const sides = [
    [[0, 0, -1], [-1, 0, 0]],
    [[1, 0, 0], [0, 0, -1]],
    [[0, 0, 1], [1, 0, 0]],
    [[-1, 0, 0], [0, 0, 1]],
  ];
  for (const [n, u] of sides) {
    const row = rings.map((r) => {
      const at = (s) => [s * u[0] * r.half + n[0] * r.half, r.y, s * u[2] * r.half + n[2] * r.half];
      return [stalk.vertex(at(-1), n, r.joints, r.weights), stalk.vertex(at(1), n, r.joints, r.weights)];
    });
    for (let k = 0; k + 1 < row.length; k++) stalk.quad(row[k][0], row[k][1], row[k + 1][1], row[k + 1][0]);
  }
  const head = new Mesh();
  head.box([0, (4 * SEG + HEAD_TOP) / 2, 0], [0.38, (HEAD_TOP - 4 * SEG) / 2, 0.3], 4);
  const eyes = new Mesh();
  for (const x of [-0.14, 0.14]) eyes.box([x, 2.15, -0.315], [0.06, 0.09, 0.02], 4);

  const b = new Buffers();
  const primitive = (m, material) => ({
    attributes: {
      POSITION: b.add(new Float32Array(m.pos), "VEC3", m.bounds()),
      NORMAL: b.add(new Float32Array(m.nrm), "VEC3"),
      JOINTS_0: b.add(new Uint8Array(m.joints), "VEC4"),
      WEIGHTS_0: b.add(new Float32Array(m.weights), "VEC4"),
    },
    indices: b.add(new Uint16Array(m.idx), "SCALAR"),
    material,
  });
  const primitives = [primitive(stalk, 0), primitive(head, 1), primitive(eyes, 2)];
  // Inverse bind matrices: bone k is k segments up (column-major 4×4).
  const ibm = [];
  for (let k = 0; k < BONES.length; k++) ibm.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, r4(-k * SEG), 0, 1);
  const ibms = b.add(new Float32Array(ibm), "MAT4");
  const bytes = b.bytes();
  // Nodes: 0 Sprout (the armature), 1..5 the bones, 6 the body.
  const nodes = [{ name: "Armature", children: [1, 6] }];
  BONES.forEach((name, k) => nodes.push({ name, ...(k ? { translation: [0, SEG, 0] } : {}), ...(k + 1 < BONES.length ? { children: [k + 2] } : {}) }));
  nodes.push({ name: "Body", mesh: 0, skin: 0 });
  return JSON.stringify({
    asset: { version: "2.0", generator: "samples/animation/tools/generate.mjs" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    skins: [{ joints: [1, 2, 3, 4, 5], inverseBindMatrices: ibms, skeleton: 1 }],
    meshes: [{ name: "Body", primitives }],
    materials: [
      { name: "Stalk", pbrMetallicRoughness: { baseColorFactor: [0.32, 0.68, 0.25, 1], metallicFactor: 0, roughnessFactor: 0.7 } },
      { name: "Bloom", pbrMetallicRoughness: { baseColorFactor: [1, 0.55, 0.62, 1], metallicFactor: 0, roughnessFactor: 0.5 } },
      { name: "Eyes", pbrMetallicRoughness: { baseColorFactor: [0.05, 0.05, 0.08, 1], metallicFactor: 0, roughnessFactor: 0.2 } },
    ],
    accessors: b.accessors,
    bufferViews: b.views,
    buffers: [{ uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`, byteLength: bytes.length }],
  });
}

// ---------------------------------------------------------------------------------------------- quaternions

const qAxis = (axis, deg) => {
  const s = Math.sin((deg * DEG) / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos((deg * DEG) / 2)];
};
const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const X = [1, 0, 0];
const Y = [0, 1, 0];
const Z = [0, 0, 1];

/** Keys [t, ...value] sampled every `step` seconds over `duration` (both ends included). */
function sample(duration, step, fn) {
  const keys = [];
  const n = Math.round(duration / step);
  for (let i = 0; i <= n; i++) {
    const t = r4((i * duration) / n);
    keys.push([t, ...fn(t).map(r4)]);
  }
  return keys;
}

// ---------------------------------------------------------------------------------------------- Sprout clips

/** A looping sway: each stem bone swings about z by `amp` degrees, each a little behind the one below (a wave up the stalk). */
function swayClip(name, duration, amp, lag, nod) {
  const w = (2 * Math.PI) / duration;
  const tracks = [1, 2, 3].map((k) => ({ kind: "bone", target: { bone: BONES[k] }, rotation: sample(duration, duration / 16, (t) => qAxis(Z, amp * Math.sin(w * t - (k - 1) * lag))) }));
  tracks.push({ kind: "bone", target: { bone: "Head" }, rotation: sample(duration, duration / 16, (t) => qMul(qAxis(Z, amp * 0.6 * Math.sin(w * t - 3 * lag)), qAxis(X, nod * Math.sin(2 * w * t)))) });
  return { format: "myco.anim-source@1", name, duration, loop: true, tracks };
}

/** A one-shot hop: crouch, jump 0.7 m, land with a squash. The `land` event fires as the feet touch down. */
function hopClip() {
  const T = 0.9;
  const up = 0.18;
  const down = 0.72;
  const height = (t) => (t <= up || t >= down ? 0 : 4 * 0.7 * ((t - up) / (down - up)) * (1 - (t - up) / (down - up)));
  return {
    format: "myco.anim-source@1",
    name: "Hop",
    duration: T,
    tracks: [
      { kind: "bone", target: { bone: "Root" }, translation: sample(T, 0.045, (t) => [0, height(t), 0]), scale: [[0, 1, 1, 1], [up, 1.2, 0.75, 1.2], [0.3, 0.85, 1.2, 0.85], [0.45, 1, 1, 1], [down, 1, 1, 1], [0.78, 1.25, 0.72, 1.25], [T, 1, 1, 1]] },
      // The stalk leans back on the way up and forward on the way down.
      { kind: "bone", target: { bone: "Stem2" }, rotation: [[0, ...qAxis(X, 0)], [up, ...qAxis(X, 10)], [0.45, ...qAxis(X, -8)], [down, ...qAxis(X, 6)], [T, ...qAxis(X, 0)]].map((k) => k.map(r4)) },
      { kind: "event", keys: [{ time: down, method: "land" }] },
    ],
  };
}

const SPROUT_CLIPS = {
  "clips/sprout-idle.anim.json": swayClip("Idle", 2.4, 3, 0.5, 4),
  "clips/sprout-sway.anim.json": swayClip("Sway", 1.2, 10, 0.7, 6),
  "clips/sprout-wiggle.anim.json": swayClip("Wiggle", 0.6, 17, 0.9, 8),
  "clips/sprout-hop.anim.json": hopClip(),
};

// ---------------------------------------------------------------------------------------------- the graph

const clipNode = (id, path, params = {}) => ({ id, family: "sources", kind: "clipPlayer", params: { clip: `asset:${path}`, ...params } });
const HOP_DONE = { operand: "normalizedTime", op: ">=", value: 0.97 };
const GRAPH = {
  format: "myco.animgraph-source@1",
  name: "Sprout",
  skeleton: "asset:models/sprout.gltf#Skeleton",
  output: "machine",
  parameters: [{ name: "speed", type: "float", default: 0 }],
  nodes: [
    clipNode("idle", "clips/sprout-idle.anim.json"),
    clipNode("moveIdle", "clips/sprout-idle.anim.json"),
    clipNode("sway", "clips/sprout-sway.anim.json"),
    clipNode("wiggle", "clips/sprout-wiggle.anim.json"),
    clipNode("hop", "clips/sprout-hop.anim.json", { loop: "once" }),
    { id: "move", family: "sources", kind: "blendSpace1D", name: "Move by speed", inputs: ["moveIdle", "sway", "wiggle"], params: { x: "speed", coords: [0, 1, 2] } },
    {
      id: "machine",
      family: "logic",
      kind: "stateMachine",
      name: "Base",
      machine: {
        entry: "Idle",
        states: [
          {
            name: "Idle",
            root: "idle",
            transitions: [
              { to: "Hop", if: { request: "Hop" }, duration: 0.1 },
              { to: "Move", if: { param: "speed", op: ">", value: 0.15 }, duration: 0.35, shape: "smoothstep" },
            ],
          },
          {
            name: "Move",
            root: "move",
            transitions: [
              { to: "Hop", if: { request: "Hop" }, duration: 0.1 },
              { to: "Idle", if: { param: "speed", op: "<=", value: 0.15 }, duration: 0.5, shape: "smoothstep" },
            ],
          },
          {
            name: "Hop",
            root: "hop",
            transitions: [
              { to: "Move", if: { all: [HOP_DONE, { param: "speed", op: ">", value: 0.15 }] }, duration: 0.15 },
              { to: "Idle", if: HOP_DONE, duration: 0.15 },
            ],
          },
        ],
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------- the lantern clip

// On the Lantern node (no skeleton): the gem bobs and turns, the glow cycles cyan → magenta → gold, and `chime` fires
// at the top of each bob.
const LANTERN_CLIP = {
  format: "myco.anim-source@1",
  name: "Lantern",
  duration: 3,
  loop: true,
  tracks: [
    { kind: "vec3", target: { nodePath: "Gem", component: "engine.Transform", field: "position" }, curves: [[[0, 0]], [[0, 1.4, "smooth"], [1.5, 1.9, "smooth"], [3, 1.4]], [[0, 0]]] },
    { kind: "quat", target: { nodePath: "Gem", component: "engine.Transform", field: "rotation" }, interp: "slerp", keys: sample(3, 0.25, (t) => qMul(qAxis(Y, 120 * t), qMul(qAxis(X, 35), qAxis(Z, 45)))) },
    {
      kind: "color",
      target: { nodePath: "Glow", component: "engine.Light", field: "color" },
      curves: [
        [[0, 0.2, "smooth"], [1, 1, "smooth"], [2, 1, "smooth"], [3, 0.2]],
        [[0, 0.9, "smooth"], [1, 0.25, "smooth"], [2, 0.8, "smooth"], [3, 0.9]],
        [[0, 1, "smooth"], [1, 0.9, "smooth"], [2, 0.2, "smooth"], [3, 1]],
        [[0, 1]],
      ],
    },
    { kind: "event", keys: [{ time: 1.5, method: "chime", args: ["top"] }] },
  ],
};

// ---------------------------------------------------------------------------------------------- the timeline

// On the Orrery's TimelineDirector: Moon A circles the planet once in 4 s, Moon B twice on a tilted orbit the other
// way, the planet breathes, and the Flash light switches on for a moment as each lap begins.
const ORBIT = 1.25;
const TIMELINE = {
  format: "myco.timeline@1",
  name: "Orrery",
  duration: 4,
  loop: true,
  tracks: [
    (() => {
      const keys = sample(4, 0.125, (t) => [ORBIT * Math.cos((2 * Math.PI * t) / 4), 1.5, ORBIT * Math.sin((2 * Math.PI * t) / 4)]);
      return { kind: "vec3", target: { nodePath: "Moon A", component: "engine.Transform", field: "position" }, curves: [0, 1, 2].map((c) => keys.map((k) => [k[0], k[c + 1]])) };
    })(),
    (() => {
      const keys = sample(4, 0.0625, (t) => {
        const a = (-2 * Math.PI * t) / 2;
        return [0.85 * Math.cos(a), 1.5 + 0.5 * Math.sin(a), 0.85 * Math.sin(a)];
      });
      return { kind: "vec3", target: { nodePath: "Moon B", component: "engine.Transform", field: "position" }, curves: [0, 1, 2].map((c) => keys.map((k) => [k[0], k[c + 1]])) };
    })(),
    { kind: "vec3", target: { nodePath: "Planet", component: "engine.Transform", field: "scale" }, curves: [0, 1, 2].map(() => [[0, 0.8, "smooth"], [1, 0.95, "smooth"], [2, 0.8, "smooth"], [3, 0.95, "smooth"], [4, 0.8]]) },
    { kind: "activation", target: { nodePath: "Flash" }, keys: [{ time: 0, end: 0.25 }, { time: 2, end: 2.25 }] },
  ],
};

// ---------------------------------------------------------------------------------------------- the sprite sheet

// 256 × 64 px: row 0 is the critter's walk (8 frames of 32 × 32), row 1 a coin's spin (4 frames) and a ground tile.
const SHEET_W = 256;
const SHEET_H = 64;

function sheetPng() {
  const px = new Uint8Array(SHEET_W * SHEET_H * 4);
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= SHEET_W || y >= SHEET_H) return;
    px.set(c, (y * SHEET_W + x) * 4);
  };
  const hex = (h, a = 255) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];
  /** An ellipse in a cell, filled with `fill` and ringed with `edge` (image y grows downwards). */
  const ellipse = (ox, oy, cx, cy, rx, ry, fill, edge) => {
    for (let y = -Math.ceil(ry) - 1; y <= Math.ceil(ry) + 1; y++)
      for (let x = -Math.ceil(rx) - 1; x <= Math.ceil(rx) + 1; x++) {
        const d = ((x + 0.5) / Math.max(rx, 0.5)) ** 2 + ((y + 0.5) / ry) ** 2;
        const inner = ((x + 0.5) / Math.max(rx - 1, 0.5)) ** 2 + ((y + 0.5) / (ry - 1)) ** 2;
        if (d <= 1) set(ox + cx + x, oy + cy + y, inner <= 1 || !edge ? fill : edge);
      }
  };
  const rect = (x0, y0, w, h, c) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, c);
  };
  const body = hex("#6cc24a");
  const dark = hex("#2f6b22");
  const white = hex("#ffffff");
  const black = hex("#141414");
  for (let f = 0; f < 8; f++) {
    const ox = f * 32;
    const phase = (2 * Math.PI * f) / 8;
    const bob = Math.round(Math.abs(Math.sin(phase)) * 2);
    const swing = Math.round(3 * Math.sin(phase));
    // Legs, then the body over them, then the eye (looking right).
    rect(ox + 11 + swing, 25, 4, 6, dark);
    rect(ox + 17 - swing, 25, 4, 6, dark);
    ellipse(ox, 0, 16, 16 - bob, 11, 9, body, dark);
    rect(ox + 9, 19 - bob, 12, 2, hex("#8fdc6b"));
    ellipse(ox, 0, 21, 13 - bob, 3, 3, white, null);
    rect(ox + 22, 12 - bob, 2, 2, black);
  }
  const gold = hex("#f4c430");
  const goldEdge = hex("#a87a08");
  for (let f = 0; f < 4; f++) {
    const rx = Math.max(1, 9 * Math.abs(Math.cos((Math.PI * f) / 4)));
    ellipse(f * 32, 32, 16, 16, rx, 9, gold, goldEdge);
    if (rx > 3) rect(f * 32 + 15, 32 + 11, 2, 10, hex("#ffe27a"));
  }
  // The ground tile at (128, 32), 16 × 16: grass on soil.
  rect(128, 32, 16, 16, hex("#7a5230"));
  rect(128, 32, 16, 4, hex("#5fae3e"));
  rect(128, 36, 16, 1, hex("#3f7d27"));
  return png(SHEET_W, SHEET_H, px);
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** RGBA pixels as PNG bytes. */
function png(w, h, rgba) {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array(0))]);
}

const WALK = Array.from({ length: 8 }, (_, i) => ({ name: `walk${i}`, rect: [i * 32, 0, 32, 32], pivot: [0.5, 0.5] }));
const SPIN = Array.from({ length: 4 }, (_, i) => ({ name: `coin${i}`, rect: [i * 32, 32, 32, 32], pivot: [0.5, 0.5] }));
const SHEET_META = {
  format: "myco.import@1",
  pixelsPerUnit: 16,
  filter: "point",
  mipmaps: false,
  sprites: [...WALK, ...SPIN, { name: "ground", rect: [128, 32, 16, 16], pivot: [0.5, 0.5] }],
  flipbooks: {
    walk: { slices: WALK.map((s) => s.name), fps: 12, loop: true },
    spin: { slices: [...SPIN.map((s) => s.name), "coin2", "coin1"], fps: 10, loop: true },
  },
};

// ---------------------------------------------------------------------------------------------- scenes

const T = (position, extra = {}) => ({ type: "engine.Transform", data: { position, ...extra } });
const node = (id, name, transform, components = [], parent) => ({ id, name, ...(parent ? { parent } : {}), components: [transform, ...components] });
const mesh = (meshName, material) => ({ type: "engine.MeshRenderer", data: { mesh: `builtin:${meshName}`, ...(material ? { material: `asset:materials/${material}.material.json` } : {}) } });
const ui = (component) => ({ type: "engine.UIView", data: { component: `asset:ui/${component}.svelte` } });

const MATERIALS = {
  floor: { format: "myco.material@1", color: "#3b4252", roughness: 0.95 },
  plinth: { format: "myco.material@1", color: "#d8dee9", roughness: 0.6 },
  pot: { format: "myco.material@1", color: "#c0703a", roughness: 0.8 },
  gem: { format: "myco.material@1", color: "#9be7ff", emission: "#1d5a7a", metalness: 0.2, roughness: 0.15 },
  dust: { format: "myco.material@1", color: "#e5d4b0", roughness: 1 },
  tween: { format: "myco.material@1", color: "#ebcb8b", roughness: 0.5 },
  planet: { format: "myco.material@1", color: "#5e81ac", roughness: 0.6 },
  moon: { format: "myco.material@1", color: "#eceff4", roughness: 0.7 },
};

/** Four stations along x, 3 m apart, each on a plinth, seen from the front (the camera looks along +z). */
const MAIN = {
  format: "myco.scene@5",
  settings: { physics: "3d" },
  nodes: [
    node("camera", "Camera", T([0, 2.4, -7.6], { rotation: qAxis(X, 9).map(r4) }), [{ type: "engine.Camera", data: { projection: "perspective", fieldOfView: 50, backgroundColor: "#1f232b" } }]),
    node("sun", "Sun", T([0, 8, -6], { rotation: qMul(qAxis(Y, 20), qAxis(X, 45)).map(r4) }), [{ type: "engine.Light", data: { type: "directional", intensity: 1.2, castShadows: true } }]),
    node("ambient", "Ambient", T([0, 0, 0]), [{ type: "engine.Light", data: { type: "ambient", intensity: 0.45 } }]),
    node("floor", "Floor", T([0, -0.1, 1], { scale: [16, 0.2, 7] }), [mesh("cube", "floor")]),
    ...[-4.5, -1.5, 1.5, 4.5].map((x, i) => node(`plinth-${i}`, `Plinth ${i + 1}`, T([x, 0.05, 0], { scale: [2.4, 0.1, 2.4] }), [mesh("cube", "plinth")])),

    // 1. Skeletal animation through a graph: the Sprout's Animator runs graphs/sprout.animgraph.json.
    node("sprout", "Sprout", T([-4.5, 0.4, 0]), [
      { type: "engine.Skeleton", data: { skeleton: "asset:models/sprout.gltf#Skeleton" } },
      { type: "engine.Animator", data: { graph: "asset:graphs/sprout.animgraph.json" } },
      { type: "demo.SproutController", data: { dust: { $node: "dust" } } },
    ]),
    node("sprout-body", "Body", T([0, 0, 0]), [{ type: "engine.SkinnedMeshRenderer", data: { mesh: "asset:models/sprout.gltf" } }], "sprout"),
    node("dust", "Dust", T([0, 0.02, 0], { scale: [0, 0, 0] }), [mesh("cylinder", "dust")], "sprout"),
    node("pot", "Pot", T([-4.5, 0.25, 0], { scale: [0.7, 0.2, 0.7] }), [mesh("cylinder", "pot")]),

    // 2. A property clip with notifies, no skeleton: the Lantern's Animator plays clips/lantern.anim.json.
    node("lantern", "Lantern", T([-1.5, 0, 0]), [
      { type: "engine.Animator", data: { defaultClip: "asset:clips/lantern.anim.json" } },
      { type: "demo.GemPulse", data: { gem: { $node: "gem" } } },
    ]),
    node("gem", "Gem", T([0, 1.4, 0], { scale: [0.55, 0.55, 0.55] }), [mesh("cube", "gem")], "lantern"),
    node("glow", "Glow", T([0, 1.2, -0.9]), [{ type: "engine.Light", data: { type: "point", intensity: 14, range: 5, color: [0.2, 0.9, 1, 1] } }], "lantern"),

    // 3. Tweens from script: four cubes, one easing each, in parallel and in sequence.
    node("tweens", "Tweens", T([1.5, 0, 0]), [{ type: "demo.TweenShowcase", data: {} }]),
    ...["outBounce", "inOutBack", "outElastic", "inOutSine"].map((ease, i) =>
      node(`cube-${i}`, `Cube ${ease}`, T([-0.84 + i * 0.56, 0.4, 0], { scale: [0.36, 0.36, 0.36] }), [mesh("cube", "tween")], "tweens"),
    ),

    // 4. A timeline: the Orrery's TimelineDirector plays timelines/orrery.timeline.json on its children.
    node("orrery", "Orrery", T([4.5, 0, 0]), [{ type: "engine.TimelineDirector", data: { timeline: "asset:timelines/orrery.timeline.json", playOnStart: true, wrapMode: "loop" } }]),
    node("planet", "Planet", T([0, 1.5, 0], { scale: [0.8, 0.8, 0.8] }), [mesh("sphere", "planet")], "orrery"),
    node("moon-a", "Moon A", T([ORBIT, 1.5, 0], { scale: [0.25, 0.25, 0.25] }), [mesh("sphere", "moon")], "orrery"),
    node("moon-b", "Moon B", T([0.85, 1.5, 0], { scale: [0.18, 0.18, 0.18] }), [mesh("sphere", "moon")], "orrery"),
    node("flash", "Flash", T([0, 1.5, -1.2]), [{ type: "engine.Light", data: { type: "point", intensity: 20, range: 4, color: [1, 0.85, 0.4, 1] } }], "orrery"),

    node("hud", "HUD", T([0, 0, 0]), [ui("Hud"), { type: "demo.LabHud", data: { sprout: { $node: "sprout" }, lantern: { $node: "lantern" } } }]),
  ],
};

/** The 2D page: a flipbook critter walking to and fro over the ground, and three spinning coins bobbing on tweens. */
const SPRITES = {
  format: "myco.scene@5",
  settings: { physics: "2d" },
  nodes: [
    node("camera", "Camera", T([0, 0, -10]), [{ type: "engine.Camera", data: { projection: "orthographic", orthographicSize: 4, backgroundColor: "#87bfe8" } }]),
    node("ground", "Ground", T([0, -3, 0], { scale: [20, 2, 1] }), [{ type: "engine.SpriteRenderer", data: { sprite: "asset:images/critter.png#ground" } }]),
    node("critter", "Critter", T([-4, -1, 0]), [
      { type: "engine.SpriteRenderer", data: { sprite: "asset:images/critter.png#walk0" } },
      { type: "engine.Animator", data: { defaultClip: "asset:images/critter.png#Flip/walk" } },
      { type: "demo.Walker", data: { from: -4, to: 4 } },
    ]),
    ...[-3, 0, 3].map((x, i) =>
      node(`coin-${i}`, `Coin ${i + 1}`, T([x, 1.2, 0]), [
        { type: "engine.SpriteRenderer", data: { sprite: "asset:images/critter.png#coin0" } },
        { type: "engine.Animator", data: { defaultClip: "asset:images/critter.png#Flip/spin" } },
        { type: "demo.Bob", data: { height: 0.5, period: 1.6, delay: i * 0.3 } },
      ]),
    ),
    node("hud", "HUD", T([0, 0, 0]), [ui("SpritesHud"), { type: "demo.SceneKeys", data: {} }]),
  ],
};

// ---------------------------------------------------------------------------------------------- write

write("project.json", json({
  name: "Animation",
  display: { width: 1280, height: 720, backgroundColor: "#1f232b" },
  time: { fixedDeltaTime: 1 / 60 },
  render: { sortingLayers: ["Default"], pixelsPerUnit: 16 },
}));
write("sample.json", json({
  name: "Animation",
  description: "The animation plugin in four stations and a 2D page: a skinned sprout driven by an animation graph (a state machine, a blend space on a speed parameter and a requested hop with a landing notify), a property clip with events, tweens in sequence and in parallel, a timeline on a director, and sprite flipbooks. Up/Down change the sprout's speed, Space hops, 2 opens the sprites page.",
}));
write("models/sprout.gltf", sproutGltf());
write("models/sprout.gltf.meta.json", json({ format: "myco.import@1" }));
for (const [path, clip] of Object.entries(SPROUT_CLIPS)) write(path, json(clip));
write("graphs/sprout.animgraph.json", json(GRAPH));
write("clips/lantern.anim.json", json(LANTERN_CLIP));
write("timelines/orrery.timeline.json", json(TIMELINE));
write("images/critter.png", sheetPng());
write("images/critter.png.meta.json", json(SHEET_META));
for (const [name, m] of Object.entries(MATERIALS)) write(`materials/${name}.material.json`, json(m));
write("scenes/main.scene.json", json(MAIN));
write("scenes/sprites.scene.json", json(SPRITES));
console.log("Wrote the Animation sample's data.");
