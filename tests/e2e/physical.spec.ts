import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { installFakeFolders, nextFolder, readFile } from "./fakeFolders";

// Physical materials (ADR 0052): the Material inspector's physical fields save to the file and the
// mesh draws with three's physical material; physical shader graphs compile in WebGL with every
// feature on.

test.describe.configure({ timeout: 60_000 });

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

type Hooks = {
  engine?: { world: { time: { frameCount: number }; render: { renderer: { meshRenderers: Map<{ node: { name: string } }, { meshes: { material: { getClassName(): string; clearCoat: { isEnabled: boolean; intensity: number }; subSurface: { refractionIntensity: number } } | null }[] }> } | null } } };
  shaderGraphPreview?: { setGraph(g: unknown): unknown; readCenter(): number[] | null };
};

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  return errors;
}

const meshMaterial = (page: Page, name: string) =>
  page.evaluate((n) => {
    for (const [r, e] of (window as unknown as Hooks).engine!.world.render.renderer?.meshRenderers ?? []) {
      const m = r.node.name === n ? e.meshes[0]?.material : undefined;
      if (m) return { type: m.getClassName(), clearcoat: m.clearCoat.isEnabled ? m.clearCoat.intensity : 0, transmission: m.subSurface.refractionIntensity }; // getters: read them here
    }
    return null;
  }, name);

test("a physical material's fields save to its file and the mesh draws with clearcoat and transmission", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  await installFakeFolders(page, { Playground: sampleFiles() });
  await page.goto("/editor.html");
  await nextFolder(page, "Playground");
  await page.getByRole("dialog", { name: "Start" }).getByRole("button", { name: "Open Project…" }).click();
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);

  // metal.material.json draws the Robot's Body.
  await page.locator(".asset-folder", { hasText: /^materials$/ }).click();
  await page.locator(".asset-tile", { hasText: "metal.material.json" }).click();
  const material = page.getByLabel("Material", { exact: true });
  await material.getByRole("combobox", { name: "Shader" }).selectOption("physical");
  for (const [label, value] of [["Clearcoat", "1"], ["Transmission", "0.5"], ["IOR", "1.33"]] as const) {
    await material.getByRole("spinbutton", { name: label, exact: true }).fill(value);
    await material.getByRole("spinbutton", { name: label, exact: true }).press("Enter");
  }
  await expect.poll(async () => JSON.parse((await readFile(page, "Playground/materials/metal.material.json")) ?? "{}")).toMatchObject({ shader: "physical", clearcoat: 1, transmission: 0.5, ior: 1.33 });
  await expect.poll(async () => (await meshMaterial(page, "Body"))?.type).toBe("PBRMaterial");
  expect(await meshMaterial(page, "Body")).toMatchObject({ clearcoat: 1, transmission: 0.5 });
  expect(errors).toEqual([]);
});

test("a physical shader graph with every feature compiles in WebGL", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/editor.html?sample=playground3d");
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await page.locator(".asset-folder", { hasText: /^shaders$/ }).click();
  await page.locator(".asset-tile", { hasText: "pulse.shadergraph.json" }).dblclick();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as Hooks).shaderGraphPreview)).toBe(true);
  await page.evaluate(() => {
    const p = (window as unknown as Hooks).shaderGraphPreview!;
    p.setGraph({
      target: "physical",
      surface: "opaque",
      doubleSided: false,
      properties: [],
      nodes: [
        { id: "output", type: "output", position: [0, 0], inputs: { clearcoat: 1, clearcoatRoughness: 0.2, sheenColor: [1, 0, 0], transmission: 0.5, thickness: 1, ior: 1.33, iridescence: 1, specularIntensity: 0.5 } },
        { id: "t", type: "time", position: [0, 0] },
      ],
      edges: [{ from: "t.sine", to: "output.clearcoat" }],
    });
  });
  // The Babylon preview loads and compiles asynchronously: poll until it has drawn.
  const center = () => page.evaluate(() => (window as unknown as Hooks).shaderGraphPreview!.readCenter());
  await expect.poll(center, { timeout: 20_000 }).not.toBeNull();
  expect(errors).toEqual([]);
});
