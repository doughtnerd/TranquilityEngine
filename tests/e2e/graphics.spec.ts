import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, openEditor, test, type Page, waitForEditor } from "./fixtures";
import { installFakeFolders, nextFolder, readFile } from "./fakeFolders";
import { pickCategory } from "./projectCategory";
import { showTab } from "./tabs";

// Graphics quality tiers (ADR 0050): the Project panel edits project.json's tiers, the scene
// view's Quality menu previews one, and the scene view draws at its render scale. The rest the
// render backend applies from a tier (shadows, cascades, probes, post-processing) is its unit
// tests' (renderFeatureHooks.test.ts for the surface's applied tier, babylonLighting.test.ts,
// babylonProbes.test.ts, postEffects.test.ts).

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


function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

/** The scene view's drawing-buffer pixels per CSS pixel: the device's ratio times the tier's render scale. */
const pixelRatio = (page: Page) => page.locator(".viewport canvas").evaluate((c: HTMLCanvasElement) => c.width / c.clientWidth);

test("the scene view's Quality menu previews a tier: resolution, shadows and texture filtering follow it", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page, { sample: "playground3d" });
  const menu = page.getByRole("combobox", { name: "Quality" });
  await expect(menu).toHaveValue("High"); // the default tiers' default
  await expect(menu.locator("option")).toHaveText(["Low", "Medium", "High", "Ultra"]);
  const high = await pixelRatio(page); // High's render scale is 1

  // The tier switches at once; its render scale applies on the surface's next frame.
  await menu.selectOption("Low"); // render scale 0.75
  await expect.poll(() => pixelRatio(page)).toBeCloseTo(high * 0.75, 2);
  await menu.selectOption("Ultra"); // render scale 1.25
  await expect.poll(() => pixelRatio(page)).toBeCloseTo(high * 1.25, 2);
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
  await waitForEditor(page);

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

  // The scene view's menu lists the new tier and previews it, and Low as edited. (That the surface applies the
  // project's tiers, Low's shadows off included, is renderFeatureHooks.test.ts's.)
  await showTab(page, /^Scene$/);
  const menu = page.getByRole("combobox", { name: "Quality" });
  await expect(menu.locator("option")).toHaveText(["Low", "Medium", "High", "Ultra", "Cinematic"]);
  const full = await pixelRatio(page); // High or Medium: render scale 1
  await menu.selectOption("Low");
  await expect(menu).toHaveValue("Low");
  await expect.poll(() => pixelRatio(page)).toBeCloseTo(full * 0.75, 2);
  await menu.selectOption("Cinematic"); // a new tier has High's values: render scale 1
  await expect(menu).toHaveValue("Cinematic");
  await expect.poll(() => pixelRatio(page)).toBeCloseTo(full, 2);
  expect(errors).toEqual([]);
});
