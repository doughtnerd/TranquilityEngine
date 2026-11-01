import { expect, test, type Page } from "@playwright/test";

const EDITOR = "http://localhost:4174/editor.html";

type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  orbit: { focusPoint: { toArray(): number[] } };
};

async function openEditor(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

const row = (page: Page, key: string) => page.locator(`.tree .row[data-key="${key}"]`);
const cards = (page: Page) => page.locator(".inspector-body .component h3");
/** The Add Component list (the Assets panel has options too). */
const menuOptions = (page: Page) => page.getByRole("dialog", { name: "Add component" }).getByRole("option");
const card = (page: Page, name: string) => page.locator(".inspector-body .component", { has: page.locator("h3", { hasText: name }) });

test("Add Component searches the list and adds a collider fitted to the sprite; ✕ removes it; both undo", async ({ page }) => {
  await openEditor(page);
  await row(page, "bird-sprite").click();
  await page.getByRole("button", { name: "Add Component" }).click();
  const search = page.getByRole("searchbox", { name: "Search components" });
  await expect(search).toBeFocused();
  const focusBefore = await page.evaluate(() => (window as unknown as Hooks).orbit.focusPoint.toArray());
  await search.pressSequentially("box f"); // an "f" typed here doesn't reframe the camera
  expect(await page.evaluate(() => (window as unknown as Hooks).orbit.focusPoint.toArray())).toEqual(focusBefore);
  await expect(menuOptions(page)).toHaveCount(0);
  await search.fill("box");
  await expect(menuOptions(page)).toHaveText(["BoxCollider2D"]);
  await search.press("Enter");

  await expect(page.getByRole("dialog", { name: "Add component" })).toHaveCount(0);
  const box = card(page, "BoxCollider2D");
  await expect(box).toBeVisible();
  await expect(box.getByRole("textbox", { name: "size x" })).toHaveValue("3.4"); // the sprite's size
  await expect(box.getByRole("textbox", { name: "size y" })).toHaveValue("3.4");

  await page.getByRole("button", { name: "Remove BoxCollider2D" }).click();
  await expect(box).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(card(page, "BoxCollider2D")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(card(page, "BoxCollider2D")).toHaveCount(0);
});

test("types a node can't take are greyed out with the reason; Escape closes the list", async ({ page }) => {
  await openEditor(page);
  await row(page, "bird-sprite").click();
  await page.getByRole("button", { name: "Add Component" }).click();
  const sprite = menuOptions(page).filter({ hasText: "SpriteRenderer" });
  await expect(sprite).toHaveAttribute("aria-disabled", "true");
  await expect(sprite).toHaveAttribute("title", /already has a SpriteRenderer/);
  await sprite.click({ force: true }); // nothing happens
  await expect(cards(page).filter({ hasText: "SpriteRenderer" })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Add component" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove Transform" })).toHaveCount(0); // Transform stays
});

test("with several nodes selected, Add Component adds to each in one undo step", async ({ page }) => {
  await openEditor(page);
  await row(page, "ceiling").click();
  await row(page, "ground-collider").click({ modifiers: ["ControlOrMeta"] });
  await page.getByRole("button", { name: "Add Component" }).click();
  await menuOptions(page).filter({ hasText: "CircleCollider2D" }).click();
  await expect(card(page, "CircleCollider2D")).toBeVisible(); // shared by both, so shown
  await expect(page.locator(".status-text")).toContainText("Added CircleCollider2D to 2 of 2 nodes");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(card(page, "CircleCollider2D")).toHaveCount(0);
});

test("on a prefab instance, adding or removing a component is an override", async ({ page }) => {
  await openEditor(page);
  await row(page, "bg-a").click();
  const badge = row(page, "bg-a").locator(".badge");
  await expect(badge).toHaveText("background");
  await page.getByRole("button", { name: "Remove SpriteRenderer" }).click();
  await expect(card(page, "SpriteRenderer")).toHaveCount(0);
  await expect(badge).toHaveText("background •"); // overridden
  await page.keyboard.press("ControlOrMeta+z");
  await expect(card(page, "SpriteRenderer")).toBeVisible();
  await expect(badge).toHaveText("background");
});

test("a component's checkbox switches it off and on; Transform and data components have none to use", async ({ page }) => {
  await openEditor(page);
  await row(page, "bird").click();
  const enabled = page.getByRole("checkbox", { name: "CircleCollider2D enabled" });
  await expect(enabled).toBeChecked();
  await enabled.uncheck();
  await expect(enabled).not.toBeChecked();
  await expect(card(page, "CircleCollider2D")).toHaveClass(/\boff\b/);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(enabled).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Transform enabled" })).toBeDisabled();
  await row(page, "bg-a").click();
  await expect(page.getByRole("checkbox", { name: "Scroller enabled" })).toBeDisabled();
});

test("components reorder by dragging the grip, or with Alt+arrow keys", async ({ page }) => {
  await openEditor(page);
  await row(page, "bird").click();
  const titles = async () => (await cards(page).allTextContents()).map((t) => t.replace(/[⠿✕]|Edit Collider/g, "").trim().replace(/data$/, ""));
  expect(await titles()).toEqual(["Transform", "RigidBody2D", "CircleCollider2D", "Bird"]);

  // Drag RigidBody2D's grip below the Bird script.
  const grip = (await page.getByRole("button", { name: "Reorder RigidBody2D" }).boundingBox())!;
  const bird = (await card(page, "Bird").last().boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 4, bird.y + bird.height - 4, { steps: 8 });
  await expect(card(page, "Bird").last()).toHaveClass(/drop-after/);
  await page.mouse.up();
  await expect.poll(titles).toEqual(["Transform", "CircleCollider2D", "Bird", "RigidBody2D"]);

  await page.getByRole("button", { name: "Reorder RigidBody2D" }).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(titles).toEqual(["Transform", "CircleCollider2D", "RigidBody2D", "Bird"]);
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(titles).toEqual(["Transform", "RigidBody2D", "CircleCollider2D", "Bird"]);

  // A prefab instance reorders through an override; its data component (Scroller) stays put.
  await row(page, "bg-a").click();
  await expect(page.getByRole("button", { name: /^Reorder / })).toHaveCount(0); // only one movable component
  await page.getByRole("button", { name: "Add Component" }).click();
  await menuOptions(page).filter({ hasText: "BoxCollider2D" }).click();
  expect(await titles()).toEqual(["Transform", "SpriteRenderer", "BoxCollider2D", "Scroller"]);
  await page.getByRole("button", { name: "Reorder BoxCollider2D" }).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(titles).toEqual(["Transform", "BoxCollider2D", "SpriteRenderer", "Scroller"]);
  await expect(page.getByRole("button", { name: "Reorder Scroller" })).toHaveCount(0);
});

test("on a plain node, data components reorder among the rest", async ({ page }) => {
  await openEditor(page);
  await row(page, "ceiling").click();
  for (const name of ["Scroller", "Bird"]) {
    await page.getByRole("button", { name: "Add Component" }).click();
    await menuOptions(page).filter({ hasText: new RegExp(`^${name}$`) }).click();
  }
  const titles = async () => (await cards(page).allTextContents()).map((t) => t.replace(/[⠿✕]|Edit Collider|data/g, "").trim());
  expect(await titles()).toEqual(["Transform", "BoxCollider2D", "Scroller", "Bird"]);
  await page.getByRole("button", { name: "Reorder Scroller" }).focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(titles).toEqual(["Transform", "BoxCollider2D", "Bird", "Scroller"]);
});
