import { expect, test, type Page } from "@playwright/test";

// Hand-written shader assets (ADR 0106) and instancing (ADR 0108) in a real browser: the 3D
// Playground's rim-light shader (WGSL on WebGPU, GLSL on the WebGL2 fallback) compiles and draws on a
// scene mesh, with its RIM keyword, and MeshRenderers draw through instanced batches.

test.describe.configure({ timeout: 60_000 }); // WebKit renders on the CPU

type Renderer = {
  engine: { isWebGPU: boolean };
  meshRenderers: Map<{ material: string; node: { name: string } }, { meshes: { isReady(complete?: boolean): boolean; material: { name: string; isReady(mesh?: unknown, instances?: boolean): boolean } | null }[] }>;
  batches: { stats(): { batches: number; instanced: number; drawables: number } };
};
/** `world.render` is the Babylon surface; its `renderer` is the BabylonRenderer (private fields, read for the test). */
type Hooks = { engine?: { world: { time: { frameCount: number }; render: { renderer: Renderer } } } };

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

test("the rim shader asset compiles and draws on a mesh, and meshes draw instanced", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/editor.html?sample=playground3d");
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);

  const stats = await page.evaluate(() => (window as unknown as Hooks).engine!.world.render.renderer.batches.stats());
  expect(stats.drawables).toBeGreaterThan(0);
  expect(stats.instanced).toBe(stats.batches); // the editor's scene view never thin-instances

  // Point the first MeshRenderer at the rim material.
  const name = await page.evaluate(() => {
    const [r] = [...(window as unknown as Hooks).engine!.world.render.renderer.meshRenderers.keys()];
    r.material = "asset:materials/rim.material.json";
    return r.node.name;
  });
  await page.waitForFunction(
    (node) => {
      const render = (window as unknown as Hooks).engine!.world.render.renderer;
      const entry = [...render.meshRenderers].find(([r]) => r.node.name === node)?.[1];
      const mesh = entry?.meshes[0];
      return !!mesh?.material?.name.includes("rim.shader.json") && mesh.isReady(true);
    },
    name,
    { timeout: 30_000 },
  );
  const webgpu = await page.evaluate(() => (window as unknown as Hooks).engine!.world.render.renderer.engine.isWebGPU);
  test.info().annotations.push({ type: "engine", description: webgpu ? "WebGPU (WGSL)" : "WebGL2 (GLSL)" });
  const shaderErrors = errors.filter((e) => /shader|effect|compil|wgsl|glsl/i.test(e));
  expect(shaderErrors).toEqual([]);
});
