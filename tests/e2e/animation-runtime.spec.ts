import { expect, openEditor, type Page, play, test } from "./fixtures";
import { bender, benderFiles, node, scene, sheetPng, SHEET_META, stage } from "./animationAssets";
import { inLiveWorld, type LiveNode } from "./liveWorld";
import { captureView, pixelsChanged, type ViewCapture } from "./viewCapture";

// The animation runtime in Play mode (ADR 0370–0372), read from captures of the game view and the public `myco` API:
// a skinned model's Animator poses it differently over time (the column bends), a clip keying a light changes what it
// lights, a flipbook steps a sprite through its frames, an awaited tween resolves where it ends, and a timeline drives
// two nodes. Untagged, so `npm run test:e2e:webkit` runs it too (WebKit renders on the CPU, hence the timeouts).

test.describe.configure({ timeout: 90_000 });

const gameView = (page: Page) => page.locator("#game-view canvas").first();

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

/** The bounding box (in pixels) of a capture's pixels that `match`, or null when none do. */
function boxOf(c: ViewCapture, match: (r: number, g: number, b: number) => boolean): { width: number; height: number; count: number } | null {
  let x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1, count = 0;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * c.channels;
      if (!match(c.data[i]!, c.data[i + 1]!, c.data[i + 2]!)) continue;
      count++;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return count ? { width: x1 - x0 + 1, height: y1 - y0 + 1, count } : null;
}

/** The column's orange paint, lit or shaded. */
const orange = (r: number, g: number, b: number) => r > 90 && r > g * 1.4 && r > b * 2;

/** The mean colour of a capture. */
function mean(c: ViewCapture): [number, number, number] {
  const sum = [0, 0, 0];
  for (let i = 0; i < c.data.length; i += c.channels) for (let k = 0; k < 3; k++) sum[k]! += c.data[i + k]!;
  const n = c.data.length / c.channels;
  return [sum[0]! / n, sum[1]! / n, sum[2]! / n];
}

/** Opens the test project with `files` and the scene `nodes` as its main scene, and presses Play. */
async function playScene(page: Page, nodes: ReturnType<typeof stage>, files: Record<string, string | Uint8Array> = {}): Promise<void> {
  await openEditor(page, { files: { ...files, "scenes/main.scene.json": scene(nodes) } });
  await play(page);
}

/** A live node of the default World by name (the public GameObject API: `root`, `children`). */
const liveNode = <R>(page: Page, name: string, read: (n: LiveNode) => R) =>
  inLiveWorld(
    page,
    null,
    (w, _tools, arg) => {
      const find = (n: LiveNode): LiveNode | null => (n.name === arg.name ? n : n.children.reduce<LiveNode | null>((hit, c) => hit ?? find(c), null));
      const hit = w ? find(w.root) : null;
      return hit ? (new Function("n", `return (${arg.read})(n)`) as (n: LiveNode) => unknown)(hit) : null;
    },
    { name, read: read.toString() },
  ) as Promise<R | null>;

test("a skinned model's Animator poses it differently over time in Play mode", async ({ page }) => {
  const errors = trackErrors(page);
  await playScene(page, [...stage(), ...bender()], benderFiles());
  const view = gameView(page);
  // The column shows (its orange paint), then bends: its upper half swings out sideways, so the painted box widens
  // and shortens. Two captures at two times show two poses.
  await expect.poll(async () => boxOf(await captureView(view), orange)?.count ?? 0, { timeout: 30_000, message: "the column is drawn" }).toBeGreaterThan(50);
  const boxes: { width: number; height: number }[] = [];
  await expect
    .poll(
      async () => {
        const box = boxOf(await captureView(view), orange);
        if (box) boxes.push(box);
        const widths = boxes.map((b) => b.width);
        return Math.max(...widths) / Math.min(...widths);
      },
      { timeout: 30_000, intervals: [200], message: "the column's painted width changes as it bends (widest / narrowest)" },
    )
    .toBeGreaterThan(1.5);
  expect(errors).toEqual([]);
});

test("a clip keying a light's colour changes what it lights", async ({ page }) => {
  const errors = trackErrors(page);
  const glow = {
    format: "myco.anim-source@1",
    duration: 2,
    loop: true,
    // Red at 0 and 2 s, blue at 1 s.
    tracks: [{ kind: "color", target: { nodePath: "", component: "engine.Light", field: "color" }, curves: [[[0, 1], [1, 0], [2, 1]], [[0, 0]], [[0, 0], [1, 1], [2, 0]], [[0, 1]]] }],
  };
  await playScene(
    page,
    [
      node("camera", "Camera", [0, 1, -6], [{ type: "engine.Camera", data: { projection: "perspective", fieldOfView: 50 } }]),
      node("floor", "Floor", [0, 0, 0], [{ type: "engine.MeshRenderer", data: { mesh: "builtin:cube" } }], { scale: [6, 0.2, 6] }),
      node("lamp", "Lamp", [0, 2, 0], [
        { type: "engine.Light", data: { type: "point", intensity: 40, range: 10, color: [1, 1, 1, 1] } },
        { type: "engine.Animator", data: { defaultClip: "asset:clips/glow.anim.json" } },
      ]),
    ],
    { "clips/glow.anim.json": JSON.stringify(glow) },
  );
  const view = gameView(page);
  // The floor is lit red, then blue (over the scene's own studio lighting): the view's mean colour swings from redder
  // to bluer and back. The swing of (red - blue) over the captures says the light changed colour.
  const tints: number[] = [];
  await expect
    .poll(
      async () => {
        const [r, , b] = mean(await captureView(view));
        tints.push(r - b);
        return Math.max(...tints) - Math.min(...tints);
      },
      { timeout: 30_000, intervals: [150], message: "the swing of the view's mean (red - blue)" },
    )
    .toBeGreaterThan(8);
  expect(errors).toEqual([]);
});

test("a flipbook steps a sprite through its frames", async ({ page }) => {
  const errors = trackErrors(page);
  const nodes = [
    node("camera", "Camera", [0, 0, -10], [{ type: "engine.Camera", data: { projection: "orthographic", orthographicSize: 1.5 } }]),
    node("runner", "Runner", [0, 0, 0], [
      { type: "engine.SpriteRenderer", data: { sprite: "asset:images/sheet.png#f0" } },
      { type: "engine.Animator", data: { defaultClip: "asset:images/sheet.png#Flip/cycle" } },
    ]),
  ];
  await openEditor(page, { files: { "images/sheet.png": await sheetPng(), "images/sheet.png.meta.json": SHEET_META, "scenes/main.scene.json": JSON.stringify({ format: "myco.scene@5", nodes }) } });
  await play(page);
  const view = gameView(page);
  // The sprite fills most of the view; its colour is the frame's (red, green, blue, yellow at 4 frames a second).
  const frames = new Set<string>();
  const frameOf = ([r, g, b]: [number, number, number]) => (r > 150 && g > 150 && b < 100 ? "yellow" : r > g * 1.5 && r > b * 1.5 ? "red" : g > r * 1.5 && g > b * 1.5 ? "green" : b > r * 1.5 && b > g * 1.2 ? "blue" : null);
  await expect
    .poll(
      async () => {
        const f = frameOf(mean(await captureView(view)));
        if (f) frames.add(f);
        return frames.size;
      },
      { timeout: 30_000, intervals: [100], message: "the flipbook's frames seen in the game view" },
    )
    .toBeGreaterThanOrEqual(3);
  expect(errors).toEqual([]);
});

test("an awaited tween resolves when its node has arrived", async ({ page }) => {
  const errors = trackErrors(page);
  const probe = `import { GameBehavior, behavior, tween } from "myco";

/** Tweens its node to x = 2 and, once the tween resolves, names the node after the result and where it is. */
@behavior("test.TweenProbe")
export class TweenProbe extends GameBehavior {
  async start(): Promise<void> {
    const result = await tween(this.transform, "position", [2, 0, 0], { duration: 0.6, ease: "linear" });
    this.node.name = \`Done \${result.reason} \${this.transform.position.x.toFixed(2)}\`;
  }
}
`;
  await playScene(page, [...stage(), node("probe", "Probe", [-2, 0, 0], [{ type: "engine.MeshRenderer", data: { mesh: "builtin:cube" } }, { type: "test.TweenProbe", data: {} }])], { "scripts/TweenProbe.ts": probe });
  const done = () =>
    inLiveWorld(page, null, (w) => {
      const all: string[] = [];
      const walk = (n: LiveNode) => (all.push(n.name), n.children.forEach(walk));
      if (w) walk(w.root);
      return all.find((n) => n.startsWith("Done ")) ?? null;
    });
  await expect.poll(done, { timeout: 30_000, message: "the tween's promise resolved" }).toBe("Done finished 2.00");
  expect(errors).toEqual([]);
});

test("a timeline drives two nodes at once", async ({ page }) => {
  const errors = trackErrors(page);
  // A rises from y 0 to 2 while B falls from 2 to 0, over 2 s, looping.
  const move = {
    format: "myco.timeline@1",
    duration: 2,
    tracks: [
      { kind: "vec3", target: { nodePath: "A", component: "engine.Transform", field: "position" }, curves: [[[0, -1.5]], [[0, 0], [2, 2]], [[0, 0]]] },
      { kind: "vec3", target: { nodePath: "B", component: "engine.Transform", field: "position" }, curves: [[[0, 1.5]], [[0, 2], [2, 0]], [[0, 0]]] },
    ],
  };
  const cube = { type: "engine.MeshRenderer", data: { mesh: "builtin:cube" } };
  await playScene(
    page,
    [
      ...stage(),
      node("director", "Director", [0, 0, 0], [{ type: "engine.TimelineDirector", data: { timeline: "asset:timelines/move.timeline.json", playOnStart: true, wrapMode: "loop" } }]),
      node("a", "A", [-1.5, 1, 0], [cube], { parent: "director" }),
      node("b", "B", [1.5, 1, 0], [cube], { parent: "director" }),
    ],
    { "timelines/move.timeline.json": JSON.stringify(move) },
  );
  const heights = async () => ({ a: await liveNode(page, "A", (n) => n.transform!.position.y), b: await liveNode(page, "B", (n) => n.transform!.position.y) });
  // Both follow the timeline: their heights always add up to 2 (A up, B down), and they move.
  const seen: { a: number; b: number }[] = [];
  await expect
    .poll(
      async () => {
        const h = await heights();
        if (h.a !== null && h.b !== null && Math.abs(h.a + h.b - 2) < 0.05) seen.push(h as { a: number; b: number });
        return seen.length >= 2 ? Math.max(...seen.map((s) => s.a)) - Math.min(...seen.map((s) => s.a)) : 0;
      },
      { timeout: 30_000, intervals: [150], message: "A's height range while A + B stays 2" },
    )
    .toBeGreaterThan(0.5);
  // And the game view shows them moving.
  const before = await captureView(gameView(page));
  await expect.poll(async () => pixelsChanged(before, await captureView(gameView(page))), { timeout: 10_000 }).toBeGreaterThan(200);
  expect(errors).toEqual([]);
});
