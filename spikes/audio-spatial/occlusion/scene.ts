// Throwaway spike code: a level-like static scene in a headless engine World, plus helpers.
import { Assets, BoxCollider, Engine, GameObject, Physics, SceneManager } from "../../../src/myco";
import { _startWorldService } from "../../../src/engine/core/worldServices";
import { PHYSICS_3D } from "../../../src/plugins/physics/runtime/systems3d";

export const LAYERS = ["Default", "Occluder"];
export const OCCLUDER = ["Occluder"];

/** Material table: per-hit attenuation (dB) and low-pass cutoff (Hz). Index = material id. */
export const MATERIALS = [
  { name: "drywall", db: 6, lpHz: 4000 },
  { name: "brick", db: 14, lpHz: 1800 },
  { name: "concrete", db: 26, lpHz: 700 },
  { name: "glass", db: 4, lpHz: 6000 },
  { name: "crate", db: 8, lpHz: 3000 },
];

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Box { cx: number; cy: number; cz: number; hx: number; hy: number; hz: number; layer: "Default" | "Occluder"; mat: number }
export interface Level {
  engine: Engine;
  boxes: Box[];
  /** Engine collider component -> material id (what a hit's `collider` maps through). */
  materialOf: Map<object, number>;
  colliders: object[];
  extent: number;
}

/** A 20x20 grid of 10 m cells (200 m square): partial walls along cell edges (Occluder), crates (Default), a floor. */
export async function buildLevel(seed = 1, wallProb = 0.28, props = 120): Promise<Level> {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", settings: { physics: "3d" }, nodes: [] } }));
  const engine = await Engine.create({ headless: true, project: { physics: { gravity: [0, -9.81, 0] as [number, number, number], layers: LAYERS } } });
  await SceneManager.load("s.json");
  await _startWorldService(engine.world, PHYSICS_3D);
  const r = rng(seed);
  const boxes: Box[] = [];
  const cells = 20, cell = 10, half = (cells * cell) / 2;
  const THICK = [0.2, 0.3, 0.5, 1.0];
  const MAT_FOR_THICK = [0, 3, 1, 2];
  for (let i = 0; i <= cells; i++) {
    for (let j = 0; j < cells; j++) {
      for (const horiz of [true, false]) {
        if (i === 0 || i === cells) continue; // no boundary walls
        if (r() > wallProb) continue;
        const len = 4 + r() * 6, off = (r() - 0.5) * (cell - len);
        const k = Math.floor(r() * 4), th = THICK[k], h = 3 + r() * 3;
        const along = -half + j * cell + cell / 2 + off, across = -half + i * cell;
        boxes.push(horiz
          ? { cx: along, cy: h / 2, cz: across, hx: len / 2, hy: h / 2, hz: th / 2, layer: "Occluder", mat: MAT_FOR_THICK[k] }
          : { cx: across, cy: h / 2, cz: along, hx: th / 2, hy: h / 2, hz: len / 2, layer: "Occluder", mat: MAT_FOR_THICK[k] });
      }
    }
  }
  for (let p = 0; p < props; p++) {
    const sx = 0.5 + r() * 2.5, sy = 0.5 + r() * 2.5, sz = 0.5 + r() * 2.5;
    boxes.push({ cx: (r() - 0.5) * 190, cy: sy / 2, cz: (r() - 0.5) * 190, hx: sx / 2, hy: sy / 2, hz: sz / 2, layer: "Default", mat: 4 });
  }
  const materialOf = new Map<object, number>();
  const colliders: object[] = [];
  const make = (name: string, b: Box) => {
    const go = GameObject.create(name);
    go.transform!.position.set(b.cx, b.cy, b.cz);
    const c = go.addBehavior(BoxCollider);
    c.size.set(b.hx * 2, b.hy * 2, b.hz * 2);
    c.layer = b.layer;
    materialOf.set(c, b.mat);
    colliders.push(c);
  };
  boxes.forEach((b, i) => make(`${b.layer}${i}`, b));
  // Floor (Default layer, top at y = 0); rays stay above it so it never matters, but it is a collider like any level has.
  make("floor", { cx: 0, cy: -0.5, cz: 0, hx: 110, hy: 0.5, hz: 110, layer: "Default", mat: 4 });
  for (let i = 0; i < 3; i++) engine.step(1 / 60);
  return { engine, boxes, materialOf, colliders, extent: half };
}

/** True when (x, z) at height y lies inside any box (plus margin). */
export function insideAny(boxes: Box[], x: number, y: number, z: number, margin = 0.4): boolean {
  for (const b of boxes) if (Math.abs(x - b.cx) < b.hx + margin && Math.abs(y - b.cy) < b.hy + margin && Math.abs(z - b.cz) < b.hz + margin) return true;
  return false;
}

/** Analytic first-hit test against the axis-aligned boxes (optionally Occluder-layer only). Returns the entry distance, or -1. */
export function analyticHit(boxes: Box[], ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, occluderOnly: boolean): number {
  let best = -1;
  for (const b of boxes) {
    if (occluderOnly && b.layer !== "Occluder") continue;
    let t0 = 0, t1 = maxDist;
    const o = [ox, oy, oz], d = [dx, dy, dz], lo = [b.cx - b.hx, b.cy - b.hy, b.cz - b.hz], hi = [b.cx + b.hx, b.cy + b.hy, b.cz + b.hz];
    let miss = false;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-12) { if (o[a] < lo[a] || o[a] > hi[a]) { miss = true; break; } continue; }
      let ta = (lo[a] - o[a]) / d[a], tb = (hi[a] - o[a]) / d[a];
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) { miss = true; break; }
    }
    if (!miss && (best < 0 || t0 < best)) best = t0;
  }
  return best;
}

export interface Pt { x: number; y: number; z: number }

/** Sound sources: uniform in a disc of `radius` around the origin, at ear-ish heights, never inside geometry. */
export function placeSources(level: Level, count: number, seed: number, radius = 80): { pos: Float64Array; loud: Float64Array } {
  const r = rng(seed), pos = new Float64Array(count * 3), loud = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    for (;;) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * radius, y = 0.8 + r() * 2;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (insideAny(level.boxes, x, y, z)) continue;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      break;
    }
    loud[i] = 0.3 + r() * 0.7;
  }
  return { pos, loud };
}

export function freeListener(level: Level, seed: number): Pt {
  const r = rng(seed);
  for (;;) {
    const x = (r() - 0.5) * 40, z = (r() - 0.5) * 40;
    if (!insideAny(level.boxes, x, 1.5, z)) return { x, y: 1.5, z };
  }
}

export { Physics };
