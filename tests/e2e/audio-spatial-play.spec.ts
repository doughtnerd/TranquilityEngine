import { expect, type Page, play, test } from "./fixtures";
import { inspector, openSpatial, SPATIAL_SCENE } from "./audioSpatial";
import { captureView, pixelsChanged, type ViewCapture } from "./viewCapture";

// The M3 editor work that needs a running game (ADR 0162 E4, E7, E9), on the spatial scene of audioSpatial.ts: the
// occlusion overlay in the game view (toggled from the Scene toolbar's Audio popover since the Audio Debug panel moved to
// the Audio Studio, ADR 0327), a zone's kernel, and live tuning
// (a field edited on a live node in the Inspector shows in `Audio.debug()` a few frames later). Headless Chromium has no
// sound output; `Audio.debug()` stands in for ears, as in audio-events.spec.ts.
test.describe.configure({ timeout: 120_000 });

type Voice = {
  clip: string;
  state: string;
  occlusion?: { gain: number; cutoffHz: number; hits: number; material: string; collider: string | null };
  filter?: { lowpassHz: number; lowpassBy: string | null };
};
type Debug = { voices: Voice[]; zones?: { node: string; ir: string; state: string; why: string | null; irSeconds: number }[]; occlusion?: { enabled: boolean; rays: number; note: string }; memory?: Record<string, number> };
type Hooks = { playEngine?: { world: { name: string } } | null };

const debug = (page: Page) => page.evaluate(() => (globalThis as unknown as { __myco: { Audio: { debug(): unknown } } }).__myco.Audio.debug() as Debug);
const emitter = async (page: Page) => (await debug(page)).voices.find((v) => v.clip === "music/foo.mp3");
/** The game view after two steps of the paused game (a paused game isn't drawn again; the editor's drawing follows a change a frame later). */
async function stepped(page: Page): Promise<ViewCapture> {
  const step = page.getByRole("button", { name: "Step", exact: true });
  await step.click();
  await step.click();
  return captureView(page.locator("#game-view canvas").first());
}

/** Start Play and wait until the emitter's voice has an occlusion result for the wall (physics is up and a ray has hit). */
async function playUntilOccluded(page: Page): Promise<void> {
  await openSpatial(page);
  await play(page);
  await expect.poll(async () => (await emitter(page))?.occlusion?.hits, { timeout: 20_000 }).toBe(1);
}

test("the occlusion overlay draws rays in the game view while the Audio popover's toggle is on", async ({ page }) => {
  await playUntilOccluded(page);
  const toggle = page.getByRole("checkbox", { name: "Occlusion rays" });
  /** Set the toggle in the Scene toolbar's Audio popover (a step closes it). */
  const setRays = async (on: boolean) => {
    if (!(await toggle.isVisible())) await page.getByRole("button", { name: "Audio overlay" }).click();
    await toggle.setChecked(on);
  };
  // The game is paused and stepped, and the game view captured: the ray and its hit marker are the only change the
  // toggle makes (the occlusion keeps being worked out while paused frames step).
  await page.getByRole("button", { name: "❚❚ Pause", exact: true }).click();
  const off = await stepped(page);
  expect(pixelsChanged(off, await stepped(page)), "the paused scene holds still").toBeLessThan(20);

  await setRays(true);
  await expect.poll(async () => pixelsChanged(off, await stepped(page)), { message: "the ray and its hit marker draw" }).toBeGreaterThan(40);

  await setRays(false);
  await expect.poll(async () => pixelsChanged(off, await stepped(page))).toBeLessThan(20);

  // The choice is remembered across a reload of the editor.
  await setRays(true);
  await expect.poll(async () => page.evaluate(() => localStorage.getItem("myco.editor.audioOcclusionOverlay"))).toBe("true");
});

test("a zone with a preset gets its kernel from the decoder worker in Play and goes active", async ({ page }) => {
  // The spatial scene with the listener and the emitter inside the zone, so the zone wins a slot. Nothing streams
  // here: the zone's kernel is the first thing on the decoder worker's channel to the worklet (ADR 0162 C9).
  const scene = structuredClone(SPATIAL_SCENE);
  const move = (id: string, position: number[]) => (scene.nodes.find((n) => n.id === id)!.components[0] = { type: "engine.Transform", data: { position } });
  move("ears", [0, 1, 0]);
  move("emitter", [2, 1, 0]);
  await openSpatial(page, { "scenes/main.scene.json": JSON.stringify(scene) });
  await play(page);
  const zone = async () => {
    const z = (await debug(page)).zones?.[0];
    return z ? `${z.state}${z.why ? ` (${z.why})` : ""}` : "no zone";
  };
  await expect.poll(zone, { timeout: 20_000, message: "the hall preset's kernel reaches the core and its slot is active" }).toBe("active");
  const z = (await debug(page)).zones![0];
  expect(z.ir).toBe("hall");
  expect(z.irSeconds).toBeGreaterThan(0);
});

// --- live tuning ----------------------------------------------------------------------------------------------------

/** Show the running game's live nodes and select one: its Inspector edits the game, not the scene. */
async function selectLive(page: Page, name: string): Promise<void> {
  const hierarchy = page.locator(".panel.hierarchy");
  const picker = hierarchy.getByRole("combobox", { name: "Inspect World" });
  await expect(picker).toBeVisible();
  const worldName = await page.evaluate(() => (window as unknown as Hooks).playEngine!.world.name);
  await picker.selectOption(worldName);
  await hierarchy.getByRole("tree", { name: "Live nodes" }).locator(`.row[data-name="${name}"]`).click();
  await expect(inspector(page).locator(".live-badge")).toContainText("live");
}

const card = (page: Page, type: string) => inspector(page).locator(".component", { hasText: type }).first();

test("live tuning: an AudioSource's occlusion switch, a zone's impulse response and a wall's openness reach Audio.debug() in Play", async ({ page }) => {
  await playUntilOccluded(page);
  const before = (await emitter(page))!;
  expect(before.occlusion!.gain).toBeLessThan(0.5); // the wall muffles it
  expect(before.filter!.lowpassBy).toBe("occlusion");
  expect((await debug(page)).zones![0].ir).toBe("hall");

  // The wall's openness: opened fully, the muffling goes away.
  await selectLive(page, "Wall");
  const openness = card(page, "AudioOccluder").getByRole("textbox", { name: "openness", exact: true });
  await openness.fill("1");
  await openness.press("Enter");
  await expect.poll(async () => (await emitter(page))?.occlusion?.gain, { message: "an open wall doesn't muffle" }).toBeGreaterThan(0.95);
  await openness.fill("0");
  await openness.press("Enter");
  await expect.poll(async () => (await emitter(page))?.occlusion?.gain).toBeLessThan(0.5);

  // The source's own switch: occlusion off, the voice isn't tested and plays open.
  await selectLive(page, "Emitter");
  const sw = card(page, "AudioSource").getByRole("checkbox", { name: "occlusion", exact: true });
  await expect(sw).toBeChecked();
  await sw.uncheck();
  await expect.poll(async () => (await emitter(page))?.filter?.lowpassBy, { message: "no longer low-passed by occlusion" }).toBeNull();
  await expect.poll(async () => (await emitter(page))?.occlusion?.gain ?? 1).toBeGreaterThan(0.95);
  await sw.check();
  await expect.poll(async () => (await emitter(page))?.occlusion?.hits).toBe(1);

  // A zone field: its impulse response replaces the preset in the zones row.
  await selectLive(page, "Zone");
  const ir = card(page, "AudioReverbZone").getByRole("combobox", { name: "ir", exact: true });
  await ir.selectOption("music/town.mp3");
  await expect.poll(async () => (await debug(page)).zones![0].ir).toBe("music/town.mp3");
});
