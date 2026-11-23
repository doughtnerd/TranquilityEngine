import { expect, openEditor, type Page, test } from "./fixtures";
import { sheetPng, SHEET_SLICES } from "./animationAssets";
import { savedJson } from "./animationWindows";

// The 2D animation tools (ADR 0373, T56) on a sliced sprite sheet: slices picked in the Assets panel become a flipbook
// of their image ("Create Flipbook from Slices", written to the image's sidecar), and the Sprite Editor's Bones tab
// adds a bone by dragging on a slice, one step of the editor's own history.

test.describe.configure({ timeout: 90_000 });

/** The sheet with its four slices and no flipbooks. */
const META = JSON.stringify({ format: "myco.import@1", pixelsPerUnit: 16, sprites: SHEET_SLICES });

type Sidecar = { flipbooks?: Record<string, { slices: string[] }> };

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

const panel = (page: Page) => page.locator(".panel.assets");
const tile = (page: Page, name: string) => panel(page).locator(".asset-item", { has: page.locator(".asset-name", { hasText: new RegExp(`^${name}$`) }) });

async function openSheet(page: Page): Promise<void> {
  await openEditor(page, { files: { "images/sheet.png": await sheetPng(), "images/sheet.png.meta.json": META } });
  await panel(page).locator(".asset-folder", { hasText: /^images$/ }).click();
  await expect(tile(page, "sheet(\\.png)?")).toBeVisible();
}

test("slices picked in the Assets panel become a flipbook of their image", async ({ page }) => {
  const errors = trackErrors(page);
  await openSheet(page);
  await panel(page).getByRole("button", { name: /^Show the slices of sheet/ }).click();
  await tile(page, "f0").click();
  for (const name of ["f1", "f2", "f3"]) await tile(page, name).click({ modifiers: ["ControlOrMeta"] });
  await tile(page, "f3").click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Create Flipbook from Slices/ }).click();
  await expect.poll(async () => Object.values((await savedJson<Sidecar>(page, "images/sheet.png.meta.json"))?.flipbooks ?? {}).map((f) => f.slices)).toEqual([["f0", "f1", "f2", "f3"]]);
  expect(errors).toEqual([]);
});

test("the Sprite Editor's Bones tab adds a bone by dragging on a slice, one undo step", async ({ page }) => {
  const errors = trackErrors(page);
  await openSheet(page);
  await tile(page, "sheet(\\.png)?").click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Sprite Editor/ }).click();
  const dlg = page.getByRole("dialog", { name: /^Sprite Editor/ });
  await dlg.getByRole("group", { name: "Tools" }).getByRole("button", { name: "Bones", exact: true }).click();
  const stage = dlg.getByRole("application", { name: /^Bone stage/ });
  await expect(stage).toBeVisible();
  await expect(dlg.getByText(/^No bones yet/)).toBeVisible();
  await dlg.getByRole("radio", { name: "Create Bones" }).or(dlg.getByRole("button", { name: "Create Bones" })).click();

  const s = (await stage.boundingBox())!;
  await page.mouse.move(s.x + s.width * 0.25, s.y + s.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width * 0.75, s.y + s.height * 0.5, { steps: 6 });
  await page.mouse.up();
  await expect(dlg.getByRole("list", { name: "Bone list" }).getByRole("button")).toHaveCount(1);
  await expect(stage.locator("g.bone")).toHaveCount(1);

  // One step: Undo once and the slice has no bones again.
  const undo = dlg.getByRole("group", { name: "History" }).getByRole("button", { name: "Undo" });
  await undo.click();
  await expect(dlg.getByText(/^No bones yet/)).toBeVisible();
  await expect(undo).toBeDisabled();
  expect(errors).toEqual([]);
});
