import { expect, test, type Page } from "@playwright/test";

// Appearance settings (theme presets, colour overrides, fonts) and branding (src/editor/theme.ts,
// ui/SettingsDialog.tsx, ui/StartBrand.tsx, ui/AboutDialog.tsx).

const EDITOR = "/editor.html?sample=flappy"; // relative to baseURL (E2E_PORT)

type Hooks = { engine?: { world: { time: { frameCount: number } } } };

async function openEditor(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

async function openAppearance(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("tab", { name: "Appearance" }).click();
  return dialog;
}

const rootVar = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const style = (page: Page, selector: string, prop: string) =>
  page.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

test("switching the theme preset recolours the editor live, and is remembered", async ({ page }) => {
  await openEditor(page);
  expect(await style(page, "body", "background-color")).toBe("rgb(8, 12, 13)"); // Myco Dark
  const dialog = await openAppearance(page);
  await dialog.getByLabel("Preset").selectOption({ label: "Myco Light" });
  await expect.poll(() => style(page, "body", "background-color")).toBe("rgb(233, 237, 230)");
  expect(await style(page, ".dock-group", "background-color")).toBe("rgb(247, 248, 243)");
  expect(await style(page, "body", "color")).toBe("rgb(22, 34, 33)");
  // The selected hierarchy row uses the theme's selection colour.
  await page.keyboard.press("Escape");
  await page.locator(`.tree .row[data-key="bird"]`).click();
  expect(await style(page, `.tree .row[data-key="bird"]`, "background-color")).toBe("rgb(200, 224, 221)");

  await page.reload();
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  expect(await style(page, "body", "background-color")).toBe("rgb(233, 237, 230)");
  expect(await page.evaluate(() => localStorage.getItem("myco.editor.theme"))).toBe('"myco-light"');

  const again = await openAppearance(page);
  await again.getByLabel("Preset").selectOption({ label: "High Contrast" });
  await expect.poll(() => style(page, "body", "background-color")).toBe("rgb(0, 0, 0)");
  expect(await rootVar(page, "--accent")).toBe("#00ffff");
});

test("a colour override applies live, is remembered, and resets", async ({ page }) => {
  await openEditor(page);
  const dialog = await openAppearance(page);
  await dialog.getByLabel("Accent colour", { exact: true }).fill("#ff8800");
  await expect.poll(() => rootVar(page, "--accent")).toBe("#ff8800");
  // The active tool button and the focus ring follow it.
  expect(await style(page, ".scene-toolbar button.active", "background-color")).toBe("rgb(255, 136, 0)");
  expect(await rootVar(page, "--focus-ring")).toBe("#ff8800");
  await expect(dialog.locator(".settings-color.changed")).toHaveCount(1);

  await page.reload();
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  expect(await rootVar(page, "--accent")).toBe("#ff8800");
  const again = await openAppearance(page);
  await again.getByRole("button", { name: "Reset colours" }).click();
  await expect.poll(() => rootVar(page, "--accent")).toBe("#2ad4d4");
  await expect(again.getByRole("button", { name: "Reset colours" })).toBeDisabled();
});

test("font settings apply to the UI and the Code panel's font, and are remembered", async ({ page }) => {
  await openEditor(page);
  const dialog = await openAppearance(page);
  const uiSize = dialog.getByRole("spinbutton", { name: /^UI font size/ });
  await uiSize.fill("16");
  await uiSize.press("Enter");
  await expect.poll(() => style(page, "body", "font-size")).toBe("16px");
  // Smaller labels scale with it: panel headers are 11px at the default 13px.
  expect(parseFloat(await style(page, ".dock-tab", "font-size"))).toBeCloseTo((11 * 16) / 13, 1);

  const codeSize = dialog.getByRole("spinbutton", { name: /^Code font size/ });
  await codeSize.fill("18");
  await codeSize.press("Enter");
  await expect.poll(() => rootVar(page, "--font-size-code")).toBe("18px");
  expect(await style(page, ".theme-preview-code", "font-size")).toBe("18px");

  await dialog.getByRole("combobox", { name: /^UI font/ }).selectOption({ label: "Custom…" });
  const family = dialog.getByRole("textbox", { name: "UI font family" });
  await family.fill("Georgia, serif");
  await family.press("Enter");
  await expect.poll(() => style(page, "body", "font-family")).toBe("Georgia, serif");

  await page.reload();
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  expect(await style(page, "body", "font-size")).toBe("16px");
  expect(await style(page, "body", "font-family")).toBe("Georgia, serif");
  const again = await openAppearance(page);
  await expect(again.getByRole("textbox", { name: "UI font family" })).toHaveValue("Georgia, serif");
  await again.getByRole("button", { name: "Reset fonts" }).click();
  await expect.poll(() => style(page, "body", "font-size")).toBe("13px");
});

test("the start screen shows the Myco Engine logo and the Foxfire Studios credit; About has the version", async ({ page }) => {
  await page.goto("/editor.html");
  const start = page.getByRole("dialog", { name: "Start" });
  const heading = start.getByRole("heading", { name: "Myco Engine", level: 1 });
  await expect(heading).toBeVisible();
  const logo = heading.getByRole("img", { name: "Myco Engine" });
  await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  await expect(start.locator(".start-footer")).toContainText("by Foxfire Studios");
  await expect(page).toHaveTitle(/Myco Engine/);
  expect(await page.locator('link[rel="icon"]').first().getAttribute("href")).toBeTruthy();

  await start.getByRole("button", { name: "About", exact: true }).click();
  const about = page.getByRole("dialog", { name: "About Myco Engine" });
  await expect(about).toContainText(/Version \d+\.\d+\.\d+/);
  await expect(about).toContainText("Foxfire Studios");
  await page.keyboard.press("Escape");
  await expect(about).toHaveCount(0);
  await expect(start).toBeVisible();
});

test("the toolbar's Myco icon opens About", async ({ page }) => {
  await openEditor(page);
  const brand = page.getByRole("button", { name: "About Myco Engine" });
  await expect(brand.locator("img")).toBeVisible();
  await brand.click();
  const about = page.getByRole("dialog", { name: "About Myco Engine" });
  await expect(about).toBeVisible();
  await about.getByRole("button", { name: "Close" }).click();
  await expect(about).toHaveCount(0);
});
