import { expect, test, type Page } from "./fixtures";

// Post-processing (ADR 0051): the 3D Playground's camera has a PostProcessing component (bloom,
// ambient occlusion, vignette). The scene view previews its effects through the composer on the
// High tier; the Low tier turns the composer off but keeps the camera's tone mapping.

test.describe.configure({ timeout: 60_000 });

type Post = { composed: boolean; loaded: boolean; toneMapping: string; effects: { bloom: unknown; ambientOcclusion: unknown; vignette: unknown; depthOfField: unknown; antialias: string } | null };
type Hooks = { engine?: { world: { time: { frameCount: number }; render: { diagnostics(): { post: Post } } } } };

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  return errors;
}

const post = (page: Page) => page.evaluate(() => (window as unknown as Hooks).engine!.world.render.diagnostics().post);

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

// The King of Pirates sample's Fog has affectsSkybox, so the scene's background is a plain colour. three clears the
// canvas whenever it renders a scene with a colour background, so the editor's helper passes drawn after the composer
// used to wipe the composed frame: on every tier with a composer the Scene view showed only the fog colour and gizmos.
test("the scene view keeps the composed frame under the editor's helpers when fog colours the sky", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/editor.html?sample=pirates");
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await page.getByRole("combobox", { name: "Quality" }).selectOption("Medium");
  await expect.poll(async () => (await post(page)).composed, { timeout: 30_000 }).toBe(true);
  // The first composed frames can still be held on the clear colour while their pipelines compile (ADR 0120), so poll
  // until a drawn frame shows the scene; a wiped frame stayed wiped on every frame.
  await expect.poll(() => variedPixels(page), { timeout: 20_000 }).toBeGreaterThan(200); // of 361: about 350 now; about 40 (the helper lines) when the frame was wiped
  expect(errors).toEqual([]);
});

/**
 * Copy the canvas right after the surface draws a frame (the drawing buffer isn't preserved), and count how many
 * pixels of a coarse grid over the sea and islands differ from the fog colour of the background.
 */
function variedPixels(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        type Surface = { render(world: unknown): void; canvas: HTMLCanvasElement };
        const surface = (window as unknown as { engine: { world: { render: Surface } } }).engine.world.render;
        const draw = surface.render.bind(surface);
        surface.render = (world: unknown) => {
          surface.render = draw;
          draw(world);
          try {
            const w = surface.canvas.width, h = surface.canvas.height;
            const copy = document.createElement("canvas");
            copy.width = w;
            copy.height = h;
            const ctx = copy.getContext("2d")!;
            ctx.drawImage(surface.canvas, 0, 0);
            const px = ctx.getImageData(0, 0, w, h).data;
            // Rows from the top, so `h - 1 - y` puts y from the bottom.
            const sample = (x: number, y: number) => { const i = ((h - 1 - y) * w + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
            const sky = sample(Math.floor(w / 2), h - 2);
            let n = 0;
            for (let gy = 1; gy < 20; gy++) for (let gx = 1; gx < 20; gx++) {
              const c = sample(Math.floor((gx * w) / 20), Math.floor(h * (0.2 + (0.3 * gy) / 20))); // sea and islands, above the HUD
              if (Math.abs(c[0] - sky[0]) + Math.abs(c[1] - sky[1]) + Math.abs(c[2] - sky[2]) > 24) n++;
            }
            resolve(n);
          } catch (err) {
            reject(err);
          }
        };
      }),
  );
}
