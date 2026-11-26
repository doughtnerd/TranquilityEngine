import { expect, type Hooks, openEditor, type Page, play, test } from "./fixtures";
import { assetsMenu, menu } from "./menus";
import { showTab } from "./tabs";

// The input system in the editor (ADR 0336, 0337; docs/wiki/guide/input.md): the Input Debugger panel follows a playing
// World's actions and events, and the Input Context editor writes mappings (with Bind capturing the next key press)
// that the InputContext component's `context` dropdown offers. The debugger's Record saves a fake controller's raw input as a
// fixture file, and its Overlay shows players over the game view. The UIControlMapper's real drawing and rebinding are in
// input-mapper.spec.ts; keyboard navigation of game UI in ui-navigation.spec.ts.
test.describe.configure({ timeout: 90_000 }); // opening a project compiles its scripts, and Play type-checks them

/** A script declaring one action set, whose `jump` is J by default (the default context). */
const ACTIONS = `import { button, defineActions } from "myco";

export const TestActions = defineActions("game.TestActions", { jump: button("<Keyboard>/j"), fire: button("<Keyboard>/f") });
`;

const tab = (page: Page, name: string) => page.locator(".dock-tab", { has: page.locator(".dock-tab-label", { hasText: new RegExp(`^${name}$`) }) });
const assets = (page: Page) => page.locator(".panel.assets");
const tile = (page: Page, name: string) => assets(page).locator(".asset-item", { has: page.locator(".asset-name", { hasText: name }) });
const read = (page: Page, path: string) => page.evaluate((p) => (window as unknown as Hooks).testFolder.read(p), path);
const card = (page: Page, name: string) => page.locator(".inspector-body .component", { has: page.locator("h3", { hasText: name }) });

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

test("the Input Debugger shows a playing World's action values, flags, source and events, and says to play when stopped", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page, { files: { "scripts/testActions.ts": ACTIONS } });
  await menu(page, "Window", "Input Debugger");
  await expect(tab(page, "Input Debugger")).toHaveClass(/active/);
  const panel = page.locator(".input-debugger");
  await expect(panel.getByRole("note", { name: "Play to see a World's input here" })).toBeVisible();

  await play(page);
  await page.locator("#game-view canvas").first().click(); // focus the game view (the keyboard appears with the first key)
  const jump = panel.locator('tr[data-action="jump"]');
  await expect(jump).toBeVisible({ timeout: 15_000 });
  await expect(panel.locator('tr[data-action="fire"]')).toBeVisible();
  await expect(jump.locator(".input-debugger-value")).toHaveText("0");
  await expect(panel.getByRole("list", { name: "Active contexts" })).toContainText("default");

  // Holding J: the action's value, its held flag, and the default context's mapping that produced it.
  await page.keyboard.down("j");
  await expect(jump.locator(".input-debugger-value")).toHaveText("1.00");
  await expect(jump).toHaveClass(/active/);
  await expect(jump.locator(".input-debugger-phases")).toContainText("held");
  await expect(jump.locator(".input-debugger-source")).toHaveText("default #1 · <Keyboard>/j");
  await expect(panel.getByRole("table").first()).toContainText("keyboard"); // the keyboard is a device now
  await page.keyboard.up("j");
  await expect(jump.locator(".input-debugger-value")).toHaveText("0");
  await expect(jump).not.toHaveClass(/active/);

  // The log has the press as device and action events.
  const log = panel.getByRole("list", { name: "Recent events" });
  await expect(log).toContainText(/P0 jump (started|performed)/);
  await expect(log).toContainText(/P0 jump completed/);
  await expect(log).toContainText("<Keyboard>/j");
  // The other action never fired.
  await expect(log).not.toContainText("fire");

  await page.getByRole("button", { name: /Stop/ }).click();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect(panel.getByRole("note", { name: "Play to see a World's input here" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("New Input Context: a mapping bound with a key press is saved, and InputContext's context dropdown lists the file", async ({ page }) => {
  const errors = trackErrors(page);
  await page.setViewportSize({ width: 1600, height: 1000 }); // the Input Context panel sits in the right dock
  await openEditor(page, { files: { "scripts/testActions.ts": ACTIONS } });

  // Create › Input › Input Context (right-click in the Assets panel) writes a context in the folder the panel shows, here the root.
  await page.locator(".dock-tab", { hasText: "Assets" }).click();
  const list = (await assets(page).locator(".asset-items").boundingBox())!;
  await page.mouse.click(list.x + list.width - 10, list.y + list.height - 10, { button: "right" });
  await assetsMenu(page, "Create", "Input", "Input Context");
  const path = "New Input Context.input.json";
  await expect.poll(async () => JSON.parse((await read(page, path)) ?? "null")).toEqual({ name: "New Input Context", mappings: [] });
  await expect(tile(page, "New Input Context.input.json")).toHaveCount(1);

  // Double-click opens the Input Context panel.
  await tile(page, "New Input Context.input.json").dblclick();
  await expect(tab(page, "Input Context")).toHaveClass(/active/);
  const editor = page.locator(".panel .input-context").filter({ has: page.getByRole("button", { name: "Add mapping" }) }).last();
  await expect(editor).toBeVisible();

  // Add a mapping, choose the action, then Bind and press K.
  await editor.getByRole("button", { name: "Add mapping" }).click();
  const mapping = editor.getByRole("listitem", { name: "Mapping 1" });
  await expect(mapping).toBeVisible();
  const action = mapping.getByRole("combobox", { name: "Action" });
  // The project's actions, and the engine's UI actions (ADR 0340), which a game may bind in its own contexts too.
  const options = await action.locator("option").allTextContents();
  expect(options.filter((o) => o.includes("game.TestActions"))).toEqual([expect.stringMatching(/^jump/), expect.stringMatching(/^fire/)]);
  expect(options.filter((o) => o.includes("engine.UIActions")).map((o) => o.split(" ")[0])).toEqual(["navigate", "submit", "cancel", "next", "previous"]);
  await action.selectOption({ label: (await action.locator("option", { hasText: "fire" }).textContent())! });
  await expect.poll(async () => JSON.parse((await read(page, path)) ?? "null")?.mappings?.[0]?.action).toMatch(/fire$/);
  await mapping.getByRole("button", { name: "Bind" }).click();
  await expect(mapping.getByRole("button", { name: "Cancel" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("k");
  await expect(mapping.getByRole("button", { name: "Bind" })).toBeVisible();
  await expect(mapping.getByRole("combobox", { name: "Control", exact: true })).toHaveValue("<Keyboard>/k");

  // The file on disk has the mapping.
  await expect.poll(async () => JSON.parse((await read(page, path)) ?? "null")?.mappings).toEqual([{ action: expect.stringMatching(/fire$/), control: "<Keyboard>/k" }]);
  await expect(mapping.getByRole("list", { name: "Mapping 1 problems" })).toHaveCount(0);

  // A node's InputContext component offers the file in its context dropdown.
  await page.locator('.tree .row[data-key="ceiling"]').click();
  await showTab(page, "Inspector"); // the Input Context panel opened in front of it
  await page.getByRole("button", { name: "Add Component" }).click();
  await page.getByRole("searchbox", { name: "Search components" }).fill("InputContext");
  await page.getByRole("dialog", { name: "Add component" }).getByRole("option", { name: /^InputContext/ }).click();
  const context = card(page, "InputContext").getByRole("combobox", { name: "context" });
  await expect(context).toBeVisible();
  await expect(context.locator("option")).toContainText(["None", path]);
  await context.selectOption(path);
  await expect(context.locator("option:checked")).toHaveText(path);
  expect(errors).toEqual([]);
});

/**
 * A fake controller at the browser's Gamepad API (`navigator.getGamepads`), the boundary the engine's Gamepad API adapter reads
 * and the hardware recorder taps, so a recording has something to record. `window.e2eFakePad(buttons)` sets its buttons'
 * values (index → value). It's the spec's own double of the browser, not engine state.
 */
function fakeGamepad(): void {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
  let timestamp = 0;
  const pad = { index: 0, id: "Xbox 360 Controller (XInput STANDARD GAMEPAD)", mapping: "standard", connected: true, axes: [0, 0, 0, 0], buttons, vibrationActuator: null, get timestamp() { return timestamp; } };
  Object.defineProperty(Navigator.prototype, "getGamepads", { configurable: true, value: () => [pad, null, null, null] });
  (window as unknown as { e2eFakePad(values: Record<number, number>): void }).e2eFakePad = (values) => {
    for (const [i, v] of Object.entries(values)) buttons[Number(i)] = { pressed: v > 0.5, touched: v > 0, value: v };
    timestamp++;
  };
}

const pressPad = (page: Page, values: Record<number, number>) => page.evaluate((v) => (window as unknown as { e2eFakePad(values: Record<number, number>): void }).e2eFakePad(v), values);

test("Record saves the controllers' raw input as a myco-input-recording file in recordings/", async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(fakeGamepad);
  await openEditor(page, { files: { "scripts/testActions.ts": ACTIONS } });
  await menu(page, "Window", "Input Debugger");
  const panel = page.locator(".input-debugger");
  await play(page);
  await page.locator("#game-view canvas").first().click();
  // The pad is a device of the playing World: the Gamepad API adapter reads it.
  await expect(panel.locator('tr[data-device="Xbox 360 Controller (XInput STANDARD GAMEPAD)"]')).toBeVisible({ timeout: 15_000 });

  await panel.getByRole("button", { name: "Record" }).click();
  const stop = panel.getByRole("button", { name: /^Stop/ });
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  // Keys aren't controllers' raw input (the recorder taps the gamepad adapters), the pad's presses are.
  await page.keyboard.press("j");
  const log = panel.getByRole("list", { name: "Recent events" });
  await pressPad(page, { 0: 1 });
  await expect(log).toContainText("buttonSouth");
  await pressPad(page, { 0: 0, 7: 0.6 });
  await expect(log).toContainText("rightTrigger");
  await pressPad(page, { 7: 0 });
  await expect(stop.locator(".input-debugger-facts")).toContainText(/[1-9]\d* events/);
  await stop.click();

  // Stop saves the file and says where.
  const saved = panel.getByRole("status");
  await expect(saved).toContainText(/^Saved recordings\/input-[\d-]+\.input-recording\.json: Gamepad API, \d+ events, [\d.]+ s\.$/);
  await expect(panel.getByRole("button", { name: "Record" })).toBeVisible();
  const path = /^Saved (\S+):/.exec((await saved.textContent())!)![1];
  const recording = JSON.parse((await read(page, path))!) as { format: string; version: number; duration: number; web: { platform: string } | null; events: { web?: { id: string; buttons: number[] }[] }[] };
  expect(recording).toMatchObject({ format: "myco-input-recording", version: 1, web: { platform: expect.any(String) } });
  expect(recording.duration).toBeGreaterThan(0);
  const readings = recording.events.flatMap((e) => e.web ?? []);
  expect(readings.length).toBeGreaterThan(0);
  expect(readings.every((p) => p.id === "Xbox 360 Controller (XInput STANDARD GAMEPAD)")).toBe(true);
  expect(readings.some((p) => p.buttons[0] === 1)).toBe(true); // the south button's press
  expect(readings.some((p) => p.buttons[7] === 0.6)).toBe(true); // the right trigger, half pulled
  expect(errors).toEqual([]);
});

test("Overlay shows each player's action values, phases and recent presses over the game view during Play, and hides when turned off", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page, { files: { "scripts/testActions.ts": ACTIONS } });
  await menu(page, "Window", "Input Debugger");
  const panel = page.locator(".input-debugger");
  const toggle = panel.getByRole("button", { name: "Overlay" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await play(page);
  await page.locator("#game-view canvas").first().click();
  const overlay = page.getByRole("region", { name: "Input overlay" });
  await expect(overlay).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(overlay).toBeVisible({ timeout: 15_000 });
  const player = overlay.getByRole("region", { name: "Overlay player 0" });
  const jump = player.locator('tr[data-action="jump"]');
  await expect(jump).toBeVisible();
  await expect(player.getByLabel("Contexts")).toContainText("default");
  await expect(jump.locator(".input-overlay-value")).toHaveText("0");

  // Holding J: jump's bar fills, its value reads 1.00 with a held badge, and the press is listed.
  await page.keyboard.down("j");
  await expect(jump.locator(".input-overlay-value")).toHaveText("1.00");
  await expect(jump).toHaveClass(/active/);
  await expect(jump.locator(".input-overlay-phases")).toContainText("held");
  await expect(jump.locator(".input-overlay-fill")).toHaveAttribute("style", /width: 100%/);
  await expect(player.getByLabel("Recent presses")).toContainText("j");
  await expect(player.locator(".input-overlay-family")).toHaveText("keyboard");
  await page.keyboard.up("j");
  await expect(jump.locator(".input-overlay-value")).toHaveText("0");
  await expect(jump).not.toHaveClass(/active/);
  await expect(player.locator('tr[data-action="fire"]')).not.toHaveClass(/active/);

  // Off again: the overlay goes.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(overlay).toHaveCount(0);
  expect(errors).toEqual([]);
});
