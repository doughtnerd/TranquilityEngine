import { expect, test, type Page } from "@playwright/test";

const EDITOR = "http://localhost:4174/editor.html";

declare global {
  interface Window {
    engine?: { world: { time: { frameCount: number } } };
    orbit?: { focus(point?: [number, number, number], distance?: number): void; focusPoint: { toArray(): number[] } };
  }
}

/** Collect uncaught exceptions and console errors for the whole test. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

async function openEditor(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => (window.engine?.world.time.frameCount ?? 0) > 10);
}

const selectedRow = (page: Page) => page.locator(".tree .row.selected .name");

test("opens the demo scene with its node tree", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page);
  await expect(page.locator(".tree .row .name")).toContainText(["Camera", "bg-a", "Bird", "Sprite", "GameManager"]);
  await expect(page.getByRole("button", { name: "2D" })).toHaveAttribute("aria-pressed", "true");
  expect(errors).toEqual([]);
});

test("clicking in the viewport selects, cycles through overlaps, and clears on empty space", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page);
  const canvas = page.locator("#viewport canvas");
  const box = (await canvas.boundingBox())!;
  const centre = { x: box.width / 2, y: box.height / 2 };

  // The Select tool shows no gizmo, so repeated clicks reach the sprites underneath.
  await page.keyboard.press("q");
  // Centre the view on the bird, then click it: inside its collider, so the Bird node is selected.
  await page.evaluate(() => window.orbit!.focus([-4, 1, 0]));
  await canvas.click({ position: centre });
  await expect(selectedRow(page)).toHaveText("Bird");
  await expect(page.locator(".inspector .node-name")).toHaveValue("Bird"); // the name is an editable field

  // The same spot again: the sprite drawn there, then the sky (a background prefab instance).
  await canvas.click({ position: centre });
  await expect(selectedRow(page)).toHaveText("Sprite");
  await canvas.click({ position: centre });
  await expect(selectedRow(page)).toHaveText("bg-a");

  // F frames the selection.
  await page.getByText("Bird", { exact: true }).click();
  await page.keyboard.press("f");
  await expect.poll(() => page.evaluate(() => window.orbit!.focusPoint.toArray())).toEqual([-4, 1, 0]);

  // Far from the scene there's nothing under the pointer: the selection clears.
  await page.evaluate(() => window.orbit!.focus([80, 80, 0]));
  await canvas.click({ position: centre });
  await expect(selectedRow(page)).toHaveCount(0);
  await expect(page.locator(".inspector .panel-body")).toHaveText("Nothing selected");
  expect(errors).toEqual([]);
});

// (A left drag on empty space draws a selection box: see selection.spec.ts.)
test("a camera drag doesn't change the selection", async ({ page }) => {
  await openEditor(page);
  const canvas = page.locator("#viewport canvas");
  const box = (await canvas.boundingBox())!;
  await page.evaluate(() => window.orbit!.focus([-4, 1, 0]));
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(selectedRow(page)).toHaveText("Bird");

  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down({ button: "right" }); // pans in 2D, orbits in 3D
  await page.mouse.move(box.x + 120, box.y + 80, { steps: 5 });
  await page.mouse.up({ button: "right" });
  await expect(selectedRow(page)).toHaveText("Bird");
});

test("editing a field in the inspector updates the scene, and Ctrl+Z undoes it", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page);
  await page.getByText("Bird", { exact: true }).click();
  const y = page.getByRole("textbox", { name: "position y" });
  await expect(y).toHaveValue("1");

  await y.fill("3.5");
  await y.press("Enter");
  await expect(page.locator(".scene-name")).toContainText("•"); // unsaved changes
  await expect(page.getByRole("button", { name: "Undo" })).toHaveAttribute("title", /Set position/);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(y).toHaveValue("1");
  await expect(page.locator(".scene-name")).not.toContainText("•");
  expect(errors).toEqual([]);
});

test("with the Move tool, clicking the gizmo on the selection keeps it selected", async ({ page }) => {
  await openEditor(page);
  const canvas = page.locator("#viewport canvas");
  const box = (await canvas.boundingBox())!;
  const centre = { x: box.width / 2, y: box.height / 2 };
  await expect(page.getByRole("button", { name: "Move" })).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => window.orbit!.focus([-4, 1, 0]));
  await canvas.click({ position: centre });
  await expect(selectedRow(page)).toHaveText("Bird");
  // The gizmo loads on first use; wait until it's showing on the selection.
  await page.waitForFunction(() => (window as unknown as { engine: { world: { render: { gizmo?: { enabled: boolean } } } } }).engine.world.render.gizmo?.enabled === true);
  // The gizmo now sits over the bird: pressing its handle drags instead of selecting what's below.
  await canvas.click({ position: centre });
  await expect(selectedRow(page)).toHaveText("Bird");
});

test("scene cameras show an icon that selects the camera", async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press("q");
  const canvas = page.locator("#viewport canvas");
  const box = (await canvas.boundingBox())!;
  // The editor frames the scene's camera on open, so its icon sits in the middle of the view.
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(selectedRow(page)).toHaveText("Camera");
  await expect(page.locator(".inspector .node-name")).toHaveValue("Camera");
});

test("Play runs the scene in a game view, Stop returns to the unchanged editor", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page);
  await page.getByText("Bird", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "position y" })).toHaveValue("1");

  await page.getByRole("button", { name: /Play/ }).click();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
  const game = page.locator("#game-view canvas");
  await expect(game).toBeVisible();
  await expect(page.locator(".status-bar")).toContainText("Playing scenes/main.scene.json");

  // Flap: the game's own scripts run in play mode, so the bird moves in the Runtime World.
  await game.click();
  await page.waitForTimeout(500);

  await page.keyboard.press("ControlOrMeta+p"); // stop
  await expect(page.getByRole("button", { name: /Play/ })).toBeVisible();
  await expect(game).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "position y" })).toHaveValue("1"); // the edited scene is untouched
  expect(errors).toEqual([]);
});

test("prefab overrides are marked and can be reverted", async ({ page }) => {
  await openEditor(page);
  await page.locator(".tree .row", { hasText: "bg-b" }).click();
  await expect(page.locator(".override-count")).toHaveText("1 override");
  const x = page.getByRole("textbox", { name: "position x" });
  await expect(x).toHaveValue("32");
  await page.getByRole("button", { name: "Revert position" }).click();
  await expect(x).toHaveValue("0"); // back to the prefab's value
  await expect(page.locator(".override-count")).toHaveText("No overrides");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(x).toHaveValue("32");
});
