import { expect, test, type Page } from "@playwright/test";

const EDITOR = "/editor.html?sample=flappy"; // opens the Flappy sample (ADR 0031); relative to baseURL (E2E_PORT)

type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  openTestProject(extra: Record<string, string>): Promise<void>;
  testFolder: { read(path: string): string | undefined };
};

const LEVELS = `{ "speed": 4, "names": ["one", "two"] }\n`;
const RACER = `import { GameBehavior, behavior, field } from "myco";
import levels from "../data/levels.json";

@behavior("game.Racer")
export class Racer extends GameBehavior {
  @field(Number) speed = levels.speed;
}
`;

async function openProject(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await page.evaluate(
    ([levels, racer]) => (window as unknown as Hooks).openTestProject({ "data/levels.json": levels, "scripts/Racer.ts": racer, "tools/build.js": "console.log('build');\n" }),
    [LEVELS, RACER],
  );
}

const editor = (page: Page) => page.locator(".code-editor .monaco-editor");

async function typeAtEnd(page: Page, text: string): Promise<void> {
  const box = (await editor(page).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 8);
  await page.keyboard.insertText(text);
}

test("the code editor loads in the background, says when it's opening a file, and opens files quickly", async ({ page }) => {
  await openProject(page);
  // The TypeScript worker starts once the editor is idle (the project has a script).
  await page.waitForFunction(() => performance.getEntriesByType("resource").some((e) => /ts\.worker/.test(e.name)), null, { timeout: 20_000 });
  await page.evaluate(() => {
    (window as unknown as { overlaySeen: boolean }).overlaySeen = false;
    new MutationObserver(() => {
      if (document.querySelector(".code-loading")) (window as unknown as { overlaySeen: boolean }).overlaySeen = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.locator(".asset-folder", { hasText: /^data$/ }).click();
  const start = Date.now();
  await page.locator(".asset-tile", { hasText: "levels.json" }).dblclick();
  await expect(editor(page).locator(".view-lines")).toContainText('"speed": 4');
  expect(Date.now() - start).toBeLessThan(2000);
  await expect(page.locator(".code-loading")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { overlaySeen: boolean }).overlaySeen)).toBe(true);
});

test("JSON and JavaScript files open in the Code panel", async ({ page }) => {
  await openProject(page);
  await page.locator(".asset-folder", { hasText: /^data$/ }).click();
  await page.locator(".asset-tile", { hasText: "levels.json" }).dblclick();
  await expect(page.locator(".code-tab.active")).toContainText("levels.json");
  await expect(editor(page).locator(".view-lines")).toContainText('"speed": 4', { timeout: 20_000 });

  await page.locator(".dock-tab", { hasText: "Assets" }).click();
  await page.locator(".asset-folder", { hasText: /^tools$/ }).click();
  await page.locator(".asset-tile", { hasText: "build.js" }).dblclick();
  await expect(page.locator(".code-tab.active")).toContainText("build.js");
  await expect(editor(page).locator(".view-lines")).toContainText("console.log('build');");
  await typeAtEnd(page, "// edited\n");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".status-text")).toHaveText("Saved tools/build.js.");
  expect(await page.evaluate(() => (window as unknown as Hooks).testFolder.read("tools/build.js"))).toContain("// edited");
});

test("scripts import JSON with its types, and JSON is only saved when it parses", async ({ page }) => {
  await openProject(page);
  await page.locator(".asset-folder", { hasText: /^scripts$/ }).click();
  await page.locator(".asset-tile", { hasText: "Racer.ts" }).dblclick();
  await expect(editor(page).locator(".view-lines")).toContainText("levels.speed", { timeout: 20_000 });
  // The import resolves: no errors once the TypeScript service has checked it (the overview ruler shows any, scrolled or not).
  await page.waitForTimeout(3000);
  await expect(editor(page).locator(".squiggly-error")).toHaveCount(0);
  await typeAtEnd(page, "\nexport const wrong: string = levels.speed;\n"); // a number, typed from the JSON
  await expect(editor(page).locator(".squiggly-error").first()).toBeVisible({ timeout: 15_000 });

  await page.locator(".dock-tab", { hasText: "Assets" }).click();
  await page.locator(".asset-folder", { hasText: /^data$/ }).click();
  await page.locator(".asset-tile", { hasText: "levels.json" }).dblclick();
  await expect(editor(page).locator(".view-lines")).toContainText('"speed": 4', { timeout: 20_000 });
  await typeAtEnd(page, "oops");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".status-text")).toContainText("isn't valid JSON, so it wasn't saved");
  expect(await page.evaluate(() => (window as unknown as Hooks).testFolder.read("data/levels.json"))).not.toContain("oops");
});
