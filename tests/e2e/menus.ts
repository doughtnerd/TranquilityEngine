import { expect, type Locator, type Page } from "@playwright/test";

/** The editor's menu bar. */
export const menubar = (page: Page): Locator => page.getByRole("menubar", { name: "Main menu" });

/** The menu bar's open drop-downs (and submenus), not other menus such as context menus. */
const barMenus = (page: Page): Locator => page.locator(".menubar-menu");

/** A menu's title in the bar. */
export const menuTitle = (page: Page, menu: string): Locator => menubar(page).getByRole("menuitem", { name: menu, exact: true });

/** An item's accessible name is its label then its shortcut (or a submenu arrow): match the label alone. */
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const itemName = (name: string | RegExp): RegExp => (typeof name === "string" ? new RegExp(`^${escape(name)}(?:\\s+(?:Ctrl\\+\\S+|Del|▸))?$`) : name);

/** An item in a menu that is already open (`path` is the item's name, or a submenu's then its item's). */
export function menuItem(page: Page, ...path: string[]): Locator {
  const [first, ...rest] = path;
  let item = barMenus(page).last().getByRole("menuitem", { name: first, exact: true });
  for (const name of rest) item = barMenus(page).last().getByRole("menuitem", { name, exact: true });
  return item;
}

/** Open a menu and return it. */
export async function openMenu(page: Page, menu: string): Promise<Locator> {
  const title = menuTitle(page, menu);
  if ((await title.getAttribute("aria-expanded")) !== "true") await title.click();
  await expect(title).toHaveAttribute("aria-expanded", "true");
  return barMenus(page).first();
}

/**
 * Open `menu` and click an item (`File`, `Save`), through a submenu if the path has more
 * (`File`, `Open Recent`, `Second`). Items are matched by name, either a menuitem or a checkable one.
 */
export async function menu(page: Page, menu: string, ...path: (string | RegExp)[]): Promise<void> {
  const root = await openMenu(page, menu);
  let scope = root;
  for (let i = 0; i < path.length; i++) {
    const name = itemName(path[i]);
    const item = scope.getByRole("menuitem", { name }).or(scope.getByRole("menuitemcheckbox", { name }));
    if (i < path.length - 1) {
      await item.click(); // opens the submenu
      scope = item.locator("xpath=..").getByRole("menu");
      await expect(scope).toBeVisible();
    } else {
      await item.click();
    }
  }
}

/** An item of an open (or openable) menu, to check its state. Opens the menu; close it with `closeMenus`. */
export async function menuItemOf(page: Page, menuName: string, item: string | RegExp): Promise<Locator> {
  const root = await openMenu(page, menuName);
  return root.getByRole("menuitem", { name: item }).or(root.getByRole("menuitemcheckbox", { name: item }));
}

export async function closeMenus(page: Page): Promise<void> {
  if (await barMenus(page).count()) await page.keyboard.press("Escape");
  await expect(barMenus(page)).toHaveCount(0);
}

/** The Edit menu's Undo item (its text says what it undoes), opened; check it, then `closeMenus`. */
export async function undoItem(page: Page): Promise<Locator> {
  return menuItemOf(page, "Edit", /^Undo/);
}
