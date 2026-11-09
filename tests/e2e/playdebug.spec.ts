import { expect, type Page, play, PLAY_START, test } from "./fixtures";
import { showTab } from "./tabs";
import { menu } from "./menus";

// Play mode debugging (ADR 0022, 0032, 0033): the World picker shows a live World of the running
// game in the Hierarchy and Inspector, live edits change only the game, "Keep values" writes them
// into the scene on Stop as one undo step; the session pauses and steps a frame at a time (toolbar,
// shortcuts, and per World in the game view's strip); the Host pattern (samples/arena) plays with
// N clients plus thin clients; the Network panel breaks snapshot bandwidth down by ghost type.
const FLAPPY = "/editor.html?sample=flappy"; // relative to baseURL (E2E_PORT)
const ARENA = "/editor.html?sample=arena";

type LiveNode = { name: string; children: LiveNode[]; transform: { position: { x: number; y: number } } | null; isValid: boolean };
type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  playEngine?: {
    world: { name: string; time: { frameCount: number } };
    worlds(): { name: string }[];
    _world(name: string): { root: LiveNode; time: { frameCount: number } } | null;
  } | null;
};

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

/** The x of the first live node named `name` in a World of the running game (the default World unless named). */
const liveX = (page: Page, name: string, world?: string) =>
  page.evaluate(
    ([n, w]) => {
      const engine = (window as unknown as Hooks).playEngine!;
      const find = (node: LiveNode): LiveNode | null => (node.name === n ? node : node.children.reduce<LiveNode | null>((hit, c) => hit ?? find(c), null));
      return find(engine._world(w ?? engine.world.name)!.root)?.transform?.position.x ?? null;
    },
    [name, world ?? null] as const,
  );

const frames = (page: Page, world?: string) =>
  page.evaluate((w) => {
    const engine = (window as unknown as Hooks).playEngine!;
    return engine._world(w ?? engine.world.name)!.time.frameCount;
  }, world ?? null);

test("the World picker shows the running game; live edits; Keep values writes them on Stop, undoably", async ({ page }) => {
  const errors = trackErrors(page);
  await open(page, FLAPPY);
  const hierarchy = page.locator(".panel.hierarchy");
  const inspector = page.locator(".panel.inspector");
  // Editing: no picker.
  await expect(hierarchy.getByRole("combobox", { name: "Inspect World" })).toHaveCount(0);
  const sceneBirdX = inspector.locator(".component", { hasText: "Transform" }).first().getByRole("textbox", { name: "position x" });
  const selectSceneBird = () => hierarchy.locator(".tree .row .name", { hasText: /^Bird$/ }).click();
  await selectSceneBird();
  const sceneX = await sceneBirdX.inputValue();

  await play(page);
  const picker = hierarchy.getByRole("combobox", { name: "Inspect World" });
  await expect(picker).toBeVisible();
  const worldName = await page.evaluate(() => (window as unknown as Hooks).playEngine!.world.name);
  await picker.selectOption(worldName);

  // The live tree: the loaded scene and its nodes, refreshed as it changes.
  const tree = hierarchy.getByRole("tree", { name: "Live nodes" });
  await expect(tree.locator(".row.live-scene .badge")).toHaveText(["main"]);
  const birdRow = tree.locator('.row[data-name="Bird"]');
  await expect(birdRow).toHaveCount(1);
  await birdRow.click();
  await expect(birdRow).toHaveClass(/selected/);
  await expect(inspector.locator(".live-badge")).toContainText(`live · ${worldName}`);

  // A live edit moves the game's bird only.
  await page.getByRole("button", { name: "❚❚ Pause", exact: true }).click(); // hold it still while editing
  const transform = inspector.locator(".component", { hasText: "Transform" }).first();
  const x = transform.getByRole("textbox", { name: "position x" });
  await x.fill("-3.5");
  await x.press("Enter");
  await expect.poll(() => liveX(page, "Bird")).toBe(-3.5);
  await expect(x).toHaveValue("-3.5");

  // Keep the Transform's values; the header marks it kept.
  await transform.getByRole("button", { name: "Keep Transform values" }).click();
  await expect(page.locator(".status-text")).toContainText("Kept Bird's Transform values");
  await expect(transform.locator(".kept-badge")).toHaveText("kept");
  await expect(inspector.locator(".kept-list summary")).toContainText("1 kept for Stop");

  // A node made at runtime can't keep values, and says why: Flappy's pipes are instantiated by the spawner.
  await page.getByRole("button", { name: "▶ Resume", exact: true }).click();
  await page.locator("#game-view").click(); // start the game so pipes spawn
  await page.keyboard.press("Space");
  const pipe = tree.locator('.row.live-instance[data-name="PipePair"]').first();
  await expect(pipe).toBeVisible({ timeout: 15_000 });
  await pipe.click();
  await expect(inspector.locator(".keep-note")).toContainText("instantiated at runtime from prefabs/pipe-pair.prefab.json");
  await expect(inspector.getByRole("button", { name: "Keep all changes to this node" })).toBeDisabled();

  // Back to the edited scene: the document still has the old position while playing.
  await picker.selectOption("");
  await expect(hierarchy.getByRole("tree", { name: "Scene nodes" })).toBeVisible();

  await page.getByRole("button", { name: /Stop/ }).click();
  await expect(page.locator(".status-text")).toContainText("Kept play-mode changes: 1 field written");
  await selectSceneBird();
  await expect(sceneBirdX).toHaveValue("-3.5");
  await menu(page, "Edit", /^Undo/);
  await expect(sceneBirdX).toHaveValue(sceneX);
  expect(errors).toEqual([]);
});

/** The name of the live node `name`'s parent in the running game's default World, or null if there's no such node. */
const liveParent = (page: Page, name: string) =>
  page.evaluate((n) => {
    const engine = (window as unknown as Hooks).playEngine!;
    const find = (node: LiveNode, parent: LiveNode | null): LiveNode | null | undefined =>
      node.name === n ? parent : node.children.reduce<LiveNode | null | undefined>((hit, c) => (hit !== undefined ? hit : find(c, node)), undefined);
    const parent = find(engine._world(engine.world.name)!.root, null);
    return parent === undefined ? null : (parent?.name ?? "(root)");
  }, name);

test("the live Hierarchy creates, renames, reparents and deletes nodes; the live Inspector adds and removes components and sets node references (ADR 0124)", async ({ page }) => {
  const errors = trackErrors(page);
  await open(page, FLAPPY);
  const hierarchy = page.locator(".panel.hierarchy");
  const inspector = page.locator(".panel.inspector");
  await play(page);
  const worldName = await page.evaluate(() => (window as unknown as Hooks).playEngine!.world.name);
  await hierarchy.getByRole("combobox", { name: "Inspect World" }).selectOption(worldName);
  await page.getByRole("button", { name: "❚❚ Pause", exact: true }).click(); // edits apply while paused too
  const tree = hierarchy.getByRole("tree", { name: "Live nodes" });
  const row = (name: string) => tree.locator(`.row[data-name="${name}"]`);

  // Create at the top level (under the loaded scene) and name it in place.
  await hierarchy.getByRole("button", { name: "Create live node" }).click();
  await page.getByRole("menuitem", { name: "Create Empty", exact: true }).click();
  const rename = tree.getByRole("textbox", { name: "Node name" });
  await expect(rename).toBeFocused();
  await rename.fill("Marker");
  await rename.press("Enter");
  await expect(row("Marker")).toHaveCount(1);
  expect(await liveParent(page, "Marker")).toBe("main");

  // A child from the right-click menu.
  await row("Marker").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Create Empty Child" }).click();
  await rename.fill("Inner");
  await rename.press("Enter");
  await expect(row("Inner")).toHaveCount(1);
  expect(await liveParent(page, "Inner")).toBe("Marker");

  // Drag onto another node reparents; onto the World header moves it to the top level.
  await row("Inner").dragTo(row("Bird"));
  await expect.poll(() => liveParent(page, "Inner")).toBe("Bird");
  await row("Inner").dragTo(hierarchy.locator(".live-name"));
  await expect.poll(() => liveParent(page, "Inner")).toBe("main");
  // A loaded scene can't be moved.
  await expect(tree.locator(".row.live-scene")).toHaveAttribute("draggable", "false");

  // Add a component with a node reference, point it at the bird, then remove it.
  await row("Marker").click();
  await expect(inspector.locator(".node-name")).toHaveText("Marker");
  await inspector.getByRole("button", { name: "Add Component" }).click();
  await page.getByRole("searchbox", { name: "Search components" }).fill("FixedJoint2D");
  await page.getByRole("searchbox", { name: "Search components" }).press("Enter");
  const joint = inspector.locator('.component[data-type="engine.FixedJoint2D"]');
  await expect(joint).toHaveCount(1);
  const birdEntity = await row("Bird").getAttribute("data-entity");
  const ref = joint.getByRole("combobox", { name: "connectedBody" });
  await expect(ref).toHaveValue("");
  await ref.selectOption(birdEntity!);
  await expect(ref).toHaveValue(birdEntity!);
  await page.waitForTimeout(400); // a refresh later it still reads the live value
  await expect(ref).toHaveValue(birdEntity!);
  await expect(inspector.getByRole("button", { name: "Remove Transform" })).toBeDisabled();
  await joint.getByRole("button", { name: "Remove FixedJoint2D" }).click();
  await expect(joint).toHaveCount(0);

  // Delete from the keyboard.
  await row("Marker").click();
  await page.keyboard.press("Delete");
  await expect(row("Marker")).toHaveCount(0);
  expect(await liveParent(page, "Marker")).toBeNull();
  await expect(page.locator(".status-text")).toContainText("Deleted Marker from the running game");

  // None of it reached the scene.
  await page.getByRole("button", { name: /Stop/ }).click();
  const sceneTree = hierarchy.getByRole("tree", { name: "Scene nodes" });
  await expect(sceneTree).toBeVisible();
  await expect(sceneTree.locator(".row .name", { hasText: /^(Marker|Inner)$/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Pause, Step and the shortcuts hold and advance the whole game; a World steps alone from the strip", async ({ page }) => {
  const errors = trackErrors(page);
  await open(page, FLAPPY);
  const pause = page.getByRole("button", { name: "❚❚ Pause", exact: true });
  await expect(pause).toBeDisabled(); // editing
  await play(page);
  await expect.poll(() => frames(page), { timeout: PLAY_START }).toBeGreaterThan(5); // the game's renderer starts after the button shows

  await pause.click();
  const resume = page.getByRole("button", { name: "▶ Resume", exact: true });
  await expect(resume).toHaveAttribute("aria-pressed", "true");
  // A frame already under way when Pause was pressed may still finish: read the count once it holds.
  let held = -1;
  await expect.poll(async () => {
    const before = await frames(page);
    await page.waitForTimeout(250);
    held = await frames(page);
    return held - before;
  }).toBe(0);

  await page.getByRole("button", { name: "Step", exact: true }).click();
  await expect.poll(() => frames(page)).toBe(held + 1);
  await page.locator(".toolbar").click({ position: { x: 2, y: 2 } }); // focus outside text fields
  await page.keyboard.press("F10");
  await expect.poll(() => frames(page)).toBe(held + 2);
  await page.keyboard.press("Control+Alt+p");
  await expect.poll(() => frames(page)).toBe(held + 3);

  // The strip's Step advances just its World, even while the session is paused.
  const world = await page.evaluate(() => (window as unknown as Hooks).playEngine!.world.name);
  await page.getByRole("toolbar", { name: "Worlds" }).getByRole("button", { name: `Step ${world}` }).click();
  await expect.poll(() => frames(page)).toBe(held + 4);

  // Ctrl+Shift+P resumes.
  await page.keyboard.press("Control+Shift+p");
  await expect(pause).toBeVisible();
  await expect.poll(() => frames(page)).toBeGreaterThan(held + 10);
  await page.getByRole("button", { name: /Stop/ }).click();
  await expect(pause).toBeDisabled();
  expect(errors).toEqual([]);
});

test("Host pattern: Arena plays with 2 clients and a thin client on a server made from its template; bandwidth per ghost type", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = trackErrors(page);
  await open(page, ARENA);
  await showTab(page, /^Network/);
  const panel = page.locator(".panel.network");
  await panel.getByRole("checkbox", { name: "Multiplayer play" }).check();
  await panel.getByRole("combobox", { name: "Clients", exact: true }).selectOption("2");
  await panel.getByRole("combobox", { name: "Thin clients", exact: true }).selectOption("1");
  await expect(panel.getByRole("combobox", { name: "Clients load" })).toHaveValue("server");
  await expect(panel.locator(".network-note")).toContainText('creates the server World "Server" from its template');
  await expect(panel.locator(".network-note")).toContainText("scenes/arena.scene.json");

  await page.getByRole("button", { name: "▶ Play" }).click();
  // Arena has scripts: Play type-checks them first (ADR 0125), loading Monaco's TypeScript worker the first time.
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible({ timeout: 20_000 });
  expect(await page.evaluate(() => (window as unknown as Hooks).playEngine!.worlds().map((w) => w.name))).toEqual(["Client 1", "Client 2", "Thin 1", "Server"]);
  await expect(page.locator("#game-view .game-tile")).toHaveCount(2);

  // Every client joined directly: the server has a player per connection, the thin client's included.
  const serverPlayers = () =>
    page.evaluate(() => {
      const engine = (window as unknown as Hooks).playEngine!;
      const out: number[] = [];
      const visit = (n: LiveNode) => {
        if (n.name === "Player" && n.transform) out.push(n.transform.position.x);
        n.children.forEach(visit);
      };
      visit(engine._world("Server")!.root);
      return out;
    });
  await expect.poll(async () => (await serverPlayers()).length, { timeout: 20_000 }).toBe(3);

  // The thin client's synthetic input moves its player (the game's keyboard system writes zeros there).
  const thinPlayerX = () => page.evaluate(() => {
    type Rep = { node: LiveNode; ownerId: number; isOwnedLocally: boolean };
    const t = (globalThis as unknown as { __myco: { Replicated: unknown } }).__myco;
    const w = (window as unknown as { playEngine: { _world(n: string): { _componentsOfType(type: unknown): Rep[] } } }).playEngine._world("Thin 1");
    return w._componentsOfType(t.Replicated).find((r) => r.isOwnedLocally && r.node.name === "Player")?.node.transform?.position.x ?? null;
  });
  await expect.poll(thinPlayerX, { timeout: 15_000 }).not.toBeNull();
  const start = (await thinPlayerX())!;
  await expect.poll(async () => Math.abs(((await thinPlayerX()) ?? start) - start), { timeout: 15_000 }).toBeGreaterThan(0.2);

  // Bandwidth per ghost type on a server connection: players (prefabs/player.prefab.json).
  const server = panel.locator('.network-world[data-world="Server"]');
  await server.getByRole("button", { name: /Show traffic by kind for Server Connection/ }).first().click();
  const types = server.getByRole("table", { name: "Bandwidth per ghost type" });
  await expect(types.locator('tr[data-ghost-type="prefabs/player.prefab.json"] td').first()).toHaveText("player");

  // The live Hierarchy can show the server World, ghosts and all.
  const hierarchy = page.locator(".panel.hierarchy");
  await hierarchy.getByRole("combobox", { name: "Inspect World" }).selectOption("Client 1");
  await expect(hierarchy.locator('.live-tree .row.live-ghost[data-name="Player"]')).toHaveCount(3, { timeout: 10_000 });
  await page.getByRole("button", { name: /Stop/ }).click();
  expect(errors).toEqual([]);
});
