import { expect, type Locator, openTestProject, type Page, test } from "./fixtures";

// The Event editor (ADR 0158 §7, M2 E6) in a real browser, on a writable in-memory copy of the Flappy sample:
// authoring (New Event, containers, drag in clips, weights, wrap / reorder / duplicate / delete, event and node
// fields, a local parameter and an automation curve, undo, reopening) with the event file on disk checked after each
// step, and Audition (Play, the sliders reaching the instance, Release / Stop, the stale hint). Headless Chromium has
// no sound output: `Audio.debug()` stands in for ears, as in audio-events.spec.ts.
test.describe.configure({ timeout: 120_000 });

type Hooks = { testFolder: { read(path: string): string | undefined } };
type Json = Record<string, unknown>;
type DebugEvent = { id: number; asset: string; voices: number; parameters: Record<string, number | string> };

const NEW_EVENT = "music/New Event.audioevent.json";
const assets = (page: Page) => page.locator(".panel.assets");
const tile = (page: Page, name: string) => assets(page).locator(".asset-item", { has: page.locator(".asset-name", { hasText: name }) });
const tree = (page: Page) => page.getByTestId("event-tree");
const row = (page: Page, path: string) => page.locator(`[data-testid="event-tree-row"][data-event-path="${path}"]`);
const props = (page: Page) => page.getByTestId("event-properties");
const box = async (l: Locator) => (await l.boundingBox())!;

const read = (page: Page, path: string) => page.evaluate((p) => (window as unknown as Hooks).testFolder.read(p), path);
const readJson = async (page: Page, path: string): Promise<Json> => JSON.parse((await read(page, path)) ?? "null");
const children = (node: unknown): Json[] => ((node as Json).children as Json[] | undefined) ?? [];
const types = (node: Json): string[] => [node.type as string, ...children(node).flatMap(types)];

/** Open the music folder in the Assets panel (the bottom dock). */
async function openMusic(page: Page): Promise<void> {
  await page.locator(".dock-tab", { hasText: "Assets" }).click();
  await assets(page).locator(".asset-folder", { hasText: /^music$/ }).click();
}

async function open(page: Page, extra: Record<string, string> = {}): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 }); // the Event editor's panel sits in the narrow right dock
  await openTestProject(page, extra);
  await openMusic(page);
}

/** Press on an asset tile and move to the point `at` gives (once the ghost shows), optionally releasing. */
async function dragClip(page: Page, name: string, target: Locator, release = true): Promise<void> {
  const t = await box(tile(page, name));
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2 + 20, t.y - 20, { steps: 3 });
  const r = await box(target);
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2, { steps: 8 });
  if (release) await page.mouse.up();
}

const ghost = (page: Page) => page.locator(".asset-drag-ghost");

test("authoring: containers, clips, weights, fields, a parameter and an automation, with the file and undo checked at each step", async ({ page }) => {
  await open(page, { "music/other.audioevent.json": JSON.stringify({ format: "myco.audioevent@1" }) });

  // New Event (right-click in the Assets panel) writes a valid empty event; double-clicking it opens the editor.
  const list = await box(assets(page).locator(".asset-items"));
  await page.mouse.click(list.x + list.width - 10, list.y + list.height - 10, { button: "right" });
  await page.getByRole("menuitem", { name: "New Event", exact: true }).click();
  await expect(tile(page, "New Event.audioevent.json")).toHaveCount(1);
  expect((await readJson(page, NEW_EVENT)).format).toBe("myco.audioevent@1");
  await tile(page, "New Event.audioevent.json").dblclick();
  const editor = page.getByTestId("event-editor");
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute("data-asset-document", NEW_EVENT);
  await expect(page.getByTestId("event-tree-row")).toHaveCount(1); // the root layer
  expect(types((await readJson(page, NEW_EVENT)).root as Json)).toEqual(["layer"]);

  /** Run `action`, wait for the file to change and keep what it holds: one entry per undo step. */
  const snapshots: string[] = [JSON.stringify(await readJson(page, NEW_EVENT))];
  const step = async (action: () => Promise<unknown>): Promise<Json> => {
    const before = snapshots[snapshots.length - 1];
    await action();
    await expect.poll(async () => JSON.stringify(await readJson(page, NEW_EVENT)), { message: "the file should change" }).not.toBe(before);
    snapshots.push(JSON.stringify(await readJson(page, NEW_EVENT)));
    return readJson(page, NEW_EVENT);
  };
  const root = (e: Json) => e.root as Json;

  // A random container in the root layer.
  let e = await step(() => page.getByTestId("event-add-node").selectOption("random"));
  expect(types(root(e))).toEqual(["layer", "random"]);
  await expect(row(page, "0")).toHaveAttribute("data-node-type", "random");
  await expect(row(page, "0")).toHaveClass(/selected/);
  await expect(page.getByTestId("event-node-properties")).toHaveAttribute("data-node-type", "random");

  // Two clips dragged in from the Assets panel: the drag's label says what a drop does.
  e = await step(async () => {
    await dragClip(page, "foo.mp3", row(page, "0"), false);
    await expect(ghost(page)).toHaveText(/^Add the clip in random/);
    await page.mouse.up();
  });
  expect(types(root(e))).toEqual(["layer", "random", "clip"]);
  e = await step(async () => {
    await dragClip(page, "town.mp3", row(page, "0"), false);
    await expect(ghost(page)).toHaveText(/^Add the clip in random/);
    await page.mouse.up();
  });
  expect(types(root(e))).toEqual(["layer", "random", "clip", "clip"]);
  const clips = children(children(root(e))[0]).map((c) => c.clip).sort();
  expect(clips).toEqual(["music/foo.mp3", "music/town.mp3"]);
  await expect(page.getByTestId("event-tree-row")).toHaveCount(4);

  // Over a clip row the same drag replaces that clip (checked, then released back on the container: no change).
  await dragClip(page, "foo.mp3", row(page, "0/0"), false);
  await expect(ghost(page)).toHaveText("Replace this clip");
  const back = await box(tile(page, "foo.mp3"));
  await page.mouse.move(back.x + back.width / 2, back.y + back.height / 2, { steps: 8 }); // not a drop target
  await page.mouse.up();
  await page.waitForTimeout(200);
  expect(JSON.stringify(await readJson(page, NEW_EVENT))).toBe(snapshots[snapshots.length - 1]);
  const [first, second] = children(children(root(e))[0]).map((c) => c.clip as string);

  // Weights on the two children.
  await row(page, "0/0").click();
  await expect(page.getByTestId("event-node-properties")).toHaveAttribute("data-node-type", "clip");
  e = await step(async () => {
    await props(page).getByLabel("Weight", { exact: true }).fill("3");
    await props(page).getByLabel("Weight", { exact: true }).press("Tab");
  });
  await row(page, "0/1").click();
  e = await step(async () => {
    await props(page).getByLabel("Weight", { exact: true }).fill("2");
    await props(page).getByLabel("Weight", { exact: true }).press("Tab");
  });
  expect(children(children(root(e))[0]).map((c) => [c.clip, c.weight])).toEqual([[first, 3], [second, 2]]);

  // Wrap the random container in a sequence.
  await row(page, "0").click();
  e = await step(() => page.getByLabel("Wrap in", { exact: true }).selectOption("sequence"));
  expect(types(root(e))).toEqual(["layer", "sequence", "random", "clip", "clip"]);
  await expect(row(page, "0/0")).toHaveAttribute("data-node-type", "random");

  // A layer beside it, moved before the sequence with Alt+Up; then the sequence duplicated, the layer deleted.
  await page.getByTestId("event-tree-row").first().click(); // the root layer
  e = await step(() => page.getByTestId("event-add-node").selectOption("layer"));
  expect(children(root(e)).map((c) => c.type)).toEqual(["sequence", "layer"]);
  await expect(row(page, "1")).toHaveClass(/selected/);
  e = await step(async () => {
    await tree(page).focus();
    await page.keyboard.press("Alt+ArrowUp");
  });
  expect(children(root(e)).map((c) => c.type)).toEqual(["layer", "sequence"]);
  await row(page, "1").click();
  e = await step(async () => {
    await tree(page).focus();
    await page.keyboard.press("Control+d");
  });
  expect(children(root(e)).map((c) => c.type)).toEqual(["layer", "sequence", "sequence"]);
  await row(page, "0").click();
  e = await step(async () => {
    await tree(page).focus();
    await page.keyboard.press("Delete");
  });
  expect(children(root(e)).map((c) => c.type)).toEqual(["sequence", "sequence"]);
  expect(types(root(e))).toEqual(["layer", "sequence", "random", "clip", "clip", "sequence", "random", "clip", "clip"]);
  await expect(page.getByTestId("event-tree-row")).toHaveCount(9);

  // The event's own fields: bus, cooldown, limit.
  await page.getByTestId("event-tree-event").click();
  await expect(page.getByTestId("event-event-properties")).toBeVisible();
  e = await step(() => props(page).getByLabel("Bus", { exact: true }).selectOption("Music"));
  expect(e.bus).toBe("Music");
  e = await step(async () => {
    await props(page).getByLabel("Cooldown value").fill("0.5");
    await props(page).getByLabel("Cooldown value").press("Tab");
  });
  expect(e.cooldown).toBe(0.5);
  e = await step(async () => {
    await props(page).getByLabel("Limit Max instances").fill("3");
    await props(page).getByLabel("Limit Max instances").press("Tab");
  });
  expect((e.limit as Json).maxInstances).toBe(3);

  // A node field: a clip's volume.
  await row(page, "0/0/0").click();
  e = await step(async () => {
    await props(page).getByLabel("Volume value").fill("0.5");
    await props(page).getByLabel("Volume value").press("Tab");
  });
  expect(children(children(children(root(e))[0])[0])[0].volume).toBe(0.5);

  // The last three steps: a local parameter, an automation on the event, a dragged key.
  await page.getByTestId("event-tree-event").click();
  e = await step(() => page.getByTestId("event-parameters").getByRole("button", { name: "+ Parameter" }).click());
  expect(e.parameters).toHaveLength(1);
  const name = await page.getByTestId("event-parameter").first().getAttribute("data-parameter");
  expect(name).toBeTruthy();
  const automation = page.getByTestId("event-automation");
  e = await step(() => automation.getByRole("button", { name: "+ Automation" }).click());
  expect(e.automation).toEqual([{ parameter: name, target: "volume", curve: [[0, 1], [1, 1]] }]);
  const key = automation.locator(".curve-key[data-key='0']"); // the left key: the right one is out of the narrow panel once the graph widens
  e = await step(async () => {
    // Select the key first: selecting shows the key's readout, which (in the narrow right dock) widens the graph, and
    // a press that did both would move the graph under the pointer mid-drag (reported as a bug, see the spec's notes).
    await key.click();
    await expect(automation.locator(".curve-readout input").first()).toBeVisible();
    await key.scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
    const k = await box(key);
    await page.mouse.move(k.x + k.width / 2, k.y + k.height / 2);
    await page.mouse.down();
    await page.mouse.move(k.x + k.width / 2, k.y + k.height / 2 - 20, { steps: 6 });
    await page.mouse.up();
  });
  const curve = (e.automation as { curve: number[][] }[])[0].curve;
  expect(curve[0][1]).not.toBe(1);
  expect(curve[0][0]).toBeCloseTo(0, 1); // a vertical drag: x stays at the range's start
  expect(curve[1]).toEqual([1, 1]);

  // Ctrl+Z three times: the file follows, one step each (the drag was one step).
  const files = async () => JSON.stringify(await readJson(page, NEW_EVENT));
  const last = snapshots.length - 1;
  for (let back = 1; back <= 3; back++) {
    await tree(page).focus();
    await page.keyboard.press("Control+z");
    await expect.poll(files).toBe(snapshots[last - back]);
  }
  expect((JSON.parse(snapshots[last - 3]) as Json).parameters).toEqual([]);
  await expect(page.getByTestId("event-parameter")).toHaveCount(0);
  // Ctrl+Shift+Z brings one back.
  await tree(page).focus();
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(files).toBe(snapshots[last - 2]);
  await tree(page).focus();
  await page.keyboard.press("Control+z");
  await expect.poll(files).toBe(snapshots[last - 3]);

  // Reopen: another event, then this one again; the tree is what the file says.
  const finalTypes = types(root(await readJson(page, NEW_EVENT)));
  await tile(page, "other.audioevent.json").dblclick();
  await expect(editor).toHaveAttribute("data-asset-document", "music/other.audioevent.json");
  await expect(page.getByTestId("event-tree-row")).toHaveCount(1);
  await tile(page, "New Event.audioevent.json").dblclick();
  await expect(editor).toHaveAttribute("data-asset-document", NEW_EVENT);
  expect(await page.getByTestId("event-tree-row").evaluateAll((els) => els.map((el) => el.getAttribute("data-node-type")))).toEqual(finalTypes);
  await expect(page.getByTestId("event-parameter")).toHaveCount(0);
});

test("reopening an event shows its tree and fields from the file", async ({ page }) => {
  const OTHER = { format: "myco.audioevent@1", root: { type: "layer", children: [{ type: "clip", clip: "music/foo.mp3" }] } };
  const MINE = {
    format: "myco.audioevent@1",
    bus: "UI",
    cooldown: 1.5,
    parameters: [{ name: "Speed", min: 0, max: 4, default: 1 }],
    root: { type: "sequence", children: [{ type: "clip", clip: "music/town.mp3", weight: 2 }, { type: "random", children: [{ type: "clip", clip: "music/foo.mp3" }] }] },
  };
  await open(page, { "music/a.audioevent.json": JSON.stringify(OTHER), "music/b.audioevent.json": JSON.stringify(MINE) });
  await tile(page, "a.audioevent.json").dblclick();
  await expect(page.getByTestId("event-editor")).toHaveAttribute("data-asset-document", "music/a.audioevent.json");
  await expect(page.getByTestId("event-tree-row")).toHaveCount(2);
  await tile(page, "b.audioevent.json").dblclick();
  await expect(page.getByTestId("event-editor")).toHaveAttribute("data-asset-document", "music/b.audioevent.json");
  expect(await page.getByTestId("event-tree-row").evaluateAll((els) => els.map((el) => el.getAttribute("data-node-type")))).toEqual(["sequence", "clip", "random", "clip"]);
  await expect(row(page, "0")).toHaveAttribute("title", "music/town.mp3");
  await expect(page.getByTestId("event-parameter")).toHaveAttribute("data-parameter", "Speed");
  await page.getByTestId("event-tree-event").click();
  await expect(props(page).getByLabel("Bus", { exact: true })).toHaveValue("UI");
  await expect(props(page).getByLabel("Cooldown value")).toHaveValue("1.5");
});

const AUDITION_EVENT = {
  format: "myco.audioevent@1",
  parameters: [
    { name: "Speed", min: 0, max: 10, default: 0 },
    { name: "Area", labels: ["Outdoor", "Cave"], default: "Outdoor" },
  ],
  root: { type: "layer", children: [{ type: "clip", clip: "music/foo.mp3", loop: true }] },
};
const AUDITION_PATH = "music/test.audioevent.json";

const debugEvents = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __myco: { Audio: { debug(): { events: unknown[] } } } }).__myco.Audio.debug().events as DebugEvent[]);
const mine = async (page: Page) => (await debugEvents(page)).filter((ev) => ev.asset === AUDITION_PATH);

test("Audition plays the open event, passes slider values to the instance, releases and stops it, and notes edits made while it plays", async ({ page }) => {
  await open(page, { [AUDITION_PATH]: JSON.stringify(AUDITION_EVENT) });
  await tile(page, "test.audioevent.json").dblclick();
  const aud = page.getByTestId("event-audition");
  const phase = aud.getByTestId("audition-phase");
  await expect(aud).toBeVisible();
  await expect(phase).toHaveText("");
  await expect(aud.getByTestId("audition-play")).toBeEnabled();
  await expect(aud.getByTestId("audition-stop")).toBeDisabled();
  await expect(aud.getByTestId("audition-release")).toBeDisabled();

  // Play: playing, one voice on the event's clip, one instance in the audio host.
  await aud.getByTestId("audition-play").click();
  await expect(phase).toHaveText("playing");
  await expect(aud.getByTestId("audition-voices").locator("tbody tr")).toHaveCount(1);
  await expect(aud.getByTestId("audition-voices").locator("tbody tr").first()).toContainText("music/foo.mp3");
  await expect(aud.getByTestId("audition-stop")).toBeEnabled();
  await expect.poll(async () => (await mine(page)).length).toBe(1);
  expect((await mine(page))[0].voices).toBeGreaterThan(0);

  // Sliders reach the instance: a numeric one, then a labelled one's radio.
  await page.getByLabel("Audition Speed").fill("7");
  await expect.poll(async () => (await mine(page))[0]?.parameters.Speed).toBe(7);
  await page.getByRole("radiogroup", { name: "Audition Area" }).getByRole("radio", { name: "Cave" }).click();
  await expect.poll(async () => (await mine(page))[0]?.parameters.Area).toBe("Cave");

  // An edit while it plays: the stale hint; nothing changes for the running instance. Play again picks it up.
  await expect(aud.getByTestId("audition-stale")).toHaveCount(0);
  await page.getByTestId("event-tree-event").click();
  await props(page).getByLabel("Cooldown value").fill("0.25");
  await props(page).getByLabel("Cooldown value").press("Tab");
  await expect(aud.getByTestId("audition-stale")).toBeVisible();
  await expect(phase).toHaveText("playing");

  // Release, then Stop: ended, voices gone, the instance gone from the host.
  await aud.getByTestId("audition-release").click();
  await expect(phase).toHaveText("released");
  await aud.getByTestId("audition-stop").click();
  await expect(phase).toHaveText("ended");
  await expect(aud.getByTestId("audition-voices")).toHaveCount(0);
  await expect(aud.getByTestId("audition-stale")).toHaveCount(0);
  await expect.poll(async () => (await mine(page)).length).toBe(0);
  await expect(aud.getByTestId("audition-play")).toBeEnabled();
  await expect(aud.getByTestId("audition-release")).toBeDisabled();

  // Play after the edit: a fresh instance starts from the slider values (the event's defaults apply to the rest) with no stale hint.
  await aud.getByTestId("audition-play").click();
  await expect(phase).toHaveText("playing");
  await expect(aud.getByTestId("audition-stale")).toHaveCount(0);
  await expect.poll(async () => (await mine(page))[0]?.parameters.Speed).toBe(7);
  expect((await readJson(page, AUDITION_PATH)).cooldown).toBe(0.25);
  await aud.getByTestId("audition-stop").click();
  await expect(phase).toHaveText("ended");
});
