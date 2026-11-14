import { expect, openTestProject, type Page, test } from "./fixtures";
import { closeMenus, menu, menubar, menuTitle, openMenu } from "./menus";

const EDITOR = "/editor.html?sample=flappy"; // opens the Flappy sample (ADR 0031); relative to baseURL (E2E_PORT)

type Hooks = { engine?: { world: { time: { frameCount: number } } }; openTestProject(extra?: Record<string, string>): Promise<void>; testFolder: { read(path: string): string | undefined } };

async function openEditor(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

test("the bar has File, Edit, Create, Window, Layouts and Help, Play in the middle and the project on the right; items show their shortcuts, and a disabled one says why", async ({ page }) => {
  await openEditor(page);
  await expect(menubar(page).getByRole("menuitem")).toHaveText(["File", "Edit", "Create", "Window", "Layouts", "Help"]);
  await expect(page.getByRole("button", { name: /Play/ })).toBeVisible();
  await expect(page.locator(".menubar-right .project-name")).toContainText("Flappy Bird");
  await expect(page.locator(".menubar-right .readonly-badge")).toHaveText("Read-only"); // a sample
  // The old toolbar buttons are gone.
  for (const name of ["Save", "Undo", "Redo", "Reset Layout", "Settings", "Project ▾", "Export…"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);

  // Items show their shortcuts, and a disabled one says why.
  const file = await openMenu(page, "File");
  await expect(file.getByRole("menuitem", { name: /^Save/ })).toContainText("Ctrl+S");
  await expect(file.getByRole("menuitem", { name: /^Save/ })).toBeDisabled(); // a read-only sample
  await expect(file.getByRole("menuitem", { name: /^Save/ })).toHaveAttribute("title", /read-only/);
  await expect(file.getByRole("menuitem", { name: "Reload Scripts" })).toHaveCount(0); // a sample has no scripts folder
  await closeMenus(page);
  const edit = await openMenu(page, "Edit");
  await expect(edit.getByRole("menuitem", { name: /^Undo/ })).toContainText("Ctrl+Z");
  await expect(edit.getByRole("menuitem", { name: /^Undo/ })).toHaveAttribute("title", /nothing to undo/);
});

test("a menu opens on click, closes on a second click, Escape and a click outside; hovering switches", async ({ page }) => {
  await openEditor(page);
  const file = menuTitle(page, "File"), edit = menuTitle(page, "Edit");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await file.click();
  await expect(file).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("menu").getByRole("menuitem", { name: "Open Project…" })).toBeVisible();
  await edit.hover();
  await expect(edit).toHaveAttribute("aria-expanded", "true");
  await expect(file).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("menu").getByRole("menuitem", { name: "Settings…" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await file.click();
  await file.click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await file.click();
  await page.locator(".status-bar").click({ position: { x: 300, y: 5 } }); // outside the bar (the log toggles; fine)
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("the keyboard moves through the menus: Alt, arrows, Enter, Escape", async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press("Alt");
  await expect(menuTitle(page, "File")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(menuTitle(page, "Edit")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft"); // wraps
  await expect(menuTitle(page, "Help")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(menuTitle(page, "File")).toBeFocused();

  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight"); // Edit, Create, Window
  await expect(menuTitle(page, "Window")).toBeFocused();
  await page.keyboard.press("ArrowDown"); // opens and focuses the first item
  await expect(menuTitle(page, "Window")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("menuitemcheckbox", { name: "Scene", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitemcheckbox", { name: "Hierarchy", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp"); // wraps to the last item
  await expect(page.getByRole("menuitem", { name: "Reset Layout", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowRight"); // the next menu, opened (Layouts: Default first)
  await expect(menuTitle(page, "Layouts")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("menuitemcheckbox", { name: "Default", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowRight"); // and the one after
  await expect(menuTitle(page, "Help")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("menu").getByRole("menuitem").first()).toBeFocused(); // focused once it has rendered: keys go there
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(menuTitle(page, "Help")).toBeFocused();
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft"); // Layouts, Window, Create, Edit

  // Enter activates: Edit > Settings… opens the dialog.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: "Settings…" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
});

test("a submenu opens with ArrowRight and closes with ArrowLeft", async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press("Alt");
  await page.keyboard.press("ArrowDown");
  await page.getByRole("menuitem", { name: "Open Recent" }).focus(); // disabled in a browser without folder access: skip then
  if (await page.getByRole("menuitem", { name: "Open Recent" }).isDisabled()) return;
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("menuitem", { name: "Open Recent" })).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("menuitem", { name: "Open Recent" })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("menuitem", { name: "Open Recent" })).toBeFocused();
});

test("Window lists a checkable item per panel, shows a panel, and resets the layout", async ({ page }) => {
  await openEditor(page);
  const window = await openMenu(page, "Window");
  const history = window.getByRole("menuitemcheckbox", { name: "History", exact: true });
  await expect(window.getByRole("menuitemcheckbox", { name: "Hierarchy", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(history).toHaveAttribute("aria-checked", "false"); // a background tab
  await history.click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /^History/ })).toHaveAttribute("aria-selected", "true");
  await expect(await openMenu(page, "Window").then((m) => m.getByRole("menuitemcheckbox", { name: "History", exact: true }))).toHaveAttribute("aria-checked", "true");
  await closeMenus(page);
  await menu(page, "Window", "Reset Layout");
  await expect(page.getByRole("tab", { name: /^History/ })).toHaveAttribute("aria-selected", "false");
});

test("Create adds a node like the Hierarchy's menu, as one undo step", async ({ page }) => {
  await openEditor(page);
  await menu(page, "Create", "Sprite");
  await expect(page.locator('.tree .row[data-key="sprite"]')).toHaveClass(/selected/);
  await expect(page.locator(".scene-name")).toContainText("•");
  const edit = await openMenu(page, "Edit");
  await expect(edit.getByRole("menuitem", { name: /^Undo/ })).toContainText("Create Sprite");
  await edit.getByRole("menuitem", { name: /^Undo/ }).click();
  await expect(page.locator('.tree .row[data-key="sprite"]')).toHaveCount(0);
});

test("Help opens the log and About", async ({ page }) => {
  await openEditor(page);
  await menu(page, "Help", "Log");
  await expect(page.locator("#message-log")).toBeVisible();
  await menu(page, "Help", "About Myco Engine");
  await expect(page.getByRole("dialog", { name: /About/ })).toBeVisible();
});

test("File > Save writes the scene of a project folder and clears the unsaved mark", async ({ page }) => {
  await openTestProject(page);
  await expect(page.locator(".menubar-right .readonly-badge")).toHaveCount(0);
  await page.locator('.tree .row[data-key="bird"]').click();
  const y = page.getByRole("textbox", { name: "position y" });
  await y.fill("7.25");
  await y.press("Enter");
  await expect(page.locator(".scene-name")).toContainText("•");
  await expect(page.locator(".unsaved-dot")).toBeVisible();
  await menu(page, "File", "Save");
  await expect(page.locator(".scene-name")).not.toContainText("•");
  await expect(page.locator(".unsaved-dot")).toHaveCount(0);
  const saved = await page.evaluate(() => (window as unknown as Hooks).testFolder.read("scenes/main.scene.json"));
  expect(saved).toContain("7.25");
});

test("Alt used as a modifier (Alt+click in the scene view) doesn't move the focus to the menu bar", async ({ page }) => {
  await openEditor(page);
  const view = (await page.locator("#viewport canvas").first().boundingBox())!;
  await page.keyboard.down("Alt");
  await page.mouse.click(view.x + view.width / 2, view.y + view.height / 2);
  await page.keyboard.up("Alt");
  await expect(menuTitle(page, "File")).not.toBeFocused();
  // Alt on its own still does.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt");
  await expect(menuTitle(page, "File")).toBeFocused();
});

test("the menu bar does nothing while a dialog is open", async ({ page }) => {
  await openEditor(page);
  await menu(page, "Edit", "Settings…");
  const dialog = page.getByRole("dialog", { name: /Settings/ });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Alt");
  await expect(menuTitle(page, "File")).not.toBeFocused();
  await menuTitle(page, "File").click({ force: true }); // under the backdrop: forced, as a stray click would be
  await expect(menuTitle(page, "File")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".menubar-menu")).toHaveCount(0);
});

test("closing a menu with Escape gives the focus back to where it was", async ({ page }) => {
  await openEditor(page);
  const search = page.getByPlaceholder(/Search/).first();
  await search.focus();
  await menuTitle(page, "Edit").click();
  await expect(page.locator(".menubar-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".menubar-menu")).toHaveCount(0);
  await expect(search).toBeFocused();
});
