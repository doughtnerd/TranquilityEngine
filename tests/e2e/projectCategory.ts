import type { Page } from "@playwright/test";

/**
 * Pick a category in the Project panel's settings, whether it shows as a list of tabs or (when the
 * panel is narrow) as the "Settings category" dropdown. A category with problems is named
 * "Physics, 2 problems", so the tab matches by prefix.
 */
export async function pickCategory(page: Page, name: string): Promise<void> {
  const panel = page.locator(".panel.project");
  const tab = panel.getByRole("tab", { name: new RegExp(`^${name}(,|$)`) });
  if (await tab.count()) return tab.click();
  await panel.getByRole("combobox", { name: "Settings category" }).selectOption({ value: name });
}
