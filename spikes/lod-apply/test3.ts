/**
 * Result 3: per-pass thin source meshes sharing geometry.
 *   v  two views, each with its own thin source mesh (own matrix buffer, shared vertex buffers) in its own cull object list
 *   c  three CSM cascades, each with its own thin source mesh returned from the shadow map's getCustomRenderList per layer
 *   p  fill + upload cost at 10k instances per pass (2 views + 3 cascades)
 */
import "@babylonjs/core/Meshes/thinInstanceMesh.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { Frustum } from "@babylonjs/core/Maths/math.frustum.js";
import { Plane } from "@babylonjs/core/Maths/math.plane.js";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { Color3, Matrix, PBRMaterial, Vector3, Viewport, buildGraph, buildGraph2, CreateBox, CreatePlane, DirectionalLight, drawLog, drawsOf, flat, makeEnv, orthoCamera, readCanvas, settle, state, stats, count, type AbstractMesh, type Env, type ViewSpec } from "./harness2";
import { selectLevels } from "./test1";
import type { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator.js";

/** A box's data as one set of shared Babylon vertex buffers; `source()` makes a thin source mesh on them with an own index buffer. */
function sharedBox(env: Env, size: number): { source(name: string): Mesh; positions: number } {
  const vd = VertexData.CreateBox({ size });
  const vb = [
    new VertexBuffer(env.engine, vd.positions!, VertexBuffer.PositionKind, false, false, 3),
    new VertexBuffer(env.engine, vd.normals!, VertexBuffer.NormalKind, false, false, 3),
    new VertexBuffer(env.engine, vd.uvs!, VertexBuffer.UVKind, false, false, 2),
  ];
  const verts = vd.positions!.length / 3;
  return {
    positions: verts,
    source(name) {
      const m = new Mesh(name, env.scene);
      for (const b of vb) m.setVerticesBuffer(b, false);
      m.setIndices(vd.indices!, verts, false);
      return m;
    },
  };
}

// ---- v: two views with per-view thin sources ------------------------------------------------------------------
const G = 100, N = G * G, PITCH = 4, VIEW = 400, W = VIEW * 2, H = VIEW;
const CULLED = 255;
const instPos = (i: number): [number, number] => [-198 + PITCH * (i % G), -198 + PITCH * ((i / G) | 0)];

/** Fill a pass's source matrix buffer with the instances `keep` accepts. Returns the count. */
function fillMatrices(all: Float32Array, buf: Float32Array, n: number, keep: (i: number) => boolean): number {
  let c = 0;
  for (let i = 0; i < n; i++) if (keep(i)) { buf.set(all.subarray(i * 16, i * 16 + 16), c * 16); c++; }
  return c;
}
function worldMatrices(n: number, pos: (i: number) => [number, number, number]): Float32Array {
  const all = new Float32Array(n * 16);
  for (let i = 0; i < n; i++) { const p = pos(i); Matrix.Translation(p[0], p[1], p[2]).copyToArray(all, i * 16); }
  return all;
}

export async function t3Views(): Promise<unknown> {
  const env = makeEnv(W, H);
  const box = sharedBox(env, 2);
  const all = worldMatrices(N, (i) => [...instPos(i), 0] as [number, number, number]);
  const levels = [new Uint8Array(N), new Uint8Array(N)];
  const bufs = [new Float32Array(N * 16), new Float32Array(N * 16)];
  const src = [box.source("srcA"), box.source("srcB")];
  src[0].material = flat(env.scene, "A", 1, 0, 0);
  src[1].material = flat(env.scene, "B", 0, 1, 0);
  src.forEach((s, v) => { s.thinInstanceSetBuffer("matrix", bufs[v], 16, false); s.alwaysSelectAsActiveMesh = true; s.isVisible = true; });
  const camA = orthoCamera(env.scene, "A", 200, new Viewport(0, 0, 0.5, 1));
  const camB = orthoCamera(env.scene, "B", 200, new Viewport(0.5, 0, 0.5, 1));
  await buildGraph2(env, [
    { name: "A", camera: camA, objects: [src[0]] },
    { name: "B", camera: camB, objects: [src[1]] },
  ]);
  const frame = 3;
  for (let v = 0; v < 2; v++) selectLevels(v, frame, levels[v]);
  await settle(env, 2);
  for (let v = 0; v < 2; v++) {
    const c = fillMatrices(all, bufs[v], N, (i) => levels[v][i] !== CULLED);
    src[v].thinInstanceCount = c;
    src[v].thinInstanceBufferUpdated("matrix");
  }
  drawLog.length = 0;
  env.scene.render();
  const px = readCanvas(env);
  let mismatches = 0, seenA = 0, seenB = 0, wrongColour = 0;
  for (let i = 0; i < N; i++) for (let v = 0; v < 2; v++) {
    const [x, y] = instPos(i);
    const o = ((200 - y) * W + v * VIEW + x + 200) * 4;
    const r = px[o], g = px[o + 1], b = px[o + 2];
    const red = r > 128 && g < 64 && b < 64, green = g > 128 && r < 64 && b < 64;
    const got = v === 0 ? red : green;
    const other = v === 0 ? green : red;
    if (other) wrongColour++;
    if (got) (v === 0 ? seenA++ : seenB++);
    if (got !== (levels[v][i] !== CULLED)) mismatches++;
  }
  const out = {
    expected: levels.map((l) => l.reduce((n, x) => n + (x !== CULLED ? 1 : 0), 0)), seen: [seenA, seenB], mismatches, wrongColour,
    draws: { A: drawsOf("render:A"), B: drawsOf("render:B") },
  };
  env.dispose();
  return out;
}

// ---- c: cascades -----------------------------------------------------------------------------------------------
const CW = 640, CH = 360;
type CascadeMode = "all" | "perCascade" | "perCascade-emptyLayer";

/** Ground pixels in shadow: dark but not caster-red (the lit ground is bright white). */
const isShadow = (r: number, g: number, b: number): boolean => r < 140 && g < 140 && b < 140 && r > 8 && Math.abs(r - g) < 20 && Math.abs(g - b) < 20;

export async function t3Cascades(mode: CascadeMode, emptyLayer = 1): Promise<unknown> {
  const env = makeEnv(CW, CH);
  const { scene } = env;
  const box = sharedBox(env, 1.2);
  // 9 x 19 casters on the ground in front of a perspective camera.
  const COLS = 9, ROWS = 19, M = COLS * ROWS;
  const pos = (i: number): [number, number, number] => [-12 + 3 * (i % COLS), 0.6, -3 + 3 * ((i / COLS) | 0)];
  const all = worldMatrices(M, pos);
  const ground = CreatePlane("ground", { size: 200 }, scene);
  ground.rotation.x = Math.PI / 2;
  ground.position.set(0, 0, 30);
  const gm = new PBRMaterial("g", scene);
  gm.albedoColor = new Color3(1, 1, 1); gm.metallic = 0; gm.roughness = 1;
  ground.material = gm;
  ground.receiveShadows = true;
  const light = new DirectionalLight("sun", new Vector3(0.3, -1, 0.2).normalize(), scene);
  light.intensity = 1.5;
  light.position = new Vector3(0, 80, 0);
  const amb = new HemisphericLight("amb", new Vector3(0, 1, 0), scene);
  amb.intensity = 0.15;
  const cam = new FreeCamera("cam", new Vector3(0, 3, -4), scene);
  cam.setTarget(new Vector3(0, 0, 10));
  cam.fov = 0.9; cam.minZ = 0.5; cam.maxZ = 45;

  const caster = flat(scene, "red", 1, 0, 0);
  const NC = 3;
  const sources: Mesh[] = [];
  const bufs: Float32Array[] = [];
  const mk = (name: string, capacity: number): Mesh => {
    const s = box.source(name);
    s.material = caster;
    const buf = new Float32Array(capacity * 16);
    bufs.push(buf);
    s.thinInstanceSetBuffer("matrix", buf, 16, false);
    s.alwaysSelectAsActiveMesh = true;
    s.thinInstanceCount = 0;
    sources.push(s);
    return s;
  };
  const sAll = mk("all", M);
  sAll.thinInstanceCount = M;
  all.forEach((v, i) => (bufs[0][i] = v));
  sAll.thinInstanceBufferUpdated("matrix");
  const cas = [0, 1, 2].map((c) => mk(`c${c}`, M));
  const viewSrc = sAll; // the view draws every caster (one source for the view in this test)
  const casters: AbstractMesh[] = mode === "all" ? [sAll] : cas;
  const g = await buildGraph(env, [{ name: "V", camera: cam, objects: [ground, viewSrc] } satisfies ViewSpec], [{ light, camera: cam, casters, cascaded: true, mapSize: 1024, cascades: NC }], undefined, 20000);
  const csm = g.shadows[0].shadowGenerator as unknown as CascadedShadowGenerator;
  const sm = g.shadows[0].shadowGenerator.getShadowMap()!;
  // Per-cascade stats from the shadow map's own hooks.
  const perLayer: { layer: number; selected: number }[] = [];
  const planes = [0, 1, 2, 3, 4, 5].map(() => new Plane(0, 0, 0, 0));
  const selectMs: number[] = [];
  sm.onBeforeRenderObservable.add((layer: number) => { state.tag = `shadow${layer}`; });
  if (mode !== "all") {
    const lists: AbstractMesh[][] = [[], [], []];
    sm.getCustomRenderList = (layer: number) => {
      const t0 = performance.now();
      Frustum.GetPlanesToRef(csm.getCascadeTransformMatrix(layer)!, planes);
      // the engine's test: inside the four sides and nearer the light than the far side (the near side isn't tested)
      const tested = [new Plane(0, 0, 0, 1), planes[1], planes[2], planes[3], planes[4], planes[5]];
      const buf = bufs[1 + layer];
      let n = 0;
      for (let i = 0; i < M; i++) {
        const p = pos(i);
        let inside = true;
        for (const pl of tested) if (pl.normal.x * p[0] + pl.normal.y * p[1] + pl.normal.z * p[2] + pl.d < -1.2) { inside = false; break; }
        if (inside) { buf.set(all.subarray(i * 16, i * 16 + 16), n * 16); n++; }
      }
      const s = cas[layer];
      s.thinInstanceCount = n;
      if (n) s.thinInstanceBufferUpdated("matrix");
      selectMs.push(performance.now() - t0);
      perLayer.push({ layer, selected: n });
      lists[layer].length = 0;
      if (n && !(mode === "perCascade-emptyLayer" && layer === emptyLayer)) lists[layer].push(s);
      return lists[layer];
    };
  }
  await settle(env, 4);
  perLayer.length = 0;
  drawLog.length = 0;
  scene.render();
  const px = readCanvas(env);
  const total = count(px, CW, [0, 0, CW, CH], isShadow);
  // pixel counts in horizontal bands (near rows are the bottom of the picture)
  const bands: number[] = [];
  for (let y0 = 0; y0 < CH; y0 += 45) bands.push(count(px, CW, [0, y0, CW, Math.min(CH, y0 + 45)], isShadow));
  const castersVisible = count(px, CW, [0, 0, CW, CH], (r, gg, b) => r > 128 && gg < 64 && b < 64);
  const shadowDraws = [0, 1, 2].map((l) => drawsOf(`shadow${l}`));
  const out = {
    mode, casters: M, shadowPixels: total, bandsTopToBottom: bands, castersVisiblePx: castersVisible,
    selectedPerLayer: perLayer.map((p) => p.selected),
    shadowDrawsPerLayer: shadowDraws, shadowInstancesTotal: shadowDraws.reduce((s, d) => s + d.instances, 0),
    selectMsPerLayer: selectMs.map((x) => +x.toFixed(3)),
    png: env.canvas.toDataURL(),
  };
  env.dispose();
  return out;
}

// ---- p: fill + upload at 10k instances per pass ----------------------------------------------------------------
export async function t3Perf(frames = 40): Promise<unknown> {
  const env = makeEnv(64, 64);
  const box = sharedBox(env, 2);
  const mats = worldMatrices(N, (i) => [...instPos(i), 0] as [number, number, number]);
  const PASSES = 5; // views A, B, cascades 0, 1, 2
  const bufs = Array.from({ length: PASSES }, () => new Float32Array(N * 16));
  const srcs = bufs.map((b, p) => {
    const s = box.source(`p${p}`);
    s.material = flat(env.scene, `m${p}`, 1, 1, 1);
    s.thinInstanceSetBuffer("matrix", b, 16, false);
    s.alwaysSelectAsActiveMesh = true;
    return s;
  });
  const cam = orthoCamera(env.scene, "c", 200);
  void cam;
  await settle(env, 2);
  // pass p keeps an instance when its rank window says so: views 60 %, cascades 25 / 40 / 60 %
  const keepFrac = [0.6, 0.6, 0.25, 0.4, 0.6];
  const rank = new Float32Array(N);
  for (let i = 0; i < N; i++) rank[i] = (Math.imul(i + 1, 2654435761) >>> 0) / 4294967296;
  const fill: number[][] = Array.from({ length: PASSES }, () => []);
  const upload: number[][] = Array.from({ length: PASSES }, () => []);
  const frameTotal: number[] = [];
  const counts: number[] = [];
  for (let f = 0; f < frames + 5; f++) {
    const shift = (f * 0.013) % 1;
    let total = 0;
    for (let p = 0; p < PASSES; p++) {
      const t0 = performance.now();
      const frac = keepFrac[p];
      const c = fillMatrices(mats, bufs[p], N, (i) => { let r = rank[i] + shift + p * 0.2; if (r >= 1) r -= Math.floor(r); return r < frac; });
      const t1 = performance.now();
      srcs[p].thinInstanceCount = c;
      srcs[p].thinInstanceBufferUpdated("matrix");
      const t2 = performance.now();
      if (f >= 5) { fill[p].push(t1 - t0); upload[p].push(t2 - t1); total += t2 - t0; if (f === 5) counts.push(c); }
    }
    if (f >= 5) frameTotal.push(total);
    env.scene.render(); // flush the uploads, like a frame would
  }
  const out = {
    instancesPerPassBuffer: N, bytesPerPassBuffer: N * 64, bytesAllPasses: PASSES * N * 64, selectedPerPass: counts,
    fillMs: fill.map((a) => stats(a)), uploadMs: upload.map((a) => stats(a)), allFivePassesMs: stats(frameTotal),
    raw: { fill: fill.map((a) => a), upload, frameTotal },
  };
  env.dispose();
  return out;
}
