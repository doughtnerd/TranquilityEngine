import { afterFrames, expect, type Locator, type Page, play, test, type Hooks, openEditor } from "./fixtures";
import { closeMenus, undoItem } from "./menus";
import { captureArea, pixelsChanged } from "./viewCapture";

/** Collect uncaught exceptions and console errors for the whole test. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

const selectedRow = (page: Page) => page.locator(".tree .row.selected .name");

/**
 * Wait until the Move gizmo draws on the selection at `centre` (canvas CSS pixels; it loads on first use): the view
 * around it changes from how it looks with the Select tool, which shows none. (Which canvas points are over its handles
 * is babylonEditorGizmo.test.ts's; that a press on it never changes the selection, viewportSelection.test.ts's.)
 */
async function waitForGizmo(page: Page, canvas: Locator, centre: { x: number; y: number }): Promise<void> {
  const box = (await canvas.boundingBox())!;
  const area = { x: box.x + centre.x - 80, y: box.y + centre.y - 80, width: 160, height: 160 };
  const tools = page.locator(".scene-toolbar");
  await tools.getByRole("button", { name: "Select", exact: true }).click();
  await afterFrames(page, 3);
  const without = await captureArea(page, area);
  await tools.getByRole("button", { name: "Move", exact: true }).click();
  await expect.poll(async () => pixelsChanged(without, await captureArea(page, area)), { timeout: 20_000, message: "pixels the gizmo draws" }).toBeGreaterThan(20);
}

test("opens the demo scene with its node tree; clicking in the viewport selects, cycles through overlaps, and clears on empty space", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page, { sample: "flappy" });
  await expect(page.locator(".tree .row .name")).toContainText(["Camera", "bg-a", "Bird", "Sprite", "GameManager"]);
  await expect(page.getByRole("button", { name: "2D", exact: true })).toHaveAttribute("aria-pressed", "true");

  const canvas = page.locator("#viewport canvas");
  const box = (await canvas.boundingBox())!;
  const centre = { x: box.width / 2, y: box.height / 2 };

  // The Select tool shows no gizmo, so repeated clicks reach the sprites underneath.
  await page.keyboard.press("q");
  // Centre the view on the bird, then click it: inside its collider, so the Bird node is selected.
  await page.evaluate(() => (window as unknown as Hooks).orbit!.focus([-4, 1, 0]));
  await afterFrames(page);
  await canvas.click({ position: centre });
  await expect(selectedRow(page)).toHaveText("Bird");
  await expect(page.locator(".inspector .node-name")).toHaveValue("Bird"); // the name is an editable field

  // The same spot again: the sprite drawn there, then the sky (a background prefab instance).
  await canvas.click({ position: centre });
  await expect(selectedRow(page)).toHaveText("Sprite");
  await canvas.click({ position: centre });
  await expect(selectedRow(page)).toHaveText("bg-a");

  // F frames the selection. The view looks elsewhere first, so the check below sees F's effect
  // (and F, read by the camera on its next frame, has landed before the view moves again).
  await page.getByText("Bird", { exact: true }).click();
  await page.evaluate(() => (window as unknown as Hooks).orbit!.focus([0, 0, 0]));
  await afterFrames(page);
  await page.keyboard.press("f");
  await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).orbit!.focusPoint.toArray())).toEqual([-4, 1, 0]);

  // Far from the scene there's nothing under the pointer: the selection clears.
  await page.evaluate(() => (window as unknown as Hooks).orbit!.focus([80, 80, 0]));
  await afterFrames(page);
  await canvas.click({ position: centre });
  await expect(selectedRow(page)).toHaveCount(0);
  await expect(page.locator(".inspector .panel-body")).toContainText("Nothing selected") // the Inspector also lists the scene settings now;
  expect(errors).toEqual([]);
});

// (A left drag on empty space draws a selection box: see selection.spec.ts.)
test("a camera drag doesn't change the selection", async ({ page }) => {
  await openEditor(page, { sample: "flappy" });
  const canvas = page.locator("#viewport canvas");
  const box = (await canvas.boundingBox())!;
  await page.evaluate(() => (window as unknown as Hooks).orbit!.focus([-4, 1, 0]));
  await afterFrames(page);
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
  await openEditor(page, { sample: "flappy" });
  await page.getByText("Bird", { exact: true }).click();
  const y = page.getByRole("textbox", { name: "position y" });
  await expect(y).toHaveValue("1");

  await y.fill("3.5");
  await y.press("Enter");
  await expect(page.locator(".scene-name")).toContainText("•"); // unsaved changes
  await expect(await undoItem(page)).toContainText(/Set position/);
  await closeMenus(page);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(y).toHaveValue("1");
  await expect(page.locator(".scene-name")).not.toContainText("•");
  expect(errors).toEqual([]);
});

test("with the Move tool, clicking the gizmo on the selection keeps it selected", async ({ page }) => {
  await openEditor(page, { sample: "flappy" });
  const canvas = page.locator("#viewport canvas");
  const box = (await canvas.boundingBox())!;
  const centre = { x: box.width / 2, y: box.height / 2 };
  await expect(page.getByRole("button", { name: "Move", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => (window as unknown as Hooks).orbit!.focus([-4, 1, 0]));
  await afterFrames(page);
  await canvas.click({ position: centre });
  await expect(selectedRow(page)).toHaveText("Bird");
  // The gizmo loads on first use; wait until it's showing on the selection.
  await waitForGizmo(page, canvas, centre);
  // The gizmo now sits over the bird: pressing its handle drags instead of selecting what's below.
  await canvas.click({ position: centre });
  await expect(selectedRow(page)).toHaveText("Bird");
});

test("a Move gizmo drag is one undo step, and Escape during it puts the node back", async ({ page }) => {
  await openEditor(page, { sample: "flappy" });
  const canvas = page.locator("#viewport canvas");
  const box = (await canvas.boundingBox())!;
  const centre = { x: box.width / 2, y: box.height / 2 };
  await page.evaluate(() => (window as unknown as Hooks).orbit!.focus([-4, 1, 0]));
  await afterFrames(page);
  await canvas.click({ position: centre });
  await expect(selectedRow(page)).toHaveText("Bird");
  await waitForGizmo(page, canvas, centre);
  const x = page.getByRole("textbox", { name: "position x" }), y = page.getByRole("textbox", { name: "position y" });
  const position = async () => [await x.inputValue(), await y.inputValue()];
  await expect.poll(position).toEqual(["-4", "1"]);
  const drag = async () => {
    await page.mouse.move(box.x + centre.x, box.y + centre.y);
    await page.mouse.down();
    await page.mouse.move(box.x + centre.x + 40, box.y + centre.y - 30, { steps: 5 });
  };

  await drag();
  await expect.poll(position).not.toEqual(["-4", "1"]);
  await page.keyboard.press("Escape");
  await expect.poll(position).toEqual(["-4", "1"]);
  await page.mouse.move(box.x + centre.x + 60, box.y + centre.y - 40, { steps: 3 }); // the handle was let go
  await page.mouse.up();
  await afterFrames(page);
  expect(await position()).toEqual(["-4", "1"]);
  await expect(selectedRow(page)).toHaveText("Bird");
  await expect(page.locator(".scene-name")).not.toContainText("•");

  await drag();
  await page.mouse.up();
  await expect.poll(position).not.toEqual(["-4", "1"]);
  await expect(await undoItem(page)).toContainText(/Move Bird/);
  await closeMenus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(position).toEqual(["-4", "1"]);
});

test("scene cameras show an icon that selects the camera", async ({ page }) => {
  await openEditor(page, { sample: "flappy" });
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
  await openEditor(page, { sample: "flappy" });
  await page.getByText("Bird", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "position y" })).toHaveValue("1");

  // The exact name: the Inspector's tag chips (e.g. "Remove tag Player") would match /Play/ too.
  await play(page);
  const game = page.locator("#game-view canvas");
  await expect(game).toBeVisible();
  await expect(page.locator(".status-bar")).toContainText("Playing scenes/main.scene.json");

  // Flap: the game's own scripts run in play mode, so the bird moves in the Runtime World.
  await game.click();
  await page.waitForTimeout(500);
  // Chromium's autofill sends key events with no key; game input and editor shortcuts ignore them.
  await page.evaluate(() => {
    for (const type of ["keydown", "keyup"]) window.dispatchEvent(new Event(type));
  });

  await page.keyboard.press("ControlOrMeta+p"); // stop
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect(game).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "position y" })).toHaveValue("1"); // the edited scene is untouched
  expect(errors).toEqual([]);
});

test("prefab overrides are marked and can be reverted", async ({ page }) => {
  await openEditor(page, { sample: "flappy" });
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
