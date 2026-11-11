import { readFileSync } from "node:fs";
import { expect, openTestProject, type Page, test } from "./fixtures";

// The Event editor's M3 fields (ADR 0162 E5, E9): filter, sends (reverb and one aux), the spatial occlusion switch,
// Doppler level and reverb send curve, each written to the event file, kept across reopening the event, and the
// Audition backend label with its note on the Babylon fallback. Headless Chromium has no sound output.
test.describe.configure({ timeout: 120_000 });

type Hooks = { testFolder: { read(path: string): string | undefined } };
type Json = Record<string, unknown>;

const PATH = "music/fx.audioevent.json";
const OTHER = "music/other.audioevent.json";
const EVENT = { format: "myco.audioevent@1", root: { type: "layer", children: [{ type: "clip", clip: "music/foo.mp3" }] } };

const assets = (page: Page) => page.locator(".panel.assets");
const tile = (page: Page, name: string) => assets(page).locator(".asset-item", { has: page.locator(".asset-name", { hasText: name }) });
const props = (page: Page) => page.getByTestId("event-properties");
const field = (page: Page, name: string) => props(page).locator(`.ev-field[data-field="${name}"]`);
const group = (page: Page, name: string) => props(page).locator(`fieldset[data-field="${name}"]`);
const readJson = async (page: Page): Promise<Json> => JSON.parse((await page.evaluate((p) => (window as unknown as Hooks).testFolder.read(p), PATH)) ?? "null");
const file = async (page: Page, key: string) => (await readJson(page))[key];

async function open(page: Page, extra: Record<string, string> = {}): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openTestProject(page, { [PATH]: JSON.stringify(EVENT), [OTHER]: JSON.stringify(EVENT), ...extra });
  await page.locator(".dock-tab", { hasText: "Assets" }).click();
  await assets(page).locator(".asset-folder", { hasText: /^music$/ }).click();
  await tile(page, "fx.audioevent.json").dblclick();
  await expect(page.getByTestId("event-editor")).toHaveAttribute("data-asset-document", PATH);
  await page.getByTestId("event-tree-event").click();
  await expect(page.getByTestId("event-event-properties")).toBeVisible();
}

/** Type into a labelled number input of the properties and commit with Tab. */
async function type(page: Page, label: string, value: string): Promise<void> {
  const input = props(page).getByLabel(label, { exact: true });
  await input.fill(value);
  await input.press("Tab");
}

test("filter, sends and the spatial occlusion, Doppler and reverb send curve are written to the file and survive reopening the event", async ({ page }) => {
  await open(page);
  for (const name of ["filter", "sends", "spatial"]) await expect(group(page, name)).toBeVisible();
  expect((await readJson(page)).filter).toBeUndefined(); // a file holds only what was set

  // Filter: an implicit group, there from the first key.
  await type(page, "Filter Low-pass (Hz)", "3000");
  await expect.poll(() => file(page, "filter")).toEqual({ lowpass: 3000 });
  await type(page, "Filter High-pass (Hz)", "120");
  await expect.poll(() => file(page, "filter")).toEqual({ lowpass: 3000, highpass: 120 });

  // Sends: the reverb level and the one aux send (a bus and a level).
  await type(page, "Sends Reverb send value", "1.5");
  await expect.poll(() => file(page, "sends")).toEqual({ reverb: 1.5 });
  await props(page).getByLabel("Sends Aux send bus", { exact: true }).selectOption("SFX");
  await expect.poll(() => file(page, "sends")).toEqual({ reverb: 1.5, SFX: 1 });
  await type(page, "Sends Aux send level", "0.5");
  await expect.poll(() => file(page, "sends")).toEqual({ reverb: 1.5, SFX: 0.5 });

  // Spatial: switched on, then occlusion off, Doppler level, and the reverb send curve's first key dragged.
  await props(page).getByLabel("Spatial", { exact: true }).check();
  await expect.poll(() => file(page, "spatial")).toBeTruthy();
  await props(page).getByLabel("Spatial Occlusion", { exact: true }).uncheck();
  await expect.poll(async () => ((await file(page, "spatial")) as Json).occlusion).toBe(false);
  await type(page, "Spatial Doppler level value", "2");
  await expect.poll(async () => ((await file(page, "spatial")) as Json).dopplerLevel).toBe(2);
  const key = field(page, "reverbSendCurve").locator(".curve-key[data-key='0']");
  await key.click();
  await expect(field(page, "reverbSendCurve").locator(".curve-readout input").first()).toBeVisible();
  await key.scrollIntoViewIfNeeded();
  await page.waitForTimeout(100);
  const k = (await key.boundingBox())!;
  await page.mouse.move(k.x + k.width / 2, k.y + k.height / 2);
  await page.mouse.down();
  await page.mouse.move(k.x + k.width / 2, k.y + k.height / 2 + 15); // one move: a stall under load can't split the drag
  await page.mouse.up();
  await expect.poll(async () => ((await file(page, "spatial")) as Json).reverbSendCurve).toBeTruthy();
  const curve = ((await file(page, "spatial")) as { reverbSendCurve: number[][] }).reverbSendCurve;
  expect(curve[0][1]).not.toBe(1); // lowered from the default's 1 at the near end
  const written = await readJson(page);

  // Reopen: another event, then this one again; every field shows what the file holds.
  await tile(page, "other.audioevent.json").dblclick();
  await expect(page.getByTestId("event-editor")).toHaveAttribute("data-asset-document", OTHER);
  await tile(page, "fx.audioevent.json").dblclick();
  await expect(page.getByTestId("event-editor")).toHaveAttribute("data-asset-document", PATH);
  await page.getByTestId("event-tree-event").click();
  expect(await readJson(page)).toEqual(written);
  await expect(props(page).getByLabel("Filter Low-pass (Hz)", { exact: true })).toHaveValue("3000");
  await expect(props(page).getByLabel("Filter High-pass (Hz)", { exact: true })).toHaveValue("120");
  await expect(props(page).getByLabel("Sends Reverb send value", { exact: true })).toHaveValue("1.5");
  await expect(props(page).getByLabel("Sends Aux send bus", { exact: true })).toHaveValue("SFX");
  await expect(props(page).getByLabel("Sends Aux send level", { exact: true })).toHaveValue("0.5");
  await expect(props(page).getByLabel("Spatial", { exact: true })).toBeChecked();
  await expect(props(page).getByLabel("Spatial Occlusion", { exact: true })).not.toBeChecked();
  await expect(props(page).getByLabel("Spatial Doppler level value", { exact: true })).toHaveValue("2");

  // A value at its "off" setting removes the key again: low-pass at 20 kHz or more, an emptied aux bus.
  await type(page, "Filter Low-pass (Hz)", "20000");
  await expect.poll(() => file(page, "filter")).toEqual({ highpass: 120 });
  await props(page).getByLabel("Sends Aux send bus", { exact: true }).selectOption("");
  await expect.poll(() => file(page, "sends")).toEqual({ reverb: 1.5 });

  // Undo takes the last step back (the aux bus returns).
  await page.getByTestId("event-tree").focus();
  await page.keyboard.press("Control+z");
  await expect.poll(() => file(page, "sends")).toEqual({ reverb: 1.5, SFX: 0.5 });
});

test("the Audition's backend label names the audio core", async ({ page }) => {
  await open(page);
  const audition = page.getByTestId("event-audition");
  await expect(audition.getByTestId("audition-backend")).toHaveText(/^Audio core/);
  await expect(audition.getByTestId("audition-backend-note")).toHaveCount(0);
});

test("on the Babylon fallback the label says so and notes that filters and aux sends are skipped", async ({ page }) => {
  const project = JSON.parse(readFileSync(new URL("../../samples/flappy/project.json", import.meta.url), "utf8")) as Json;
  await open(page, { "project.json": JSON.stringify({ ...project, audio: { backend: "babylon" } }) });
  const audition = page.getByTestId("event-audition");
  await expect(audition.getByTestId("audition-backend")).toHaveText("Babylon fallback");
  await expect(audition.getByTestId("audition-backend-note")).toContainText("skips the event's filters and aux sends");
});
