import { expect, type Hooks, test, type Page, openEditor } from "./fixtures";
import { captureView, type ViewCapture } from "./viewCapture";

// Post-processing (ADR 0051): the 3D Playground's camera has a PostProcessing component (bloom,
// ambient occlusion, vignette). The scene view previews its effects through the composer on the
// High tier; the Low tier turns the composer off but keeps the camera's tone mapping. Which effects
// and tone mapping each tier keeps is postEffects.test.ts's; the scene view's post (no depth of
// field) is framePlan.test.ts's.

test.describe.configure({ timeout: 60_000 });

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  return errors;
}

/** The editor's World has stepped `n` more frames: the scene view keeps drawing (a failing effect would stop the render loop). */
async function keepsDrawing(page: Page, n = 10): Promise<void> {
  const frames = await page.evaluate(() => (window as unknown as Hooks).engine!.world.time.frameCount);
  await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).engine!.world.time.frameCount), { timeout: 20_000 }).toBeGreaterThan(frames + n);
}

test("the scene view previews the camera's effects on High, and Low draws directly with the same tone mapping", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page, { sample: "playground3d" });
  // The libraries load on demand, then the composer draws: bloom, ambient occlusion and vignette, MSAA, AgX.
  await keepsDrawing(page);
  await page.getByRole("combobox", { name: "Quality" }).selectOption("Low"); // no composer, the same tone mapping
  await keepsDrawing(page);
  await page.getByRole("combobox", { name: "Quality" }).selectOption("Medium"); // SMAA and bloom, no AO
  await keepsDrawing(page);
  expect(errors).toEqual([]);
});

// The King of Pirates sample's Fog has affectsSkybox, so the scene's background is a plain colour. three clears the
// canvas whenever it renders a scene with a colour background, so the editor's helper passes drawn after the composer
// used to wipe the composed frame: on every tier with a composer the Scene view showed only the fog colour and gizmos.
test("the scene view keeps the composed frame under the editor's helpers when fog colours the sky", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page, { sample: "pirates" });
  await page.getByRole("combobox", { name: "Quality" }).selectOption("Medium");
  // The first composed frames can still be held on the clear colour while their pipelines compile (ADR 0120), so poll
  // until a drawn frame shows the scene; a wiped frame stayed wiped on every frame.
  const view = page.locator("#viewport canvas");
  await expect.poll(async () => variedPixels(await captureView(view)), { timeout: 30_000 }).toBeGreaterThan(200); // of 361: about 350 now; about 40 (the helper lines) when the frame was wiped
  expect(errors).toEqual([]);
});

/**
 * How many pixels of a coarse grid over the sea and islands, in a capture of the scene view, differ from the fog colour
 * of the background (the sky at the top of the view).
 */
function variedPixels(capture: ViewCapture): number {
  const { data, width: w, height: h, channels } = capture;
  // Rows from the top, so `h - 1 - y` puts y from the bottom.
  const sample = (x: number, y: number) => {
    const i = ((h - 1 - y) * w + x) * channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const sky = sample(Math.floor(w / 2), h - 2);
  let n = 0;
  for (let gy = 1; gy < 20; gy++)
    for (let gx = 1; gx < 20; gx++) {
      const c = sample(Math.floor((gx * w) / 20), Math.floor(h * (0.2 + (0.3 * gy) / 20))); // sea and islands, above the HUD
      if (Math.abs(c[0] - sky[0]) + Math.abs(c[1] - sky[1]) + Math.abs(c[2] - sky[2]) > 24) n++;
    }
  return n;
}
