import { afterFrames, expect, type Hooks, test, type Page, openEditor } from "./fixtures";
import { captureArea, pixelsChanged, steadyView } from "./viewCapture";

// Hand-written shader assets (ADR 0106) in a real browser: the 3D
// Playground's rim-light shader (WGSL on WebGPU, GLSL on the WebGL2 fallback) compiles and draws on a
// scene mesh, with its RIM keyword. (That a shader asset's material is rebuilt when its code changes
// is materialLibrary.test.ts's.)

test.describe.configure({ timeout: 60_000 }); // WebKit renders on the CPU

const row = (page: Page, name: string) => page.locator(".tree .row", { has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });
const card = (page: Page, name: string) => page.locator(".inspector-body .component").filter({ has: page.getByRole("checkbox", { name: `${name} enabled`, exact: true }) });

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

test("the rim shader asset compiles and draws on a mesh", async ({ page, webgpu }) => {
  const errors = trackErrors(page);
  await openEditor(page, { sample: "playground3d" });

  // The renderer starts asynchronously, possibly after the World's first frames, and models load after it: wait until
  // the Ball draws, then look at it up close. (That the scene view's MeshRenderers draw as instanced batches is
  // instancing.test.ts's, ADR 0108.)
  await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).nodeRect("ball") !== null), { timeout: 20_000 }).toBe(true);
  await row(page, "Ball").click();
  await page.evaluate(() => (window as unknown as Hooks).orbit.focus([-1.2, 7, -0.5], 3));
  await afterFrames(page);
  const canvas = (await page.locator(".viewport canvas").boundingBox())!;
  const ball = { x: canvas.x + canvas.width / 2 - 60, y: canvas.y + canvas.height / 2 - 60, width: 120, height: 120 };
  await steadyView(page.locator(".viewport canvas"));
  const metal = await captureArea(page, ball);

  // Point the Ball's MeshRenderer at the rim material: its shader compiles and the ball draws with it.
  const material = card(page, "MeshRenderer").getByRole("combobox", { name: "material" });
  await material.selectOption("materials/rim.material.json");
  await expect.poll(async () => pixelsChanged(metal, await captureArea(page, ball)), { timeout: 30_000, message: "pixels of the ball the rim shader changes" }).toBeGreaterThan(200);
  test.info().annotations.push({ type: "engine", description: webgpu ? "WebGPU (WGSL)" : "WebGL2 (GLSL)" });
  const shaderErrors = errors.filter((e) => /shader|effect|compil|wgsl|glsl/i.test(e));
  expect(shaderErrors).toEqual([]);
});
