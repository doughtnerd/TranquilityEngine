/** Result 4: cost. Smoke-level on SwiftShader (a CPU rasteriser on a shared machine): ratios, not absolute GPU numbers. */
import { Color3, CreatePlane, DirectionalLight, flat, makeEnv, Matrix, orthoCamera, PBRMaterial, Vector3, type Env } from "./harness";
import { markFadeBatch, MycoLodFadePlugin } from "./lodFadePlugin";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh.js";

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const syncRead = (env: Env) => env.gl.readPixels(0, 0, 1, 1, env.gl.RGBA, env.gl.UNSIGNED_BYTE, new Uint8Array(4));

/** Full-screen overdraw: L quads stacked front-to-back-passing (each nearer than the last, so none is depth-rejected). */
export async function t4Fragment(): Promise<unknown> {
  const S = 256, L = 16;
  const out: Record<string, unknown> = { canvas: S, layers: L, fragmentsPerFrame: S * S * L };
  for (const lit of [false, true]) {
    const env = makeEnv(S, S);
    env.scene.activeCamera = orthoCamera(env.scene, "cam", 4);
    let mat: PBRMaterial;
    if (lit) {
      mat = new PBRMaterial("lit", env.scene);
      mat.albedoColor = new Color3(1, 1, 1);
      mat.metallic = 0;
      mat.roughness = 0.5;
      new DirectionalLight("sun", new Vector3(0, 0, 1), env.scene).intensity = 2;
    } else mat = flat(env.scene, "unlit", 1, 1, 1);
    new MycoLodFadePlugin(mat);
    const group = (name: string, fade: boolean, value: number): InstancedMesh[] => {
      const src = CreatePlane(name, { size: 8 }, env.scene);
      src.material = mat;
      if (fade) markFadeBatch(src);
      src.isVisible = false;
      return Array.from({ length: L }, (_, k) => {
        const i = src.createInstance(`${name}${k}`);
        i.position.z = (L - k) * 0.01;
        if (fade) (i.instancedBuffers as Record<string, number>).mycoLodFade = value;
        return i;
      });
    };
    const groups: Record<string, InstancedMesh[]> = {
      plain: group("plain", false, 0),
      "fade, f=0 (nothing discarded)": group("f0", true, 0),
      "fade, f=0.5 (half discarded)": group("f5", true, 0.5),
    };
    const only = (name: string) => Object.entries(groups).forEach(([n, g]) => g.forEach((i) => i.setEnabled(n === name)));
    const names = Object.keys(groups);
    for (const n of names) { only(n); for (let i = 0; i < 4; i++) { env.scene.render(); syncRead(env); await new Promise((r) => setTimeout(r, 20)); } }
    const times: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));
    for (let round = 0; round < 5; round++) {
      for (const n of names) {
        only(n);
        for (let f = 0; f < 6; f++) {
          const t0 = performance.now();
          env.scene.render();
          syncRead(env);
          times[n].push(performance.now() - t0);
        }
      }
    }
    const base = median(times.plain);
    out[lit ? "litPBR_1dirLight" : "unlitPBR"] = Object.fromEntries(names.map((n) => [n, { medianMs: +median(times[n]).toFixed(1), minMs: +Math.min(...times[n]).toFixed(1), vsPlain: +(median(times[n]) / base).toFixed(2) }]));
    env.dispose();
  }
  return out;
}

/** CPU-side cost of re-uploading a thin-instance matrix buffer (what a per-view rewrite pays per view). */
export async function t4Upload(): Promise<unknown> {
  const out: Record<string, unknown> = {};
  for (const n of [1000, 10000]) {
    const env = makeEnv(128, 128);
    env.scene.activeCamera = orthoCamera(env.scene, "cam", 4);
    const src = CreatePlane("p", { size: 0.01 }, env.scene);
    src.material = flat(env.scene, "w", 1, 1, 1);
    const buf = new Float32Array(n * 16);
    const proto = new Float32Array(n * 16);
    for (let i = 0; i < n; i++) Matrix.Translation(((i * 37) % 800) / 100 - 4, ((i * 91) % 800) / 100 - 4, 0).copyToArray(proto, i * 16);
    buf.set(proto);
    src.thinInstanceSetBuffer("matrix", buf, 16, false);
    src.thinInstanceCount = n;
    src.alwaysSelectAsActiveMesh = true;
    for (let i = 0; i < 4; i++) { env.scene.render(); syncRead(env); await new Promise((r) => setTimeout(r, 20)); }
    const timeIt = (iters: number, fn: () => void) => { const t0 = performance.now(); for (let i = 0; i < iters; i++) fn(); return (performance.now() - t0) / iters; };
    const fill = timeIt(200, () => buf.set(proto));
    const updated = timeIt(200, () => src.thinInstanceBufferUpdated("matrix"));
    const setBuffer = timeIt(50, () => src.thinInstanceSetBuffer("matrix", buf, 16, false));
    const frame = (rewrite: number) => timeIt(20, () => { for (let k = 0; k < rewrite; k++) { buf.set(proto); src.thinInstanceBufferUpdated("matrix"); } env.scene.render(); syncRead(env); });
    frame(0);
    const f0 = frame(0), f1 = frame(1), f2 = frame(2);
    out[`n=${n}`] = {
      fillJsMs: +fill.toFixed(3), thinInstanceBufferUpdatedMs: +updated.toFixed(3), thinInstanceSetBufferMs: +setBuffer.toFixed(3),
      frameNoRewriteMs: +f0.toFixed(2), frameWith1RewriteMs: +f1.toFixed(2), frameWith2RewritesMs: +f2.toFixed(2), bytes: n * 64,
    };
    env.dispose();
  }
  return out;
}
