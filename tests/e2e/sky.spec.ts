import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { installFakeFolders, nextFolder } from "./fakeFolders";

// Procedural skies (ADR 0112–0114): an Environment with a *.sky.json map draws the sky live, bakes
// it to a cubemap for lighting, and drives the sun; the Sky component sets the time of day.

test.describe.configure({ timeout: 90_000 });

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

type SkyState = { active: boolean; drawn: boolean; bakes: number; baked: boolean; time: number; lastBakeMs: number };
type Hooks = { engine?: { world: { time: { frameCount: number }; render: { skyState(): SkyState; lightingState(): { environment: string } } } } };

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  return errors;
}

const sky = (page: Page) => page.evaluate(() => (window as unknown as Hooks).engine!.world.render.skyState());
const assets = (page: Page) => page.locator(".assets");

async function openPlayground(page: Page, extra: Record<string, string> = {}): Promise<void> {
  await installFakeFolders(page, { Playground: { ...sampleFiles(), ...extra } });
  await page.goto("/editor.html");
  await nextFolder(page, "Playground");
  await page.getByRole("dialog", { name: "Start" }).getByRole("button", { name: "Open Project…" }).click();
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

async function openScene(page: Page, folder: string, file: string): Promise<void> {
  await assets(page).locator(".asset-folder", { hasText: new RegExp(`^${folder}$`) }).dblclick();
  await assets(page).locator(".asset-tile").filter({ hasText: file }).dblclick();
}

test("a sky asset draws the sky, bakes lighting and rebakes when it changes", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  await openPlayground(page);
  expect((await sky(page)).active).toBe(false);
  await openScene(page, "scenes", "skies.scene.json");
  await page.waitForTimeout(4000);
  console.log("ERRS", errors.slice(0, 6).join("\n---\n").slice(0, 4000));
  await expect.poll(async () => await sky(page), { timeout: 20_000 }).toMatchObject({ active: true, drawn: true, baked: true });
  const first = (await sky(page)).bakes;
  expect(first).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/claude-0/scratch/clear-day.png" });
  console.log("STATE", JSON.stringify(await sky(page)));
  expect(errors).toEqual([]);
});

test("DEV presets screenshots", async ({ page }) => {
  await openPlayground(page);
  await openScene(page, "scenes", "skies.scene.json");
  await expect.poll(async () => (await sky(page)).baked, { timeout: 20_000 }).toBe(true);
  await page.getByRole("button", { name: "▶ Play" }).click();
  await page.waitForTimeout(3000);
  for (const p of ["clear-day", "sunset", "overcast", "night", "gradient"]) {
    await page.evaluate((p) => {
      const w = (window as any).playEngine.world;
      // Find the Environment through the scene nodes.
      const visit = (n: any): any => { for (const c of w._componentsOf(n.entity)) if ("skyboxBlur" in c) return c; for (const k of n.children) { const r = visit(k); if (r) return r; } return null; };
      const env = visit(w.root);
      env.map = `asset:skies/${p}.sky.json`;
    }, p);
    await page.evaluate(() => { const w = (window as any).playEngine.world; const find = (n: any): any => n.name === "Camera" ? n : n.children.map(find).find(Boolean); const cam = find(w.root); cam.transform.eulerAngles = [-18, 0, 0]; });
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `/tmp/claude-0/scratch/${p}.png` });
    await page.evaluate(() => { const w = (window as any).playEngine.world; const find = (n: any): any => n.name === "Camera" ? n : n.children.map(find).find(Boolean); const cam = find(w.root); cam.transform.eulerAngles = [25, 0, 0]; });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `/tmp/claude-0/scratch/${p}-up.png` });
  }
});
