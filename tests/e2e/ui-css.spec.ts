import { readFileSync } from "node:fs";
import { expect, openEditor, type Page, play, test } from "./fixtures";
import { inLiveWorld } from "./liveWorld";

// The web CSS the UI core draws (ADR 0422's five waves, and 0428 forms, 0429 inline runs, 0430 filters, SVG and skew),
// captured in Play mode and compared with committed baselines, one test per wave (0422 "Order and verification": a
// browser capture per wave). UI documents are retired (0423 wave D), so each test document is a Svelte component on a
// UIView: a grid of labelled cells, each showing one feature, over a plain camera background.
//
// Baselines are Playwright's (`toHaveScreenshot`, in `ui-css.spec.ts-snapshots/`, named per project and platform). The
// committed ones are Linux with software GL at the e2e device scale (0.5); another platform or the GPU writes its own
// on its first run (`--update-snapshots`). The tolerance is a share of the view's pixels, as the other capture specs
// count changed pixels rather than demand exact ones: text antialiasing and Canvas2D blurs move by a pixel between
// Chromium builds. Each test also checks a few things through the public API (`UIView.query`, an element's `bounds()`),
// so a baseline taken from a broken drawing is caught by more than the eye.
test.describe.configure({ timeout: 90_000 }); // opening a project compiles its scripts, and Play type-checks them

/** The share of the view's pixels that may differ from the baseline (and Playwright's per-pixel colour threshold). */
const SHOT = { maxDiffPixelRatio: 0.01, threshold: 0.2 } as const;
/** The page size the baselines were taken at: the game view's canvas size follows it. */
const VIEWPORT = { width: 1600, height: 1000 };

/**
 * The test project's settings: the Flappy sample's (the test project is Flappy with files written over it) with a 1280 × 720
 * display, the UI's reference size, so the canvas is exactly the documents' design size. `fit` letterboxes it at that
 * aspect ratio; `stretch` fills the game view, so a page resize changes the canvas's aspect ratio (the @media test).
 */
const projectJson = (scaleMode: "fit" | "stretch" = "fit") => {
  const project = JSON.parse(readFileSync(new URL("../../samples/flappy/project.json", import.meta.url), "utf8"));
  return JSON.stringify({ ...project, display: { ...project.display, width: 1280, height: 720, scaleMode } });
};

/** A camera with a plain dark background and the test document's view. */
const scene = (props: object = {}) =>
  JSON.stringify({
    format: "myco.scene@4",
    settings: { physics: "2d" },
    nodes: [
      {
        id: "camera",
        name: "Camera",
        components: [
          { type: "engine.Transform", data: { position: [0, 0, -10] } },
          { type: "engine.Camera", data: { projection: "orthographic", orthographicSize: 10, backgroundColor: "#20242c" } },
        ],
      },
      { id: "doc", name: "Doc", components: [{ type: "engine.Transform", data: {} }, { type: "engine.UIView", data: { component: "asset:ui/Doc.svelte", ...props } }] },
    ],
  });

/** The cells' grid, shared by every test document: four 296 × 334 cells a row, each with its label at the bottom. */
const GRID = `
  #screen { width: 100%; height: 100%; flex-direction: row; flex-wrap: wrap; align-content: flex-start; gap: 16px; padding: 16px; }
  .cell { width: 296px; height: 334px; background-color: #2c3340; flex-direction: column; align-items: flex-start; padding: 12px; }
  .label { position: absolute; left: 12px; bottom: 8px; font-size: 18px; color: #c8d0dc; }
`;

const cell = (label: string, body: string) => `  <section class="cell">\n${body}\n    <p class="label">${label}</p>\n  </section>`;

/** Every console error and page error, and every warning the UI gives (a declaration it refused, a value it couldn't read). */
function trackProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (err) => problems.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error" || (msg.type() === "warning" && /svelte|\bui\b|css|style|transform|filter|refus|can't read/i.test(msg.text()))) problems.push(`${msg.type()}: ${msg.text()}`);
  });
  return problems;
}

const gameView = (page: Page) => page.locator("#game-view canvas").first();

type Box = { x: number; y: number; width: number; height: number };

/** Each selector's drawn box (`UIHostElement.bounds()`, canvas UI pixels), null while it isn't laid out. */
const boundsOf = (page: Page, selectors: string[]): Promise<(Box | null)[] | null> =>
  inLiveWorld(
    page,
    null,
    (w, { myco, componentsOf }, sels) => {
      if (!w) return null;
      type El = { bounds(): Box | null };
      const view = componentsOf<{ query(s: string): El | null }>(w.root, myco.UIView)[0];
      if (!view) return null;
      return sels.map((s) => view.query(s)?.bounds() ?? null);
    },
    selectors,
  );

/** Open the test project with `doc` as ui/Doc.svelte, play it, and wait until the view has laid out its last cell. */
async function playDoc(page: Page, doc: string, o: { props?: object; ready?: string; scaleMode?: "fit" | "stretch" } = {}): Promise<void> {
  await openEditor(page, { viewport: VIEWPORT, files: { "project.json": projectJson(o.scaleMode), "ui/Doc.svelte": doc, "scenes/main.scene.json": scene(o.props) } });
  await play(page);
  const ready = o.ready ?? ".cell:last-child";
  await expect.poll(async () => ((await boundsOf(page, [ready]))?.[0]?.width ?? 0) > 0, { timeout: 20_000 }).toBe(true);
}

/** Pause the game and step it `n` frames (play mode's Step: 1/60 s each, on the unscaled clock UI animates on too). */
async function step(page: Page, n: number): Promise<void> {
  const button = page.getByRole("button", { name: "Step", exact: true });
  for (let i = 0; i < n; i++) await button.click();
}

/** Let a few frames draw what the view laid out, then pause, so the capture holds still. */
async function settle(page: Page): Promise<void> {
  const at = await inLiveWorld(page, null, (w) => w?.time.frameCount ?? 0);
  await expect.poll(() => inLiveWorld(page, null, (w) => w?.time.frameCount ?? 0)).toBeGreaterThan(at + 5);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await step(page, 2); // a paused game draws only when stepped: two steps make sure the last change is drawn
}

test.describe("captures", () => {
  // Full device scale for the captures alone: at the e2e default (0.5 with software GL) 18 px labels are 9 device pixels.
  test.use({ deviceScaleFactor: 1 });

// --- Wave 1: layout -----------------------------------------------------------------------------------------------------

const LAYOUT = `<div id="screen">
${cell(
  "per-side edges",
  `    <div id="edges"><div class="fill"></div></div>`,
)}
${cell(
  "min / max sizes",
  `    <div class="row"><div id="capped" class="grow a"></div><div id="floored" class="grow b"></div><div class="grow c"></div></div>
    <div class="row"><div id="half" class="half a"></div></div>
    <div id="ratio" class="b"></div>`,
)}
${cell(
  "flex-wrap",
  `    <div id="wrap">${Array.from({ length: 9 }, (_, i) => `<div class="tile t${i % 3}"></div>`).join("")}</div>`,
)}
${cell(
  "overflow: hidden",
  `    <div class="pair">
      <div id="clipped" class="frame"><div class="stripes">${Array.from({ length: 6 }, (_, i) => `<div class="stripe s${i % 3}"></div>`).join("")}</div></div>
      <div class="frame open"><div class="stripes">${Array.from({ length: 6 }, (_, i) => `<div class="stripe s${i % 3}"></div>`).join("")}</div></div>
    </div>`,
)}
${cell(
  "z-index",
  `    <div class="stack">
      <div id="z-top" class="sq a" style="left: 20px; top: 20px; z-index: 3"></div>
      <div class="sq b" style="left: 70px; top: 60px; z-index: 1"></div>
      <div class="sq c" style="left: 120px; top: 100px"></div>
    </div>`,
)}
${cell(
  "align-self, flex-basis",
  `    <div class="selfs">
      <div class="self a" style="align-self: flex-start"></div>
      <div class="self b" style="align-self: center"></div>
      <div class="self c" style="align-self: flex-end"></div>
      <div class="self a" style="align-self: stretch; height: auto"></div>
    </div>
    <div class="row"><div class="basis a" style="flex: 1 1 30px"></div><div class="basis c" style="flex: 2 1 30px"></div></div>`,
)}
</div>

<style>${GRID}
  .a { background-color: #e05a47; }
  .b { background-color: #3a9a6e; }
  .c { background-color: #3a6ea5; }
  #edges { width: 220px; height: 180px; background-color: #556070; border: 2px solid #ffcc33; border-width: 4px 16px 28px 40px; padding: 8px 24px 4px 48px; margin: 10px 0 0 6px; }
  .fill { flex-grow: 1; background-color: #e05a47; }
  .row { width: 272px; height: 50px; flex-direction: row; margin-bottom: 12px; background-color: #3b4454; }
  .grow { flex-grow: 1; height: 50px; }
  #capped { max-width: 40px; }
  #floored { min-width: 160px; }
  .half { width: 20%; min-width: 120px; height: 50px; }
  #ratio { width: 160px; aspect-ratio: 2; }
  #wrap { width: 200px; flex-direction: row; flex-wrap: wrap; gap: 8px; }
  .tile { width: 56px; height: 56px; }
  .t0 { background-color: #e05a47; }
  .t1 { background-color: #3a9a6e; }
  .t2 { background-color: #3a6ea5; }
  .pair { flex-direction: row; gap: 20px; margin-top: 30px; margin-left: 30px; }
  .frame { width: 100px; height: 100px; border: 3px solid #ffcc33; overflow: hidden; }
  .frame.open { overflow: visible; }
  .stripes { position: absolute; left: -30px; top: -30px; width: 160px; flex-direction: column; }
  .stripe { height: 30px; }
  .s0 { background-color: #e05a47; }
  .s1 { background-color: #3a9a6e; }
  .s2 { background-color: #3a6ea5; }
  .stack { width: 260px; height: 240px; }
  .sq { position: absolute; width: 110px; height: 110px; border: 3px solid #ffffff; }
  .selfs { width: 272px; height: 150px; flex-direction: row; gap: 10px; background-color: #3b4454; margin-bottom: 12px; }
  .self { width: 54px; height: 50px; }
  .basis { height: 50px; }
</style>
`;

test("wave 1, layout: per-side edges, min/max sizes, wrapping, overflow clipping and z-index", async ({ page }) => {
  const problems = trackProblems(page);
  await playDoc(page, LAYOUT);
  await settle(page);
  const [edges, capped, floored, ratio, clipped, top] = (await boundsOf(page, ["#edges", "#capped", "#floored", "#ratio", "#clipped", "#z-top"]))!;
  // Margins are outside the box, borders and padding inside it: the box is its width and height.
  expect(edges).toMatchObject({ width: 220, height: 180 });
  // max-width caps a growing item and min-width floors one. Yoga shares the row's free space after the floor among all three
  // ((272 - 160) / 3) and then clamps, so the capped item ends at 37.3, not CSS's 40 (CSS freezes it at its max, and the third
  // item takes the rest): a Yoga difference from the spec, kept here as drawn.
  expect(capped!.width).toBeLessThanOrEqual(40);
  expect(floored!.width).toBeGreaterThanOrEqual(160);
  expect(ratio).toMatchObject({ width: 160, height: 80 });
  expect(clipped).toMatchObject({ width: 100, height: 100 });
  expect(top!.width).toBe(110);
  await expect(gameView(page)).toHaveScreenshot("wave1-layout.png", SHOT);
  expect(problems).toEqual([]);
});

// --- Wave 2: paint ------------------------------------------------------------------------------------------------------

const PAINT = `<div id="screen">
${cell("box-shadow", `    <div id="shadowed" class="card"></div>`)}
${cell("text-shadow", `    <p id="title">Shadow</p><p class="soft">soft glow</p>`)}
${cell("linear-gradient", `    <div class="swatch g1"></div><div class="swatch g2"></div><div class="swatch g3"></div>`)}
${cell("radial-gradient", `    <div class="swatch big g4"></div>`)}
${cell("per-corner radii", `    <div class="corners"></div><div class="corners two"></div>`)}
${cell("radius + border + gradient", `    <div class="pill"></div><div class="badge"></div>`)}
</div>

<style>${GRID}
  .card { width: 200px; height: 140px; margin: 30px; background-color: #e8ecf2; border-radius: 10px; box-shadow: 12px 16px 18px rgba(0, 0, 0, 0.75); }
  #title { font-size: 56px; color: #ffffff; text-shadow: 4px 5px 2px #e05a47; margin-top: 20px; }
  .soft { font-size: 40px; color: #ffe08a; text-shadow: 0 0 10px #ff8800; margin-top: 20px; }
  .swatch { width: 272px; height: 70px; margin-bottom: 12px; }
  .g1 { background-image: linear-gradient(90deg, #e05a47, #3a6ea5); }
  .g2 { background-image: linear-gradient(to bottom, #ffcc33, #3a9a6e 70%, #20242c); }
  .g3 { background-image: linear-gradient(45deg, #ffffff 0%, #ffffff 30%, #3a6ea5 30%, #3a6ea5 60%, #e05a47 60%); }
  .big { height: 272px; }
  .g4 { background-image: radial-gradient(#ffffff, #ffcc33 30%, #e05a47 60%, #2c3340); }
  .corners { width: 240px; height: 110px; margin-bottom: 20px; background-color: #3a9a6e; border-radius: 0 40px 10px 60px; }
  .two { background-color: #3a6ea5; border-radius: 50px 4px; }
  .pill { width: 240px; height: 70px; margin-bottom: 20px; border-radius: 35px; border: 4px solid #ffffff; background-image: linear-gradient(90deg, #3a6ea5, #3a9a6e); }
  .badge { width: 120px; height: 120px; border-radius: 60px; background-color: #e05a47; border: 8px solid #ffcc33; box-shadow: 0 6px 10px #000000; }
</style>
`;

test("wave 2, paint: box and text shadows, linear and radial gradients, per-corner radii", async ({ page }) => {
  const problems = trackProblems(page);
  await playDoc(page, PAINT);
  await settle(page);
  // A shadow doesn't change the box (it's drawn outside it).
  expect((await boundsOf(page, ["#shadowed"]))![0]).toMatchObject({ width: 200, height: 140 });
  await expect(gameView(page)).toHaveScreenshot("wave2-paint.png", SHOT);
  expect(problems).toEqual([]);
});

// --- Wave 3: transforms (and 0430's skew and matrix) --------------------------------------------------------------------

const TRANSFORMS = `<div id="screen">
${cell("rotate(20deg)", `    <div class="ghost"></div><div id="rotated" class="box a" style="transform: rotate(20deg)"></div>`)}
${cell("scale(1.5, 0.6)", `    <div class="ghost"></div><div id="scaled" class="box b" style="transform: scale(1.5, 0.6)"></div>`)}
${cell("translate(50px, 40px)", `    <div class="ghost"></div><div id="moved" class="box c" style="transform: translate(50px, 40px)"><p class="tag">moved</p></div>`)}
${cell(
  "nested + origin",
  `    <div class="ghost"></div><div id="outer" class="box c" style="rotate: 15deg"><div id="inner" class="inner a" style="transform: rotate(30deg) scale(0.8)"></div></div>
    <div class="corner b" style="rotate: 30deg; transform-origin: left top"></div>`,
)}
${cell("skewX(20deg)", `    <div class="ghost"></div><div id="skewed" class="box a" style="transform: skewX(20deg)"><p class="tag">skew</p></div>`)}
${cell("matrix()", `    <div class="ghost"></div><div id="matrixed" class="box b" style="transform: matrix(1, 0.3, -0.2, 1, 10, 0)"></div>`)}
${cell("translate(-50%) rotate", `    <div id="badge" class="badge" style="transform: translate(-50%, -50%) rotate(45deg)"></div>`)}
${cell("transformed clip", `    <div class="ghost"></div><div id="clipper" class="box clip" style="rotate: -12deg"><div class="spill a"></div></div>`)}
</div>

<style>${GRID}
  .a { background-color: #e05a47; }
  .b { background-color: #3a9a6e; }
  .c { background-color: #3a6ea5; }
  .ghost, .box { position: absolute; left: 78px; top: 70px; width: 140px; height: 140px; }
  .ghost { border: 2px solid #8090a0; }
  .tag { font-size: 22px; color: #ffffff; margin: 8px; }
  .inner { position: absolute; left: 30px; top: 30px; width: 80px; height: 80px; }
  .corner { position: absolute; left: 150px; top: 230px; width: 100px; height: 30px; }
  .badge { position: absolute; left: 148px; top: 150px; width: 110px; height: 110px; background-color: #ffcc33; border: 6px solid #e05a47; }
  .clip { overflow: hidden; background-color: #556070; border: 3px solid #ffcc33; }
  .spill { position: absolute; left: 60px; top: 60px; width: 140px; height: 140px; }
</style>
`;

test("wave 3, transforms: rotate, scale, translate, nested transforms and origins, skew and matrix (0430), transformed clips", async ({ page }) => {
  const problems = trackProblems(page);
  await playDoc(page, TRANSFORMS);
  await settle(page);
  const [rotated, scaled, moved, skewed, badge] = (await boundsOf(page, ["#rotated", "#scaled", "#moved", "#skewed", "#badge"]))!;
  // Drawn boxes follow the transforms: a 140 px square turned 20° is cos+sin wider; scaled 1.5 × 0.6; moved 50, 40.
  const turned = 140 * (Math.cos(Math.PI / 9) + Math.sin(Math.PI / 9));
  expect(rotated!.width).toBeCloseTo(turned, 0);
  expect(scaled!.width).toBeCloseTo(210, 0);
  expect(scaled!.height).toBeCloseTo(84, 0);
  const ghost = (await boundsOf(page, [".cell:nth-child(3) .ghost"]))![0]!;
  expect(moved!.x - ghost.x).toBeCloseTo(50, 0);
  expect(moved!.y - ghost.y).toBeCloseTo(40, 0);
  // skewX(20deg) widens the box by its height × tan 20°, and keeps its height.
  expect(skewed!.width).toBeCloseTo(140 + 140 * Math.tan(Math.PI / 9), 0);
  expect(skewed!.height).toBeCloseTo(140, 0);
  // translate(-50%, -50%) centres the badge on its left/top point.
  const cell7 = (await boundsOf(page, [".cell:nth-child(7)"]))![0]!;
  expect(badge!.x + badge!.width / 2 - cell7.x).toBeCloseTo(148, 0);
  await expect(gameView(page)).toHaveScreenshot("wave3-transforms.png", SHOT);
  expect(problems).toEqual([]);
});

// --- Wave 4: animation --------------------------------------------------------------------------------------------------

const ANIMATION = `<script lang="ts">
  let { on = false }: { on?: boolean } = $props();
</script>

<div id="screen">
  <div class="track"><div id="mover" class:on></div></div>
  <div class="track"><div id="grower" class:on></div></div>
  <div class="track"><div id="spinner" class:on></div><div id="eased" class:on></div></div>
  <p class="caption">transition: translate, background-color, width, opacity (1 s linear); @keyframes rotate (1 s linear); ease-in-out</p>
</div>

<style>
  #screen { width: 100%; height: 100%; flex-direction: column; gap: 24px; padding: 40px; }
  .track { width: 1000px; height: 140px; background-color: #2c3340; flex-direction: row; align-items: center; padding: 10px; gap: 40px; }
  #mover { width: 120px; height: 120px; background-color: #e05a47; translate: 0 0; transition: translate 1s linear, background-color 1s linear; }
  #mover.on { translate: 600px 0; background-color: #3a6ea5; }
  #grower { width: 100px; height: 80px; background-color: #3a9a6e; opacity: 1; transition: width 1s linear, opacity 1s linear; }
  #grower.on { width: 700px; opacity: 0.3; }
  #spinner { width: 100px; height: 100px; background-color: #ffcc33; }
  #spinner.on { animation: turn 1s linear forwards; }
  @keyframes turn { from { rotate: 0deg; } to { rotate: 90deg; } }
  #eased { width: 100px; height: 100px; background-color: #e05a47; border-radius: 0; transition: border-radius 1s ease-in-out, translate 1s ease-in-out; }
  #eased.on { border-radius: 50px; translate: 400px 0; }
  .caption { font-size: 22px; color: #c8d0dc; }
</style>
`;

test("wave 4, animation: transitions and @keyframes sampled at fixed times by stepping the paused game", async ({ page }) => {
  const problems = trackProblems(page);
  await playDoc(page, ANIMATION, { ready: "#eased" });
  await settle(page); // paused from here: the game moves only when stepped, 1/60 s a step
  const start = (await boundsOf(page, ["#mover"]))![0]!;

  // Start the transitions and the animation: the view's prop adds the class (`UIView.props`, reactive).
  await inLiveWorld(page, null, (w, { myco, componentsOf }) => {
    componentsOf<{ props: Record<string, unknown> }>(w!.root, myco.UIView)[0].props.on = true;
  });
  // Half way: 30 steps after the change (the change's frame starts them, 29 more advance them).
  await step(page, 30);
  const half = (await boundsOf(page, ["#mover", "#grower"]))!;
  const travelled = half[0]!.x - start.x;
  expect(travelled, "linear translate half way (of 600 px)").toBeGreaterThan(270);
  expect(travelled).toBeLessThan(330);
  expect(half[1]!.width, "linear width half way (100 → 700 px)").toBeGreaterThan(370);
  expect(half[1]!.width).toBeLessThan(430);
  await expect(gameView(page)).toHaveScreenshot("wave4-animation-half.png", SHOT);

  // Past the end: everything holds its final value (the animation's fill mode is forwards).
  await step(page, 40);
  const end = (await boundsOf(page, ["#mover", "#grower", "#spinner"]))!;
  expect(end[0]!.x - start.x).toBeCloseTo(600, 0);
  expect(end[1]!.width).toBeCloseTo(700, 0);
  expect(end[2]!.width).toBeCloseTo(100, 0); // a quarter turn of a square is the square again
  await expect(gameView(page)).toHaveScreenshot("wave4-animation-end.png", SHOT);
  expect(problems).toEqual([]);
});

// --- Wave 5: selectors, calc() and @media -------------------------------------------------------------------------------

const SELECTORS = `<div id="screen">
${cell(
  ":nth-child, :not, :empty",
  `    <div class="list">${Array.from({ length: 6 }, (_, i) => `<div class="item">${i === 3 ? "" : `<span>row ${i + 1}</span>`}</div>`).join("")}</div>`,
)}
${cell(
  "+ ~ [attr]",
  `    <div class="chips">
      <div class="chip" data-kind="fire"></div><div class="chip" data-kind="water"></div><div class="chip mark"></div><div class="chip"></div><div class="chip" data-kind="FIRE"></div>
    </div>`,
)}
${cell("calc()", `    <div class="calc"><div id="calc-a" class="bar"></div><div id="calc-b" class="bar two"></div><div id="calc-c" class="bar three"></div></div>`)}
${cell("@media", `    <div id="media" class="media"><div class="m a"></div><div class="m b"></div><div class="m c"></div></div><p id="media-text" class="mq">gold in a column at 3:2 or wider</p>`)}
</div>

<style>${GRID}
  :global(:root) { --gutter: 12px; }
  .list { width: 272px; flex-direction: column; }
  .item { height: 36px; padding-left: 10px; background-color: #3b4454; justify-content: center; }
  .item span { font-size: 18px; color: #ffffff; }
  .item:nth-child(odd) { background-color: #4a5a70; }
  .item:not(:last-child) { border-bottom-width: 3px; border-color: #ffcc33; }
  .item:empty { background-color: #e05a47; }
  .chips { width: 272px; flex-direction: row; flex-wrap: wrap; gap: 8px; }
  .chip { width: 60px; height: 60px; background-color: #556070; }
  [data-kind="fire" i] { background-color: #e05a47; }
  [data-kind^="wat"] { background-color: #3a6ea5; }
  .chip + .mark { border: 4px solid #ffffff; }
  .mark ~ .chip { border-radius: 30px; }
  .calc { width: 272px; height: 200px; flex-direction: column; gap: 10px; background-color: #3b4454; }
  .bar { height: 40px; background-color: #3a9a6e; width: calc(100% - 2 * var(--gutter)); }
  .two { width: calc(50% + 20px); background-color: #3a6ea5; }
  .three { width: clamp(40px, calc(3 * 30px), 200px); height: calc(var(--gutter) * 4); background-color: #ffcc33; }
  .media { width: 272px; flex-direction: row; gap: 10px; }
  .m { width: 80px; height: 80px; }
  .a { background-color: #e05a47; }
  .b { background-color: #3a9a6e; }
  .c { background-color: #3a6ea5; }
  .mq { font-size: 20px; color: #ffffff; margin-top: 10px; }
  @media (min-aspect-ratio: 3/2) { .media { flex-direction: column; } .mq { color: #ffcc33; } }
  @media (max-aspect-ratio: 3/2) { .m { border-radius: 40px; } }
</style>
`;

/** The page size the @media test narrows to (from VIEWPORT): the stretched canvas goes from about 1.9:1 to about square. */
const NARROW = { width: 1100, height: 1000 };

test("wave 5, selectors and values: structural, attribute and sibling selectors, calc(), and canvas @media across a resize", async ({ page }) => {
  const problems = trackProblems(page);
  await playDoc(page, SELECTORS, { scaleMode: "stretch" });
  await settle(page);
  const [a, b, c, cellBox] = (await boundsOf(page, ["#calc-a", "#calc-b", "#calc-c", ".calc"]))!;
  expect(a!.width).toBeCloseTo(cellBox!.width - 24, 0);
  expect(b!.width).toBeCloseTo(cellBox!.width / 2 + 20, 0);
  expect(c!.width).toBeCloseTo(90, 0);
  expect(c!.height).toBe(48);
  const wideMedia = (await boundsOf(page, ["#media"]))![0]!;
  await expect(gameView(page)).toHaveScreenshot("wave5-selectors-wide.png", SHOT);

  // A narrower game view: the canvas's aspect ratio drops under 3:2 and the other @media rules match (the frame after).
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.setViewportSize(NARROW);
  await expect.poll(async () => (await boundsOf(page, ["#media"]))![0]!.height, { message: "the @media row lays out as a row" }).toBeLessThan(wideMedia.height);
  await settle(page);
  await expect(gameView(page)).toHaveScreenshot("wave5-selectors-narrow.png", SHOT);
  expect(problems).toEqual([]);
});

// --- 0428: form elements ------------------------------------------------------------------------------------------------

const FORMS = `<script lang="ts">
  let music = $state(true);
  let mode = $state("normal");
  let volume = $state(30);
  let name = $state("Ada");
  let quality = $state("high");
</script>

<div id="screen">
${cell(
  "checkbox, radio",
  `    <label class="line"><input type="checkbox" id="music" bind:checked={music} />Music</label>
    <label class="line"><input type="checkbox" />Subtitles</label>
    <label class="line"><input type="checkbox" indeterminate />Some</label>
    <label class="line"><input type="checkbox" checked disabled />Locked</label>
    <label class="line"><input type="radio" name="mode" value="easy" bind:group={mode} />Easy</label>
    <label class="line"><input type="radio" name="mode" value="normal" bind:group={mode} />Normal</label>`,
)}
${cell(
  "range, progress, meter",
  `    <input type="range" id="volume" min="0" max="100" bind:value={volume} />
    <input type="range" class="tinted" min="0" max="10" value="8" />
    <progress id="progress" max="100" value="60"></progress>
    <meter value="0.2" min="0" max="1" low="0.3" high="0.7" optimum="0.9"></meter>
    <meter value="0.5" min="0" max="1" low="0.3" high="0.7" optimum="0.9"></meter>
    <meter value="0.95" min="0" max="1" low="0.3" high="0.7" optimum="0.9"></meter>`,
)}
${cell(
  "text, password, textarea",
  `    <input id="name" bind:value={name} />
    <input placeholder="Your clan" />
    <input type="password" value="secret" />
    <textarea rows="3">Two lines
of notes</textarea>`,
)}
${cell(
  "select, form",
  `    <form id="settings" class="form">
      <label for="quality" class="caption">Quality</label>
      <select id="quality" bind:value={quality}><option value="low">Low</option><option value="high">High</option></select>
      <button class="save">Save</button>
    </form>`,
)}
</div>

<style>${GRID}
  .line { flex-direction: row; align-items: center; gap: 10px; font-size: 20px; color: #ffffff; height: 36px; }
  input[type="checkbox"], input[type="radio"] { width: 24px; height: 24px; accent-color: #3a9a6e; }
  input[type="range"] { width: 260px; height: 24px; margin-bottom: 14px; accent-color: #e05a47; }
  input.tinted { accent-color: #ffcc33; }
  progress { width: 260px; height: 18px; margin-bottom: 14px; accent-color: #3a6ea5; }
  meter { width: 260px; height: 18px; margin-bottom: 10px; }
  input, textarea { width: 260px; height: 40px; font-size: 20px; margin-bottom: 12px; background-color: #f0f2f6; color: #20242c; border: 2px solid #8090a0; padding: 6px; placeholder-color: #7a8290; }
  textarea { height: auto; }
  .form { flex-direction: column; gap: 10px; }
  .caption { font-size: 20px; color: #ffffff; }
  select { width: 200px; height: 40px; font-size: 20px; background-color: #f0f2f6; color: #20242c; border: 2px solid #8090a0; }
  .save { width: 120px; height: 44px; background-color: #3a6ea5; color: #ffffff; font-size: 20px; border-radius: 6px; }
</style>
`;

test("0428 form elements: checkboxes, radios, sliders, progress and meters, text fields, a text area, a select", async ({ page }) => {
  const problems = trackProblems(page);
  await playDoc(page, FORMS);
  await settle(page);
  // The bound state reached the controls (read through the public components).
  const state = await inLiveWorld(page, null, (w, { myco, componentsOf }) => {
    type El = { component: Record<string, unknown> } | null;
    const view = componentsOf<{ query(s: string): El }>(w!.root, myco.UIView)[0];
    return {
      music: view.query("#music")?.component.checked,
      volume: view.query("#volume")?.component.value,
      name: view.query("#name")?.component.value,
      quality: view.query("#quality")?.component.value,
    };
  });
  expect(state).toEqual({ music: true, volume: 30, name: "Ada", quality: "high" });
  await expect(gameView(page)).toHaveScreenshot("forms.png", SHOT);
  expect(problems).toEqual([]);
});

// --- 0429: inline runs and {@html} --------------------------------------------------------------------------------------

const RICH = `<script lang="ts">
  const coins = 42;
  const html = 'From <b>{@html}</b>: <i>italic</i>, <u>underlined</u>, <s>struck</s> and <span style="color: #ffcc33">gold</span>.';
</script>

<div id="screen">
${cell(
  "phrasing tags",
  `    <p class="para">You have <b>{coins}</b> coins. <a href="#shop">Visit the <em>shop</em></a><br />H<sub>2</sub>O and x<sup>2</sup>, <code>x = 1</code>, <mark>new</mark>, <small>small print</small>.</p>`,
)}
${cell(
  "styled runs",
  `    <p class="para">A <span class="red">red</span> word, a <span class="big">big</span> one, <span class="hl">highlighted</span>, <span class="over">overlined</span> and <strong>strong <em>nested</em></strong> runs wrapping across lines.</p>`,
)}
${cell("&#123;@html&#125;", `    <p id="html" class="para">{@html html}</p>`)}
${cell(
  "alignment",
  `    <p class="para centre">Centred text that wraps onto <b>more</b> lines.</p>
    <p class="para right">Right <i>aligned</i></p>`,
)}
</div>

<style>${GRID}
  .para { width: 272px; font-size: 22px; color: #e8ecf2; margin-bottom: 14px; }
  .para a { color: #7ab8ff; }
  .red { color: #ff6a55; }
  .big { font-size: 34px; }
  .hl { background-color: #3a6ea5; }
  .over { text-decoration: overline; }
  .centre { text-align: center; }
  .right { text-align: right; }
</style>
`;

test("0429 inline text: phrasing runs, styled runs, {@html} and alignment", async ({ page }) => {
  const problems = trackProblems(page);
  await playDoc(page, RICH);
  await settle(page);
  // {@html}'s tags became runs inside one text element: no new elements beside it.
  const runs = await inLiveWorld(page, null, (w, { myco, componentsOf }) => {
    type El = { children: readonly unknown[]; component: { text?: string } };
    const view = componentsOf<{ query(s: string): El | null; queryAll(s: string): El[] }>(w!.root, myco.UIView)[0];
    return { bold: view.queryAll("#html b").length, gold: view.queryAll("#html span").length };
  });
  expect(runs).toEqual({ bold: 1, gold: 1 });
  await expect(gameView(page)).toHaveScreenshot("rich-text.png", SHOT);
  expect(problems).toEqual([]);
});

// --- 0430: filters and inline SVG ---------------------------------------------------------------------------------------

/** A colourful square to filter: three bands of colour and a white label. */
const SWATCH = `<div class="sw"><div class="band a"></div><div class="band b"></div><div class="band c"></div><p class="sw-label">Aa</p></div>`;

const FILTERS = `<div id="screen">
${cell("none / grayscale / sepia", `    <div class="row">${SWATCH}<div class="f-gray">${SWATCH}</div><div class="f-sepia">${SWATCH}</div></div>`)}
${cell("blur / hue / invert", `    <div class="row"><div class="f-blur">${SWATCH}</div><div class="f-hue">${SWATCH}</div><div class="f-invert">${SWATCH}</div></div>`)}
${cell("drop-shadow, brightness", `    <div class="row"><div class="f-drop">${SWATCH}</div><div class="f-bright">${SWATCH}</div><div class="f-contrast">${SWATCH}</div></div>`)}
${cell(
  "inline svg",
  `    <svg id="icon" width="272" height="200" viewBox="0 0 272 200">
      <defs><linearGradient id="sky" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3a6ea5" /><stop offset="1" stop-color="#3a9a6e" /></linearGradient></defs>
      <rect x="4" y="4" width="264" height="80" rx="12" fill="url(#sky)" stroke="#ffffff" stroke-width="3" />
      <circle cx="50" cy="140" r="40" fill="#e05a47" />
      <polygon points="110,180 150,100 190,180" fill="#ffcc33" stroke="#20242c" stroke-width="4" />
      <path d="M200 110 l20 20 l40 -40" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" />
      <text x="136" y="54" font-size="28" text-anchor="middle" fill="#ffffff">SVG</text>
    </svg>`,
)}
${cell("filtered svg", `    <svg class="f-gray" width="120" height="120" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#e05a47" /></svg>`)}
</div>

<style>${GRID}
  .row { flex-direction: row; gap: 12px; flex-wrap: wrap; width: 272px; }
  .sw { width: 80px; height: 80px; flex-direction: column; }
  .band { flex-grow: 1; }
  .a { background-color: #e05a47; }
  .b { background-color: #3a9a6e; }
  .c { background-color: #3a6ea5; }
  .sw-label { position: absolute; left: 18px; top: 18px; font-size: 32px; color: #ffffff; }
  .f-gray { filter: grayscale(1); }
  .f-sepia { filter: sepia(1); }
  .f-blur { filter: blur(3px); }
  .f-hue { filter: hue-rotate(120deg); }
  .f-invert { filter: invert(1); }
  .f-drop { filter: drop-shadow(6px 8px 4px #000000); }
  .f-bright { filter: brightness(1.6); }
  .f-contrast { filter: contrast(0.4); }
  #icon { color: #ffffff; }
</style>
`;

test("0430 filters and inline SVG: each filter function, a drop shadow, an SVG document with a gradient, and a filtered SVG", async ({ page }) => {
  const problems = trackProblems(page);
  await playDoc(page, FILTERS);
  await settle(page);
  expect((await boundsOf(page, ["#icon"]))![0]).toMatchObject({ width: 272, height: 200 });
  // The SVG is rasterised asynchronously (an image of its document): wait until the capture holds still.
  await expect(gameView(page)).toHaveScreenshot("filters-svg.png", SHOT);
  expect(problems).toEqual([]);
});

});

// --- Frame time: the Pirates HUD and the control mapper (0422's performance check) --------------------------------------
//
// What a view costs a frame, read where a developer reads it: play mode's Stats overlay, whose per-World Update (UI sync,
// restyle, layout and the UI's animation run in the update phase) and Render (Babylon GUI draws its Canvas2D texture
// there) are the Engine's own phase timings. The view's share is the difference between the World with its views
// enabled and the same World a moment later with them disabled (`Component.enabled`: a disabled view unmounts), each the
// median of a few seconds of Stats readings. The numbers are recorded in implementation-status (0422) and the UI plan;
// the tripwires below are those measurements with a generous margin (CLAUDE.md: a gate against accidental growth, not a
// design limit; raise it with a reason in the plan when a scheduled feature needs more).

/**
 * A view's per-frame cost, ms (median of Update + Render with views on, minus the same with them off), may not exceed these.
 * Measured 2026-11-26 (4-core cloud container, Chromium with software GL, e2e frame cap): the control mapper (five rows,
 * pointer over it) 3.1, 2.4 and 3.3 ms over three runs (World 8.1–8.8 ms with it, 4.7–5.7 without); the Pirates HUD in a
 * bot match 5.4, 2.3 and 5.0 ms (World 19.0–20.8 ms with it, 14.0–17.3 without; the match's own frame varies by a few ms).
 * The tripwires are about 2.5× the highest reading.
 */
const TRIPWIRE_MS = { mapper: 8, piratesHud: 14 };
/** How long each half of a measurement reads Stats. */
const MEASURE_MS = 6_000;

type FrameCost = { on: number; off: number; ui: number; samples: number };

/** The Stats overlay's Update and Render for `world`, ms, or null until it has a reading. */
async function phaseMs(page: Page, world: string | null): Promise<{ update: number; render: number } | null> {
  const rows = page.getByRole("region", { name: "Stats" }).locator(world === null ? ".play-stats-world" : `.play-stats-world[data-world="${world}"]`).first();
  const update = Number.parseFloat((await rows.locator('[data-stat="update-ms"]').textContent().catch(() => null)) ?? "");
  const sub = (await rows.locator('[data-stat="update-ms"] + .sub').textContent().catch(() => null)) ?? "";
  const render = Number.parseFloat(/render ([\d.]+)/.exec(sub)?.[1] ?? "");
  return Number.isFinite(update) && Number.isFinite(render) ? { update, render } : null;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2 : NaN;
};

/** The median Update + Render of `world` over `MEASURE_MS`, one reading per Stats refresh. */
async function medianFrame(page: Page, world: string | null): Promise<{ ms: number; n: number }> {
  const readings: number[] = [];
  let last = "";
  const until = Date.now() + MEASURE_MS;
  while (Date.now() < until) {
    const p = await phaseMs(page, world);
    const key = p ? `${p.update}/${p.render}` : "";
    if (p && key !== last) readings.push(p.update + p.render);
    last = key;
    await page.waitForTimeout(260); // the overlay refreshes every 250 ms
  }
  return { ms: median(readings), n: readings.length };
}

/** Enable or disable every UIView in `world` (null: the default World), through `Component.enabled`. */
const setViews = (page: Page, world: string | null, enabled: boolean) =>
  inLiveWorld(
    page,
    world,
    (w, { myco, componentsOf }, on) => {
      const views = componentsOf<{ enabled: boolean }>(w!.root, myco.UIView);
      for (const v of views) v.enabled = on;
      return views.length;
    },
    enabled,
  );

/** Measure `world` with its views on, then off, then turn them back on. */
async function frameCost(page: Page, world: string | null): Promise<FrameCost> {
  await page.locator(".play-tools").getByRole("button", { name: "Stats", exact: true }).click();
  await expect.poll(() => phaseMs(page, world), { timeout: 20_000 }).not.toBeNull();
  await page.waitForTimeout(1_000); // past the frames that started the overlay
  const on = await medianFrame(page, world);
  expect(await setViews(page, world, false)).toBeGreaterThan(0);
  await page.waitForTimeout(1_000);
  const off = await medianFrame(page, world);
  await setViews(page, world, true);
  return { on: on.ms, off: off.ms, ui: on.ms - off.ms, samples: Math.min(on.n, off.n) };
}

const report = (name: string, cost: FrameCost) => {
  const text = `${name}: views on ${cost.on.toFixed(2)} ms, off ${cost.off.toFixed(2)} ms, UI ${cost.ui.toFixed(2)} ms a frame (median of ${cost.samples}+ Stats readings each)`;
  console.log(`[ui-css perf] ${text}`);
  test.info().annotations.push({ type: "frame time", description: text });
};

test.describe("frame time", { tag: "@slow" }, () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.removeItem("myco.editor.playStats"));
  });

  test("the control-mapper screen's UI stays within its frame-time tripwire", async ({ page, browserName }) => {
    test.skip(browserName === "webkit", "the tripwire is measured on Chromium");
    const problems = trackProblems(page);
    const MAPPER_SCENE = JSON.stringify({
      format: "myco.scene@4",
      settings: { physics: "2d" },
      nodes: [
        { id: "camera", name: "Camera", components: [{ type: "engine.Transform", data: { position: [0, 0, -10] } }, { type: "engine.Camera", data: { projection: "orthographic", orthographicSize: 10, backgroundColor: "#4ec0ca" } }] },
        { id: "menu", name: "Menu", components: [{ type: "engine.UIControlMapper", data: { actions: "jump, left, right, fire, pause" } }] },
      ],
    });
    const ACTIONS = `import { button, defineActions } from "myco";

export const MenuActions = defineActions("game.MenuActions", {
  jump: button("<Keyboard>/j", "<Gamepad>/buttonSouth"),
  left: button("<Keyboard>/a", "<Gamepad>/dpad/left"),
  right: button("<Keyboard>/d", "<Gamepad>/dpad/right"),
  fire: button("<Keyboard>/f", "<Gamepad>/buttonWest"),
  pause: button("<Keyboard>/escape", "<Gamepad>/start"),
});
`;
    await openEditor(page, { viewport: VIEWPORT, files: { "scripts/menuActions.ts": ACTIONS, "scenes/main.scene.json": MAPPER_SCENE } });
    await play(page);
    await expect
      .poll(() => inLiveWorld(page, null, (w, { myco, componentsOf }) => (w ? componentsOf<{ rows: unknown[] }>(w.root, myco.UIControlMapper)[0]?.rows.length ?? 0 : 0)), { timeout: 20_000 })
      .toBe(5);
    // The pointer over the mapper's middle, so hover restyles are part of what's measured.
    const box = (await gameView(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const cost = await frameCost(page, null);
    report("control mapper", cost);
    expect(cost.ui, `the control mapper's UI costs ${cost.ui.toFixed(2)} ms a frame`).toBeLessThan(TRIPWIRE_MS.mapper);
    expect(problems).toEqual([]);
  });

  test("the Pirates HUD in a running match stays within its frame-time tripwire", async ({ page, browserName }) => {
    test.skip(browserName === "webkit", "a 3D sample in software rendering is too slow on WebKit");
    test.setTimeout(300_000);
    type Lobby = { state: string; me: { host: boolean } | null; createRoom(o: { name: string; public: boolean }): void; start(): void };
    const lobby = <R>(fn: (l: Lobby) => R) => page.evaluate(`(${fn.toString()})(globalThis.__myco.Lobby)`) as Promise<R>;
    const MATCH = "Match 1 Client";
    await openEditor(page, { sample: "pirates", viewport: VIEWPORT, timeout: 120_000 });
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(() => inLiveWorld(page, "Menu", (w) => w?.time.frameCount ?? -1), { timeout: 120_000 }).toBeGreaterThan(10);
    // Practice against bots, as the menu's button does (lobbyview.spec.ts): a private room, started once we're its host.
    await expect.poll(() => lobby((l) => l.state), { timeout: 60_000 }).toBe("lobby");
    await lobby((l) => l.createRoom({ name: "Practice", public: false }));
    await expect.poll(() => lobby((l) => l.state === "room" && !!l.me?.host)).toBe(true);
    await lobby((l) => l.start());
    await expect.poll(() => inLiveWorld(page, MATCH, (w) => w?.time.frameCount ?? -1), { timeout: 120_000 }).toBeGreaterThan(5);
    // The HUD has mounted (its clock is laid out) before measuring.
    await expect
      .poll(
        () =>
          inLiveWorld(page, MATCH, (w, { myco, componentsOf }) => {
            if (!w) return false;
            const views = componentsOf<{ query(s: string): { rect(): unknown } | null }>(w.root, myco.UIView);
            return views.some((v) => !!v.query("#clock")?.rect());
          }),
        { timeout: 60_000 },
      )
      .toBe(true);
    // ADR 0433: afloat, with the middle panel's lines empty, the bottom bar (batteries, hull bar) is laid out on the screen.
    // Yoga gave the empty lines the whole height and pushed it below the screen.
    const bars = await inLiveWorld(page, MATCH, (w, { myco, componentsOf }) => {
      type Rect = { x: number; y: number; width: number; height: number } | null;
      const views = componentsOf<{ query(s: string): { rect(): Rect } | null }>(w!.root, myco.UIView);
      const rect = (s: string) => views.map((v) => v.query(s)?.rect() ?? null).find((r) => r) ?? null;
      return { screen: rect("#screen"), bars: rect("#bars"), hullBar: rect("#hull-bar"), battery: rect("#port") };
    });
    expect(bars.screen && bars.bars && bars.hullBar && bars.battery, JSON.stringify(bars)).toBeTruthy();
    expect(bars.bars!.height).toBeGreaterThan(0);
    expect(bars.bars!.y + bars.bars!.height).toBeLessThanOrEqual(bars.screen!.y + bars.screen!.height + 0.5);
    expect(bars.hullBar!.width).toBeGreaterThan(0);
    expect(bars.battery!.y + bars.battery!.height).toBeLessThanOrEqual(bars.screen!.y + bars.screen!.height + 0.5);
    const cost = await frameCost(page, MATCH);
    report("Pirates HUD", cost);
    expect(cost.ui, `the Pirates HUD costs ${cost.ui.toFixed(2)} ms a frame`).toBeLessThan(TRIPWIRE_MS.piratesHud);
  });
});
