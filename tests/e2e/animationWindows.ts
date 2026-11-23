import { expect, type Hooks, type Locator, type Page } from "./fixtures";

// Shared steps of the animation editor specs: docking an on-demand panel where it has room, clicking a dope sheet's
// time ruler, and reading project files the editor saved.

const dockTab = (page: Page, name: string) => page.locator(".dock-tab").and(page.getByRole("tab", { name: new RegExp(`^${name}`) }));

/**
 * Moves panel `name` (a dock tab) into the bottom dock beside Assets and shows it: on-demand panels open beside the
 * Inspector, which they would hide (the Inspector's key buttons and fields are used beside them).
 */
export async function dockBelow(page: Page, name: string): Promise<void> {
  const from = (await dockTab(page, name).boundingBox())!;
  const to = (await dockTab(page, "Assets").boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + 30, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".dock-group", { has: dockTab(page, "Assets") }).locator(".dock-tab", { hasText: name })).toBeVisible();
  await dockTab(page, name).click();
}

/** Clicks the time ruler `ruler` at `fraction` of its length (0 … 1): a press on the ruler itself (the playhead's flag can sit over the point). */
export async function rulerClick(page: Page, ruler: Locator, fraction: number): Promise<void> {
  const box = (await ruler.boundingBox())!;
  await page.mouse.click(box.x + Math.max(0.5, Math.min(box.width - 0.5, box.width * fraction)), box.y + box.height / 2);
}

/** A project file as the editor saved it, parsed (null when there is none). */
export const savedJson = <T = unknown>(page: Page, path: string): Promise<T | null> => page.evaluate((p) => JSON.parse((window as unknown as Hooks).testFolder.read(p) ?? "null"), path) as Promise<T | null>;
