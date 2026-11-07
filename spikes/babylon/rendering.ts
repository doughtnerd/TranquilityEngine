// Rendering checks for ADR 0109–0111, driven by Playwright or by hand: `?case=` picks a scene.
// - rendertexture: a camera draws a red sphere on blue into tv.rendertexture.json; a quad in the main
//   camera's view shows it. Samples land in `window.__check`.
import { Assets, Camera, Color, Engine, Environment, GameObject, Graphics, Light, MeshRenderer, SceneManager, SpriteRenderer, Vector2 } from "../../src/engine/index";
import { defaultGraphics } from "../../src/engine/core/graphics";
import { requestSceneDepth, sceneDepth } from "../../src/engine/render/babylon/frameGraph";
import type { Scene } from "@babylonjs/core/scene.js";
import type { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";

type Check = { done: boolean; samples: Record<string, number[]>; errors: string[]; notes: string[] };
const check: Check = { done: false, samples: {}, errors: [], notes: [] };
(window as unknown as { __check: Check }).__check = check;
const log = (s: string) => (document.getElementById("log")!.textContent += `${s}\n`);

function renderTextureScene(): void {
  const main = GameObject.create("Main");
  main.transform!.position.set(0, 0, 5);
  main.addBehavior(Camera, { projection: "perspective", backgroundColor: Color.from("#202020") });
  GameObject.create("Env").addBehavior(Environment, { intensity: 0, skybox: false });
  const screen = GameObject.create("Screen");
  screen.transform!.scale.set(0.4, 1, 0.225); // builtin:plane is 10 m square
  screen.transform!.eulerAngles = [90, 0, 0];
  screen.addBehavior(MeshRenderer, { mesh: "builtin:plane", material: "screen.material.json", castShadows: false });
  // A sprite showing the same texture (its quad's V runs bottom to top, like an image's).
  const sprite = GameObject.create("Sprite");
  sprite.transform!.position.set(-2.2, 0, 0);
  sprite.addBehavior(SpriteRenderer, { sprite: "tv.rendertexture.json", size: new Vector2(1.6, 0.9) });
  // The texture's camera, far away looking at a red sphere on blue, top half only lit.
  const rtCam = GameObject.create("RT camera");
  rtCam.transform!.position.set(100, 0, 3);
  rtCam.addBehavior(Camera, { projection: "perspective", fieldOfView: 40, backgroundColor: Color.from("#0000ff"), targetTexture: "tv.rendertexture.json" });
  const ball = GameObject.create("Ball");
  ball.transform!.position.set(100, 0.6, 0);
  ball.transform!.scale.set(0.8, 0.8, 0.8);
  ball.addBehavior(MeshRenderer, { mesh: "builtin:sphere", material: "red.material.json" });
  GameObject.create("Sun").addBehavior(Light, { type: "ambient", intensity: 1 });
}

async function main() {
  const params = new URLSearchParams(location.search);
  Assets.addSource(
    Assets.fromObject({
      "s.json": { format: "myco.scene@1", settings: { physics: "none" }, nodes: [] },
      "tv.rendertexture.json": { width: 256, height: 144, format: params.get("format") ?? "ldr" },
      "screen.material.json": { format: "myco.material@1", shader: "unlit", color: "#ffffff", texture: "tv.rendertexture.json" },
      "red.material.json": { format: "myco.material@1", shader: "unlit", color: "#ff0000" },
    }),
  );
  Graphics._configure(defaultGraphics(), params.get("tier") ?? "High");
  const container = document.getElementById("view")!;
  const engine = await Engine.create({ container, project: { display: { width: 640, height: 360 } } });
  await SceneManager.load("s.json");
  const which = params.get("case") ?? "rendertexture";
  if (which === "rendertexture") renderTextureScene();
  const canvas = container.querySelector("canvas") as HTMLCanvasElement;
  const scene = () => (globalThis as { __mycoBabylonScenes?: Scene[] }).__mycoBabylonScenes?.at(-1);
  let releaseDepth: (() => void) | null = null;
  const out = document.getElementById("shot") as HTMLCanvasElement;
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  for (let i = 0; i < 60; i++) {
    engine.step(1 / 60);
    if (params.has("depth") && !releaseDepth && scene()) releaseDepth = requestSceneDepth(scene()!, check);
    out.width = canvas.width;
    out.height = canvas.height;
    ctx.drawImage(canvas, 0, 0);
    await new Promise((r) => setTimeout(r, 16));
  }
  const at = (name: string, fx: number, fy: number) => {
    const d = ctx.getImageData(Math.floor(fx * out.width), Math.floor(fy * out.height), 1, 1).data;
    check.samples[name] = [d[0], d[1], d[2]];
    log(`${name}: ${d[0]},${d[1]},${d[2]}`);
  };
  // The screen covers the middle; its centre-top shows the sphere (the RT camera looks slightly below it), edges the blue.
  at("centre", 0.5, 0.45);
  at("screenEdge", 0.3, 0.5);
  at("outside", 0.05, 0.05);
  at("lowerMiddle", 0.5, 0.62);
  at("spriteTop", 0.21, 0.39);
  at("spriteBottom", 0.21, 0.6);
  if (releaseDepth) {
    const s = scene()!;
    const cam = s.cameras.find((c) => c.name === "camera:Main") as TargetCamera;
    const d = sceneDepth(s, cam);
    check.notes.push(d ? `depth ${d.width}x${d.height} near ${d.near} far ${d.far}` : "no depth");
    log(check.notes.at(-1)!);
    releaseDepth();
  }
  engine.dispose();
  check.done = true;
}

main().catch((err) => {
  check.errors.push(String(err?.stack ?? err));
  log(String(err?.stack ?? err));
  check.done = true;
});
