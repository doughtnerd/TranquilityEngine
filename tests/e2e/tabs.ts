import type { Page } from "@playwright/test";

/**
 * Show a panel by its tab, whether the tab is in its header or behind a "» N" overflow button
 * (tabs that don't fit a narrow dock go there). `name` matches the start of the tab's title.
 */
export async function showTab(page: Page, name: string | RegExp): Promise<void> {
  const re = typeof name === "string" ? new RegExp(`^${name}`) : name;
  const tab = page.getByRole("tab", { name: re });
  if (await tab.count()) return tab.first().click();
  for (const more of await page.getByRole("button", { name: "More tabs" }).all()) {
    await more.click();
    const item = page.getByRole("menuitem", { name: re });
    if (await item.count()) return item.first().click();
    await page.keyboard.press("Escape");
  }
  throw new Error(`No tab matches ${re}, in a header or behind an overflow button.`);
}
