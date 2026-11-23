import { expect, type Hooks, openEditor, type Page, play, test } from "./fixtures";
import { benderFiles, node, scene, stage } from "./animationAssets";
import { dockBelow } from "./animationWindows";
import { captureView, pixelsChanged, steadyView } from "./viewCapture";

// The animation graph editor and its live debugger (ADR 0373, T51/T52) on a game playing in the editor: the skinned
// column's Animator runs a graph whose machine rests in "Rest" (the bind pose) until its `bend` parameter turns it to
// "Bend" (the column's clip). Selecting the Animator in the live Hierarchy lights the overlay (the machine's live badge,
// the current state); editing `bend` in the live parameter panel moves the machine (and the column bends in the game
// view); paused, scrubbing the recorder back shows the recorded pose in the game view, and Live brings the game's back.

test.describe.configure({ timeout: 120_000 });

const GRAPH = {
  format: "myco.animgraph-source@1",
  output: "machine",
  parameters: [{ name: "bend", type: "bool" }],
  nodes: [
    { id: "rest", family: "sources", kind: "bindPose", params: {} },
    { id: "bendClip", family: "sources", kind: "clipPlayer", params: { clip: "asset:models/bend.gltf#Anim/Bend" } },
    {
      id: "machine",
      family: "logic",
      kind: "stateMachine",
      machine: {
        entry: "Rest",
        states: [
          { name: "Rest", root: "rest", transitions: [{ to: "Bend", if: { param: "bend", op: "==", value: true }, duration: 0.1 }] },
          { name: "Bend", root: "bendClip", transitions: [{ to: "Rest", if: { param: "bend", op: "==", value: false }, duration: 0.1 }] },
        ],
      },
    },
  ],
};

const SCENE = scene([
  ...stage(),
  node("bender", "Bender", [0, 0, 0], [
    { type: "engine.Skeleton", data: { skeleton: "asset:models/bend.gltf#Skeleton" } },
    { type: "engine.Animator", data: { graph: "asset:graphs/bend.animgraph.json" } },
  ]),
  node("bender-body", "Body", [0, 0, 0], [{ type: "engine.SkinnedMeshRenderer", data: { mesh: "asset:models/bend.gltf" } }], { parent: "bender" }),
]);

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

const gameView = (page: Page) => page.locator("#game-view canvas").first();
const editorPanel = (page: Page) => page.locator(".ag-editor");

test("the live debugger follows the Animator picked in the live Hierarchy, edits its parameters, and scrubs recorded poses", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page, { viewport: { width: 1600, height: 1000 }, files: { ...benderFiles(), "graphs/bend.animgraph.json": JSON.stringify(GRAPH), "scenes/main.scene.json": SCENE } });
  // Open the graph from the Assets panel, and give it the bottom dock (it opens beside the Scene view, over the game).
  const assets = page.locator(".panel.assets");
  const tile = (name: string) => assets.locator(".asset-item", { has: page.locator(".asset-name", { hasText: new RegExp(`^${name}$`) }) });
  await tile("graphs").dblclick();
  await tile("bend(\\.animgraph\\.json)?").dblclick();
  await expect(editorPanel(page)).toBeVisible();
  await dockBelow(page, "Animation Graph");
  const machineNode = editorPanel(page).locator('.ag-node[data-node="machine"]');
  await expect(machineNode).toBeVisible();

  await play(page);
  const debuggerBar = editorPanel(page).getByRole("region", { name: "Live debugger" });
  await expect(debuggerBar).toBeVisible();

  // The live Hierarchy's selection is what the debugger follows: pick the Bender in the play World.
  const hierarchy = page.locator(".panel.hierarchy");
  const worldName = await page.evaluate(() => (window as unknown as Hooks).playEngine!.world.name);
  await hierarchy.getByRole("combobox", { name: "Inspect World" }).selectOption(worldName);
  await hierarchy.getByRole("tree", { name: "Live nodes" }).locator('.row[data-name="Bender"]').click();
  // The overlay: the machine node is live (its weight badge), and inside it Rest is the current state.
  await expect(machineNode).toHaveClass(/live-active/, { timeout: 15_000 });
  await machineNode.dblclick();
  const state = (name: string) => editorPanel(page).getByLabel(`State ${name}`, { exact: true });
  await expect(state("Rest")).toHaveClass(/live-current/);
  const rest = await steadyView(gameView(page));

  // Setting `bend` in the live parameters moves the machine to Bend, and the column bends in the game view.
  // The box shows the game's value (it follows a frame later), so it's clicked rather than checked.
  const bend = editorPanel(page).getByRole("checkbox", { name: "bend live value" });
  await bend.click();
  await expect(bend).toBeChecked();
  await expect(state("Bend")).toHaveClass(/live-current/, { timeout: 10_000 });
  await expect.poll(async () => pixelsChanged(rest, await captureView(gameView(page))), { timeout: 15_000, message: "pixels the bend changes in the game view" }).toBeGreaterThan(150);

  // Paused, the recorder's oldest frames are the rest pose: scrubbing back shows it in the game view; Live shows the game's again.
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const paused = await steadyView(gameView(page));
  expect(pixelsChanged(rest, paused), "the game is paused mid-bend").toBeGreaterThan(150);
  const scrubber = debuggerBar.getByRole("slider", { name: "Recorded frame" });
  await scrubber.fill("0");
  await expect(debuggerBar.getByLabel("Scrubbed time")).not.toHaveText("live");
  await expect.poll(async () => pixelsChanged(paused, await captureView(gameView(page))), { timeout: 15_000, message: "pixels the recorded pose changes in the paused game view" }).toBeGreaterThan(150);
  await debuggerBar.getByRole("button", { name: "Live", exact: true }).click();
  await expect.poll(async () => pixelsChanged(paused, await captureView(gameView(page))), { timeout: 15_000, message: "pixels off the paused game's own pose after Live" }).toBeLessThan(60);
  expect(errors).toEqual([]);
});
