// Clustered against regular lights (ADR 0079): the same scene drawn twice, once with point and spot
// lights in Babylon's clustered light container and once as the scene's own lights, and the frames
// compared pixel by pixel. Four spot lights point straight down at a matte floor, at spotSoftness 0,
// 0.2, 0.5 and 1 from left to right; a point light sits over a sphere at the front. Stepped by hand;
// each frame is copied to a 2D canvas in the same task (a WebGPU canvas reads blank once presented).
// Results land in `window.__lights`. Open /spikes/babylon/lights.html on the dev server; `?tier=`
// picks the quality tier (default Ultra), `?frames=` the frames per run (default 90).
import { Assets, Camera, Color, Engine, Environment, GameObject, Graphics, Light, MeshRenderer, SceneManager } from "../../src/engine/index";
import { defaultGraphics } from "../../src/engine/core/graphics";
import { _setClustering } from "../../src/engine/render/babylon/lighting";

const SOFTNESS = [0, 0.2, 0.5, 1];

interface Run {
  clustered: boolean;
  /** Lights in the clustered container when the frame was taken. */
  inContainer: number;
  /** The scene's own point and spot lights (not in the container). */
  ownLights: number;
}
type Report = {
  done: boolean;
  tier: string;
  runs: Run[];
  /** Per spot light (left to right) and the point light: the largest and mean channel difference (0–255), and pixels differing by more than 2. */
  regions: { name: string; max: number; mean: number; over2: number; pixels: number }[];
  whole: { max: number; mean: number; over2: number };
  errors: string[];
};
const report: Report = { done: false, tier: "", runs: [], regions: [], whole: { max: 0, mean: 0, over2: 0 }, errors: [] };
(window as unknown as { __lights: Report }).__lights = report;
const log = (s: string) => (document.getElementById("log")!.textContent += `${s}\n`);

type BabylonScene = { lights: { getClassName(): string; lights?: unknown[] }[]; getEngine(): { _device?: GPUDevice } };
const scenes = () => (globalThis as { __mycoBabylonScenes?: BabylonScene[] }).__mycoBabylonScenes ?? [];

function buildScene(): void {
  const cam = GameObject.create("Camera");
  cam.transform!.position.set(0, 14, 0);
  cam.transform!.eulerAngles = [-90, 0, 0];
  cam.addBehavior(Camera, { projection: "perspective", backgroundColor: Color.from("#000000") });
  GameObject.create("Ambient").addBehavior(Light, { type: "ambient", intensity: 0.03 });
  // No image-based light: only the lights under test reach the floor.
  GameObject.create("Environment").addBehavior(Environment, { intensity: 0, skybox: false });
  const floor = GameObject.create("Floor");
  floor.transform!.scale.set(3, 1, 2);
  floor.addBehavior(MeshRenderer, { mesh: "builtin:plane", material: "floor.material.json" });
  SOFTNESS.forEach((softness, i) => {
    const spot = GameObject.create(`Spot ${softness}`);
    spot.transform!.position.set(-9 + i * 6, 5, -2.5);
    spot.transform!.eulerAngles = [-90, 0, 0];
    spot.addBehavior(Light, { type: "spot", intensity: 25, range: 9, spotAngle: 50, spotSoftness: softness, color: Color.from("#ffffff") });
  });
  const ball = GameObject.create("Ball");
  ball.transform!.position.set(0, 1, 4);
  ball.addBehavior(MeshRenderer, { mesh: "builtin:sphere", material: "floor.material.json" });
  const point = GameObject.create("Point");
  point.transform!.position.set(1.5, 2.5, 4.5);
  point.addBehavior(Light, { type: "point", intensity: 4, range: 6, color: Color.from("#ffd9a0") });
}

/** Draw `count` frames of a fresh Engine and return the last one's pixels, with what the scene's lights were. */
async function run(clustered: boolean, count: number, out: HTMLCanvasElement): Promise<{ image: ImageData; run: Run }> {
  _setClustering(clustered);
  const container = document.getElementById("view")!;
  container.replaceChildren();
  const engine = await Engine.create({ container, project: { display: { width: 960, height: 540 } } });
  await SceneManager.load("s.json");
  buildScene();
  const canvas = container.querySelector("canvas") as HTMLCanvasElement;
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  let listening = false;
  for (let i = 0; i < count; i++) {
    engine.step(1 / 60);
    out.width = canvas.width;
    out.height = canvas.height;
    ctx.drawImage(canvas, 0, 0);
    const device = scenes().at(-1)?.getEngine()._device;
    if (device && !listening) {
      listening = true;
      device.addEventListener("uncapturederror", (ev: Event) => report.errors.push((ev as GPUUncapturedErrorEvent).error.message.slice(0, 400)));
    }
    await new Promise((r) => setTimeout(r, 16));
  }
  const scene = scenes().at(-1)!;
  const containers = scene.lights.filter((l) => l.getClassName() === "ClusteredLightContainer");
  const inContainer = containers.reduce((n, c) => n + (c.lights?.length ?? 0), 0);
  const ownLights = scene.lights.filter((l) => l.getClassName() === "PointLight" || l.getClassName() === "SpotLight").length;
  const image = ctx.getImageData(0, 0, out.width, out.height);
  engine.dispose();
  return { image, run: { clustered, inContainer, ownLights } };
}

function compare(a: ImageData, b: ImageData, diff: HTMLCanvasElement): void {
  const w = a.width, h = a.height;
  diff.width = w;
  diff.height = h;
  const d = diff.getContext("2d")!.createImageData(w, h);
  // Regions: the four spot pools (columns across the back half) and the point light's corner (front middle).
  const regions = [...SOFTNESS.map((s, i) => ({ name: `spot softness ${s}`, x0: (i * w) / 4, x1: ((i + 1) * w) / 4, y0: 0, y1: h * 0.55 })), { name: "point light and sphere", x0: w * 0.35, x1: w * 0.7, y0: h * 0.55, y1: h }];
  const stats = regions.map((r) => ({ name: r.name, max: 0, sum: 0, over2: 0, pixels: 0 }));
  let max = 0, sum = 0, over2 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const m = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
      d.data[i] = d.data[i + 1] = d.data[i + 2] = Math.min(255, m * 16);
      d.data[i + 3] = 255;
      max = Math.max(max, m);
      sum += m;
      if (m > 2) over2++;
      regions.forEach((r, k) => {
        if (x < r.x0 || x >= r.x1 || y < r.y0 || y >= r.y1) return;
        const s = stats[k];
        s.max = Math.max(s.max, m);
        s.sum += m;
        s.pixels++;
        if (m > 2) s.over2++;
      });
    }
  }
  diff.getContext("2d")!.putImageData(d, 0, 0);
  report.whole = { max, mean: +(sum / (w * h)).toFixed(3), over2 };
  report.regions = stats.map((s) => ({ name: s.name, max: s.max, mean: +(s.sum / Math.max(1, s.pixels)).toFixed(3), over2: s.over2, pixels: s.pixels }));
}

async function main() {
  const params = new URLSearchParams(location.search);
  Assets.addSource(
    Assets.fromObject({
      "s.json": { format: "myco.scene@1", settings: { physics: "none" }, nodes: [] },
      "floor.material.json": { format: "myco.material@1", color: "#b0b0b0", roughness: 0.9, metalness: 0 },
    }),
  );
  const tierName = params.get("tier") ?? "Ultra";
  const graphics = defaultGraphics();
  Graphics._configure(graphics, tierName);
  report.tier = Graphics.quality;
  const frames = Number(params.get("frames") ?? 90);
  const a = await run(true, frames, document.getElementById("a") as HTMLCanvasElement);
  report.runs.push(a.run);
  log(`clustered run: ${a.run.inContainer} lights in the container, ${a.run.ownLights} of the scene's own`);
  const b = await run(false, frames, document.getElementById("b") as HTMLCanvasElement);
  report.runs.push(b.run);
  log(`regular run: ${b.run.inContainer} lights in the container, ${b.run.ownLights} of the scene's own`);
  _setClustering(true);
  compare(a.image, b.image, document.getElementById("d") as HTMLCanvasElement);
  log(`whole frame: max ${report.whole.max}, mean ${report.whole.mean}, ${report.whole.over2} pixels over 2`);
  for (const r of report.regions) log(`${r.name}: max ${r.max}, mean ${r.mean}, ${r.over2} of ${r.pixels} pixels over 2`);
  if (report.errors.length) log(`GPU errors: ${report.errors.join(" | ")}`);
  report.done = true;
}

main().catch((err) => {
  report.errors.push(String(err?.stack ?? err));
  log(String(err?.stack ?? err));
  report.done = true;
});
