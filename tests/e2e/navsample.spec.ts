import { expect, type Page, play, test, openEditor } from "./fixtures";
import { inLiveWorld, type LiveNode } from "./liveWorld";
import { captureView, pixelsNear, themeColor } from "./viewCapture";

// The navigation sample (ADR 0065, samples/navigation: Foxfire's Streaming Demo on the built-in navigation): listed
// on the start screen, played with Play. The streamer loads the chunk scenes around the agents (additively), the
// crowds walk, fly and hop to spots round the touring goal, and the Nav overlay draws the live navigation of the
// play World, read from captures of the game view taken while the game is paused and stepped.
//
// The play World is read through the editor's hooks: `window.playEngine` (the running game) and
// `globalThis.__myco` (the engine module project scripts import as "myco").
const START = "/editor.html"; // relative to baseURL (E2E_PORT)

test.describe.configure({ timeout: 120_000 });

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

interface PlayState {
  frame: number;
  /** The play World's loaded chunk scenes (scene nodes named chunk-…). */
  chunkScenes: string[];
  /** Chunks in the navigation runtime. */
  runtimeChunks: number;
  agents: { name: string; x: number; y: number; z: number; mode: string }[];
}

/** The running game's World: its scenes, navigation chunks and agents. */
const playState = (page: Page) =>
  inLiveWorld(page, null, (w, { myco }) => {
    type Agent = { node: LiveNode; mode: string };
    if (!w || !myco.NavAgent) return null;
    return {
      frame: w.time.frameCount,
      chunkScenes: w.sceneNodes.map((s) => s.name).filter((n) => n.startsWith("chunk-")),
      runtimeChunks: (myco.Navigation.loadedChunks as string[]).length, // the current World's: between frames, the play Engine's default World
      agents: (myco.GameObject.findObjectsOfType(myco.NavAgent) as Agent[]) // the current World's, as a script finds them
        .filter((a) => a.node.isValid && a.node.transform)
        .map((a) => ({ name: a.node.name, x: a.node.transform!.position.x, y: a.node.transform!.position.y, z: a.node.transform!.position.z, mode: a.mode })),
    } satisfies PlayState;
  });

const gameView = (page: Page) => captureView(page.locator("#game-view canvas").first());

test("the start screen lists Navigation", async ({ page }) => {
  await page.goto(START);
  const sample = page.getByRole("dialog", { name: "Start" }).locator(".sample", { hasText: "Navigation" });
  await expect(sample).toContainText("Streaming Demo");
  await sample.getByRole("button", { name: "Open" }).click();
  await expect(page.locator(".project-name")).toHaveText("Navigation (sample, read-only)");
  await expect(page.locator(".inspector .component.missing")).toHaveCount(0);
});

test("Play: chunks stream in round the agents, agents of every kind move, the Nav overlay draws the live navigation", { tag: "@slow" }, async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page, { sample: "navigation" });
  await expect(page.locator(".project-name")).toHaveText("Navigation (sample, read-only)");

  await play(page);

  // The streamer loads the chunks the agents stand in or near (the centre, the south, the west with its courses),
  // and each chunk's bake joins the navigation runtime.
  await expect.poll(async () => (await playState(page))?.chunkScenes.length ?? 0, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
  await expect.poll(async () => (await playState(page))?.runtimeChunks ?? 0, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
  const first = (await playState(page))!;
  expect(first.chunkScenes).toContain("chunk-5-centre");
  expect(first.chunkScenes.length).toBeLessThan(9);
  expect(first.agents.length).toBeGreaterThanOrEqual(100);

  // A few seconds on, agents of every kind have moved; the flyers are in the air.
  const kindOf = (name: string) => name.replace(/ \d+$/, "").replace(/ member$/, "");
  const start = new Map(first.agents.map((a) => [a.name, a]));
  // Wait on frames, not a fixed time: software GL renders this scene at a few frames a second.
  await expect.poll(async () => ((await playState(page))?.frame ?? 0) - first.frame, { timeout: 90_000 }).toBeGreaterThan(120);
  const later = (await playState(page))!;
  const moved = new Map<string, number>();
  for (const a of later.agents) {
    const s = start.get(a.name);
    if (s && Math.hypot(a.x - s.x, a.z - s.z) > 3) moved.set(kindOf(a.name), (moved.get(kindOf(a.name)) ?? 0) + 1);
  }
  for (const kind of ["Walker", "Flyer", "Walk-and-fly agent", "Jumper", "Climber"]) expect(moved.get(kind) ?? 0, `${kind}: ${JSON.stringify([...moved])}`).toBeGreaterThan(0);
  expect([...moved.keys()].some((k) => /group/.test(k))).toBe(true);
  expect(later.agents.some((a) => a.mode === "flying" && a.y > 4)).toBe(true);

  // The crowds head for the south-east through the door: its chunk streams in.
  await expect.poll(async () => (await playState(page))?.chunkScenes ?? [], { timeout: 45_000 }).toContain("chunk-3-south-east");

  // The Nav overlay draws the play World's navigation (navmesh outlines over the seams and paths) while it's on. The
  // game is paused and stepped a frame at a time (a paused game isn't drawn again); a frame with Navmesh on has many
  // more pixels of the outline colour (the theme's `--success`) than one with it off. The camera moves, so frames
  // aren't compared pixel by pixel.
  await page.getByRole("button", { name: "❚❚ Pause", exact: true }).click();
  const navmesh = page.getByRole("checkbox", { name: "Navmesh" });
  /** Tick Navmesh in the Nav popover (a step closes it). */
  const setNavmesh = async (on: boolean) => {
    if (!(await navmesh.isVisible())) await page.getByRole("button", { name: "Navigation overlay" }).click();
    await navmesh.setChecked(on);
  };
  /** The game view after two steps (the editor's drawing follows a change a frame later). */
  const stepped = async () => {
    const step = page.getByRole("button", { name: "Step", exact: true });
    await step.click();
    await step.click();
    return gameView(page);
  };
  const outline = await themeColor(page, "--success");
  const toggles = async () => {
    const off = pixelsNear(await stepped(), outline);
    await setNavmesh(true);
    const on = pixelsNear(await stepped(), outline);
    await setNavmesh(false);
    const offAgain = pixelsNear(await stepped(), outline);
    expect(on, `outline-coloured pixels: ${off} off, ${on} on, ${offAgain} off again`).toBeGreaterThan(Math.max(60, 4 * Math.max(off, offAgain)));
  };
  await toggles();

  // Post-processing on the camera keeps the debug drawing: it's drawn back after the effects (a bloom pass used to
  // hide it for good in play Worlds).
  const added = await inLiveWorld(page, null, (w, { myco }) => {
    const camera = w && myco.Camera ? (myco.GameObject.findObjectsOfType(myco.Camera) as { node: LiveNode }[])[0] : undefined;
    if (!camera) return false;
    camera.node.addBehavior(myco.PostProcessing, { bloom: true });
    return true;
  });
  expect(added).toBe(true);
  await page.waitForTimeout(1_000); // the post-processing libraries load, then frames go through the composer
  await stepped();
  await toggles();

  await page.getByRole("button", { name: /Stop/ }).click();
  await expect(page.getByRole("button", { name: "▶ Play" })).toBeVisible();
  expect(errors).toEqual([]);
});
