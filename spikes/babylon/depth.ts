// Depth-order check page (ADR 0075): a red cube in front of a blue one, with the Playground camera's
// effects and a reflection probe, at the quality tier in `?tier=` (default Ultra). Stepped by hand;
// each frame is copied into a 2D canvas in the same task (a WebGPU canvas reads blank once presented).
// Results land in `window.__depth`: the colour at the middle of the overlap (red = right).
// Open /spikes/babylon/depth.html?renderer=babylon&tier=Ultra on the dev server.
import { Assets, Camera, Color, Engine, GameObject, Graphics, Light, MeshRenderer, PostProcessing, ReflectionProbe, SceneManager, Vector3 } from "../../src/engine/index";
import { defaultGraphics } from "../../src/engine/core/graphics";

type Report = { done: boolean; tier: string; frames: number; center: number[] | null; errors: string[] };
const report: Report = { done: false, tier: "", frames: 0, center: null, errors: [] };
(window as unknown as { __depth: Report }).__depth = report;

async function main() {
  const params = new URLSearchParams(location.search);
  Assets.addSource(
    Assets.fromObject({
      "s.json": { format: "myco.scene@1", nodes: [] },
      "red.material.json": { format: "myco.material@1", color: "#ff2020", roughness: 0.6 },
      "blue.material.json": { format: "myco.material@1", color: "#2040ff", roughness: 0.6 },
    }),
  );
  const container = document.getElementById("view")!;
  const playground = params.get("scene") === "playground";
  if (playground) {
    // The 3D Playground sample itself (`?scene=playground`), played for a few seconds.
    const base = "/samples/playground3d/";
    const files = "effects/campfire.particles.json materials/glow.material.json materials/ground.material.json materials/metal.material.json materials/pulse.material.json materials/water.material.json models/crate.mtl models/crate.obj models/robot.fbx scenes/main.scene.json shaders/pulse.shadergraph.json shaders/ripple.shadersubgraph.json shaders/water.shadergraph.json".split(" ");
    const map: Record<string, unknown> = {};
    for (const f of files) map[f] = f.endsWith(".json") ? await (await fetch(base + f)).json() : base + f;
    Assets.clearSources();
    Assets.addSource(Assets.fromObject(map));
  }
  const engine = await Engine.create({ container, project: { display: { width: 960, height: 540 } } });
  // `?set={"renderScale":1}` overrides fields of the chosen tier, to find which one matters.
  const tierName = params.get("tier") ?? "Ultra";
  const overrides = JSON.parse(params.get("set") ?? "{}") as Record<string, unknown>;
  const graphics = defaultGraphics();
  graphics.tiers = graphics.tiers.map((t) => (t.name === tierName ? { ...t, ...overrides } : t));
  Graphics._configure(graphics, tierName);
  report.tier = `${Graphics.quality} ${JSON.stringify(overrides)}`;
  if (playground) {
    await SceneManager.load("scenes/main.scene.json");
    await runFrames(engine, 180);
    // Magnify the crates (the readback canvas shows this crop).
    const out = document.getElementById("out") as HTMLCanvasElement;
    const src = document.createElement("canvas");
    src.width = out.width;
    src.height = out.height;
    src.getContext("2d")!.drawImage(out, 0, 0);
    out.style.width = "240px";
    out.style.height = "135px";
    out.getContext("2d")!.drawImage(src, src.width * 0.4, src.height * 0.32, src.width * 0.25, src.height * 0.25, 0, 0, out.width, out.height);
    report.done = true;
    return;
  }
  await SceneManager.load("s.json");

  const cam = GameObject.create("Camera");
  cam.transform!.position.set(0, 1, 8);
  cam.addBehavior(Camera, { projection: "perspective", backgroundColor: Color.from("#9ec5e8") });
  if (params.get("post") !== "off") cam.addBehavior(PostProcessing, { bloom: true, ambientOcclusion: true, vignette: true });
  const sun = GameObject.create("Sun");
  sun.transform!.eulerAngles = [-50, 30, 0];
  sun.addBehavior(Light, { type: "directional", intensity: 2, castShadows: true });
  const front = GameObject.create("Front");
  front.transform!.position.set(0.4, 1, 2);
  front.addBehavior(MeshRenderer, { mesh: "builtin:cube", material: "red.material.json" });
  const back = GameObject.create("Back");
  back.transform!.position.set(-0.4, 1, -1);
  back.addBehavior(MeshRenderer, { mesh: "builtin:cube", material: "blue.material.json" });
  if (params.get("probe") !== "off") GameObject.create("Probe").addBehavior(ReflectionProbe, { size: new Vector3(10, 10, 10) });

  await runFrames(engine, 120);
  report.done = true;
}

/** Step the engine by hand, copying each frame into the visible 2D canvas in the same task. */
async function runFrames(engine: Engine, count: number): Promise<void> {
  const out = document.getElementById("out") as HTMLCanvasElement;
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  const canvas = document.querySelector("#view canvas") as HTMLCanvasElement;
  const scenes = () => (globalThis as { __mycoBabylonScenes?: { getEngine(): { _device?: GPUDevice } }[] }).__mycoBabylonScenes ?? [];
  let listening = false;
  for (let i = 0; i < count; i++) {
    engine.step(1 / 60);
    report.frames = i + 1;
    out.width = canvas.width;
    out.height = canvas.height;
    ctx.drawImage(canvas, 0, 0);
    const d = ctx.getImageData(Math.floor(out.width / 2), Math.floor(out.height * 0.45), 1, 1).data;
    report.center = [d[0], d[1], d[2]];
    const device = scenes().at(-1)?.getEngine()._device;
    if (device && !listening) {
      listening = true;
      device.addEventListener("uncapturederror", (ev: Event) => report.errors.push((ev as GPUUncapturedErrorEvent).error.message.slice(0, 400)));
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  report.done = true;
}
main().catch((err) => {
  report.errors.push(String(err?.stack ?? err));
  report.done = true;
});
