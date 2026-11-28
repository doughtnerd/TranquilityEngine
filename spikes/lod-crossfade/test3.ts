/** Result 3: does the shadow generator's depth shader honour the fade discard, and what makes it. */
import { ShadowDepthWrapper } from "@babylonjs/core/Materials/shadowDepthWrapper.js";
import { buildGraph, Color3, count, CreateBox, CreatePlane, DirectionalLight, effectCount, flat, makeEnv, orthoCamera, PBRMaterial, readCanvas, sleep, ShadowGenerator, Vector3, type ViewSpec } from "./harness";
import { markFadeBatch, MycoLodFadePlugin } from "./lodFadePlugin";

const S = 256;
const dark = (r: number, g: number, b: number) => r < 25 && g < 25 && b < 25;

type Mode = "plain" | "noWrapper" | "wrapperBase" | "wrapperStandalone";

interface Variant { mode: Mode; t: number; withB?: boolean; filter?: number; hideCaster?: boolean }

/** One shadow-only scene (the casters are hidden from the camera by layer mask): returns the wall pixels and the effect count. */
async function shadowRun(v: Variant): Promise<{ px: Uint8Array; effects: number; shadowEffects: string[]; ready: string }> {
  const env = makeEnv(S, S);
  const base = effectCount(env);
  const scene = env.scene;
  const wall = CreatePlane("wall", { width: 16, height: 8 }, scene);
  wall.position.z = 6; // the shadow lands 3 units right of its caster (light x/z = 0.5)
  const wm = new PBRMaterial("wallMat", scene);
  wm.albedoColor = new Color3(1, 1, 1);
  wm.metallic = 0;
  wm.roughness = 1;
  wall.material = wm;
  wall.receiveShadows = true;
  const light = new DirectionalLight("sun", new Vector3(0.5, 0, 1).normalize(), scene);
  light.intensity = 3;
  light.position = new Vector3(-10, 0, -20);

  const mat = flat(scene, "fadeMat", 1, 0, 0);
  new MycoLodFadePlugin(mat);
  const fade = v.mode !== "plain";
  const mk = (name: string, value: number) => {
    const src = CreateBox(`${name}Src`, { size: 2 }, scene);
    src.material = mat;
    if (fade) markFadeBatch(src);
    src.isVisible = false;
    const inst = src.createInstance(name);
    inst.position.x = -3;
    if (v.hideCaster) inst.layerMask = 0x2; // the camera (layerMask 1) never draws it; the shadow map ignores the mask
    if (fade) (inst.instancedBuffers as Record<string, number>).mycoLodFade = value;
    return { src, inst };
  };
  const a = mk("A", v.t);
  const casters = [a.src, a.inst];
  if (v.withB) {
    const b = mk("B", -Math.max(v.t, 1e-6));
    casters.push(b.src, b.inst);
  }
  if (v.mode === "wrapperBase") {
    mat.shadowDepthWrapper = new ShadowDepthWrapper(mat, scene); // splices the shadow code into the full PBR+plugin shaders
  } else if (v.mode === "wrapperStandalone") {
    const depth = flat(scene, "fadeDepthMat", 1, 1, 1); // unlit twin carrying only the vertex-side plugins and the fade plugin
    new MycoLodFadePlugin(depth);
    mat.shadowDepthWrapper = new ShadowDepthWrapper(depth, scene, { standalone: true });
  }
  const cam = orthoCamera(scene, "cam", 6);
  cam.layerMask = 0x1;
  const views: ViewSpec[] = [{ name: "V", camera: cam, objects: [wall, ...casters] }];
  const g = await buildGraph(env, views, [{ light, camera: cam, casters, mapSize: 1024, filter: v.filter ?? ShadowGenerator.FILTER_NONE }], undefined, 2500);
  // `graphReadyAtBuild`: did the frame graph report ready before any frame was rendered (shaders compiled by readiness checks alone)?
  const ready = `graphReadyAtBuild=${g.ready}`;
  for (let i = 0; i < 6; i++) { env.scene.render(); await sleep(30); }
  env.scene.render();
  const px = readCanvas(env);
  const keys = Object.keys((env.engine as unknown as { _compiledEffects: object })._compiledEffects);
  const res = { ready, px, effects: effectCount(env) - base, shadowEffects: keys.filter((k) => /^shadowMap|DEPTH|SHADOW/i.test(k.split("@")[0]) || /@.*#define SHADOWDEPTH|SHADOWDEPTH/.test(k)).map((k) => k.slice(0, 40)) };
  env.dispose();
  return res;
}

const region = (px: Uint8Array) => count(px, S, [0, 50, S, 206], dark);

export async function t3Shadows(): Promise<unknown> {
  const plain = await shadowRun({ mode: "plain", t: 0 });
  const N = region(plain.px);
  const rows: Record<string, unknown>[] = [{ variant: "plain mesh (no define), default shadow shader", shadowPx: N, effects: plain.effects, ready: plain.ready }];
  for (const mode of ["noWrapper", "wrapperBase", "wrapperStandalone"] as Mode[]) {
    for (const t of mode === "noWrapper" ? [0.5] : [0.25, 0.5, 0.75]) {
      const r = await shadowRun({ mode, t });
      rows.push({ variant: `fade batch, ${mode}, outgoing t=${t}`, shadowPx: region(r.px), fractionOfPlain: +(region(r.px) / N).toFixed(3), expectIfHonoured: +((16 - Math.round(t * 16)) / 16).toFixed(3), effects: r.effects, ready: r.ready });
    }
  }
  for (const mode of ["noWrapper", "wrapperStandalone"] as Mode[]) {
    const r = await shadowRun({ mode, t: 0.3, withB: true });
    rows.push({ variant: `two coincident levels A(+0.3) and B(-0.3), ${mode}: shadow union`, shadowPx: region(r.px), fractionOfPlain: +(region(r.px) / N).toFixed(3), effects: r.effects });
  }
  for (const mode of ["wrapperBase", "wrapperStandalone"] as Mode[]) {
    const r = await shadowRun({ mode, t: 0.5, hideCaster: true });
    rows.push({ variant: `${mode}, t=0.5, caster never drawn by a camera (layer mask)`, ready: r.ready, shadowPx: region(r.px), fractionOfPlain: +(region(r.px) / N).toFixed(3), effects: r.effects });
  }
  // Softened by PCF: the mean brightness inside the plain shadow (0 = black) vs the lit wall.
  const lumaIn = async (v: Variant) => {
    const mapPlain = (await shadowRun({ mode: "plain", t: 0, filter: v.filter })).px;
    const r = await shadowRun(v);
    let sum = 0, n = 0, lit = 0;
    for (let y = 50; y < 206; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      if (dark(mapPlain[i], mapPlain[i + 1], mapPlain[i + 2])) { sum += r.px[i]; n++; }
    }
    lit = r.px[(128 * S + 250) * 4]; // a lit wall pixel at the far right
    return { meanInsidePlainShadow: +(sum / n).toFixed(1), litWall: lit, density: +(1 - sum / n / lit).toFixed(3) };
  };
  const pcf = { plainPCF: await lumaIn({ mode: "plain", t: 0, filter: ShadowGenerator.FILTER_PCF }), fadeStandalonePCF_t05: await lumaIn({ mode: "wrapperStandalone", t: 0.5, filter: ShadowGenerator.FILTER_PCF }) };
  return { rows, pcf };
}
