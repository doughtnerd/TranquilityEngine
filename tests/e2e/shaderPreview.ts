import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import sharp from "sharp";
import type { Page } from "@playwright/test";

// The Shader Graph panel's preview as the user sees it: its pixels from a screenshot of the preview, and
// the panel's own note when the generated shader didn't compile. Shared by the shader graph specs.

const PLAYGROUND = "samples/playground3d";

/** The 3D Playground's files (all text), for a writable copy seeded with `installFakeFolders`. */
export function playgroundFiles(dir = PLAYGROUND): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(out, playgroundFiles(full));
    else if (name !== "sample.json") out[relative(PLAYGROUND, full).split(sep).join("/")] = readFileSync(full, "utf8");
  }
  return out;
}

/** A shader graph file's text (the graph's fields as the panel writes them). */
export const shaderGraphFile = (graph: object) => `${JSON.stringify({ format: "myco.shadergraph@1", ...graph }, null, 2)}\n`;

type Rgb = [number, number, number];

/** The preview's centre pixel (where the mesh is) and a corner pixel (the background), read from a screenshot of it. */
export async function previewPixels(page: Page): Promise<{ center: Rgb; corner: Rgb }> {
  const png = await page.getByLabel("Shader preview").screenshot();
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number): Rgb => {
    const i = (Math.floor(y) * info.width + Math.floor(x)) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  return { center: at(info.width / 2, info.height / 2), corner: at(2, 2) };
}

/** True once the preview draws its mesh: the centre differs from the background, and the panel reports no shader error. */
export async function previewDraws(page: Page): Promise<boolean> {
  if (await page.getByText("The generated shader didn't compile").isVisible()) return false;
  const { center, corner } = await previewPixels(page);
  return center.some((c, i) => Math.abs(c - corner[i]) > 8);
}
