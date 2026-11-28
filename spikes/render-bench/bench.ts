// Render-bench harness page (spike only; not engine code). Loads a generated project the way the game player does
// (src/player/main.ts) but owns the frame loop, so each frame can be timed and a camera pose, LOD level and
// visibility set applied before it. Everything the oracles do goes through the engine's public component API
// (MeshRenderer.mesh, GameObject.setActive, the camera node's Transform) except the object-ID pass, which reads the
// engine's loaded model data and world matrices and renders them in a second WebGL context.
//
// window.bench:
//   info()                 what ran (GPU string, tier, node counts)
//   computeOcclusion()     object-ID pass at the static pose and along the fly path -> visibility data (JSON)
//   run(cfg)               one measured run (see RunConfig)
import { EngineStore } from "@babylonjs/core/Engines/engineStore.js";
import { Frustum } from "@babylonjs/core/Maths/math.frustum.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Camera, GameObject } from "../../src/engine";
import { World } from "../../src/engine/core/World";
import { Graphics } from "../../src/engine/render/Graphics";
import { launchGame } from "../../src/engine/launch";
import { loadMeshes, meshesIfLoaded } from "../../src/engine/scene/models";
import { loadProjectFiles } from "../../src/engine/scene/projectFiles";
import { activateGamePlugins } from "../../src/plugins/runtime";
import * as myco from "../../src/myco";
import { MeshRenderer } from "../../src/myco";

type Pose = { pos: number[]; yaw: number; pitch: number };
type BenchJson = { scene: string; staticPose: Pose; flyPath: Pose[]; objects: Record<string, number> };
export type RunConfig = {
  mode: "static" | "fly";
  frames: number;
  warmup: number;
  lod: boolean;
  /** LOD oracle culls objects below screen height 0.02 (default true). */
  lodCull?: boolean;
  occlusion: boolean;
  /** true: real draws (software raster); false: draw calls are counted but not issued (CPU-only). */
  raster?: boolean;
  /** raster mode: real-draw warm-up frames before measuring (default 2). */
  rasterWarmup?: number;
  /** validation: return the last measured frame's canvas as a PNG data URL. */
  capture?: boolean;
  /** debugging: hide every renderer farther than this many metres from the camera (no ID pass). */
  hideBeyond?: number;
  /** debugging: hide renderers whose node id starts with this. */
  hidePrefix?: string;
  /** minimum wall-clock time of the settle phase (raster mode: lets the software GL finish compiling shader programs). */
  settleMs?: number;
};
type OccData = { ids: string[]; poses: { s: number; inFrustum: number; visible: number; occluded: number }[]; visible: number[][]; inFrustum: number[][]; tookMs: number };

const log = (s: string) => { document.getElementById("log")!.textContent += `${s}\n`; };
const params = new URLSearchParams(location.search);
const project = params.get("project") ?? "forest-auto";
const scene = project.split("-")[0];
const urlOf = (path: string) => new URL(`../projects/${project}/${path.split("/").map(encodeURIComponent).join("/")}`, document.baseURI).href;
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

// --- load ----------------------------------------------------------------------------------------------------------
(globalThis as { __myco?: unknown }).__myco = myco;
const files: string[] = await (await fetch(urlOf("files.json"))).json();
const bench: BenchJson = await (await fetch(urlOf("bench.json"))).json();
const tLoad0 = performance.now();
const { values } = await loadProjectFiles(files, {
  readText: async (p) => (await fetch(urlOf(p))).text(),
  url: (p) => urlOf(p),
});
const settings = values.get("project.json") as never;
const { engine: runtime } = await launchGame({
  assets: { has: (p) => values.has(p), get: (p) => values.get(p), paths: () => values.keys() },
  activatePlugins: () => activateGamePlugins([], {}),
  project: settings,
  entryScene: "scenes/main.scene.json",
  container: document.getElementById("game")!,
});
const world = runtime.world;
const loadMs = performance.now() - tLoad0;

let timings = { fixed: 0, update: 0, render: 0 };
runtime._setTiming({ frame() {}, world(_n, fixed, update, render) { timings = { fixed, update, render }; } });

const canvas = document.querySelector("#game canvas") as HTMLCanvasElement;
const gl = canvas.getContext("webgl2") as WebGL2RenderingContext;
const dbg = gl.getExtension("WEBGL_debug_renderer_info");
const bScene = () => {
  // the scene with the most meshes among the engine's (the game view's)
  let best: any = null;
  for (const e of EngineStore.Instances as any[]) for (const s of e.scenes) if (!best || s.meshes.length > best.meshes.length) best = s;
  return best;
};

// --- renderers, camera ----------------------------------------------------------------------------------------------
type R = {
  c: MeshRenderer;
  node: GameObject;
  entity: number;
  id: string;
  ref: string;
  center: number[];
  radius: number; // model-space bounding sphere
  scaleMax: number;
  pos: number[]; // world position of the node
  wc: number[]; // world-space bounding sphere centre
  wr: number;
  lod: number;
  hidden: boolean;
};
let camNode!: GameObject;
let renderers: R[] = [];
const lodRef = (ref: string, lv: number) => (lv === 0 ? ref : ref.replace(/\.obj$/, `_lod${lv}.obj`));

World._runIn(world, () => {
  camNode = GameObject.findObjectsOfType(Camera)[0].node;
});
const refs = new Set<string>();
World._runIn(world, () => { for (const c of GameObject.findObjectsOfType(MeshRenderer)) if (c.mesh.endsWith(".obj")) refs.add(c.mesh); });
for (const ref of refs) for (let lv = 0; lv < 4; lv++) await loadMeshes(lodRef(ref, lv));

const sphereOf = (ref: string) => {
  const ms = meshesIfLoaded(ref)!;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const m of ms) {
    const p = m.data.positions;
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[i + k]); mx[k] = Math.max(mx[k], p[i + k]); }
  }
  const center = mn.map((v, k) => (v + mx[k]) / 2);
  return { center, radius: Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2 };
};
const spheres = new Map<string, { center: number[]; radius: number }>();
for (const ref of refs) spheres.set(ref, sphereOf(ref));

function quatOf(yaw: number, pitch: number): number[] {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  return [cy * sp, sy * cp, -sy * sp, cy * cp];
}
function setPose(p: Pose): void {
  const t = camNode.transform!;
  t.position.set(p.pos[0], p.pos[1], p.pos[2]);
  const q = quatOf(p.yaw, p.pitch);
  t.rotation.set(q[0], q[1], q[2], q[3]);
}
const flyPose = (u: number): Pose => {
  const s = Math.min(bench.flyPath.length - 1, Math.max(0, u * (bench.flyPath.length - 1)));
  const k = Math.min(bench.flyPath.length - 2, Math.floor(s)), t = s - k, a = bench.flyPath[k], b = bench.flyPath[k + 1];
  return { pos: a.pos.map((v, i) => v + (b.pos[i] - v) * t), yaw: a.yaw + (b.yaw - a.yaw) * t, pitch: a.pitch + (b.pitch - a.pitch) * t };
};
const forwardOf = (p: Pose): Vector3 => {
  // rotate (0,0,1) by q
  const [x, y, z, w] = quatOf(p.yaw, p.pitch);
  return new Vector3(2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y));
};

function stepFrame(dt: number): void {
  runtime.step(dt);
}

// one step to settle: world matrices, Babylon camera
setPose(bench.staticPose);
stepFrame(1 / 30);
stepFrame(1 / 30);
World._runIn(world, () => {
  renderers = GameObject.findObjectsOfType(MeshRenderer)
    .filter((c) => c.mesh.endsWith(".obj"))
    .map((c) => {
      const e = c.node.entity;
      const m = world.worldMatrix(e);
      const o = e * 16;
      const sx = Math.hypot(m[o], m[o + 1], m[o + 2]), sy = Math.hypot(m[o + 4], m[o + 5], m[o + 6]), sz = Math.hypot(m[o + 8], m[o + 9], m[o + 10]);
      const sp = spheres.get(c.mesh)!;
      const scaleMax = Math.max(sx, sy, sz);
      // world-space bounding-sphere centre: node matrix applied to the model-space centre (row-vector, column-major array)
      const [cx, cy, cz] = sp.center;
      const wc = [cx * m[o] + cy * m[o + 4] + cz * m[o + 8] + m[o + 12], cx * m[o + 1] + cy * m[o + 5] + cz * m[o + 9] + m[o + 13], cx * m[o + 2] + cy * m[o + 6] + cz * m[o + 10] + m[o + 14]];
      return { c, node: c.node, entity: e, id: c.node.id, ref: c.mesh, center: sp.center, radius: sp.radius, scaleMax, pos: [m[o + 12], m[o + 13], m[o + 14]], wc, wr: sp.radius * scaleMax, lod: 0, hidden: false };
    });
});

// --- camera matrices (for the object-ID pass; validated against Babylon's own) ---------------------------------------
function viewOf(p: Pose): Matrix {
  const eye = new Vector3(p.pos[0], p.pos[1], p.pos[2]);
  const f = forwardOf(p);
  return Matrix.LookAtLH(eye, eye.add(f), Vector3.Up());
}
const bCam = () => { const sc = bScene(); return (sc.activeCamera ?? sc.activeCameras?.[0] ?? sc.cameras[0]) as any; };
function validateView(p: Pose): number {
  setPose(p);
  stepFrame(1 / 30);
  const ref = bCam().getViewMatrix(true).m as ArrayLike<number>;
  const mine = viewOf(p).m as ArrayLike<number>;
  let d = 0;
  for (let i = 0; i < 16; i++) d = Math.max(d, Math.abs(ref[i] - mine[i]));
  return d;
}

// --- LOD oracle ------------------------------------------------------------------------------------------------------
const LOD_H = [0.5, 0.25, 0.1]; // level k+1 below screen-height fraction LOD_H[k]
const CULL_H = 0.02;
function lodLevel(r: R, eye: number[], tanHalf: number, cull: boolean): number {
  const d = Math.hypot(r.wc[0] - eye[0], r.wc[1] - eye[1], r.wc[2] - eye[2]);
  // screen-height fraction of the bounding sphere's diameter: (2 R) / (2 d tan(fov/2))
  const h = r.wr / Math.max(1e-3, d * tanHalf);
  if (cull && h < CULL_H) return -1;
  return h >= LOD_H[0] ? 0 : h >= LOD_H[1] ? 1 : h >= LOD_H[2] ? 2 : 3;
}

// --- occlusion data / ID pass --------------------------------------------------------------------------------------
const FLY_KEYS = 25; // poses along the fly path: fly samples every 1/25th of the path
const occPoses = (): Pose[] => [bench.staticPose, ...Array.from({ length: FLY_KEYS + 1 }, (_, i) => flyPose(i / FLY_KEYS))];

async function computeOcclusion(): Promise<OccData> {
  const t0 = performance.now();
  // validate the camera maths against the engine's real camera at the static pose and mid-path
  const errs = [validateView(bench.staticPose), validateView(flyPose(0.5))];
  if (errs.some((e) => !(e < 1e-3))) throw new Error(`camera view mismatch (max abs diff ${errs.join(", ")})`);
  const proj = bCam().getProjectionMatrix() as Matrix;
  const c = document.createElement("canvas");
  c.width = 1280; c.height = 720;
  const g = c.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true, alpha: false })!;
  (g as any).__benchSkip = true;
  const sh = (type: number, src: string) => { const s = g.createShader(type)!; g.shaderSource(s, src); g.compileShader(s); if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s)!); return s; };
  const prog = g.createProgram()!;
  g.attachShader(prog, sh(g.VERTEX_SHADER, "#version 300 es\nin vec3 p; uniform mat4 vp; uniform mat4 w; void main(){ gl_Position = vp * w * vec4(p,1.0); }"));
  g.attachShader(prog, sh(g.FRAGMENT_SHADER, "#version 300 es\nprecision highp float; uniform vec3 idc; out vec4 o; void main(){ o = vec4(idc, 1.0); }"));
  g.linkProgram(prog);
  g.useProgram(prog);
  const uVp = g.getUniformLocation(prog, "vp"), uW = g.getUniformLocation(prog, "w"), uId = g.getUniformLocation(prog, "idc");
  const buffers = new Map<string, { vao: WebGLVertexArrayObject; n: number }[]>();
  for (const ref of refs) {
    const list: { vao: WebGLVertexArrayObject; n: number }[] = [];
    for (const m of meshesIfLoaded(ref)!) {
      const vao = g.createVertexArray()!;
      g.bindVertexArray(vao);
      const vb = g.createBuffer()!;
      g.bindBuffer(g.ARRAY_BUFFER, vb);
      g.bufferData(g.ARRAY_BUFFER, Float32Array.from(m.data.positions as ArrayLike<number>), g.STATIC_DRAW);
      g.enableVertexAttribArray(0);
      g.vertexAttribPointer(0, 3, g.FLOAT, false, 0, 0);
      const ib = g.createBuffer()!;
      g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, ib);
      const idx = Uint32Array.from(m.data.indices as ArrayLike<number>);
      g.bufferData(g.ELEMENT_ARRAY_BUFFER, idx, g.STATIC_DRAW);
      list.push({ vao, n: idx.length });
    }
    buffers.set(ref, list);
  }
  const mats = renderers.map((r) => { const m = world.worldMatrix(r.entity); return Float32Array.from((m as any).slice(r.entity * 16, r.entity * 16 + 16)); });
  const ids = renderers.map((r) => r.id);
  const poses = occPoses();
  const out: OccData = { ids, poses: [], visible: [], inFrustum: [], tookMs: 0 };
  const buf = new Uint8Array(1280 * 720 * 4);
  g.viewport(0, 0, 1280, 720);
  g.enable(g.DEPTH_TEST);
  for (let pi = 0; pi < poses.length; pi++) {
    const vp = viewOf(poses[pi]).multiply(proj);
    g.uniformMatrix4fv(uVp, false, vp.m as any);
    g.clearColor(0, 0, 0, 1);
    g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT);
    const planes = Frustum.GetPlanes(vp);
    const inF: number[] = [];
    for (let i = 0; i < renderers.length; i++) {
      const r = renderers[i];
      let inside = true;
      for (const pl of planes) if (pl.normal.x * r.wc[0] + pl.normal.y * r.wc[1] + pl.normal.z * r.wc[2] + pl.d < -r.wr) { inside = false; break; }
      if (!inside) continue;
      inF.push(i);
      const id = i + 1;
      g.uniform3f(uId, (id & 255) / 255, ((id >> 8) & 255) / 255, ((id >> 16) & 255) / 255);
      g.uniformMatrix4fv(uW, false, mats[i]);
      for (const b of buffers.get(r.ref)!) { g.bindVertexArray(b.vao); g.drawElements(g.TRIANGLES, b.n, g.UNSIGNED_INT, 0); }
    }
    g.readPixels(0, 0, 1280, 720, g.RGBA, g.UNSIGNED_BYTE, buf);
    const seen = new Set<number>();
    for (let i = 0; i < buf.length; i += 4) {
      const id = buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16);
      if (id) seen.add(id - 1);
    }
    out.inFrustum.push(inF);
    out.visible.push([...seen].sort((a, b) => a - b));
    out.poses.push({ s: pi === 0 ? -1 : (pi - 1) / FLY_KEYS, inFrustum: inF.length, visible: seen.size, occluded: inF.length - [...seen].filter((i) => inF.includes(i)).length });
    log(`occlusion pose ${pi}/${poses.length - 1}: ${inF.length} in frustum, ${seen.size} visible`);
  }
  out.tookMs = performance.now() - t0;
  setPose(bench.staticPose);
  return out;
}

// --- the measured run ------------------------------------------------------------------------------------------------
let occData: OccData | null = null;
const idIndex = new Map(renderers.map((r, i) => [r.id, i]));

async function prewarmLods(): Promise<void> {
  // make every LOD mesh's Babylon geometry once, with almost everything hidden, so the run isn't timed building them
  const firstOfRef = new Map<string, R>();
  for (const r of renderers) if (!firstOfRef.has(r.ref)) firstOfRef.set(r.ref, r);
  for (const r of renderers) if (!firstOfRef.has(r.ref) || firstOfRef.get(r.ref) !== r) r.node.setActive(false);
  for (let lv = 1; lv <= 3; lv++) {
    for (const [ref, r] of firstOfRef) r.c.mesh = lodRef(ref, lv);
    stepFrame(1 / 30);
  }
  for (const [ref, r] of firstOfRef) r.c.mesh = ref;
  for (const r of renderers) r.node.setActive(true);
  stepFrame(1 / 30);
}

async function run(cfg: RunConfig) {
  if (cfg.occlusion && !occData) occData = await (await fetch(new URL(`../occlusion/${scene}.json`, document.baseURI).href)).json();
  const cull = cfg.lodCull !== false;
  // restore a clean state
  for (const r of renderers) { r.hidden = false; r.lod = 0; r.c.mesh = r.ref; r.node.setActive(true); }
  if (cfg.lod) await prewarmLods();
  const dt = 1 / 30;
  const tanHalf = Math.tan((60 * Math.PI) / 180 / 2);
  const rows: any[] = [];
  const occSet = new Set<number>(); // renderer indices visible this frame (occlusion oracle)
  // Phases: "settle" (draws counted, not issued, until the per-frame draw count has been identical for 10 frames, at least
  // cfg.warmup frames: batches, pipelines and instancing settle), "rwarm" (raster mode only: a few real-draw frames to pay
  // program linking and first-use costs), then "measure".
  let phase: "settle" | "rwarm" | "measure" = "settle";
  let stable = 0, prevDraws = -1, f = 0, mIdx = 0, rw = 0, settleFrames = 0;
  const rwarm = cfg.raster ? cfg.rasterWarmup ?? 2 : 0;
  let capture: string | null = null;
  const settleStart = performance.now();
  let lastT = await nextFrame();
  for (;;) {
    const u = cfg.mode === "fly" && phase === "measure" ? mIdx / Math.max(1, cfg.frames - 1) : 0;
    const pose = cfg.mode === "fly" ? flyPose(u) : bench.staticPose;
    // --- oracle bookkeeping (timed separately, outside the engine's step)
    const o0 = performance.now();
    setPose(pose);
    let hiddenOcc = 0, culledLod = 0;
    const lodCounts = [0, 0, 0, 0];
    if (cfg.lod || cfg.occlusion || cfg.hideBeyond || cfg.hidePrefix) {
      if (cfg.occlusion) {
        occSet.clear();
        const s = cfg.mode === "fly" ? u * FLY_KEYS : -1;
        const sets = cfg.mode === "fly" ? [Math.floor(s) + 1, Math.min(FLY_KEYS, Math.ceil(s)) + 1] : [0];
        for (const si of new Set(sets)) for (const i of occData!.visible[si]) occSet.add(idIndex.get(occData!.ids[i])!);
      }
      for (let i = 0; i < renderers.length; i++) {
        const r = renderers[i];
        const lv = cfg.lod ? lodLevel(r, pose.pos, tanHalf, cull) : 0;
        const occHide = (cfg.occlusion && !occSet.has(i)) || (!!cfg.hidePrefix && r.id.startsWith(cfg.hidePrefix)) || (cfg.hideBeyond !== undefined && Math.hypot(r.wc[0] - pose.pos[0], r.wc[1] - pose.pos[1], r.wc[2] - pose.pos[2]) > cfg.hideBeyond);
        const hide = occHide || lv < 0;
        if (hide !== r.hidden) { r.node.setActive(!hide); r.hidden = hide; }
        if (!hide) {
          const want = Math.max(0, lv);
          if (want !== r.lod) { r.c.mesh = lodRef(r.ref, want); r.lod = want; }
        }
        if (occHide) hiddenOcc++;
        else if (lv < 0) culledLod++;
        else lodCounts[lv]++;
      }
    }
    const oracleMs = performance.now() - o0;
    window.__gl.skip = !(cfg.raster && phase !== "settle");
    window.__gl.reset();
    const t0 = performance.now();
    stepFrame(dt);
    const t1 = performance.now();
    const shot = window.__gl.snapshot();
    // validation only: the drawing buffer is valid until the frame is presented, so read it in the same task as the step
    if (cfg.capture && phase === "measure" && mIdx === cfg.frames - 1) capture = canvas.toDataURL("image/png");
    const now = await nextFrame();
    if (params.has("verbose")) console.log(`frame ${f} ${phase}: cpu ${(t1 - t0).toFixed(0)} ms, interval ${(now - lastT).toFixed(0)} ms, draws ${shot.map((b) => b.key + ":" + b.draws + "/" + Math.round(b.tris)).join(" ")}`);
    const draws = shot.reduce((a, b) => a + b.draws, 0);
    if (phase === "settle") {
      stable = draws > 0 && draws === prevDraws ? stable + 1 : 0;
      prevDraws = draws;
      if ((f + 1 >= cfg.warmup && stable >= 10 && performance.now() - settleStart >= (cfg.settleMs ?? 0)) || f + 1 >= cfg.warmup + 600 + (cfg.settleMs ?? 0) / 10) { settleFrames = f + 1; phase = rwarm > 0 ? "rwarm" : "measure"; }
    } else if (phase === "rwarm") {
      if (++rw >= rwarm) phase = "measure";
    } else {
      rows.push({
        cpuMs: t1 - t0,
        updateMs: timings.update,
        renderMs: timings.render,
        oracleMs,
        intervalMs: now - lastT,
        buckets: shot,
        // Babylon's own count of the indices it drew this frame / 3 (cross-check of the WebGL hook's triangle total; the
        // scene's active-mesh list is already cleared when step() returns, so its length reads 0 here)
        babylonTris: bScene().getActiveIndices() / 3,
        hiddenOcc,
        culledLod,
        lodCounts,
      });
      if (++mIdx >= cfg.frames) break;
    }
    lastT = now;
    f++;
  }
  return { rows, settleFrames, capture };
}

declare global { interface Window { __gl: { skip: boolean; reset(): void; snapshot(): { key: string; draws: number; tris: number; other: number; t0: number; t1: number }[] }; bench: unknown } }

window.bench = {
  info: () => ({
    project,
    scene,
    loadMs,
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "?",
    canvas: [canvas.width, canvas.height],
    tier: { name: Graphics.tier.name, shadows: Graphics.tier.shadows, cascades: Graphics.tier.shadowCascades, distance: Graphics.tier.shadowDistance, antialias: Graphics.tier.antialias, renderScale: Graphics.tier.renderScale, postProcessing: Graphics.tier.postProcessing },
    renderers: renderers.length,
    refs: [...refs],
    objects: bench.objects,
    babylonMeshes: bScene().meshes.length,
  }),
  computeOcclusion,
  run,
  debug: () => {
    const sc = bScene();
    const eff = (m: any) => { try { const e = m.getEffect?.(); return e ? { ready: e.isReady(), err: e.getCompilationError?.() || null, defines: String(e.defines).length } : null; } catch (x) { return String(x); } };
    return {
      active: { am: sc.getActiveMeshes().length, am2: sc._activeMeshes?.length, idx: sc.getActiveIndices?.(), cams: sc.cameras.length, activeCams: sc.activeCameras?.length, meshes: sc.meshes.length, enabled: sc.meshes.filter((m: any) => m.isEnabled()).length },
      materials: sc.materials.slice(0, 40).map((m: any) => ({ n: m.name, c: m.getClassName(), ready: m.isReadyForSubMesh ? undefined : undefined, effect: eff(m), albedo: m.albedoColor?.toHexString?.(), unlit: m.unlit })),
      lights: sc.lights.map((l: any) => ({ n: l.name, c: l.getClassName(), i: l.intensity, sg: !!l.getShadowGenerator?.(), en: l.isEnabled() })),
      env: !!sc.environmentTexture, envIntensity: sc.environmentIntensity, imageProc: { exposure: sc.imageProcessingConfiguration?.exposure, tone: sc.imageProcessingConfiguration?.toneMappingEnabled },
    };
  },
};
log(`ready: ${project}, ${renderers.length} renderers, load ${loadMs.toFixed(0)} ms`);
(window as any).__benchReady = true;
