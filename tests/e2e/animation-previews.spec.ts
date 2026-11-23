import { expect, openEditor, type Page, test } from "./fixtures";
import { benderFiles } from "./animationAssets";
import { captureView, pixelsChanged, steadyView } from "./viewCapture";

// Posed asset previews (ADR 0373, T18b): selecting a skinned model in the Assets panel shows its clips in the
// Inspector's import settings with a live preview that poses the model at the clip's playhead. The skinned column's
// "Bend" clip is rest at 0 s and bent 90° at 1 s: captures of the preview at the two playhead positions differ.

test.describe.configure({ timeout: 90_000 });

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

test("a model's clip preview poses the model at the playhead", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page, { viewport: { width: 1600, height: 1000 }, files: benderFiles() });
  const assets = page.locator(".panel.assets");
  const tile = (name: string) => assets.locator(".asset-item", { has: page.locator(".asset-name", { hasText: new RegExp(`^${name}$`) }) });
  await tile("models").dblclick();
  await tile("bend(\\.gltf)?").click();
  const inspector = page.locator(".inspector");
  const time = inspector.getByRole("slider", { name: "Clip time" });
  await expect(time).toBeVisible({ timeout: 20_000 });
  // The clip card's own live preview (the import settings' model preview sits above it, at rest).
  const preview = inspector.locator(".clip-import-preview .asset-large-preview");
  await preview.scrollIntoViewIfNeeded();
  await expect(preview).toHaveClass(/live/, { timeout: 20_000 });

  await time.fill("0");
  const rest = await steadyView(preview);
  await time.fill("1");
  await expect.poll(async () => pixelsChanged(rest, await captureView(preview)), { timeout: 20_000, message: "pixels the bent pose changes in the preview" }).toBeGreaterThan(100);
  // Back at 0 s: the rest pose again.
  await time.fill("0");
  await expect.poll(async () => pixelsChanged(rest, await captureView(preview)), { timeout: 20_000, message: "pixels off the rest pose back at 0 s" }).toBeLessThan(40);
  expect(errors).toEqual([]);
});
