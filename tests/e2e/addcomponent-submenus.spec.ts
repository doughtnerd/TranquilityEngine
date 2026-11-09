import { expect, test, type Page } from "./fixtures";

const EDITOR = "/editor.html?sample=flappy"; // relative to baseURL (E2E_PORT)

type Hooks = { engine?: { world: { time: { frameCount: number } } } };

async function openMenu(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await page.locator('.tree .row[data-key="ceiling"]').click();
  await page.getByRole("button", { name: "Add Component" }).click();
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "Add component" });
const search = (page: Page) => page.getByRole("searchbox", { name: "Search components" });
const card = (page: Page, name: string) => page.locator(".inspector-body .component", { has: page.locator("h3", { hasText: name }) });

test("the menu shows categories, and Navigation opens a submenu with NavAgent", async ({ page }) => {
  await openMenu(page);
  const root = dialog(page).getByRole("menu", { name: "Component categories" });
  for (const name of ["Rendering", "Physics 2D", "Physics 3D", "Navigation", "Audio", "Scripts", "Data"]) {
    await expect(root.getByRole("menuitem", { name: name, exact: true })).toBeVisible();
  }
  await root.getByRole("menuitem", { name: "Navigation", exact: true }).hover();
  const flyout = page.getByRole("menu", { name: "Navigation" });
  await expect(flyout.getByRole("menuitem", { name: "NavAgent" })).toBeVisible();
  await expect(page.getByRole("menu", { name: "Rendering" })).toHaveCount(0);
});

test("scripts are grouped by folder in nested submenus", async ({ page }) => {
  await openMenu(page);
  await dialog(page).getByRole("menuitem", { name: "Scripts", exact: true }).click();
  await page.getByRole("menu", { name: "Scripts" }).getByRole("menuitem", { name: "behaviors", exact: true }).click();
  await expect(page.getByRole("menu", { name: "behaviors" }).getByRole("menuitem", { name: "Bird" })).toBeVisible();
});

test("the keyboard opens, moves through and closes submenus", async ({ page }) => {
  await openMenu(page);
  await expect(search(page)).toBeFocused();
  await page.keyboard.press("ArrowRight"); // opens the first category, Rendering
  await expect(page.getByRole("menu", { name: "Rendering" })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("menu", { name: "Rendering" })).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("menu", { name: "Rendering" })).toBeVisible();
  await page.keyboard.press("Escape"); // closes one level
  await expect(page.getByRole("menu", { name: "Rendering" })).toHaveCount(0);
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter"); // adds the highlighted type
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator(".inspector-body .component")).toHaveCount(3); // Transform, BoxCollider2D, and the new one
  await openMenu2(page);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
});

async function openMenu2(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Add Component" }).click();
  await expect(dialog(page)).toBeVisible();
}

test("typing searches a flat list across all categories, showing each category", async ({ page }) => {
  await openMenu(page);
  await search(page).fill("nav");
  const options = dialog(page).getByRole("option");
  await expect(options.filter({ hasText: "NavAgent" })).toHaveAttribute("data-path", "Navigation");
  expect(await options.count()).toBeGreaterThan(3);
  await expect(dialog(page).getByRole("menu")).toHaveCount(0);
  await search(page).fill("");
  await expect(dialog(page).getByRole("menu", { name: "Component categories" })).toBeVisible();
});

test("recently added types appear at the top", async ({ page }) => {
  await openMenu(page);
  await search(page).fill("CircleCollider2D");
  await search(page).press("Enter");
  await expect(card(page, "CircleCollider2D")).toBeVisible();
  await openMenu2(page);
  const root = dialog(page).getByRole("menu", { name: "Component categories" });
  await expect(root.getByText("Recent", { exact: true })).toBeVisible();
  await expect(root.getByRole("menuitem").first()).toHaveText("CircleCollider2D");
});
