import { expect, type Hooks, openEditor, type Page, play, test } from "./fixtures";
import { bender, benderFiles, scene, stage } from "./animationAssets";

// Animation tools on the skinned column (ADR 0373, 0375; T55, T34): the ragdoll builder's Generate fills its bone
// table from the Skeleton; the pose database tool's Bake writes the `.posedb.bin` beside the source; and while the
// game plays, the Play Stats overlay's Animation table counts the evaluated instances.

test.describe.configure({ timeout: 90_000 });

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

const panel = (page: Page) => page.locator(".panel.assets");
const tile = (page: Page, name: string) => panel(page).locator(".asset-item", { has: page.locator(".asset-name", { hasText: new RegExp(`^${name}$`) }) });

test("the ragdoll builder's Generate fills the bone table from the Skeleton", async ({ page }) => {
  const errors = trackErrors(page);
  const [root, body] = bender();
  const ragdolled = { ...root!, components: [...root!.components, { type: "engine.Ragdoll", data: {} }] };
  await openEditor(page, { viewport: { width: 1600, height: 1000 }, files: { ...benderFiles(), "scenes/main.scene.json": scene([...stage(), ragdolled, body!]) } });
  await page.locator(".tree .row", { has: page.locator(".name", { hasText: /^Bender$/ }) }).first().click();
  const builder = page.getByLabel("Ragdoll builder");
  await builder.scrollIntoViewIfNeeded();
  await expect(builder.getByText(/^No bodies listed/)).toBeVisible();
  await builder.getByRole("button", { name: "Generate from Skeleton" }).click();
  // A body per bone of the column's skeleton (Root and Upper), in the table.
  const table = builder.getByRole("table", { name: "Ragdoll bodies" });
  await expect(table.getByRole("button", { name: /^Select / })).toHaveText(["Root", "Upper"], { timeout: 20_000 });
  await expect(builder.getByRole("button", { name: "Regenerate from Skeleton" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the pose database tool's Bake writes the baked file beside the source", async ({ page }) => {
  const errors = trackErrors(page);
  const source = {
    format: "myco.posedb-source@1",
    skeleton: "asset:models/bend.gltf#Skeleton",
    rate: 30,
    sources: [{ clip: "asset:models/bend.gltf#Anim/Bend", ranges: [], mirror: false }],
    schema: { bones: [{ bone: "Upper", position: true, velocity: true, weight: 1 }], trajectory: { times: [0.33, 0.66, 1], position: 1, direction: 1 }, custom: [] },
    normalisation: "feature",
  };
  await openEditor(page, { viewport: { width: 1600, height: 1000 }, files: { ...benderFiles(), "poses/bend.posedb.json": JSON.stringify(source) } });
  await tile(page, "poses").dblclick();
  await tile(page, "bend(\\.posedb\\.json)?").click();
  const bake = page.locator(".posedb-bake");
  await bake.scrollIntoViewIfNeeded();
  await expect(bake.getByText(/^Not baked yet/)).toBeVisible();
  await bake.getByRole("button", { name: "Bake", exact: true }).click();
  await expect(bake.getByRole("status").filter({ hasText: /^Wrote / })).toContainText("poses/bend.posedb.bin", { timeout: 30_000 });
  const size = await page.evaluate(() => ((window as unknown as Hooks).testFolder.read("poses/bend.posedb.bin") as unknown as Uint8Array | undefined)?.length ?? 0);
  expect(size).toBeGreaterThan(64);
  await expect(bake.getByText(/^Not baked yet/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the Play Stats Animation table counts evaluated instances while playing", async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => localStorage.removeItem("myco.editor.playStats"));
  await openEditor(page, { files: { ...benderFiles(), "scenes/main.scene.json": scene([...stage(), ...bender(), ...bender([2, 0, 0]).map((n) => ({ ...n, id: `${n.id}-2`, ...(n.parent ? { parent: `${n.parent}-2` } : {}) }))]) } });
  await play(page);
  await page.locator(".play-tools").getByRole("button", { name: "Stats", exact: true }).click();
  const stats = page.getByRole("region", { name: "Stats" });
  await expect(stats.locator('[data-table="Animation"]')).toBeVisible({ timeout: 20_000 });
  const count = (label: string) => async () => Number((await stats.locator(`[data-stat="Animation:${label}"]`).first().textContent())?.replace(/[^\d.]/g, "") || 0);
  await expect.poll(count("Evaluated"), { timeout: 20_000, message: "evaluated instances" }).toBeGreaterThan(0);
  await expect.poll(count("Instances"), { message: "active instances" }).toBe(2);
  expect(errors).toEqual([]);
});
