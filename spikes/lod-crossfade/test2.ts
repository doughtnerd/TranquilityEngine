/** Result 2: the dither crossfade plugin: complement coverage, coexistence with another plugin and with instancing, effect counts. */
import { count, CreatePlane, drawLog, drawsOf, effectCount, flat, makeEnv, mask, orthoCamera, readCanvas, settle, state, Matrix, type Env, type Mesh } from "./harness";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh.js";
import { markFadeBatch, MycoLodFadePlugin, MycoTestOffsetPlugin } from "./lodFadePlugin";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";

const N = 256; // canvas size; ortho half-width 4 => 32 px per unit
const lit = (r: number, g: number, b: number) => r > 128 || g > 128 || b > 128;

/** The material: unlit white PBR + stand-in vertex plugin (priority 200, optional) + the fade plugin (priority 220). */
function fadeMaterial(env: Env, offset: boolean): PBRMaterial {
  const m = flat(env.scene, "fadeMat", 1, 1, 1);
  if (offset) new MycoTestOffsetPlugin(m, 1); // +1 unit = +32 px in x
  new MycoLodFadePlugin(m);
  return m;
}

type Kind = "instances" | "thin";
interface Unit { mesh: Mesh; set(v: number): void; show(on: boolean): void; node: Mesh | InstancedMesh }

/** A fade-capable unit on one material: an InstancedMesh batch source's instance, or a thin-instance mesh (one slot). */
function unit(env: Env, kind: Kind, mat: PBRMaterial, name: string, size: number, x: number, fade: boolean): Unit {
  const src = CreatePlane(name, { size }, env.scene);
  src.material = mat;
  if (kind === "instances") {
    if (fade) markFadeBatch(src);
    src.isVisible = false;
    const inst = src.createInstance(`${name}:i`);
    inst.position.x = x;
    return { mesh: src, node: inst, set: (v) => { if (fade) (inst.instancedBuffers as Record<string, number>).mycoLodFade = v; }, show: (on) => inst.setEnabled(on) };
  }
  const fadeBuf = new Float32Array(1);
  const mtx = new Float32Array(16);
  Matrix.Translation(x, 0, 0).copyToArray(mtx);
  src.thinInstanceSetBuffer("matrix", mtx, 16, false);
  if (fade) markFadeBatch(src, fadeBuf);
  src.thinInstanceRefreshBoundingInfo(true);
  return { mesh: src, node: src, set: (v) => { fadeBuf[0] = v; if (fade) src.thinInstanceBufferUpdated("mycoLodFade"); }, show: (on) => src.setEnabled(on) };
}

async function grab(env: Env, units: Unit[], only: Unit | null): Promise<Uint8Array> {
  for (const u of units) u.show(u === only);
  env.scene.render();
  return readCanvas(env);
}

/** Coverage of two coincident levels: A (steady -> outgoing, +t) and B (incoming, -t), against the plain silhouette. */
export async function t2Complement(kind: Kind, offset: boolean): Promise<unknown> {
  const env = makeEnv(N, N);
  const mat = fadeMaterial(env, offset);
  env.scene.activeCamera = orthoCamera(env.scene, "cam", 4);
  const plain = unit(env, kind, mat, "plain", 4, 0, false);
  const a = unit(env, kind, mat, "levelA", 4, 0, true);
  const b = unit(env, kind, mat, "levelB", 4, 0, true);
  const units = [plain, a, b];
  await settle(env, 4);
  const sil = mask(await grab(env, units, plain), lit);
  const total = sil.reduce((s, v) => s + v, 0);
  let xmin = N, xmax = -1;
  for (let i = 0; i < sil.length; i++) if (sil[i]) { xmin = Math.min(xmin, i % N); xmax = Math.max(xmax, i % N); }
  const rows: unknown[] = [];
  let allExact = true;
  for (const t of [0, 1 / 16, 0.1, 0.3, 0.5, 0.75, 15 / 16, 1]) {
    a.set(t);
    b.set(-Math.max(t, 1e-6)); // an incoming level at t = 0 is encoded as a tiny negative (-0 is not < 0)
    const ma = mask(await grab(env, units, a), lit);
    const mb = mask(await grab(env, units, b), lit);
    let nA = 0, nB = 0, both = 0, holes = 0, outside = 0;
    for (let i = 0; i < ma.length; i++) {
      nA += ma[i]; nB += mb[i];
      if (ma[i] && mb[i]) both++;
      if (sil[i] && !ma[i] && !mb[i]) holes++;
      if (!sil[i] && (ma[i] || mb[i])) outside++;
    }
    const exact = both === 0 && holes === 0 && outside === 0;
    allExact = allExact && exact;
    rows.push({ t, expectKeepA: Math.round(total * (16 - Math.round(t * 16)) / 16), nA, nB, double: both, holes, outside });
  }
  // Both levels in the same frame (what the engine would draw): the union has no hole and the silhouette stays complete.
  a.set(0.3); b.set(-0.3);
  for (const u of units) u.show(u !== plain);
  env.scene.render();
  const both = mask(readCanvas(env), lit);
  let holesBoth = 0;
  for (let i = 0; i < both.length; i++) if (sil[i] && !both[i]) holesBoth++;
  const eff = { plain: plain.mesh.subMeshes[0].effect, a: a.mesh.subMeshes[0].effect };
  const out = {
    kind, offsetPlugin: offset, silhouettePx: total, silhouetteX: [xmin, xmax], rows, allExact, holesWhenBothDrawn: holesBoth,
    effectsDiffer: eff.plain !== eff.a,
    definesPlain: eff.plain?.defines.includes("MYCO_LOD_FADE"),
    definesFade: eff.a?.defines.includes("MYCO_LOD_FADE"),
  };
  env.dispose();
  return out;
}

/** Per-instance values in one draw call: two instances of one fade source, f = 0 and f = 0.5, plus drawn with the offset plugin. */
export async function t2PerInstance(kind: Kind): Promise<unknown> {
  const env = makeEnv(N, N);
  const mat = fadeMaterial(env, false);
  env.scene.activeCamera = orthoCamera(env.scene, "cam", 4);
  const src = CreatePlane("fadeSrc", { size: 2 }, env.scene);
  src.material = mat;
  let draws: { calls: number; instances: number };
  if (kind === "instances") {
    markFadeBatch(src);
    src.isVisible = false;
    const l = src.createInstance("l"); l.position.x = -1.5; (l.instancedBuffers as Record<string, number>).mycoLodFade = 0;
    const r = src.createInstance("r"); r.position.x = 1.5; (r.instancedBuffers as Record<string, number>).mycoLodFade = 0.5;
  } else {
    const mtx = new Float32Array(32);
    Matrix.Translation(-1.5, 0, 0).copyToArray(mtx, 0);
    Matrix.Translation(1.5, 0, 0).copyToArray(mtx, 16);
    src.thinInstanceSetBuffer("matrix", mtx, 16, false);
    markFadeBatch(src, new Float32Array([0, 0.5]));
    src.thinInstanceRefreshBoundingInfo(true);
  }
  await settle(env, 4);
  drawLog.length = 0;
  state.tag = "frame";
  env.scene.render();
  draws = drawsOf("frame");
  const px = readCanvas(env);
  const left = count(px, N, [0, 0, 128, N], lit), right = count(px, N, [128, 0, N, N], lit);
  env.dispose();
  return { kind, leftPx: left, rightPx: right, expectLeft: 64 * 64, expectRight: 64 * 64 * 0.5, draws };
}

/** Compiled-effect counts without and with fading meshes (fresh engine each, so the effect cache starts empty). */
export async function t2EffectCounts(): Promise<unknown> {
  const out: Record<string, unknown> = {};
  const run = async (label: string, build: (env: Env, mat: PBRMaterial) => void) => {
    const env = makeEnv(64, 64);
    const base = effectCount(env);
    const mat = fadeMaterial(env, true);
    env.scene.activeCamera = orthoCamera(env.scene, "cam", 4);
    build(env, mat);
    await settle(env, 4);
    const keys = Object.keys((env.engine as unknown as { _compiledEffects: object })._compiledEffects);
    out[label] = { effects: effectCount(env) - base, shaders: keys.map((k) => `${k.split("@")[0]}${/MYCO_LOD_FADE/.test(k) ? "+FADE" : ""}${/THIN_INSTANCES/.test(k) ? "+THIN" : /INSTANCES/.test(k) ? "+INST" : ""}`) };
    env.dispose();
  };
  await run("A: steady instances only (plugins on the material, no fade batch)", (env, m) => { unit(env, "instances", m, "s", 2, 0, false); });
  await run("B: + a fade InstancedMesh batch", (env, m) => { unit(env, "instances", m, "s", 2, 0, false); unit(env, "instances", m, "f", 2, 0, true); });
  await run("C: + a fade thin-instance batch too", (env, m) => { unit(env, "instances", m, "s", 2, 0, false); unit(env, "instances", m, "f", 2, 0, true); unit(env, "thin", m, "ft", 2, 0, true); });
  await run("D: steady thin batch only", (env, m) => { unit(env, "thin", m, "st", 2, 0, false); });
  await run("E: steady instances + steady thin + fade instances + fade thin", (env, m) => {
    unit(env, "instances", m, "s", 2, 0, false); unit(env, "thin", m, "st", 2, 0, false); unit(env, "instances", m, "f", 2, 0, true); unit(env, "thin", m, "ft", 2, 0, true);
  });
  return out;
}
