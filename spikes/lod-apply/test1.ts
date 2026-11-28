/**
 * Result 1: per-view selection at 10k instances. A 100 x 100 grid of 2x2 px boxes, 4 level source meshes (one flat colour per level),
 * every renderer has one InstancedMesh per level (40k in all). Two views (side by side in the back buffer) draw different visible sets
 * (60 % each, 30 % in both) at different levels each frame; a pixel check per instance verifies the right level appeared in the right view.
 *   a  per-view FrameGraphObjectList, rebuilt each frame from a Uint8Array of levels
 *   b  scene.customLODSelector (called by the object renderer per mesh per camera)
 *   c  setEnabled / isVisible toggling in each view's onBeforeRender, restored in onAfterRender
 */
import {
  buildGraph2, CreateBox, drawLog, drawsOf, flat, makeEnv, orthoCamera, readCanvas, settle, stats, Viewport,
  type AbstractMesh, type Env, type Mesh, type View2,
} from "./harness2";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh.js";
import type { Camera } from "@babylonjs/core/Cameras/camera.js";

export const G = 100;
const N = G * G;
const PITCH = 4;
const VIEW = 400;
const W = VIEW * 2, H = VIEW;
const LEVELS = 4;
const CULLED = 255;
const COLORS: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]];

/** Colour class of a pixel: level 0-3, or -1 for black. */
function levelOfPixel(r: number, g: number, b: number): number {
  if (r > 128 && g < 64 && b < 64) return 0;
  if (g > 128 && r < 64 && b < 64) return 1;
  if (b > 128 && r < 64 && g < 64) return 2;
  if (r > 128 && g > 128 && b > 128) return 3;
  return -1;
}

const rank = new Float32Array(N);
for (let i = 0; i < N; i++) rank[i] = (Math.imul(i + 1, 2654435761) >>> 0) / 4294967296;

/** The visibility stage stand-in: one byte per instance per view. A shows 60 %, B 60 %, 30 % of all in both; levels differ by view. */
export function selectLevels(view: number, frame: number, out: Uint8Array): void {
  const s = (frame * 0.013) % 1;
  for (let i = 0; i < N; i++) {
    let f = rank[i] + s;
    if (f >= 1) f -= 1;
    const visible = view === 0 ? f < 0.6 : f >= 0.3 && f < 0.9;
    out[i] = visible ? (((i % G) / 25 | 0) + view + (frame >> 3)) & 3 : CULLED;
  }
}

export interface World { env: Env; sources: Mesh[]; pool: InstancedMesh[][]; camA: ReturnType<typeof orthoCamera>; camB: ReturnType<typeof orthoCamera>; createMs: number }

export function makeWorld(): World {
  const t0 = performance.now();
  const env = makeEnv(W, H);
  const sources = COLORS.map((c, k) => {
    const m = CreateBox(`level${k}`, { size: 2 }, env.scene);
    m.material = flat(env.scene, `lvl${k}`, c[0], c[1], c[2]);
    m.isVisible = false;
    return m;
  });
  const pool = sources.map((src, k) => {
    const arr: InstancedMesh[] = new Array(N);
    for (let i = 0; i < N; i++) {
      const inst = src.createInstance(`l${k}i${i}`);
      inst.position.set(-198 + PITCH * (i % G), -198 + PITCH * ((i / G) | 0), 0);
      inst.freezeWorldMatrix();
      (inst as unknown as { idx: number }).idx = i;
      arr[i] = inst;
    }
    return arr;
  });
  const camA = orthoCamera(env.scene, "A", 200, new Viewport(0, 0, 0.5, 1));
  const camB = orthoCamera(env.scene, "B", 200, new Viewport(0.5, 0, 0.5, 1));
  return { env, sources, pool, camA, camB, createMs: +(performance.now() - t0).toFixed(0) };
}

/** World position -> canvas pixel of the instance's centre in view v (col, row from the top). */
const px = (i: number, v: number): [number, number] => [v * VIEW + (-198 + PITCH * (i % G)) + 200, 200 - (-198 + PITCH * ((i / G) | 0))];

/** Per instance check: expected level (or black) at its pixel in the view. Returns mismatches and per-level pixel-block counts. */
function verify(pixels: Uint8Array, levels: Uint8Array[]): { mismatches: number; perViewVisible: number[]; overlap: number } {
  let mismatches = 0;
  const perViewVisible = [0, 0];
  let overlap = 0;
  for (let i = 0; i < N; i++) {
    let both = 0;
    for (let v = 0; v < 2; v++) {
      const [c, r] = px(i, v);
      const o = (r * W + c) * 4;
      const got = levelOfPixel(pixels[o], pixels[o + 1], pixels[o + 2]);
      const want = levels[v][i] === CULLED ? -1 : levels[v][i];
      if (got !== want) mismatches++;
      if (got >= 0) { perViewVisible[v]++; both++; }
    }
    if (both === 2) overlap++;
  }
  return { mismatches, perViewVisible, overlap };
}

export type Variant = "a" | "b" | "b-noCurrentLod" | "c-setEnabled" | "c-isVisible";

interface Setup { views: View2[]; beforeFrame(frame: number): number[]; applyMs: number[][]; selectorCalls: { v: number }; levels: Uint8Array[]; teardown(): void }

function setup(w: World, variant: Variant, geometry: boolean, hookGeometryToo = false, setCurrentLodArg = true): Setup {
  const setCurrentLod = setCurrentLodArg && variant !== "b-noCurrentLod";
  const { pool, camA, camB } = w;
  const levels = [new Uint8Array(N), new Uint8Array(N)];
  const cams = [camA, camB];
  const applyMs: number[][] = [[], []]; // per view
  const selectorCalls = { v: 0 };
  const objects: AbstractMesh[][] = [[], []];
  const geom = (v: number): View2["geometry"] | undefined => geometry ? { width: W, height: H, before: undefined, after: undefined } : undefined;
  let teardown = (): void => {};
  const views: View2[] = [0, 1].map((v) => ({ name: v === 0 ? "A" : "B", camera: cams[v], objects: objects[v], geometry: geom(v) }));

  if (variant === "a") {
    // The cull tasks' lists are rebuilt in beforeFrame.
  } else if (variant === "b" || variant === "b-noCurrentLod") {
    for (let v = 0; v < 2; v++) { objects[v].length = 0; for (let i = 0; i < N; i++) objects[v].push(pool[0][i]); }
    const byCam = new Map<Camera, Uint8Array>([[camA, levels[0]], [camB, levels[1]]]);
    const scene = w.env.scene as unknown as { customLODSelector: ((m: AbstractMesh, c: Camera) => AbstractMesh | null) | undefined };
    const acc = [0, 0];
    scene.customLODSelector = (mesh, cam) => {
      const t = performance.now();
      const lv = byCam.get(cam)![(mesh as unknown as { idx: number }).idx];
      let r: AbstractMesh | null = null;
      if (lv !== CULLED) { r = w.sources[lv]; if (setCurrentLod) (mesh as unknown as { _currentLOD: AbstractMesh })._currentLOD = r; }
      acc[cam === camA ? 0 : 1] += performance.now() - t;
      selectorCalls.v++;
      return r;
    };
    (applyMs as unknown as { acc: number[] }).acc = acc;
    teardown = () => { scene.customLODSelector = undefined; };
  } else {
    for (let v = 0; v < 2; v++) { objects[v].length = 0; for (let k = 0; k < LEVELS; k++) for (let i = 0; i < N; i++) objects[v].push(pool[k][i]); }
    const how = variant === "c-setEnabled" ? "setEnabled" : "isVisible";
    const set = (m: AbstractMesh, on: boolean): void => (how === "setEnabled" ? m.setEnabled(on) : void (m.isVisible = on));
    const hide = (v: number): void => {
      const t = performance.now();
      const lv = levels[v];
      for (let i = 0; i < N; i++) { const keep = lv[i]; for (let k = 0; k < LEVELS; k++) if (k !== keep) set(pool[k][i], false); }
      applyMs[v].push(performance.now() - t);
    };
    const restore = (v: number): void => {
      const t = performance.now();
      const lv = levels[v];
      for (let i = 0; i < N; i++) { const keep = lv[i]; for (let k = 0; k < LEVELS; k++) if (k !== keep) set(pool[k][i], true); }
      applyMs[v][applyMs[v].length - 1] += performance.now() - t;
    };
    views[0].before = () => hide(0); views[0].after = () => restore(0);
    views[1].before = () => hide(1); views[1].after = () => restore(1);
    if (hookGeometryToo && geometry) {
      // the geometry pass runs before the render pass of the same view: it needs the same hide/restore around it
      for (let v = 0; v < 2; v++) { views[v].geometry!.before = () => hide(v); views[v].geometry!.after = () => restore(v); }
    }
  }

  const beforeFrame = (frame: number): number[] => {
    const sel: number[] = [];
    for (let v = 0; v < 2; v++) {
      const t = performance.now();
      selectLevels(v, frame, levels[v]);
      sel.push(performance.now() - t);
    }
    if (variant === "a") {
      for (let v = 0; v < 2; v++) {
        const t = performance.now();
        const list = objects[v];
        const lv = levels[v];
        let n = 0;
        for (let i = 0; i < N; i++) { const l = lv[i]; if (l !== CULLED) list[n++] = pool[l][i]; }
        list.length = n;
        applyMs[v].push(performance.now() - t);
      }
    }
    return sel;
  };
  return { views, beforeFrame, applyMs, selectorCalls, levels, teardown };
}

/** Timing: warm-up then `frames` frames; per view apply time, whole scene.render() time, selection time. */
export async function t1Timing(variant: Variant, frames = 30): Promise<unknown> {
  const w = makeWorld();
  const s = setup(w, variant, false);
  const g = await buildGraph2(w.env, s.views);
  void g;
  s.beforeFrame(0);
  await settle(w.env, 2);
  const renderMs: number[] = [], selectMs: number[] = [];
  const accBefore = (s.applyMs as unknown as { acc?: number[] }).acc;
  const selA: number[] = [], selB: number[] = [];
  let checked: ReturnType<typeof verify> | null = null;
  let lastDraw = { A: { calls: 0, instances: 0 }, B: { calls: 0, instances: 0 } };
  for (let f = 1; f <= frames + 6; f++) {
    if (f === 7) { s.applyMs[0].length = 0; s.applyMs[1].length = 0; }
    const sel = s.beforeFrame(f);
    if (accBefore) { accBefore[0] = 0; accBefore[1] = 0; }
    drawLog.length = 0;
    const t = performance.now();
    w.env.scene.render();
    const dt = performance.now() - t;
    if (accBefore) { selA.push(accBefore[0]); selB.push(accBefore[1]); }
    if (f > 6) { renderMs.push(dt); selectMs.push(sel[0] + sel[1]); }
    if (f === 10 || f === frames + 6) {
      lastDraw = { A: drawsOf("render:A"), B: drawsOf("render:B") };
      checked = verify(readCanvas(w.env), s.levels);
    }
  }
  const per = (v: number): ReturnType<typeof stats> => stats(accBefore ? (v === 0 ? selA : selB).slice(6) : s.applyMs[v]);
  const out = {
    variant, N, createMs: w.createMs, check: checked, draws: lastDraw,
    applyPerViewMs: { A: per(0), B: per(1) },
    renderTotalMs: stats(renderMs), selectLevelsBothViewsMs: stats(selectMs),
    selectorCalls: s.selectorCalls.v,
    raw: { renderMs, applyA: accBefore ? selA.slice(6) : s.applyMs[0], applyB: accBefore ? selB.slice(6) : s.applyMs[1] },
  };
  s.teardown();
  w.env.dispose();
  return out;
}

/** Parity: a depth + normals geometry pass fed with the cull output sees exactly what the render pass draws. */
export async function t1Parity(variant: Variant, hookGeometryToo = false): Promise<unknown> {
  const w = makeWorld();
  const s = setup(w, variant, true, hookGeometryToo);
  const depthCovered: Uint8Array[] = [new Uint8Array(N), new Uint8Array(N)];
  const depthSeen: number[] = [0, 0];
  const depthStats: { min: number; max: number }[] = [{ min: 1e9, max: -1e9 }, { min: 1e9, max: -1e9 }];
  s.views.forEach((v, vi) => {
    v.geometry!.onDepth = (d) => {
      // RGBA float read of an R16F target: channel 0 is the view depth; row 0 is the bottom
      let cov = 0;
      for (let i = 0; i < N; i++) {
        const [c, r] = px(i, vi);
        const o = (((H - 1 - r) * W) + c) * 4;
        const val = d[o];
        depthStats[vi].min = Math.min(depthStats[vi].min, val); depthStats[vi].max = Math.max(depthStats[vi].max, val);
        const covered = val > 0 && val < 20;
        depthCovered[vi][i] = covered ? 1 : 0;
        if (covered) cov++;
      }
      depthSeen[vi] = cov;
    };
  });
  await buildGraph2(w.env, s.views);
  s.beforeFrame(1);
  await settle(w.env, 2);
  const frame = 3;
  s.beforeFrame(frame);
  drawLog.length = 0;
  w.env.scene.render();
  const canvas = readCanvas(w.env);
  const check = verify(canvas, s.levels);
  let depthMismatch = 0;
  for (let v = 0; v < 2; v++) for (let i = 0; i < N; i++) if ((depthCovered[v][i] === 1) !== (s.levels[v][i] !== CULLED)) depthMismatch++;
  const out = {
    variant, hookGeometryToo, renderCheck: check,
    expectedVisible: s.levels.map((l) => l.reduce((n, x) => n + (x !== CULLED ? 1 : 0), 0)),
    depthCovered: depthSeen, depthMismatchVsExpected: depthMismatch, depthRange: depthStats,
    draws: { renderA: drawsOf("render:A"), renderB: drawsOf("render:B"), geomA: drawsOf("geom:A"), geomB: drawsOf("geom:B") },
  };
  s.teardown();
  w.env.dispose();
  return out;
}

/** Does the frame graph path call customLODSelector at all, with which camera, how often per frame, and is it cached per camera? */
export async function t1SelectorProbe(): Promise<unknown> {
  const w = makeWorld();
  const s = setup(w, "b", true);
  const scene = w.env.scene as unknown as { customLODSelector: (m: AbstractMesh, c: Camera) => AbstractMesh | null };
  const inner = scene.customLODSelector;
  const calls: Record<string, number> = {};
  const tag = { cur: "?" };
  scene.customLODSelector = (m, c) => { calls[`${tag.cur}|${c.name}`] = (calls[`${tag.cur}|${c.name}`] ?? 0) + 1; return inner(m, c); };
  await buildGraph2(w.env, s.views);
  s.beforeFrame(1);
  await settle(w.env, 2);
  for (const k of Object.keys(calls)) delete calls[k];
  s.beforeFrame(2);
  w.env.scene.render();
  const perCam = { ...calls };
  const lodState = (w.pool[0][0] as unknown as { _internalAbstractMeshDataInfo: { _currentLOD: Map<Camera, unknown[]> } })._internalAbstractMeshDataInfo._currentLOD;
  const out = {
    callsPerCamera: perCam, cachedCameras: [...lodState.keys()].map((c) => c.name),
    note: "geometry and render passes of one camera both draw its meshes yet the selector ran once per mesh per camera per scene.render(): the per-camera _currentLOD cache (frame id keyed) serves the second pass",
  };
  s.teardown();
  w.env.dispose();
  return out;
}
