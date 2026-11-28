/**
 * Result 2: shared GPU vertex buffers across level meshes. A 20k-triangle UV sphere (100 x 100 quads, positions + normals + uvs, optionally
 * skin indices + weights), four levels that differ only by index buffer (grid strides 1, 2, 5, 10 -> 20000, 5000, 800, 200 triangles).
 *   baseline  one Mesh per level through VertexData.applyToMesh (today's meshOf): every level uploads its own vertex buffers
 *   sharedVB  one Babylon VertexBuffer per kind, handed to every level mesh with mesh.setVerticesBuffer(); own index buffer each
 *   sharedGeo one Babylon Geometry (one vertex set, ONE concatenated index buffer) applied to all level meshes, a SubMesh range per level
 * GL byte totals come from wrapping createBuffer / bufferData / deleteBuffer; pixels from reading the canvas.
 */
import "@babylonjs/core/Meshes/thinInstanceMesh.js";
import "@babylonjs/core/Meshes/instancedMesh.js";
import { Geometry } from "@babylonjs/core/Meshes/geometry.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { SubMesh } from "@babylonjs/core/Meshes/subMesh.js";
import { Skeleton } from "@babylonjs/core/Bones/skeleton.js";
import { Bone } from "@babylonjs/core/Bones/bone.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { count, flat, makeEnv, orthoCamera, readCanvas, settle, type Env } from "./harness2";

const GRID = 100;
const STRIDES = [1, 2, 5, 10];
const R = 40;
const W = 800, H = 400;
const COLORS: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0]];

// ---- GL buffer accounting ------------------------------------------------------------------------------------
interface GlStats { creates: number; deletes: number; vertexBytes: number; indexBytes: number; otherBytes: number; datas: number }
const gls: GlStats = { creates: 0, deletes: 0, vertexBytes: 0, indexBytes: 0, otherBytes: 0, datas: 0 };
const live = new Map<unknown, number>(); // buffer -> bytes currently allocated
let glPatched = false;
function patchBuffers(): void {
  if (glPatched) return;
  glPatched = true;
  const p = WebGL2RenderingContext.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const bind = new WeakMap<object, { array: unknown; element: unknown }>();
  const createBuffer = p.createBuffer, bindBuffer = p.bindBuffer, bufferData = p.bufferData, deleteBuffer = p.deleteBuffer;
  p.createBuffer = function (this: object) { gls.creates++; return createBuffer.call(this); };
  p.deleteBuffer = function (this: object, b: unknown) { gls.deletes++; live.delete(b); return deleteBuffer.call(this, b); };
  p.bindBuffer = function (this: object, target: number, b: unknown) {
    const s = bind.get(this) ?? { array: null, element: null };
    if (target === 0x8892) s.array = b; else if (target === 0x8893) s.element = b;
    bind.set(this, s);
    return bindBuffer.call(this, target, b);
  };
  p.bufferData = function (this: object, target: number, data: unknown, ...rest: unknown[]) {
    const bytes = typeof data === "number" ? data : (data as ArrayBufferView).byteLength;
    gls.datas++;
    const s = bind.get(this);
    const b = target === 0x8892 ? s?.array : target === 0x8893 ? s?.element : null;
    if (target === 0x8892) gls.vertexBytes += bytes; else if (target === 0x8893) gls.indexBytes += bytes; else gls.otherBytes += bytes;
    if (b) live.set(b, bytes);
    return bufferData.call(this, target, data, ...rest);
  };
}
const snap = (): GlStats & { liveBytes: number; liveBuffers: number } => ({ ...gls, liveBytes: [...live.values()].reduce((a, b) => a + b, 0), liveBuffers: live.size });
const diff = (a: ReturnType<typeof snap>, b: ReturnType<typeof snap>): Record<string, number> => {
  const o: Record<string, number> = {};
  for (const k of Object.keys(a) as (keyof typeof a)[]) o[k] = b[k] - a[k];
  return o;
};

// ---- the model ----------------------------------------------------------------------------------------------------
interface Model { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array[]; matIdx: Float32Array; matWeights: Float32Array; verts: number }
function buildModel(): Model {
  const n = GRID + 1;
  const positions = new Float32Array(n * n * 3), normals = new Float32Array(n * n * 3), uvs = new Float32Array(n * n * 2);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const th = (i / GRID) * Math.PI, ph = (j / GRID) * Math.PI * 2;
    const x = Math.sin(th) * Math.cos(ph), y = Math.cos(th), z = Math.sin(th) * Math.sin(ph);
    const v = i * n + j;
    positions.set([x * R, y * R, z * R], v * 3);
    normals.set([x, y, z], v * 3);
    uvs.set([j / GRID, i / GRID], v * 2);
  }
  const indices = STRIDES.map((s) => {
    const out: number[] = [];
    for (let i = 0; i < GRID; i += s) for (let j = 0; j < GRID; j += s) {
      const a = i * n + j, b = i * n + j + s, c = (i + s) * n + j, d = (i + s) * n + j + s;
      out.push(a, b, c, b, d, c);
    }
    return Uint32Array.from(out);
  });
  const verts = n * n;
  const matIdx = new Float32Array(verts * 4); // all bone 0
  const matWeights = new Float32Array(verts * 4);
  for (let v = 0; v < verts; v++) matWeights[v * 4] = 1;
  return { positions, normals, uvs, indices, matIdx, matWeights, verts };
}

type Scenario = "baseline" | "sharedVB" | "sharedGeo";

/** One set of level meshes through the chosen path. */
function levelMeshes(env: Env, model: Model, scenario: Scenario, tag: string, skinned: boolean, shared?: { vb: VertexBuffer[]; geo?: Geometry; ranges?: number[] }): { meshes: Mesh[]; shared: NonNullable<typeof shared> } {
  const { scene, engine } = env;
  const meshes: Mesh[] = [];
  if (scenario === "baseline") {
    for (let k = 0; k < STRIDES.length; k++) {
      const m = new Mesh(`${tag}${k}`, scene);
      const vd = new VertexData();
      vd.positions = model.positions; vd.normals = model.normals; vd.uvs = model.uvs; vd.indices = model.indices[k];
      if (skinned) { vd.matricesIndices = model.matIdx; vd.matricesWeights = model.matWeights; }
      vd.applyToMesh(m, false);
      meshes.push(m);
    }
    return { meshes, shared: { vb: [] } };
  }
  if (!shared) {
    const vb = [
      new VertexBuffer(engine, model.positions, VertexBuffer.PositionKind, false, false, 3),
      new VertexBuffer(engine, model.normals, VertexBuffer.NormalKind, false, false, 3),
      new VertexBuffer(engine, model.uvs, VertexBuffer.UVKind, false, false, 2),
    ];
    if (skinned) {
      vb.push(new VertexBuffer(engine, model.matIdx, VertexBuffer.MatricesIndicesKind, false, false, 4));
      vb.push(new VertexBuffer(engine, model.matWeights, VertexBuffer.MatricesWeightsKind, false, false, 4));
    }
    shared = { vb };
    if (scenario === "sharedGeo") {
      const all = new Uint32Array(model.indices.reduce((s, a) => s + a.length, 0));
      const ranges: number[] = [];
      let o = 0;
      for (const a of model.indices) { ranges.push(o); all.set(a, o); o += a.length; }
      const geo = new Geometry(`geo${tag}`, scene);
      for (const b of vb) geo.setVerticesBuffer(b, model.verts);
      geo.setIndices(all, model.verts);
      shared.geo = geo; shared.ranges = ranges;
    }
  }
  for (let k = 0; k < STRIDES.length; k++) {
    const m = new Mesh(`${tag}${k}`, scene);
    if (scenario === "sharedVB") {
      for (const b of shared.vb) m.setVerticesBuffer(b, false);
      m.setIndices(model.indices[k], model.verts, false);
    } else {
      shared.geo!.applyToMesh(m);
      m.subMeshes = [];
      new SubMesh(0, 0, model.verts, shared.ranges![k], model.indices[k].length, m);
    }
    meshes.push(m);
  }
  return { meshes, shared };
}

interface DrawRec { fn: string; count: number; instances: number }
const draws: DrawRec[] = [];
let drawPatched = false;
function patchDraws(): void {
  if (drawPatched) return;
  drawPatched = true;
  const p = WebGL2RenderingContext.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const fn of ["drawElements", "drawElementsInstanced"]) {
    const orig = p[fn];
    p[fn] = function (this: object, ...a: unknown[]) { draws.push({ fn, count: a[1] as number, instances: fn.endsWith("Instanced") ? (a[4] as number) : 1 }); return orig.apply(this, a); };
  }
}

/** Cell pixel counts: 4 rows (plain, InstancedMesh, thin, skinned-shift) x 4 level columns, each cell 200 x 100. */
function cells(px: Uint8Array, rows: number): number[][] {
  const cellH = H / rows;
  const out: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: number[] = [];
    for (let k = 0; k < 4; k++) {
      const c = COLORS[k];
      row.push(count(px, W, [k * 200, r * cellH, (k + 1) * 200, (r + 1) * cellH], (R_, G_, B_) => (c[0] ? R_ > 128 : R_ < 64) && (c[1] ? G_ > 128 : G_ < 64) && (c[2] ? B_ > 128 : B_ < 64) && (R_ + G_ + B_ > 128)));
    }
    out.push(row);
  }
  return out;
}

export async function t2Scenario(scenario: Scenario, skinned = false): Promise<unknown> {
  patchBuffers(); patchDraws();
  const env = makeEnv(W, H);
  const { scene } = env;
  const model = buildModel();
  const cam = orthoCamera(scene, "c", 400);
  cam.orthoTop = 200; cam.orthoBottom = -200;
  const mats = COLORS.map((c, k) => flat(scene, `m${k}`, c[0], c[1], c[2]));
  const skeleton = skinned ? new Skeleton("sk", "sk", scene) : null;
  const bone = skeleton ? new Bone("b0", skeleton, null, Matrix.Identity()) : null;
  void bone;
  const before = snap();
  // Rows: 0 level meshes themselves, 1 InstancedMesh of each, 2 thin source (separate meshes, sharing the same buffers) with one thin instance each
  const set1 = levelMeshes(env, model, scenario, "L", skinned);
  const afterLevels = snap();
  const x = (k: number): number => -300 + 200 * k;
  set1.meshes.forEach((m, k) => {
    m.material = mats[k];
    m.position.set(x(k), 150, 0);
    if (skeleton) m.skeleton = skeleton;
  });
  const instances = set1.meshes.map((m, k) => {
    const i = m.createInstance(`inst${k}`);
    i.position.set(x(k), 50, 0);
    return i;
  });
  void instances;
  const afterInstances = snap();
  const set2 = levelMeshes(env, model, scenario, "T", skinned, scenario === "baseline" ? undefined : set1.shared);
  const afterThinSources = snap();
  set2.meshes.forEach((m, k) => {
    m.material = mats[k];
    if (skeleton) m.skeleton = skeleton;
    const buf = new Float32Array(16);
    Matrix.Translation(x(k), -50, 0).copyToArray(buf);
    m.thinInstanceSetBuffer("matrix", buf, 16, true);
    m.alwaysSelectAsActiveMesh = true;
  });
  const afterThin = snap();
  // The skinned variant moves bone 0 down by 12 px: the sphere centroid must shift on every level (shared weights drive every level).
  if (skeleton) {
    skeleton.bones[0].updateMatrix(Matrix.Translation(0, -12, 0), false, true);
  }
  await settle(env, 3);
  draws.length = 0;
  scene.render();
  const frameDraws = draws.slice();
  const afterRender = snap();
  const px = readCanvas(env);
  const grid = cells(px, 4); // rows of 100 px: [0] y=150 meshes, [1] y=50 instances, [2] y=-50 thin, [3] empty
  // centroid rows for the skinned shift check (row-0 spheres: expected centre at canvas row 200 - 150 = 50, or 80 when skinned)
  const centroidRow = (r: number, k: number): number => {
    let sum = 0, n = 0;
    for (let y = r * 100; y < r * 100 + 105; y++) for (let xx = k * 200; xx < (k + 1) * 200; xx++) {
      const i = (y * W + xx) * 4;
      if (px[i] > 128 || px[i + 1] > 128 || px[i + 2] > 128) { sum += y - r * 100; n++; }
    }
    return n ? +(sum / n).toFixed(1) : -1;
  };
  const out = {
    scenario, skinned,
    levelTriangles: model.indices.map((a) => a.length / 3),
    bytes: {
      levelMeshes: diff(before, afterLevels),
      instancedMeshes: diff(afterLevels, afterInstances),
      thinSources: diff(afterInstances, afterThinSources),
      thinBuffers: diff(afterThinSources, afterThin),
      firstRender: diff(afterThin, afterRender),
      total: diff(before, afterRender),
    },
    liveGpuBuffers: afterRender.liveBuffers,
    liveGpuBytes: afterRender.liveBytes - before.liveBytes,
    pixels: { plainRow: grid[0], instancedRow: grid[1], thinRow: grid[2], emptyRow: grid[3] },
    centroidRowInCell: [0, 1, 2].map((r) => [0, 1, 2, 3].map((k) => centroidRow(r, k))),
    drawCalls: frameDraws.length,
    drawIndexCounts: frameDraws.map((d) => `${d.count}x${d.instances}`),
    canvasHash: hash(px),
    bonePalette: skeleton ? Array.from(skeleton.getTransformMatrices(set1.meshes[0]).slice(0, 16)) : undefined,
    useBones: skeleton ? set1.meshes.map((m) => m.useBones) : undefined,
    png: env.canvas.toDataURL(),
  };
  // Dispose three of the four level meshes of set1 + all the second set: the survivor must still draw (shared buffers are ref counted).
  const disposeCheck = disposeSurvivor(env, set1.meshes, set2.meshes, scenario);
  env.dispose();
  return { ...out, ...(await disposeCheck) };
}

function hash(px: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < px.length; i += 7) h = Math.imul(h ^ px[i], 16777619) >>> 0;
  return h.toString(16);
}

async function disposeSurvivor(env: Env, set1: Mesh[], set2: Mesh[], scenario: Scenario): Promise<unknown> {
  const { scene } = env;
  const before = snap();
  for (const m of set2) m.dispose();
  for (let k = 1; k < 4; k++) set1[k].dispose();
  scene.render();
  const afterOther = snap();
  const px = readCanvas(env);
  const survivor = cells(px, 4)[0];
  return { afterDispose: { deletedBuffers: afterOther.deletes - before.deletes, liveBuffersLeft: afterOther.liveBuffers, survivorPixels: survivor, note: `${scenario}: level 0 mesh left drawing after the others were disposed` } };
}

/** Disposing the last level mesh frees the shared buffers (no leak). */
export async function t2Dispose(): Promise<unknown> {
  patchBuffers();
  const env = makeEnv(W, H);
  const model = buildModel();
  const out: Record<string, unknown> = {};
  for (const scenario of ["sharedVB", "sharedGeo"] as Scenario[]) {
    const s0 = snap();
    const { meshes } = levelMeshes(env, model, scenario, "D", false);
    const s1 = snap();
    meshes.forEach((m) => m.dispose());
    const s2 = snap();
    out[scenario] = { createdLive: s1.liveBuffers - s0.liveBuffers, liveAfterAllDisposed: s2.liveBuffers - s0.liveBuffers, deletesTotal: s2.deletes - s1.deletes };
  }
  env.dispose();
  return out;
}
void Vector3;
