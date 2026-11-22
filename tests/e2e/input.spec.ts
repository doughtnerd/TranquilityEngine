import { expect, type Hooks, openEditor, type Page, play, test } from "./fixtures";
import { menu } from "./menus";
import { showTab } from "./tabs";

// The input system in the editor (ADR 0336, 0337; docs/guide/input.md): the Input Debugger panel follows a playing
// World's actions and events, and the Input Context editor writes mappings (with Bind capturing the next key press)
// that the InputContext component's `context` dropdown offers. The UIControlMapper's real drawing and rebinding are in
// input-mapper.spec.ts.
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
  await expect(panel.locator(".input-debugger-empty")).toContainText("Play to see a World's input here");

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
  await expect(page.getByRole("button", { name: "▶ Play" })).toBeVisible();
  await expect(panel.locator(".input-debugger-empty")).toContainText("Play to see a World's input here");
  expect(errors).toEqual([]);
});

test("New Input Context: a mapping bound with a key press is saved, and InputContext's context dropdown lists the file", async ({ page }) => {
  const errors = trackErrors(page);
  await page.setViewportSize({ width: 1600, height: 1000 }); // the Input Context panel sits in the right dock
  await openEditor(page, { files: { "scripts/testActions.ts": ACTIONS } });

  // New… › New Input Context (right-click in the Assets panel) writes a context in the folder the panel shows, here the root.
  await page.locator(".dock-tab", { hasText: "Assets" }).click();
  const list = (await assets(page).locator(".asset-items").boundingBox())!;
  await page.mouse.click(list.x + list.width - 10, list.y + list.height - 10, { button: "right" });
  await page.getByRole("menuitem", { name: "New Input Context", exact: true }).click();
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
  await expect(action.locator("option")).toHaveText(["jump", "fire"].map((a) => new RegExp(a)));
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
