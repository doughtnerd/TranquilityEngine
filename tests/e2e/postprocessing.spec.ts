import { expect, test, type Page } from "@playwright/test";

// Post-processing (ADR 0051): the 3D Playground's camera has a PostProcessing component (bloom,
// ambient occlusion, vignette). The scene view previews its effects through the composer on the
// High tier; the Low tier turns the composer off but keeps the camera's tone mapping.

test.describe.configure({ timeout: 60_000 });

type Post = { composed: boolean; loaded: boolean; toneMapping: string; effects: { bloom: unknown; ambientOcclusion: unknown; vignette: unknown; depthOfField: unknown; antialias: string } | null };
type Hooks = { engine?: { world: { time: { frameCount: number }; render: { postState(): Post; meshRenderers: Map<unknown, unknown> } } } };

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  return errors;
}

const post = (page: Page) => page.evaluate(() => (window as unknown as Hooks).engine!.world.render.postState());

test("the scene view previews the camera's effects on High, and Low draws directly with the same tone mapping", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/editor.html?sample=playground3d");
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  // The libraries load on demand, then the composer draws.
  await expect.poll(async () => (await post(page)).composed, { timeout: 20_000 }).toBe(true);
  const high = await post(page);
  expect(high.loaded).toBe(true);
  expect(high.toneMapping).toBe("agx");
  expect(high.effects).toMatchObject({ antialias: "msaa", depthOfField: null }); // no depth of field in the editor's view
  expect(high.effects?.bloom).not.toBeNull();
  expect(high.effects?.ambientOcclusion).not.toBeNull();
  expect(high.effects?.vignette).not.toBeNull();
  // Frames keep coming (a failing effect would stop the render loop).
  const frames = await page.evaluate(() => (window as unknown as Hooks).engine!.world.time.frameCount);
  await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).engine!.world.time.frameCount)).toBeGreaterThan(frames + 10);

  await page.getByRole("combobox", { name: "Quality" }).selectOption("Low");
  await expect.poll(async () => (await post(page)).composed).toBe(false);
  expect((await post(page)).toneMapping).toBe("agx");

  await page.getByRole("combobox", { name: "Quality" }).selectOption("Medium"); // SMAA and bloom, no AO
  await expect.poll(async () => (await post(page)).composed).toBe(true);
  const medium = await post(page);
  expect(medium.effects).toMatchObject({ antialias: "smaa", ambientOcclusion: null });
  expect(errors).toEqual([]);
});
