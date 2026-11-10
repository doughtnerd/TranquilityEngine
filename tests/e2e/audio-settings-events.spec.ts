import { expect, openTestProject, type Page, test } from "./fixtures";
import { pickCategory } from "./projectCategory";
import { showTab } from "./tabs";
import { parseAudioSettings } from "../../src/engine/audio/settings";

// Project Settings > Audio's Parameters and Automation sections (ADR 0158 §2, §3, M2 E6) on a writable in-memory
// copy of the Flappy sample: global numeric and labelled parameters, a rename that carries bus automation with it, a
// bus automation and its curve, removal; `project.json` is read back after each step and must hold what the UI shows
// and parse without problems.
test.describe.configure({ timeout: 90_000 });

type Hooks = { testFolder: { read(path: string): string | undefined } };
type Audio = {
  parameters: Record<string, unknown>[];
  automation: { bus: string; parameter: string; target: string; curve: number[][] }[];
};

const panel = (page: Page) => page.locator(".panel.project");
const audio = (page: Page) => panel(page).getByRole("group", { name: "Audio settings" });
const projectJson = async (page: Page): Promise<{ audio?: Audio }> =>
  JSON.parse((await page.evaluate(() => (window as unknown as Hooks).testFolder.read("project.json")))!);
const saved = async (page: Page): Promise<Audio> => ((await projectJson(page)).audio ?? { parameters: [], automation: [] }) as Audio;
const parameter = (page: Page, name: string) => audio(page).locator(`[data-parameter="${name}"]`);
const automation = (page: Page, index: number) => audio(page).locator(`[data-automation="${index}"]`);

/** Type into a labelled input of the section and commit with Enter. */
async function commit(page: Page, label: string, value: string): Promise<void> {
  const field = audio(page).getByLabel(label, { exact: true });
  await field.fill(value);
  await field.press("Enter");
}

test("global parameters and bus automation: add, edit, rename, remove, with project.json checked at each step", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openTestProject(page);
  await showTab(page, /^Project/);
  await pickCategory(page, "Audio");
  await expect(audio(page)).toBeVisible();
  await expect(audio(page).getByText("None (add a parameter first)")).toBeVisible();
  await expect(audio(page).getByRole("button", { name: "+ Automation" })).toBeDisabled();
  expect((await saved(page)).parameters ?? []).toEqual([]);

  // A numeric parameter: the defaults, then its range, default and seek speed.
  await audio(page).getByRole("button", { name: "+ Parameter", exact: true }).click();
  await expect(parameter(page, "Parameter")).toHaveAttribute("data-kind", "numeric");
  await expect.poll(async () => (await saved(page)).parameters).toEqual([{ name: "Parameter", min: 0, max: 1, default: 0, seekSpeed: 0 }]);
  await commit(page, "Parameter max", "10");
  await commit(page, "Parameter default", "5");
  await commit(page, "Parameter seek speed", "2.5");
  await expect.poll(async () => (await saved(page)).parameters).toEqual([{ name: "Parameter", min: 0, max: 10, default: 5, seekSpeed: 2.5 }]);
  await expect(audio(page).getByLabel("Parameter max", { exact: true })).toHaveValue("10");

  // A labelled one: its labels, its default.
  await audio(page).getByRole("button", { name: "+ Labelled parameter" }).click();
  await expect(parameter(page, "Parameter 2")).toHaveAttribute("data-kind", "labelled");
  await expect.poll(async () => (await saved(page)).parameters[1]).toEqual({ name: "Parameter 2", labels: ["State 1", "State 2"], default: "State 1" });
  await commit(page, "Parameter 2 labels", "Calm, Tense, Battle");
  await expect(audio(page).getByLabel("Parameter 2 default", { exact: true }).locator("option")).toHaveText(["Calm", "Tense", "Battle"]);
  await audio(page).getByLabel("Parameter 2 default", { exact: true }).selectOption("Tense");
  await expect.poll(async () => (await saved(page)).parameters[1]).toEqual({ name: "Parameter 2", labels: ["Calm", "Tense", "Battle"], default: "Tense" });

  // Switching a parameter's kind keeps its place and name; switch back.
  await audio(page).getByLabel("Parameter 2 kind", { exact: true }).selectOption("numeric");
  await expect(parameter(page, "Parameter 2")).toHaveAttribute("data-kind", "numeric");
  await expect.poll(async () => ((await saved(page)).parameters[1] as { name: string; max?: number }).max).toBe(2);
  await audio(page).getByLabel("Parameter 2 kind", { exact: true }).selectOption("labelled");
  await expect(parameter(page, "Parameter 2")).toHaveAttribute("data-kind", "labelled");

  // A bus automation: it starts on Music's volume, driven by the first parameter, a flat curve over its range.
  await audio(page).getByRole("button", { name: "+ Automation" }).click();
  await expect(automation(page, 0)).toBeVisible();
  await expect(audio(page).getByLabel("Automation 1 bus", { exact: true })).toHaveValue("Music");
  await expect(audio(page).getByLabel("Automation 1 parameter", { exact: true })).toHaveValue("Parameter");
  await expect.poll(async () => (await saved(page)).automation).toEqual([{ bus: "Music", parameter: "Parameter", target: "volume", curve: [[0, 1], [10, 1]] }]);

  // Renaming the parameter renames what the automation reads.
  await commit(page, "Parameter Parameter name", "Intensity");
  await expect(parameter(page, "Intensity")).toBeVisible();
  await expect(parameter(page, "Parameter")).toHaveCount(0);
  await expect(audio(page).getByLabel("Automation 1 parameter", { exact: true })).toHaveValue("Intensity");
  await expect.poll(async () => (await saved(page)).automation[0].parameter).toBe("Intensity");
  expect((await saved(page)).parameters.map((p) => p.name)).toEqual(["Intensity", "Parameter 2"]);

  // Editing the curve: select the left key (the readout widens the graph in the narrow dock), drag it up.
  const key = automation(page, 0).locator(".audio-curve .curve-key[data-key='0']");
  await key.click();
  await expect(automation(page, 0).locator(".curve-readout input").first()).toBeVisible();
  await key.scrollIntoViewIfNeeded();
  await page.waitForTimeout(100);
  const k = (await key.boundingBox())!;
  await page.mouse.move(k.x + k.width / 2, k.y + k.height / 2);
  await page.mouse.down();
  await page.mouse.move(k.x + k.width / 2, k.y + k.height / 2 - 20, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await saved(page)).automation[0].curve[0][1]).toBeGreaterThan(1);
  expect((await saved(page)).automation[0].curve[0][0]).toBeCloseTo(0, 1); // a vertical drag: x stays at the range's start
  expect((await saved(page)).automation[0].curve[1]).toEqual([10, 1]);
  // A key added by double-clicking the graph's empty space.
  const before = (await saved(page)).automation[0].curve.length;
  const svg = automation(page, 0).locator(".audio-curve .curve-svg");
  const s = (await svg.boundingBox())!;
  await page.mouse.dblclick(s.x + s.width * 0.5, s.y + s.height * 0.8);
  await expect.poll(async () => (await saved(page)).automation[0].curve.length).toBe(before + 1);

  // Bus and target.
  await audio(page).getByLabel("Automation 1 bus", { exact: true }).selectOption("SFX");
  await audio(page).getByLabel("Automation 1 target", { exact: true }).selectOption("lowpass");
  await expect.poll(async () => (await saved(page)).automation[0]).toMatchObject({ bus: "SFX", parameter: "Intensity", target: "lowpass" });

  // A second automation, then the first removed.
  await audio(page).getByRole("button", { name: "+ Automation" }).click();
  await expect(automation(page, 1)).toBeVisible();
  await expect.poll(async () => (await saved(page)).automation.length).toBe(2);
  await audio(page).getByRole("button", { name: "Remove automation 1", exact: true }).click();
  await expect(automation(page, 1)).toHaveCount(0);
  await expect.poll(async () => (await saved(page)).automation).toEqual([{ bus: "Music", parameter: "Intensity", target: "volume", curve: [[0, 1], [10, 1]] }]);

  // Removing the labelled parameter leaves the automation; removing the one it reads takes the automation with it.
  await audio(page).getByRole("button", { name: "Remove parameter Parameter 2", exact: true }).click();
  await expect(parameter(page, "Parameter 2")).toHaveCount(0);
  await expect.poll(async () => (await saved(page)).parameters.map((p) => p.name)).toEqual(["Intensity"]);
  expect((await saved(page)).automation).toHaveLength(1);
  await audio(page).getByRole("button", { name: "Remove parameter Intensity", exact: true }).click();
  await expect(audio(page).locator("[data-parameter]")).toHaveCount(0);
  await expect(audio(page).locator("[data-automation]")).toHaveCount(0);
  await expect.poll(async () => (await saved(page)).parameters).toEqual([]);
  expect((await saved(page)).automation).toEqual([]);

  // What the panel wrote parses without problems, and the panel lists none.
  await expect(panel(page).locator(".project-settings-status")).toHaveText("Saved");
  await expect(panel(page).getByRole("list", { name: "Problems" })).toHaveCount(0);
  expect(parseAudioSettings((await projectJson(page)).audio).problems).toEqual([]);
});

test("parameters and automation saved in project.json reopen as the section shows them", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openTestProject(page);
  await showTab(page, /^Project/);
  await pickCategory(page, "Audio");
  // Write the section through the panel's own controls rather than the file: the point is reading it back.
  await audio(page).getByRole("button", { name: "+ Parameter", exact: true }).click();
  await commit(page, "Parameter Parameter name", "Intensity");
  await commit(page, "Intensity default", "0.25");
  await audio(page).getByRole("button", { name: "+ Labelled parameter" }).click();
  await commit(page, "Parameter Parameter name", "Area");
  await commit(page, "Area labels", "Outdoor, Cave");
  await audio(page).getByLabel("Area default", { exact: true }).selectOption("Cave");
  await audio(page).getByRole("button", { name: "+ Automation" }).click();
  await expect.poll(async () => (await saved(page)).automation.length).toBe(1);
  await expect.poll(async () => (await saved(page)).parameters).toEqual([
    { name: "Intensity", min: 0, max: 1, default: 0.25, seekSpeed: 0 },
    { name: "Area", labels: ["Outdoor", "Cave"], default: "Cave" },
  ]);
  expect((await saved(page)).automation).toEqual([{ bus: "Music", parameter: "Intensity", target: "volume", curve: [[0, 1], [1, 1]] }]);
  // Switch categories and come back: the cards show the saved values.
  await pickCategory(page, "Display");
  await pickCategory(page, "Audio");
  await expect(parameter(page, "Intensity")).toHaveAttribute("data-kind", "numeric");
  await expect(audio(page).getByLabel("Intensity default", { exact: true })).toHaveValue("0.25");
  await expect(parameter(page, "Area")).toHaveAttribute("data-kind", "labelled");
  await expect(audio(page).getByLabel("Area default", { exact: true })).toHaveValue("Cave");
  await expect(audio(page).getByLabel("Area labels", { exact: true })).toHaveValue("Outdoor, Cave");
  await expect(audio(page).getByLabel("Automation 1 parameter", { exact: true })).toHaveValue("Intensity");
});
