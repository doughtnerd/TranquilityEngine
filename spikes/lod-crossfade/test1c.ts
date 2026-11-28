/** Result 1c: shadow casters vs what the cameras draw (frame graph with a ShadowGenerator / CSM task before the views). */
import {
  buildGraph, count, CreateBox, CreatePlane, DirectionalLight, drawLog, drawsOf, flat, isRed, makeEnv, Matrix, orthoCamera, PBRMaterial, readCanvas, settle, Vector3, Viewport, Color3,
  type Env, type AbstractMesh, type ViewSpec,
} from "./harness";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh.js";

const VA = new Viewport(0, 0, 0.5, 1);
const VB = new Viewport(0.5, 0, 0.5, 1);

// Scene: camera looks along +z; a wall at z = 3 receives shadows from boxes at x = -3, 0, 3 (z = 0, red, unlit).
// The light travels along (0.5, 0, 1), so each shadow lands 1.5 right of its box. Ortho half-width 6.
const SW = 512, SH = 256;
const SCOLS = [[40, 80], [80, 112], [112, 144], [144, 176], [176, 208], [208, 240]]; // box0 sh0 box1 sh1 box2 sh2 (per viewport)

function shadowScene(env: Env, kind: "instances" | "thin") {
  const scene = env.scene;
  const wall = CreatePlane("wall", { width: 16, height: 8 }, scene);
  wall.position.z = 3;
  const wm = new PBRMaterial("wallMat", scene);
  wm.albedoColor = new Color3(1, 1, 1);
  wm.metallic = 0;
  wm.roughness = 1;
  wall.material = wm;
  wall.receiveShadows = true;
  const light = new DirectionalLight("sun", new Vector3(0.5, 0, 1).normalize(), scene);
  light.intensity = 3;
  light.position = new Vector3(-10, 0, -20);
  const src = CreateBox("src", { size: 1 }, scene);
  src.material = flat(scene, "red", 1, 0, 0);
  const inst: InstancedMesh[] = [];
  const thinBuf = new Float32Array(3 * 16);
  if (kind === "instances") {
    src.isVisible = false;
    [-3, 0, 3].forEach((x, i) => {
      const m = src.createInstance(`i${i}`);
      m.position.x = x;
      inst.push(m);
    });
  } else {
    [-3, 0, 3].forEach((x, i) => Matrix.Translation(x, 0, 0).copyToArray(thinBuf, i * 16));
    src.thinInstanceSetBuffer("matrix", thinBuf, 16, false);
    src.thinInstanceRefreshBoundingInfo(true);
  }
  return { wall, light, src, inst, thinBuf };
}

/** Rows 50..206 are wall only (the wall is 8 high in a 12-high view), so the black clear colour never counts as shadow. */
function shadowBands(px: Uint8Array) {
  const dark = (r: number, g: number, b: number) => r < 25 && g < 25 && b < 25;
  const f = (off: number) => SCOLS.map(([a, b]) => ({ red: count(px, SW, [off + a, 50, off + b, 206], isRed), dark: count(px, SW, [off + a, 50, off + b, 206], dark) }));
  return { A: f(0), B: f(256) };
}
const summarize = (b: ReturnType<typeof shadowBands>) => {
  const s = (v: { red: number; dark: number }[]) => ({ boxes: [v[0].red, v[2].red, v[4].red], shadows: [v[1].dark, v[3].dark, v[5].dark] });
  return { A: s(b.A), B: s(b.B) };
};

export interface ShadowOpts {
  kind: "instances" | "thin";
  cascaded?: boolean;
  /** A shadow generator (CSM) task for camera B as well as camera A. */
  csmPerCamera?: boolean;
  /** Control: disable the instance hidden from A before the frame instead of inside A's hook. */
  hideBeforeFrame?: boolean;
  /** Views put their buffer / enabled state back in their onAfterRender (default true). */
  restore?: boolean;
  /** Thin: rewrite the full caster buffer in the shadow map's onBeforeRender. */
  shadowHook?: boolean;
  frames?: number;
}

export async function t1cShadows(opts: ShadowOpts): Promise<unknown> {
  const restore = opts.restore ?? true;
  const env = makeEnv(SW, SH);
  const { light, src, inst, thinBuf } = shadowScene(env, opts.kind);
  const camA = orthoCamera(env.scene, "A", 6, VA);
  const camB = orthoCamera(env.scene, "B", 6, VB);
  const writeThin = (xs: number[]) => {
    xs.forEach((x, i) => Matrix.Translation(x, 0, 0).copyToArray(thinBuf, i * 16));
    src.thinInstanceCount = xs.length;
    src.thinInstanceBufferUpdated("matrix");
  };
  const ALL = [-3, 0, 3];
  const hideFromA = () => (opts.kind === "instances" ? inst[2].setEnabled(false) : writeThin([-3, 0]));
  const showAfterA = () => restore && (opts.kind === "instances" ? inst[2].setEnabled(true) : writeThin(ALL));
  const hideFromB = () => (opts.kind === "instances" ? inst[0].setEnabled(false) : writeThin([0, 3]));
  const showAfterB = () => restore && (opts.kind === "instances" ? inst[0].setEnabled(true) : writeThin(ALL));
  const casters: AbstractMesh[] = opts.kind === "instances" ? [src, ...inst] : [src];
  const wall = env.scene.getMeshByName("wall")!;
  const views: ViewSpec[] = [
    { name: "A", camera: camA, objects: [wall, ...casters], before: hideFromA, after: () => void showAfterA() },
    { name: "B", camera: camB, objects: [wall, ...casters], before: hideFromB, after: () => void showAfterB() },
  ];
  const shadows = [{ light, camera: camA, casters, cascaded: opts.cascaded, mapSize: 1024 }];
  if (opts.csmPerCamera) shadows.push({ light, camera: camB, casters, cascaded: opts.cascaded, mapSize: 1024 });
  const g = await buildGraph(env, views, shadows, opts.shadowHook ? () => writeThin(ALL) : undefined);
  await settle(env, 4);
  if (opts.hideBeforeFrame && opts.kind === "instances") inst[2].setEnabled(false);
  if (opts.kind === "thin") writeThin(ALL);
  const frames: unknown[] = [];
  for (let f = 0; f < (opts.frames ?? 1); f++) {
    g.log.length = 0;
    drawLog.length = 0;
    env.scene.render();
    const entry: Record<string, unknown> = { ...summarize(shadowBands(readCanvas(env))), draws: { shadow: drawsOf("shadow"), A: drawsOf("A"), B: drawsOf("B") } };
    if (f === 0) entry.log = g.log.slice();
    frames.push(entry);
  }
  env.dispose();
  return { opts, frames };
}

void CreateBox;
