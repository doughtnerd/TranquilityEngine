import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test, type Page } from "./fixtures";
import { installFakeFolders, nextFolder, readFile } from "./fakeFolders";
import { pickCategory } from "./projectCategory";
import { showTab } from "./tabs";

// Graphics quality tiers (ADR 0050): the Project panel edits project.json's tiers, the scene
// view's Quality menu previews one, and the render backend applies it (pixel ratio, shadows,
// texture filtering).

test.describe.configure({ timeout: 60_000 }); // WebKit renders on the CPU

const SAMPLE = "samples/playground3d";

function sampleFiles(dir = SAMPLE): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(out, sampleFiles(full));
    else if (name !== "sample.json") out[relative(SAMPLE, full).split(sep).join("/")] = readFileSync(full, "utf8");
  }
  return out;
}

type Quality = { tier: string; pixelRatio: number; shadows: boolean; shadowMapSize: number; msaa: boolean };
type Hooks = { engine?: { world: { time: { frameCount: number }; render: { diagnostics(): { quality: Quality } } } } };

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

const quality = (page: Page) => page.evaluate(() => (window as unknown as Hooks).engine!.world.render.diagnostics().quality);
const waitForFrames = (page: Page) => page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);

test("the scene view's Quality menu previews a tier: resolution, shadows and texture filtering follow it", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/editor.html?sample=playground3d");
  await waitForFrames(page);
  const menu = page.getByRole("combobox", { name: "Quality" });
  await expect(menu).toHaveValue("High"); // the default tiers' default
  await expect(menu.locator("option")).toHaveText(["Low", "Medium", "High", "Ultra"]);
  const high = await quality(page);
  expect(high).toMatchObject({ tier: "High", shadows: true, shadowMapSize: 2048 });

  await menu.selectOption("Low");
  await expect.poll(async () => (await quality(page)).tier).toBe("Low");
  const low = await quality(page);
  expect(low).toMatchObject({ shadows: true, shadowMapSize: 512 });
  expect(low.pixelRatio).toBeCloseTo(high.pixelRatio * 0.75, 5);

  await menu.selectOption("Ultra");
  await expect.poll(async () => (await quality(page)).shadowMapSize).toBe(4096);
  expect(errors).toEqual([]);
});

test("the Project panel edits the tiers, saves them to project.json, and the editor applies them", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  await installFakeFolders(page, { Playground: sampleFiles() });
  await page.goto("/editor.html");
  await nextFolder(page, "Playground");
  await page.getByRole("dialog", { name: "Start" }).getByRole("button", { name: "Open Project…" }).click();
  await expect(page.locator(".project-name")).toHaveText("3D Playground");
  await waitForFrames(page);

  await showTab(page, /^Project/);
  await pickCategory(page, "Graphics");
  const panel = page.locator(".panel.project");
  const tiers = panel.getByRole("group", { name: "Graphics tiers" });
  await expect(tiers).toBeVisible();
  const projectJson = async () => JSON.parse((await readFile(page, "Playground/project.json")) ?? "{}");

  // Shadows off on the Low tier; a new tier, renamed; the default tier changed.
  await tiers.getByRole("combobox", { name: "Low shadows" }).selectOption("off");
  await expect.poll(async () => (await projectJson()).graphics?.tiers?.[0]?.shadows).toBe("off");
  await panel.getByRole("button", { name: "Add Tier" }).click();
  await expect.poll(async () => (await projectJson()).graphics.tiers.map((t: { name: string }) => t.name)).toEqual(["Low", "Medium", "High", "Ultra", "Tier"]);
  const name = tiers.getByRole("textbox", { name: "Tier 5 name" });
  await name.fill("Cinematic");
  await name.press("Enter");
  await expect.poll(async () => (await projectJson()).graphics.tiers.map((t: { name: string }) => t.name)).toContain("Cinematic");
  await panel.getByRole("combobox", { name: "Default tier" }).selectOption("Medium");
  await expect.poll(async () => (await projectJson()).graphics.defaultTier).toBe("Medium");

  // The scene view's menu lists the new tier, and previewing Low turns shadows off.
  await showTab(page, /^Scene$/);
  const menu = page.getByRole("combobox", { name: "Quality" });
  await expect(menu.locator("option")).toHaveText(["Low", "Medium", "High", "Ultra", "Cinematic"]);
  await menu.selectOption("Low");
  await expect.poll(async () => (await quality(page)).shadows).toBe(false);
  await menu.selectOption("Cinematic");
  await expect.poll(async () => (await quality(page)).shadows).toBe(true);
  expect(errors).toEqual([]);
});
