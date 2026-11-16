import { expect, requireWebGPU, test, type Page } from "./fixtures";
import { installFakeFolders, nextFolder, readFile } from "./fakeFolders";
import { playgroundFiles, previewDraws, shaderGraphFile } from "./shaderPreview";

// Physical materials (ADR 0052): the Material inspector's physical fields save to the file (the
// renderer's material library building clearcoat and transmission from it is checked in
// materialLibrary.test.ts); physical shader graphs compile with every feature on.

test.describe.configure({ timeout: 60_000 });

type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
};

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  return errors;
}

test("a physical material's fields save to its file", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  await installFakeFolders(page, { Playground: playgroundFiles() });
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
  expect(errors).toEqual([]);
});

test("a physical shader graph with every feature compiles and draws in the preview", async ({ page, browserName, webgpu }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  requireWebGPU(webgpu); // the preview draws graphs as WGSL alone (ADR 0081)
  const errors = trackErrors(page);
  const graph = {
    target: "physical",
    surface: "opaque",
    doubleSided: false,
    properties: [],
    nodes: [
      { id: "output", type: "output", position: [0, 0], inputs: { clearcoat: 1, clearcoatRoughness: 0.2, sheenColor: [1, 0, 0], transmission: 0.5, thickness: 1, ior: 1.33, iridescence: 1, specularIntensity: 0.5 } },
      { id: "t", type: "time", position: [0, 0] },
    ],
    edges: [{ from: "t.sine", to: "output.clearcoat" }],
  };
  await installFakeFolders(page, { Playground: { ...playgroundFiles(), "shaders/physical.shadergraph.json": shaderGraphFile(graph) } });
  await page.goto("/editor.html");
  await nextFolder(page, "Playground");
  await page.getByRole("dialog", { name: "Start" }).getByRole("button", { name: "Open Project…" }).click();
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await page.locator(".asset-folder", { hasText: /^shaders$/ }).click();
  await page.locator(".asset-tile", { hasText: "physical.shadergraph.json" }).dblclick();
  await expect(page.locator('.sg-node[data-node="t"]')).toBeVisible();
  // The Babylon preview loads and compiles asynchronously: poll until it has drawn.
  await expect.poll(() => previewDraws(page), { timeout: 20_000 }).toBe(true);
  expect(errors).toEqual([]);
});
