// UI check page (ADR 0076, 0075 stage 9): a screen canvas (panel, text, button, input field, and an
// image with `fit: "cover"`), the interim Text, and a world-space canvas, on the Babylon backend. Stepped by hand; each frame is copied
// into the visible 2D canvas in the same task. Then a click on the button is simulated through Input.
// Results land in `window.__ui`. Open /spikes/babylon/ui.html?renderer=babylon on the dev server.
import { Assets, Camera, Color, Engine, GameObject, Input, Light, MeshRenderer, SceneManager, Text, UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText, Vector2 } from "../../src/engine/index";

type Report = {
  done: boolean;
  frames: number;
  clicked: boolean;
  hovered: boolean;
  buttonRect: unknown;
  errors: string[];
  pixel: number[] | null;
  /** The bundled Inter: whether the document has it loaded, and the backend that drew. */
  interLoaded: boolean;
  backend: string;
  /** The cover image's box (CSS pixels) and colours sampled near its left edge, centre and right edge. */
  coverRect: unknown;
  coverSamples: number[][];
};
const report: Report = { done: false, frames: 0, clicked: false, hovered: false, buttonRect: null, errors: [], pixel: null, interLoaded: false, backend: "", coverRect: null, coverSamples: [] };

/**
 * A 300 × 100 test image: red, green and blue thirds, so `cover` in a square box must show only the
 * green middle (cropped left and right), while `fill` would squeeze all three in.
 */
function coverTestImage(): string {
  const c = document.createElement("canvas");
  c.width = 300;
  c.height = 100;
  const g = c.getContext("2d")!;
  for (const [i, colour] of ["#ff0000", "#00ff00", "#0000ff"].entries()) {
    g.fillStyle = colour;
    g.fillRect(i * 100, 0, 100, 100);
  }
  return c.toDataURL("image/png");
}
(window as unknown as { __ui: Report }).__ui = report;

async function main() {
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, "images/thirds.png": coverTestImage() }));
  const container = document.getElementById("view")!;
  const engine = await Engine.create({ container, project: { display: { width: 960, height: 540 } } });
  await SceneManager.load("s.json");

  const cam = GameObject.create("Camera");
  cam.transform!.position.set(0, 1.5, 6);
  cam.addBehavior(Camera, { projection: "perspective", backgroundColor: Color.from("#20303f") });
  GameObject.create("Sun").addBehavior(Light, { type: "directional", intensity: 2 });
  const cube = GameObject.create("Cube");
  cube.transform!.position.set(-2, 1, 0);
  cube.addBehavior(MeshRenderer, { mesh: "builtin:cube" });

  // Screen canvas: a column panel in the top-left with a title, a button and a field.
  const canvas = GameObject.create("Canvas");
  canvas.addBehavior(UICanvas, { mode: "screen" });
  const panel = GameObject.create("Panel", { parent: canvas });
  panel.addBehavior(UIPanel, { flexDirection: "column", gap: 12, padding: 20, margin: 24, backgroundColor: new Color(0.1, 0.12, 0.16, 0.9), borderRadius: 12, borderWidth: 2, borderColor: Color.from("#3fc1c9") });
  const title = GameObject.create("Title", { parent: panel });
  title.addBehavior(UIText, { text: "King of Pirates", fontSize: 60, fontWeight: "bold", color: Color.from("#f2c14e") }); // descenders: "g"
  const play = GameObject.create("Play", { parent: panel });
  play.addBehavior(UIButton, { padding: 12, backgroundColor: Color.from("#2a6f97"), borderRadius: 8, hoverColor: Color.from("#3fc1c9") });
  GameObject.create("Label", { parent: play }).addBehavior(UIText, { text: "Play", fontSize: 24, color: Color.white });
  GameObject.create("Name", { parent: panel }).addBehavior(UIInputField, { placeholder: "Your name", width: 260, padding: 8, borderWidth: 1, borderColor: Color.from("#888888"), backgroundColor: Color.from("#111111") });
  // A square box over a 3:1 image: cover crops to the middle third.
  const cover = GameObject.create("Cover", { parent: canvas });
  cover.addBehavior(UIImage, { image: "asset:images/thirds.png", fit: (new URLSearchParams(location.search).get("fit") ?? "cover") as "cover", width: 120, height: 120, positionType: "absolute", right: 24, top: 24 });

  // The interim Text, bottom-right.
  GameObject.create("Hint").addBehavior(Text, { text: "interim Text", fontSize: 28, anchor: "bottom-right", offset: new Vector2(-16, -16), outlineColor: Color.black, outlineWidth: 3 });

  // A world canvas beside the cube.
  const sign = GameObject.create("Sign");
  sign.transform!.position.set(1.5, 1.5, 0);
  sign.addBehavior(UICanvas, { mode: "world", referenceResolution: new Vector2(400, 200), pixelSize: 0.005 });
  const signPanel = GameObject.create("SignPanel", { parent: sign });
  signPanel.addBehavior(UIPanel, { width: "100%", height: "100%", backgroundColor: new Color(0.9, 0.85, 0.6, 1), justifyContent: "center", alignItems: "center" });
  GameObject.create("SignText", { parent: signPanel }).addBehavior(UIText, { text: "World sign", fontSize: 48, color: Color.black });

  const out = document.getElementById("out") as HTMLCanvasElement;
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  const view = document.querySelector("#view canvas") as HTMLCanvasElement;
  const device = () => (globalThis as { __mycoBabylonScenes?: { getEngine(): { _device?: GPUDevice } }[] }).__mycoBabylonScenes?.at(-1)?.getEngine()._device;
  let listening = false;
  const step = async (n: number) => {
    for (let i = 0; i < n; i++) {
      engine.step(1 / 60);
      report.frames++;
      out.width = view.width;
      out.height = view.height;
      ctx.drawImage(view, 0, 0);
      const d = device();
      if (d && !listening) {
        listening = true;
        d.addEventListener("uncapturederror", (ev: Event) => report.errors.push((ev as GPUUncapturedErrorEvent).error.message.slice(0, 400)));
      }
      await new Promise((r) => setTimeout(r, 16));
    }
  };
  await step(90);

  // Click the button: move the pointer onto it, press, release.
  const rect = (engine as unknown as { defaultWorld: { render: { uiRuntime(): { rectOf(c: unknown): { x: number; y: number; width: number; height: number } | null } | null } | null } }).defaultWorld.render?.uiRuntime()?.rectOf(play.getComponent(UIButton)!) ?? null;
  report.buttonRect = rect;
  if (rect) {
    Input.simulatePointer(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await step(2);
    report.hovered = play.getComponent(UIButton)!.hovered;
    Input.simulate("down", "mouse0");
    await step(2);
    Input.simulate("up", "mouse0");
    for (let i = 0; i < 4 && !report.clicked; i++) {
      await step(1);
      report.clicked ||= play.getComponent(UIButton)!.clicked;
    }
    await step(10); // leaves the button hovered for the screenshot
  }
  const px = ctx.getImageData(Math.floor(out.width * 0.03), Math.floor(out.height * 0.06), 1, 1).data;
  report.pixel = [px[0], px[1], px[2]];
  report.interLoaded = document.fonts.check('16px "Inter"') && [...document.fonts].some((f) => f.family.replace(/"/g, "") === "Inter" && f.status === "loaded");
  report.backend = device() ? "WebGPU" : "WebGL2";
  const runtime = (engine as unknown as { defaultWorld: { render: { uiRuntime(): { rectOf(c: unknown): { x: number; y: number; width: number; height: number } | null } | null } | null } }).defaultWorld.render?.uiRuntime();
  const cr = runtime?.rectOf(cover.getComponent(UIImage)!) ?? null;
  report.coverRect = cr;
  if (cr) {
    const k = view.width / view.clientWidth;
    for (const fx of [0.05, 0.5, 0.95]) {
      const p = ctx.getImageData(Math.floor((cr.x + cr.width * fx) * k), Math.floor((cr.y + cr.height / 2) * k), 1, 1).data;
      report.coverSamples.push([p[0], p[1], p[2]]);
    }
  }
  // `?crop=title`: show the title's box (and a margin) magnified in the readback canvas.
  if (new URLSearchParams(location.search).get("crop") === "title") {
    const ui = (engine as unknown as { defaultWorld: { render: { uiRuntime(): { rectOf(c: unknown): { x: number; y: number; width: number; height: number } | null } | null } | null } }).defaultWorld.render?.uiRuntime();
    const t = ui?.rectOf(title.getComponent(UIText)!);
    if (t) {
      const k = view.width / view.clientWidth;
      const src = document.createElement("canvas");
      src.width = out.width;
      src.height = out.height;
      src.getContext("2d")!.drawImage(out, 0, 0);
      const [sx, sy, sw, sh] = [(t.x - 8) * k, (t.y - 8) * k, (t.width + 16) * k, (t.height + 24) * k];
      out.width = Math.ceil(sw);
      out.height = Math.ceil(sh);
      out.style.width = "400px";
      out.style.height = `${(400 * sh) / sw}px`;
      ctx.drawImage(src, sx, sy, sw, sh, 0, 0, out.width, out.height);
      ctx.strokeStyle = "#ff3050";
      ctx.strokeRect(8 * k, 8 * k, t.width * k, t.height * k); // the layout box
    }
  }
  report.done = true;
}
main().catch((err) => {
  report.errors.push(String(err?.stack ?? err));
  report.done = true;
});
