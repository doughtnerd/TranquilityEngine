// Stage 6 check page (ADR 0075): water, fog and a reflection probe on the Babylon backend, stepped by
// hand so it renders even when the window isn't drawing frames. Results land in `window.__stage6`.
// Open /spikes/babylon/stage6.html?renderer=babylon on the dev server.
import { Assets, Camera, Color, Engine, Fog, GameObject, Light, MeshRenderer, ReflectionProbe, SceneManager, Vector3, WaterSurface } from "../../src/engine/index";

type Report = { done: boolean; errors: string[]; compile: string[]; meshes: string[]; frames: number; water: unknown; probes: unknown };
const report: Report = { done: false, errors: [], compile: [], meshes: [], frames: 0, water: null, probes: null };
(window as unknown as { __stage6: Report }).__stage6 = report;

async function main() {
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
  const container = document.getElementById("view")!;
  const engine = await Engine.create({ container, project: { display: { width: 960, height: 540 } } });
  await SceneManager.load("s.json");

  const cam = GameObject.create("Camera");
  cam.transform!.position.set(0, 6, 18);
  cam.transform!.eulerAngles = [-15, 0, 0];
  cam.addBehavior(Camera, { projection: "perspective", backgroundColor: Color.from("#9ec5e8") });
  const sun = GameObject.create("Sun");
  sun.transform!.eulerAngles = [-50, 30, 0];
  sun.addBehavior(Light, { type: "directional", intensity: 2, castShadows: true });
  GameObject.create("Water").addBehavior(WaterSurface, { size: 60 });
  const crate = GameObject.create("Crate");
  crate.transform!.position.set(0, 1, 0);
  crate.addBehavior(MeshRenderer, { mesh: "builtin:cube" });
  const probeNode = GameObject.create("Probe");
  probeNode.transform!.position.set(0, 2, 0);
  probeNode.addBehavior(ReflectionProbe, { size: new Vector3(10, 10, 10) });
  GameObject.create("Fog").addBehavior(Fog, { mode: "linear", near: 10, far: 60, color: Color.from("#b8c8d8") });

  const scenes = () => (globalThis as { __mycoBabylonScenes?: { getEngine(): { _device?: GPUDevice }; meshes: { name: string; subMeshes?: { _drawWrappers?: Record<string, { effect?: { vertexSourceCode?: string; fragmentSourceCode?: string } } | undefined> }[] }[] }[] }).__mycoBabylonScenes ?? [];
  let listening = false;
  for (let i = 0; i < 240; i++) {
    engine.step(1 / 60);
    report.frames = i + 1;
    const s = scenes().at(-1);
    const device = s?.getEngine()._device;
    if (device && !listening) {
      listening = true;
      device.addEventListener("uncapturederror", (ev: Event) => report.errors.push((ev as GPUUncapturedErrorEvent).error.message.slice(0, 600)));
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  const s = scenes().at(-1);
  const device = s?.getEngine()._device;
  report.meshes = s?.meshes.map((m) => m.name) ?? [];
  if (s && device) {
    const seen = new Set<string>();
    for (const m of s.meshes)
      for (const sm of m.subMeshes ?? [])
        for (const dw of Object.values(sm._drawWrappers ?? {})) {
          const e = dw?.effect;
          for (const [kind, src] of [["vertex", e?.vertexSourceCode], ["fragment", e?.fragmentSourceCode]] as const) {
            if (!src || seen.has(src)) continue;
            seen.add(src);
            const info = await device.createShaderModule({ code: src }).getCompilationInfo();
            for (const msg of info.messages.filter((x) => x.type === "error")) report.compile.push(`${m.name} ${kind} L${msg.lineNum}: ${msg.message} | ${src.split("\n")[msg.lineNum - 1]?.trim().slice(0, 160)}`);
          }
        }
  }
  report.done = true;
}

main().catch((err) => {
  report.errors.push(`check failed: ${String(err)}`);
  report.done = true;
});
