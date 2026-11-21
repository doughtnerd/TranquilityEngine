import { expect, test, type Page } from "./fixtures";

// Hand-written shader assets (ADR 0106) in a real browser: the 3D
// Playground's rim-light shader (WGSL on WebGPU, GLSL on the WebGL2 fallback) compiles and draws on a
// scene mesh, with its RIM keyword.

test.describe.configure({ timeout: 60_000 }); // WebKit renders on the CPU

/** The editor's World on `window`; its render surface reports what it draws in engine terms (ADR 0128). */
type Hooks = { engine?: { world: { time: { frameCount: number }; render: { diagnostics(): { drawn: { feature: string }[]; stats: { programs: number } } } } } };

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
  await page.goto("/editor.html?sample=playground3d");
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);

  // The renderer starts asynchronously, possibly after the World's first frames, and models load after it.
  // (That the scene view's MeshRenderers draw as instanced batches is instancing.test.ts's, ADR 0108.)
  const drawn = () => page.evaluate(() => (window as unknown as Hooks).engine?.world.render.diagnostics() ?? null);
  await expect.poll(async () => (await drawn())?.drawn.filter((d) => d.feature === "meshes").length ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);

  // Point the Ball's MeshRenderer at the rim material: its shader compiles (one more program).
  await row(page, "Ball").click();
  const material = card(page, "MeshRenderer").getByRole("combobox", { name: "material" });
  const before = (await drawn())!.stats.programs;
  await material.selectOption("materials/rim.material.json");
  await expect.poll(async () => (await drawn())!.stats.programs, { timeout: 30_000 }).toBeGreaterThan(before);
  test.info().annotations.push({ type: "engine", description: webgpu ? "WebGPU (WGSL)" : "WebGL2 (GLSL)" });
  const shaderErrors = errors.filter((e) => /shader|effect|compil|wgsl|glsl/i.test(e));
  expect(shaderErrors).toEqual([]);
});
