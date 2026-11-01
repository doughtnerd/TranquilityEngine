import { expect, test, type Page } from "@playwright/test";

const EDITOR = "http://localhost:4174/editor.html";

/** The editor's debug hooks on `window` (see session.ts). Page callbacks are serialized, so each casts `window` itself. */
type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  openTestProject(extra: Record<string, string>): Promise<void>;
  testFolder: { read(path: string): string | undefined };
};

const WHEEL = `import { GameBehavior, behavior, field } from "tranquility";
import { spin } from "./util";

@behavior("game.Wheel")
export class Wheel extends GameBehavior {
  @field(Number) speed = 1;

  update(): void {
    spin(this.transform, this.speed);
  }
}
`;
const UTIL = `import type { Transform } from "tranquility";

export function spin(t: Transform, degrees: number): void {
  t.rotate2D(degrees);
}
`;

/** Open the demo as a project folder with two scripts, and the Assets panel's scripts folder. */
async function openProject(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await page.evaluate(([wheel, util]) => (window as unknown as Hooks).openTestProject({ "scripts/Wheel.ts": wheel, "scripts/util.ts": util }), [WHEEL, UTIL]);
  await page.locator(".asset-folder", { hasText: /^scripts$/ }).click();
}

const editor = (page: Page) => page.locator(".code-editor .monaco-editor");

/**
 * Put the caret at the end of the script and type `text`. Clicks below the last line rather than
 * pressing Ctrl+End, which Playwright's WebKit build sends as if on a Mac.
 */
async function typeAtEnd(page: Page, text: string): Promise<void> {
  const box = (await editor(page).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 8);
  await page.keyboard.insertText(text);
}

const tab = (page: Page, name: string) => page.locator(".code-tab", { hasText: name });

test("double-clicking a script opens it in the Code panel, typed against the engine and the other scripts", async ({ page }) => {
  await openProject(page);
  await page.locator(".asset-tile", { hasText: "Wheel.ts" }).dblclick();
  await expect(page.locator(".dock-tab.active", { hasText: "Code" })).toBeVisible();
  await expect(tab(page, "Wheel.ts")).toHaveClass(/active/);
  await expect(editor(page).locator(".view-lines")).toContainText("export class Wheel extends GameBehavior", { timeout: 20_000 });
  // No errors: "tranquility" and "./util" both resolve. A mistake gets squiggled.
  await page.waitForTimeout(1500);
  await expect(editor(page).locator(".squiggly-error")).toHaveCount(0);
  await typeAtEnd(page, "\nconst broken: number = this.nope;");
  await expect(editor(page).locator(".squiggly-error").first()).toBeVisible({ timeout: 15_000 });
});

test("editing marks the tab; Ctrl+S saves the script, reloads scripts and leaves the scene alone", async ({ page }) => {
  await openProject(page);
  await page.locator(".asset-tile", { hasText: "Wheel.ts" }).dblclick();
  await expect(editor(page).locator(".view-lines")).toContainText("speed = 1", { timeout: 20_000 });
  await typeAtEnd(page, "// saved from the Code panel");
  await expect(tab(page, "Wheel.ts").locator(".code-tab-dirty")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+s");
  await expect(tab(page, "Wheel.ts").locator(".code-tab-dirty")).toHaveCount(0);
  await expect(page.locator(".status-text")).toHaveText("Reloaded 2 scripts.");
  expect(await page.evaluate(() => (window as unknown as Hooks).testFolder.read("scripts/Wheel.ts"))).toContain("// saved from the Code panel");
});

test("closing a tab with unsaved edits asks first", async ({ page }) => {
  await openProject(page);
  await page.locator(".asset-tile", { hasText: "util.ts" }).dblclick();
  await expect(editor(page).locator(".view-lines")).toContainText("rotate2D", { timeout: 20_000 });
  await editor(page).click();
  await page.keyboard.type("x");
  await page.getByRole("button", { name: "Close util.ts" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("unsaved changes");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(tab(page, "util.ts")).toBeVisible();
  await page.getByRole("button", { name: "Close util.ts" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard changes" }).click();
  await expect(tab(page, "util.ts")).toHaveCount(0);
});

test("a script component's card opens its script", async ({ page }) => {
  await openProject(page);
  await page.locator('.tree .row[data-key="ceiling"]').click();
  await page.locator(".dock-tab", { hasText: "Inspector" }).click();
  await page.getByRole("button", { name: "Add Component" }).click();
  await page.getByRole("dialog", { name: "Add component" }).getByRole("option", { name: "Wheel" }).click();
  await page.getByRole("button", { name: "Open Wheel script" }).click();
  await expect(tab(page, "Wheel.ts")).toHaveClass(/active/);
  await expect(page.getByRole("button", { name: "Open Transform script" })).toHaveCount(0);
});
