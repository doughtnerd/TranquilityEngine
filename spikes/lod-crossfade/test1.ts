/** Result 1: per-view toggling of instances, thin-instance buffers and shadow casters in a frame graph. */
import {
  buildGraph, count, CreateBox, CreatePlane, DirectionalLight, drawLog, drawsOf, flat, isRed, makeEnv, Matrix, orthoCamera, PBRMaterial, readCanvas, settle, state, Vector3, Viewport, Color3,
  type Env, type Mesh, type AbstractMesh, type ViewSpec,
} from "./harness";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh.js";

const W = 512, H = 256; // two 256x256 viewports side by side
const VA = new Viewport(0, 0, 0.5, 1);
const VB = new Viewport(0.5, 0, 0.5, 1);

/** Lit-pixel counts in three column bands of each viewport (ortho half-width 4: x=-2,0,2 land in bands 0,1,2). */
function bands3(px: Uint8Array, pred = (r: number, g: number, b: number) => r > 128 || g > 128 || b > 128): { A: number[]; B: number[] } {
  const cols = [[0, 85], [85, 171], [171, 256]];
  const f = (off: number) => cols.map(([a, b]) => count(px, W, [off + a, 0, off + b, H], pred));
  return { A: f(0), B: f(256) };
}

function instancesScene(env: Env): { source: Mesh; inst: InstancedMesh[] } {
  const source = CreateBox("src", { size: 1 }, env.scene);
  source.material = flat(env.scene, "white", 1, 1, 1);
  source.isVisible = false;
  const inst = [-2, 0, 2].map((x, i) => {
    const m = source.createInstance(`i${i}`);
    m.position.x = x;
    return m;
  });
  return { source, inst };
}

type Toggle = "setEnabled" | "isVisible";
const set = (m: AbstractMesh, on: boolean, how: Toggle) => (how === "setEnabled" ? m.setEnabled(on) : (m.isVisible = on));

/** 1a: InstancedMesh instances hidden per view in each object renderer's onBeforeRender, restored in onAfterRender. */
export async function t1aInstances(how: Toggle): Promise<unknown> {
  const env = makeEnv(W, H);
  const { source, inst } = instancesScene(env);
  const camA = orthoCamera(env.scene, "A", 4, VA);
  const camB = orthoCamera(env.scene, "B", 4, VB);
  const views: ViewSpec[] = [
    { name: "A", camera: camA, before: () => set(inst[2], false, how), after: () => set(inst[2], true, how) }, // A draws X = {i0, i1}
    { name: "B", camera: camB, before: () => set(inst[0], false, how), after: () => set(inst[0], true, how) }, // B draws Y = {i1, i2}
  ];
  const g = await buildGraph(env, views);
  await settle(env);
  drawLog.length = 0;
  g.log.length = 0;
  env.scene.render();
  const px = readCanvas(env);
  const out = { variant: how, bands: bands3(px), drawA: drawsOf("A"), drawB: drawsOf("B"), culled: g.culls.map((c) => c.outputObjectList.meshes?.length), log: g.log.slice() };
  // A second frame: the restore in onAfterRender keeps the next frame identical.
  env.scene.render();
  (out as Record<string, unknown>).bandsFrame2 = bands3(readCanvas(env));
  void source;
  env.dispose();
  return out;
}

/** 1a-neg: an instance disabled before the frame and re-enabled in a view's hook: the cull task already dropped it. */
export async function t1aNegative(): Promise<unknown> {
  const env = makeEnv(W, H);
  const { inst } = instancesScene(env);
  const views: ViewSpec[] = [
    { name: "A", camera: orthoCamera(env.scene, "A", 4, VA) },
    { name: "B", camera: orthoCamera(env.scene, "B", 4, VB), before: () => inst[2].setEnabled(true), after: () => inst[2].setEnabled(false) },
  ];
  inst[2].setEnabled(false);
  const g = await buildGraph(env, views);
  await settle(env);
  env.scene.render();
  const out = { bands: bands3(readCanvas(env)), culled: g.culls.map((c) => c.outputObjectList.meshes?.length) };
  env.dispose();
  return out;
}

/** 1a-alt: no hooks at all: each view's cull task starts from its own object list (instances are listed per view). */
export async function t1aObjectLists(): Promise<unknown> {
  const env = makeEnv(W, H);
  const { source, inst } = instancesScene(env);
  const views: ViewSpec[] = [
    { name: "A", camera: orthoCamera(env.scene, "A", 4, VA), objects: [source, inst[0], inst[1]] },
    { name: "B", camera: orthoCamera(env.scene, "B", 4, VB), objects: [source, inst[1], inst[2]] },
  ];
  const g = await buildGraph(env, views);
  await settle(env);
  drawLog.length = 0;
  env.scene.render();
  const out = { bands: bands3(readCanvas(env)), drawA: drawsOf("A"), drawB: drawsOf("B"), culled: g.culls.map((c) => c.outputObjectList.meshes?.length) };
  env.dispose();
  return out;
}

/** 1b: a thin-instance batch whose matrix buffer and count are rewritten per view. */
export async function t1bThin(mode: "updated" | "setBuffer"): Promise<unknown> {
  const env = makeEnv(W, H);
  const src = CreateBox("thin", { size: 1 }, env.scene);
  src.material = flat(env.scene, "white", 1, 1, 1);
  const mat = (x: number) => Matrix.Translation(x, 0, 0);
  const all = new Float32Array(3 * 16);
  const write = (xs: number[]) => {
    const buf = new Float32Array(xs.length * 16);
    xs.forEach((x, i) => mat(x).copyToArray(buf, i * 16));
    if (mode === "setBuffer") src.thinInstanceSetBuffer("matrix", buf, 16, false);
    else {
      all.set(buf); // `all` is the array given to thinInstanceSetBuffer: Babylon keeps and re-uploads it
      src.thinInstanceBufferUpdated("matrix");
    }
    src.thinInstanceCount = xs.length;
  };
  // Start with all three so the bounds cover them; the engine does the same with a refreshed bounding info.
  [-2, 0, 2].forEach((x, i) => mat(x).copyToArray(all, i * 16));
  src.thinInstanceSetBuffer("matrix", all, 16, false);
  src.thinInstanceRefreshBoundingInfo(true);
  const views: ViewSpec[] = [
    { name: "A", camera: orthoCamera(env.scene, "A", 4, VA), before: () => write([-2, 0]) },
    { name: "B", camera: orthoCamera(env.scene, "B", 4, VB), before: () => write([0, 2]) },
  ];
  const g = await buildGraph(env, views);
  await settle(env);
  drawLog.length = 0;
  env.scene.render();
  const out = { mode, bands: bands3(readCanvas(env)), drawA: drawsOf("A"), drawB: drawsOf("B"), culled: g.culls.map((c) => c.outputObjectList.meshes?.length) };
  env.dispose();
  return out;
}

