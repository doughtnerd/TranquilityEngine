import { expect, openTestProject, type Page, test } from "./fixtures";
import { pickCategory } from "./projectCategory";
import { showTab } from "./tabs";
import { parseAudioSettings } from "../../src/engine/audio/settings";

// Project Settings > Audio's M3 sections (ADR 0162 E3, E9): beds, occlusion (layers, budget, material cards), reverb
// zones and Doppler. Each edit is read back from `project.json` (what the panel wrote), the section is checked to parse
// without problems, and a second page opened on the saved file shows the same values.
test.describe.configure({ timeout: 120_000 });

type Hooks = { testFolder: { read(path: string): string | undefined } };
type Material = { name: string; transmissionDb: number; cutoffHz: number; wetOcclusion: number; attackMs?: number; releaseMs?: number };
type Saved = {
  bed?: { maxBeds: number };
  buses?: { name: string; bed?: string; bedPriority?: number }[];
  ambisonic?: { maxClips: number };
  occlusion?: { layers?: string[] | null; budgetMs?: number; smoothingMs?: number; defaultMaterial?: string; materials?: Material[] };
  zones?: { maxActive?: number; standby?: number; maxIrSeconds?: number };
  doppler?: { maxSpeed: number };
  speedOfSound?: number;
};

const panel = (page: Page) => page.locator(".panel.project");
const audio = (page: Page) => panel(page).getByRole("group", { name: "Audio settings" });
const projectText = (page: Page) => page.evaluate(() => (window as unknown as Hooks).testFolder.read("project.json")!);
const saved = async (page: Page): Promise<Saved> => (JSON.parse(await projectText(page)).audio ?? {}) as Saved;
const material = (page: Page, name: string) => audio(page).getByRole("group", { name: `Material ${name}`, exact: true });

/** Type into a labelled number input of the section and commit it. */
async function commit(page: Page, label: string, value: string): Promise<void> {
  const field = audio(page).getByLabel(label, { exact: true });
  await field.fill(value);
  await field.press("Enter");
}

async function openAudio(page: Page, extra: Record<string, string> = {}): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openTestProject(page, extra);
  await showTab(page, /^Project/);
  await pickCategory(page, "Audio");
  await expect(audio(page)).toBeVisible();
}

test("beds, occlusion, zones and Doppler: edit each, project.json holds it, a project reopened on the file shows it", async ({ page }) => {
  await openAudio(page);

  // Beds: the pool size and one bus's mode and priority (its row is inside the bus's collapsed card).
  await commit(page, "Max beds", "3");
  await expect.poll(async () => (await saved(page)).bed?.maxBeds).toBe(3);
  await audio(page).locator('[data-bus="SFX"] summary').click();
  await audio(page).getByLabel("SFX bed", { exact: true }).selectOption("own");
  await commit(page, "SFX bed priority", "200");
  await expect.poll(async () => (await saved(page)).buses?.find((b) => b.name === "SFX")).toMatchObject({ bed: "own", bedPriority: 200 });
  await commit(page, "Max ambisonic clips", "2");
  await expect.poll(async () => (await saved(page)).ambisonic?.maxClips).toBe(2);

  // Occlusion: the ray budget, smoothing, and a layer unticked.
  await commit(page, "Occlusion budget (ms)", "0.5");
  await commit(page, "Occlusion smoothing (ms)", "120");
  await expect.poll(async () => (await saved(page)).occlusion).toMatchObject({ budgetMs: 0.5, smoothingMs: 120 });
  const layers = audio(page).getByRole("group", { name: "Occluding layers" }).getByRole("checkbox");
  expect(await layers.count()).toBeGreaterThan(1);
  await audio(page).getByLabel("Occlude by layer Player", { exact: true }).uncheck();
  await expect.poll(async () => (await saved(page)).occlusion?.layers).not.toContain("Player");
  expect((await saved(page)).occlusion?.layers).toContain("Default");

  // A built-in material card: its numbers, Reset enabled once edited; then a custom one added, edited, renamed.
  const names = await audio(page).locator("[data-material]").evaluateAll((els) => els.map((e) => e.getAttribute("data-material")!));
  expect(names.length).toBeGreaterThan(2);
  const builtin = names[0];
  await expect(material(page, builtin)).toHaveAttribute("data-kind", "builtin");
  await expect(material(page, builtin).getByRole("button", { name: `Reset material ${builtin}` })).toBeDisabled();
  await commit(page, `${builtin} transmission dB`, "-33");
  await commit(page, `${builtin} cutoff Hz`, "1234");
  await commit(page, `${builtin} attack ms`, "80");
  await expect.poll(async () => (await saved(page)).occlusion?.materials?.find((m) => m.name === builtin)).toMatchObject({ transmissionDb: -33, cutoffHz: 1234, attackMs: 80 });
  await expect(material(page, builtin).getByRole("button", { name: `Reset material ${builtin}` })).toBeEnabled();
  await audio(page).getByRole("button", { name: "+ Material" }).click();
  await expect(audio(page).locator('[data-material][data-kind="custom"]')).toHaveCount(1);
  const custom = (await audio(page).locator('[data-material][data-kind="custom"]').getAttribute("data-material"))!;
  await commit(page, `${custom} wet occlusion`, "0.75");
  await expect.poll(async () => (await saved(page)).occlusion?.materials?.find((m) => m.name === custom)?.wetOcclusion).toBe(0.75);
  await audio(page).getByLabel("Default material", { exact: true }).selectOption(custom);
  await expect.poll(async () => (await saved(page)).occlusion?.defaultMaterial).toBe(custom);

  // Reverb zones and Doppler.
  await commit(page, "Zones active", "1");
  await commit(page, "Zones standby", "0");
  await commit(page, "Zones max IR seconds", "3");
  await expect.poll(async () => (await saved(page)).zones).toMatchObject({ maxActive: 1, standby: 0, maxIrSeconds: 3 });
  await expect(audio(page).locator("[data-zone-memory]")).toContainText("1 slot:");
  await expect(audio(page).locator('[data-zone-warning="evictionFade"]')).toBeVisible(); // no tail slot
  await commit(page, "Doppler max speed", "250");
  await commit(page, "Speed of sound", "400");
  await expect.poll(async () => (await saved(page)).doppler?.maxSpeed).toBe(250);
  await expect.poll(async () => (await saved(page)).speedOfSound).toBe(400);

  // What the panel wrote parses without problems, and the panel lists none.
  await expect(panel(page).locator(".project-settings-status")).toHaveText("Saved");
  await expect(panel(page).getByRole("list", { name: "Problems" })).toHaveCount(0);
  const text = await projectText(page);
  expect(parseAudioSettings(JSON.parse(text).audio).problems).toEqual([]);

  // Other categories and back: the cards show the saved values.
  await pickCategory(page, "Display");
  await pickCategory(page, "Audio");
  await expect(audio(page).getByLabel("Max beds", { exact: true })).toHaveValue("3");
  await expect(audio(page).getByLabel("Zones active", { exact: true })).toHaveValue("1");

  // A project opened on the saved file (a reload, as the in-memory folder is the page's own) shows every edit.
  await openAudio(page, { "project.json": text });
  expect(await saved(page)).toMatchObject({ bed: { maxBeds: 3 }, zones: { maxActive: 1 }, doppler: { maxSpeed: 250 }, speedOfSound: 400 });
  await expect(audio(page).getByLabel("Max beds", { exact: true })).toHaveValue("3");
  await expect(audio(page).getByLabel("Max ambisonic clips", { exact: true })).toHaveValue("2");
  await audio(page).locator('[data-bus="SFX"] summary').click();
  await expect(audio(page).getByLabel("SFX bed", { exact: true })).toHaveValue("own");
  await expect(audio(page).getByLabel("SFX bed priority", { exact: true })).toHaveValue("200");
  await expect(audio(page).getByLabel("Occlusion budget (ms)", { exact: true })).toHaveValue("0.5");
  await expect(audio(page).getByLabel("Occlude by layer Player", { exact: true })).not.toBeChecked();
  await expect(audio(page).getByLabel("Occlude by layer Default", { exact: true })).toBeChecked();
  await expect(audio(page).getByLabel(`${builtin} transmission dB`, { exact: true })).toHaveValue("-33");
  await expect(audio(page).getByLabel(`${builtin} cutoff Hz`, { exact: true })).toHaveValue("1234");
  await expect(material(page, custom)).toHaveAttribute("data-kind", "custom");
  await expect(audio(page).getByLabel("Default material", { exact: true })).toHaveValue(custom);
  await expect(audio(page).getByLabel("Zones max IR seconds", { exact: true })).toHaveValue("3");
  await expect(audio(page).getByLabel("Doppler max speed", { exact: true })).toHaveValue("250");
  await expect(audio(page).getByLabel("Speed of sound", { exact: true })).toHaveValue("400");
});

test("Reset puts a built-in material back, a custom one can be removed, zones off warns", async ({ page }) => {
  await openAudio(page);
  const first = await audio(page).locator('[data-material][data-kind="builtin"]').first().getAttribute("data-material");
  await commit(page, `${first} transmission dB`, "-40");
  await expect(material(page, first!).getByRole("button", { name: `Reset material ${first}` })).toBeEnabled();
  await material(page, first!).getByRole("button", { name: `Reset material ${first}` }).click();
  await expect(audio(page).getByLabel(`${first} transmission dB`, { exact: true })).not.toHaveValue("-40");
  await expect(material(page, first!).getByRole("button", { name: `Reset material ${first}` })).toBeDisabled();

  await audio(page).getByRole("button", { name: "+ Material" }).click();
  const custom = (await audio(page).locator('[data-material][data-kind="custom"]').getAttribute("data-material"))!;
  await audio(page).getByRole("button", { name: `Remove material ${custom}` }).click();
  await expect(audio(page).locator('[data-material][data-kind="custom"]')).toHaveCount(0);

  await commit(page, "Zones active", "0");
  await expect(audio(page).locator('[data-zone-warning="zonesOff"]')).toBeVisible();
});
