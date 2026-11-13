import { expect, openTestProject, test, type Page } from "./fixtures";
import { menu } from "./menus";
import { showTab } from "./tabs";

// ADR 0174: closing panels, adding them back (several copies of one, each with its own view state),
// saved layouts with versions, and a plugin's panels when it's turned off.
test.describe.configure({ timeout: 90_000 });

const tab = (page: Page, name: string) => page.locator(".dock-tab", { has: page.locator(".dock-tab-label", { hasText: new RegExp(`^${name}$`) }) });

test("a panel closes from its tab's ×, comes back from the Window menu, and the × hides in a collapsed dock", async ({ page }) => {
  await openTestProject(page);
  await expect(tab(page, "History")).toHaveCount(1);
  await tab(page, "History").getByRole("button", { name: "Close History" }).click();
  await expect(tab(page, "History")).toHaveCount(0);
  await expect(tab(page, "Scene").getByRole("button", { name: /^Close/ })).toHaveCount(0); // the Scene view never closes
  await menu(page, "Window", "History");
  await expect(tab(page, "History")).toHaveCount(1);
  await expect(tab(page, "History")).toHaveClass(/active/);
  // Collapse the Assets dock: its tabs lose the ×.
  await page.getByRole("button", { name: /^Collapse Assets dock/ }).click();
  await expect(tab(page, "Assets").getByRole("button", { name: /^Close/ })).toHaveCount(0);
});

test("a header's Add Panel… adds a second Hierarchy to that group; each keeps its own expanded rows", async ({ page }) => {
  await openTestProject(page);
  await tab(page, "Hierarchy").click({ button: "right" });
  await page.getByRole("menu", { name: "Panel menu" }).getByRole("menuitem", { name: "Add Panel…" }).click();
  const dialog = page.getByRole("dialog", { name: "Add panels" });
  await dialog.getByRole("checkbox", { name: /^Hierarchy/ }).check();
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(tab(page, "Hierarchy")).toHaveCount(2);
  // Collapse a parent row in the second copy (showing now); the first still shows its children.
  const tree = page.locator(".hierarchy-view .tree");
  const parent = tree.locator("li[aria-expanded='true'] > .row").first();
  const name = (await parent.locator(".name").textContent())!;
  await parent.locator(".caret").click();
  await expect(tree.locator(".row", { hasText: name }).locator("xpath=..")).toHaveAttribute("aria-expanded", "false");
  await tab(page, "Hierarchy").first().click();
  await expect(page.locator(".hierarchy-view .tree .row", { hasText: name }).first().locator("xpath=..")).toHaveAttribute("aria-expanded", "true");
});

test("Save Layout As… keeps a layout in the project's .layouts/; switching layouts and restoring a version", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openTestProject(page);
  await tab(page, "Code").getByRole("button", { name: "Close Code" }).click();
  await menu(page, "Layouts", "Save Layout As…");
  const save = page.getByRole("dialog", { name: "Save layout" });
  await save.getByRole("textbox", { name: "Layout name" }).fill("No code");
  await save.getByRole("checkbox", { name: "In the project" }).check();
  await expect(save.locator(".layout-file-preview")).toHaveText(".layouts/no-code.layout.json");
  await save.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".status-text")).toHaveText("Saved the layout “No code”.");

  await menu(page, "Layouts", "Default");
  await expect(tab(page, "Code")).toHaveCount(1);
  await menu(page, "Layouts", /^No code/);
  await expect(tab(page, "Code")).toHaveCount(0);

  // A second version without History; then restore the first.
  await tab(page, "History").getByRole("button", { name: "Close History" }).click();
  await menu(page, "Layouts", "Save Layout");
  await expect(tab(page, "History")).toHaveCount(0);
  await menu(page, "Layouts", "Manage Layouts…");
  const manage = page.getByRole("dialog", { name: "Layouts" });
  const versions = manage.getByRole("list", { name: "Versions of No code" });
  await expect(versions.getByRole("listitem")).toHaveCount(2);
  await versions.getByRole("listitem").last().click(); // the oldest (newest is at the top)
  await manage.getByRole("button", { name: "Restore" }).click();
  await expect(tab(page, "History")).toHaveCount(1);
  await expect(tab(page, "Code")).toHaveCount(0);
  await manage.getByRole("button", { name: "Close" }).click();
});

test("turning off a plugin whose panel a layout shows asks first; kept, the panel stays and says what brings it back", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openTestProject(page);
  await expect(tab(page, "Tile Palette")).toHaveCount(1);
  await showTab(page, /^Project/);
  await page.locator(".panel.project").getByRole("tab", { name: "Plugins" }).click();
  await page.locator('.plugins-item input[data-plugin="myco.tilemaps"]').uncheck();
  const ask = page.getByRole("alertdialog");
  await expect(ask).toContainText("Tile Palette");
  await ask.getByRole("button", { name: "Turn off" }).click();
  await expect(tab(page, "Tile Palette")).toHaveCount(1);
  await tab(page, "Tile Palette").click();
  await expect(page.locator(".unavailable-panel")).toContainText("isn't available");
  await expect(page.locator(".unavailable-panel")).toContainText("myco.tilemaps");
  // On again: the panel works again in place.
  await page.locator(".unavailable-panel").getByRole("button", { name: "Open Plugins settings" }).click();
  await page.locator('.plugins-item input[data-plugin="myco.tilemaps"]').check();
  await tab(page, "Tile Palette").click();
  await expect(page.locator(".unavailable-panel")).toHaveCount(0);
});

test("turning off a plugin can remove its panels from the layouts instead", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openTestProject(page);
  await showTab(page, /^Project/);
  await page.locator(".panel.project").getByRole("tab", { name: "Plugins" }).click();
  await page.locator('.plugins-item input[data-plugin="myco.tilemaps"]').uncheck();
  const ask = page.getByRole("alertdialog");
  await ask.getByRole("checkbox", { name: "Remove these panels from the layouts" }).check();
  await ask.getByRole("button", { name: "Turn off" }).click();
  await expect(tab(page, "Tile Palette")).toHaveCount(0);
});

test("Detach opens a panel in a window of its own that shares the editor's state; closing it closes its panels", async ({ page, context }) => {
  await openTestProject(page);
  await tab(page, "Inspector").click({ button: "right" });
  const popup = context.waitForEvent("page");
  await page.getByRole("menu", { name: "Panel menu" }).getByRole("menuitem", { name: "Detach" }).click();
  const child = await popup;
  await expect(child.locator(".dock-tabs .dock-tab-label")).toHaveText(["Inspector"]);
  await expect(tab(page, "Inspector")).toHaveCount(0);
  await expect.poll(() => child.title()).toBe("Inspector · Myco Engine");
  // Selecting a node in the main window shows it in the detached Inspector.
  const row = page.locator(".hierarchy-view .tree .row").first();
  const name = (await row.locator(".name").textContent())!;
  await row.click();
  await expect(child.locator(".panel.inspector")).toContainText(name);
  // Panels can be added and arranged there too.
  await tab(child, "Inspector").click({ button: "right" });
  await child.getByRole("menu", { name: "Panel menu" }).getByRole("menuitem", { name: "Add Panel…" }).click();
  await child.getByRole("dialog", { name: "Add panels" }).getByRole("checkbox", { name: /^History/ }).check();
  await child.getByRole("dialog", { name: "Add panels" }).getByRole("button", { name: "Add" }).click();
  await expect(child.locator(".dock-tabs .dock-tab-label")).toHaveText(["Inspector", "History"]);
  // Move History back to the main window from its header menu.
  await tab(child, "History").click({ button: "right" });
  await child.getByRole("menu", { name: "Panel menu" }).getByRole("menuitem", { name: "Move to Main Window" }).click();
  await expect(child.locator(".dock-tabs .dock-tab-label")).toHaveText(["Inspector"]);
  await expect(tab(page, "History")).toHaveCount(1);
  // Closing the window closes the Inspector; the Window menu brings it back to the main window.
  await child.close();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("myco.editor.layout")!).windows ?? null)).toBeNull();
  await expect(tab(page, "Inspector")).toHaveCount(0);
  await menu(page, "Window", "Inspector");
  await expect(tab(page, "Inspector")).toHaveCount(1);
});
