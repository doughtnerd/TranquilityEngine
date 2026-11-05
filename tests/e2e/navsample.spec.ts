import { expect, test, type Page } from "@playwright/test";

// The navigation sample (ADR 0065, samples/navigation: Foxfire's Streaming Demo on the built-in navigation): listed
// on the start screen, played with Play. The streamer loads the chunk scenes around the agents (additively), the
// crowds walk, fly and hop to spots round the touring goal, and the Nav overlay draws the live navigation of the
// play World (the test hook `window.navOverlay()`, src/editor/navGizmo.ts).
//
// The play World is read through the editor's hooks: `window.playEngine` (the running game) and
// `globalThis.__myco` (the engine module project scripts import as "myco").
const START = "/editor.html"; // relative to baseURL (E2E_PORT)

test.describe.configure({ timeout: 120_000 });

type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  navOverlay?: () => { bakes: number; loaded: number; segments: number; failed: string[]; play: number[] };
};

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
  page.evaluate(() => {
    type Node = { name: string; isValid: boolean; transform: { position: { x: number; y: number; z: number } } | null };
    type Agent = { node: Node; mode: string };
    type W = {
      time: { frameCount: number };
      sceneNodes: Node[];
      navigation: { loadedChunks(): string[] } | null;
      _componentsOfType(type: unknown): Agent[];
    };
    const myco = (globalThis as unknown as { __myco?: { NavAgent: unknown } }).__myco;
    const w = (window as unknown as { playEngine?: { world: W } | null }).playEngine?.world;
    if (!myco || !w) return null;
    return {
      frame: w.time.frameCount,
      chunkScenes: w.sceneNodes.map((s) => s.name).filter((n) => n.startsWith("chunk-")),
      runtimeChunks: w.navigation?.loadedChunks().length ?? 0,
      agents: w
        ._componentsOfType(myco.NavAgent)
        .filter((a) => a.node.isValid && a.node.transform)
        .map((a) => ({ name: a.node.name, x: a.node.transform!.position.x, y: a.node.transform!.position.y, z: a.node.transform!.position.z, mode: a.mode })),
    } satisfies PlayState;
  });

const overlay = (page: Page) => page.evaluate(() => (window as unknown as Hooks).navOverlay?.() ?? null);

test("the start screen lists Navigation", async ({ page }) => {
  await page.goto(START);
  const sample = page.getByRole("dialog", { name: "Start" }).locator(".sample", { hasText: "Navigation" });
  await expect(sample).toContainText("Streaming Demo");
  await sample.getByRole("button", { name: "Open" }).click();
  await expect(page.locator(".project-name")).toHaveText("Navigation (sample, read-only)");
  await expect(page.locator(".inspector .component.missing")).toHaveCount(0);
});

test("Play: chunks stream in round the agents, agents of every kind move, the Nav overlay draws the live navigation", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(`${START}?sample=navigation`);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await expect(page.locator(".project-name")).toHaveText("Navigation (sample, read-only)");

  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();

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
  await page.waitForTimeout(8_000);
  const later = (await playState(page))!;
  expect(later.frame).toBeGreaterThan(first.frame + 120);
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

  // The Nav overlay draws the play World's navigation (navmesh outlines, seams, paths) while it's on.
  await page.getByRole("button", { name: "Navigation overlay" }).click();
  await page.getByRole("checkbox", { name: "Navmesh" }).check();
  await expect.poll(async () => (await overlay(page))?.play[0] ?? 0, { timeout: 15_000 }).toBeGreaterThan(50);
  await page.getByRole("checkbox", { name: "Navmesh" }).uncheck();
  const withoutNavmesh = (await overlay(page))?.play[0] ?? 0;
  await page.getByRole("checkbox", { name: "Navmesh" }).check();
  await expect.poll(async () => (await overlay(page))?.play[0] ?? 0).toBeGreaterThan(withoutNavmesh);

  // Post-processing on the camera keeps the debug drawing: it's drawn back after the effects (a bloom pass used to
  // hide it for good in play Worlds).
  const drawnObjects = () =>
    page.evaluate(() => {
      const rows = (window as unknown as { playEditorDrawing?: () => { drawn: { drawnObjects: number } | null }[] }).playEditorDrawing?.() ?? [];
      return rows.reduce((n, r) => n + (r.drawn?.drawnObjects ?? 0), 0);
    });
  await expect.poll(drawnObjects).toBeGreaterThan(0);
  const added = await page.evaluate(() => {
    type C = { node: { addBehavior(type: unknown, init?: object): unknown } };
    const myco = (globalThis as unknown as { __myco?: { Camera: unknown; PostProcessing: unknown } }).__myco;
    const w = (window as unknown as { playEngine?: { world: { _componentsOfType(type: unknown): C[] } } | null }).playEngine?.world;
    const camera = myco && w?._componentsOfType(myco.Camera)[0];
    if (!camera) return false;
    camera.node.addBehavior(myco.PostProcessing, { bloom: true });
    return true;
  });
  expect(added).toBe(true);
  await page.waitForTimeout(1_000); // the post-processing libraries load, then frames go through the composer
  await expect.poll(drawnObjects, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.getByRole("checkbox", { name: "Navmesh" }).uncheck();

  await page.getByRole("button", { name: /Stop/ }).click();
  await expect(page.getByRole("button", { name: "▶ Play" })).toBeVisible();
  expect(errors).toEqual([]);
});
