import { expect, test, type Page } from "@playwright/test";
import { showTab } from "./tabs";

// The Project panel's settings as a category list (left) with the selected category's settings
// (right); a narrow panel swaps the list for a dropdown.
const EDITOR = "/editor.html?sample=flappy";
test.describe.configure({ timeout: 60_000 });

type Hooks = { engine?: { world: { time: { frameCount: number } } }; openTestProject(extra: Record<string, string>): Promise<void> };

const CATEGORIES = ["Project", "Display", "Time", "Physics", "Rendering", "Graphics", "Navigation", "Audio", "Plugins", "Autoloads", "Build"];

async function openProject(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await page.evaluate(() => (window as unknown as Hooks).openTestProject({}));
  await showTab(page, /^Project/);
}

const panel = (page: Page) => page.locator(".panel.project");

async function commit(page: Page, label: string, value: string): Promise<void> {
  const box = panel(page).getByRole("textbox", { name: label, exact: true });
  await box.fill(value);
  await box.press("Enter");
}

test("the categories list, selection and keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openProject(page);
  const p = panel(page);
  const list = p.getByRole("tablist", { name: "Settings categories" });
  await expect(list.getByRole("tab")).toHaveText(CATEGORIES);
  await expect(list.getByRole("tab", { name: "Project" })).toHaveAttribute("aria-selected", "true");
  await expect(p.getByRole("textbox", { name: "Project name" })).toBeVisible();
  await expect(p.getByRole("textbox", { name: "Display width" })).toHaveCount(0);

  await list.getByRole("tab", { name: "Display" }).click();
  await expect(list.getByRole("tab", { name: "Display" })).toHaveAttribute("aria-selected", "true");
  await expect(p.getByRole("textbox", { name: "Display width" })).toBeVisible();
  await expect(p.getByRole("textbox", { name: "Project name" })).toHaveCount(0);
  await expect(p.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", /ps-tab-Display/);

  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("tab", { name: "Time" })).toHaveAttribute("aria-selected", "true");
  await expect(p.getByRole("textbox", { name: "Max frame time" })).toBeVisible();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(list.getByRole("tab", { name: "Project" })).toHaveAttribute("aria-selected", "true");

  // The choice is remembered (per user) across a reload.
  await list.getByRole("tab", { name: "Physics" }).click();
  await page.reload();
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await page.evaluate(() => (window as unknown as Hooks).openTestProject({}));
  await showTab(page, /^Project/);
  await expect(p.getByRole("tab", { name: "Physics" })).toHaveAttribute("aria-selected", "true");
});

test("a problem marks its category with a count", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openProject(page);
  const p = panel(page);
  await p.getByRole("tab", { name: "Display" }).click();
  await commit(page, "Display height", "0");
  await expect(p.getByRole("list", { name: "Problems" })).toBeVisible();
  const tab = p.getByRole("tab", { name: /^Display, 1 problem$/ });
  await expect(tab).toBeVisible();
  await expect(tab.locator(".project-settings-badge")).toHaveText("1");
  await expect(p.getByRole("tab", { name: "Time" }).locator(".project-settings-badge")).toHaveCount(0);

  await p.getByRole("button", { name: "Undo" }).click();
  await expect(p.locator(".project-settings-badge")).toHaveCount(0);
});

test("a narrow panel shows the categories as a dropdown", async ({ page }) => {
  await openProject(page);
  const p = panel(page);
  // Narrow the panel itself, whatever the dock layout: constrain its width.
  await p.evaluate((el) => {
    (el as HTMLElement).style.width = "220px";
    (el as HTMLElement).style.maxWidth = "220px";
    (el as HTMLElement).style.flex = "none";
  });
  const select = p.getByRole("combobox", { name: "Settings category" });
  await expect(select).toBeVisible();
  await expect(p.getByRole("tablist")).toHaveCount(0);

  await select.selectOption("Time");
  await expect(p.getByRole("textbox", { name: "Max frame time" })).toBeVisible();
  await select.selectOption("Build");
  await expect(p.getByRole("textbox", { name: "App identifier" })).toBeVisible();

  // Widening brings the list back.
  await p.evaluate((el) => {
    (el as HTMLElement).style.width = "";
    (el as HTMLElement).style.maxWidth = "";
    (el as HTMLElement).style.flex = "";
  });
});
