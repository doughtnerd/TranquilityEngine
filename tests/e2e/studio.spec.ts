import { expect, test, type Page } from "./fixtures";
import { readFileSync } from "node:fs";
import { binarySeed, installFakeFolders, nextFolder, readFile } from "./fakeFolders";
import { MINIMAL_PROJECT, openStudioFolder, openStudioSample, showPanel, sineWav, startStudioAudio, studioHeader, studioScreen, studioStart, studioStatus, trackErrors } from "./studio";

// The Audio Studio's core workflows (ADR 0341–0360; the build's minimal end-to-end pass): open a project and visit every
// screen; Samples (import, a marker and a loop, undo and redo, saved and reopened); Playlists (a new playlist, a sample
// added, triggered and heard in the status bar's voice count, undone); Mixer (a bus and a snapshot offset, saved to
// audio.json and reopened); and one generator (a blip preset auditioned and baked to a sample). Everything is read
// through the Studio's UI and the files it writes. The models behind each screen are unit-tested beside them.

test.describe.configure({ timeout: 90_000 });

const SCREENS = ["Samples", "Playlists", "Dialogue", "Mixer", "Spatial", "Take", "Profiler", "Packages"];

/** The Outline panel's group (Notes, Loops…) of the open sample. */
const outlineGroup = (page: Page, name: string) => page.getByRole("listbox", { name, exact: true }).getByRole("option");

/** Close the open project (the header's project button) and reopen it from the start screen's recent projects. */
async function reopen(page: Page, name: string): Promise<void> {
  await studioHeader(page).locator(".studio-project").click();
  await expect(studioStart(page)).toBeVisible();
  // The project just closed is the newest, under Continue where you left off (ADR 0380).
  await studioStart(page).getByRole("button", { name: new RegExp(`^Open ${name}`) }).first().click();
  await expect(studioHeader(page)).toBeVisible();
}

test("a sample opens in the Studio and every screen shows", async ({ page }) => {
  const errors = trackErrors(page);
  await openStudioSample(page, "sound-lab");
  await expect(studioHeader(page).locator(".studio-project")).toContainText("read-only");
  for (const title of SCREENS) {
    await studioScreen(page, title);
    await expect(page.getByRole("main", { name: `${title} screen` })).toBeVisible();
    await expect(page.getByRole("main", { name: `${title} screen` }).locator(".panel").first()).toBeVisible();
  }
  // Ctrl+1 goes back to Samples.
  await page.keyboard.press("ControlOrMeta+1");
  await expect(page.getByRole("main", { name: "Samples screen" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("Samples: import a WAV, add a marker and a loop, undo and redo; the edits are saved and reopen", async ({ page }) => {
  const errors = trackErrors(page);
  await openStudioFolder(page, "Game", MINIMAL_PROJECT);
  // The empty project's card over the dock (spec §4.1.2): one line and Import samples….
  await page.getByRole("note", { name: "No samples yet" }).getByRole("button", { name: "Import samples…" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("dialog", { name: "Import samples" }).getByRole("button", { name: "Choose files…" }).click();
  await (await chooser).setFiles({ name: "tone.wav", mimeType: "audio/wav", buffer: Buffer.from(sineWav(1)) });
  await page.getByRole("dialog", { name: "Import audio" }).getByRole("button", { name: "Import 1" }).click();
  await expect(page.locator('[data-sample="tone.wav"]')).toBeVisible();
  await expect.poll(() => readFile(page, "Game/tone.wav").then((t) => t?.startsWith("RIFF"))).toBe(true);

  // The sample opened: M adds a marker (a note) and L a loop, at the playhead.
  await expect(page.getByRole("listbox", { name: "Loops", exact: true })).toHaveCount(0);
  await showPanel(page, "Outline");
  await page.locator(".smp-outline").click();
  await page.keyboard.press("m");
  await expect(outlineGroup(page, "Notes")).toHaveCount(1);
  await page.keyboard.press("l");
  // The Loops group lists the pickup and tail around the loop (spec §4.1.4).
  await expect(outlineGroup(page, "Loops").filter({ hasText: "Loop 1" })).toHaveCount(1);
  // Undo takes the loop back, redo brings it again.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(outlineGroup(page, "Loops")).toHaveCount(0);
  await expect(outlineGroup(page, "Notes")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(outlineGroup(page, "Loops").filter({ hasText: "Loop 1" })).toHaveCount(1);

  // The edits are in the sidecar on disk, and come back when the project is opened again.
  await expect.poll(async () => {
    const sidecar = JSON.parse((await readFile(page, "Game/tone.wav.meta.json")) ?? "{}");
    return [sidecar.sample?.markers?.length ?? 0, sidecar.sample?.loops?.length ?? 0];
  }).toEqual([1, 1]);
  await reopen(page, "Studio Test");
  await showPanel(page, "Samples");
  await page.locator('[data-sample="tone.wav"]').click();
  await showPanel(page, "Outline");
  await expect(outlineGroup(page, "Notes")).toHaveCount(1);
  await expect(outlineGroup(page, "Loops").filter({ hasText: "Loop 1" })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("Playlists: a new playlist with a sample triggers and is heard; undo takes the sample out", async ({ page }) => {
  const errors = trackErrors(page);
  await openStudioFolder(page, "Game", { ...MINIMAL_PROJECT, "tone.wav": sineWav(2) });
  await startStudioAudio(page);
  await studioScreen(page, "Playlists");
  await page.getByRole("note", { name: "No playlists yet" }).getByRole("button", { name: "New playlist" }).click();
  await expect.poll(() => readFile(page, "Game/New playlist.playlist.json").then((t) => t !== undefined)).toBe(true);
  // Double-clicking a sample in the Library adds it to the open playlist.
  await showPanel(page, "Library");
  await page.getByRole("list", { name: "Samples" }).getByRole("listitem").filter({ hasText: "tone" }).dblclick();
  await expect.poll(async () => JSON.parse((await readFile(page, "Game/New playlist.playlist.json")) ?? "{}").entries?.length ?? 0).toBe(1);

  // Trigger: the Studio's audio plays it (the status bar's voice count, and Plays now lists it).
  await page.getByRole("toolbar", { name: "Transport" }).getByRole("button", { name: "Trigger" }).click();
  await expect(studioStatus(page)).toContainText(/Voices [1-9]/, { timeout: 15_000 });
  await expect(page.getByRole("region", { name: "Plays now" })).not.toContainText("Nothing playing");
  await page.getByRole("toolbar", { name: "Transport" }).getByRole("button", { name: "Stop" }).click();

  // Undo (in the playlist's history) takes the entry out again.
  await page.getByRole("toolbar", { name: "Playlist", exact: true }).click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => JSON.parse((await readFile(page, "Game/New playlist.playlist.json")) ?? "{}").entries?.length ?? 0).toBe(0);
  expect(errors).toEqual([]);
});

test("Mixer: a new bus and a snapshot offset are saved to audio.json and reopen", async ({ page }) => {
  const errors = trackErrors(page);
  await openStudioFolder(page, "Game", MINIMAL_PROJECT);
  await studioScreen(page, "Mixer");
  await page.getByRole("toolbar", { name: "Mixer" }).getByRole("button", { name: "New bus", exact: true }).click();
  // The new bus's row opens with its name in a rename field (the prototype's); Enter keeps the name.
  const buses = page.getByRole("listbox", { name: "Buses" });
  const rename = buses.getByRole("textbox", { name: "Rename New bus" });
  await expect(rename).toHaveValue("New bus");
  await rename.press("Enter");
  await expect(buses.getByRole("option", { name: /^New bus\b/ })).toBeVisible();
  // A snapshot: new (it opens for editing), then the bus's level in it is an offset on the base level.
  await page.getByRole("button", { name: "New snapshot" }).first().click();
  const level = page.getByLabel("Inspector: New bus").getByRole("textbox", { name: "Level in dB" });
  await level.fill("-6");
  await level.press("Enter");
  await expect(page.getByText(/dB on the base level/)).toBeVisible();

  const audio = async () => JSON.parse((await readFile(page, "Game/audio.json")) ?? "{}");
  await expect.poll(async () => (await audio()).buses?.some((b: { name: string }) => b.name === "New bus")).toBe(true);
  await expect.poll(async () => JSON.stringify((await audio()).snapshots ?? [])).toMatch(/"New bus":-6\b/);

  await reopen(page, "Studio Test");
  await studioScreen(page, "Mixer");
  await expect(page.getByRole("listbox", { name: "Buses" }).getByRole("option", { name: /^New bus\b/ })).toBeVisible();
  await expect(page.getByRole("tree", { name: "Snapshots" })).toContainText((await audio()).snapshots[0].name);
  expect(errors).toEqual([]);
});

test("Generators: a new blip from a preset auditions, and Bake makes a sample", async ({ page }) => {
  const errors = trackErrors(page);
  await openStudioFolder(page, "Game", MINIMAL_PROJECT);
  await startStudioAudio(page);
  await studioScreen(page, "Playlists");
  await showPanel(page, "Library");
  await page.getByRole("button", { name: "New generator" }).click();
  await page.getByRole("menuitem", { name: "New blip generator" }).click();
  const preset = page.getByRole("combobox", { name: "Preset" });
  await expect(preset).toBeVisible();
  await preset.selectOption({ label: "Explosion" });

  // Audition: hold to play. The status bar's voice count (read twice a second) shows the voice; a short blip can end
  // between two readings, so it plays again until one shows it.
  const hold = page.getByRole("button", { name: /Hold to play|Playing/ });
  await expect(hold).toBeEnabled({ timeout: 15_000 });
  await expect(async () => {
    await page.mouse.up();
    await hold.hover();
    await page.mouse.down();
    await expect(studioStatus(page)).toContainText(/Voices [1-9]/, { timeout: 1_200 });
    await page.mouse.up();
  }).toPass({ timeout: 20_000 });
  await page.mouse.up();

  // Bake: a WAV appears in the project, and in the Samples screen.
  await page.getByRole("button", { name: "Bake…" }).click();
  const dialog = page.getByRole("dialog", { name: /^Bake / });
  await dialog.getByRole("button", { name: "Bake", exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  await studioScreen(page, "Samples");
  await expect(page.locator("[data-sample$='.wav']").first()).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("Profiler: opening another project closes the last project's recording", async ({ page }) => {
  const errors = trackErrors(page);
  const capture = new Uint8Array(readFileSync(new URL("../../src/plugins/audio/runtime/capture/__fixtures__/sample.sporesample", import.meta.url)));
  const seed = (files: Record<string, string | Uint8Array>) => Object.fromEntries(Object.entries(files).map(([p, v]) => [p, typeof v === "string" ? v : binarySeed(v)]));
  await installFakeFolders(page, { Game: seed({ ...MINIMAL_PROJECT, "recordings/old_run.sporesample": capture }), Other: seed({ ...MINIMAL_PROJECT }) });
  await page.goto("/studio.html");
  await nextFolder(page, "Game");
  await studioStart(page).getByRole("button", { name: "Add from Folder…" }).click();
  await expect(studioHeader(page)).toBeVisible({ timeout: 30_000 });
  await studioScreen(page, "Profiler");
  await page.getByRole("treeitem", { name: /old_run/ }).click();
  // (The fixture is an older capture format: the Profiler shows it as "can't open", which still names it.)
  const oldRun = page.locator(".pf-title, .pf-error").filter({ hasText: "old_run" });
  await expect(oldRun).toHaveCount(1, { timeout: 15_000 });

  // Close it and open another project, as a hand-off from the editor does: nothing of the first one shows.
  await studioHeader(page).locator(".studio-project").click();
  await expect(studioStart(page)).toBeVisible();
  await nextFolder(page, "Other");
  await studioStart(page).getByRole("button", { name: "Add from Folder…" }).click();
  await expect(studioHeader(page)).toBeVisible({ timeout: 30_000 });
  await studioScreen(page, "Samples");
  await studioScreen(page, "Profiler");
  await expect(oldRun).toHaveCount(0);
  await expect(page.getByRole("main", { name: "Profiler screen" }).getByText("Engine performance captures", { exact: false })).toBeVisible();
  expect(errors).toEqual([]);
});
