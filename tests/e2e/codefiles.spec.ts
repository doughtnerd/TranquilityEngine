import { expect, openTestProject, type Page, test } from "./fixtures";


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

// A Node tool the project depends on (like samples/pirates/tools/*.mjs): edited, never loaded as a script.
const TOOL = `import { writeFileSync } from "node:fs";
writeFileSync("data/out.json", JSON.stringify({ ok: true }));
`;

async function openProject(page: Page): Promise<void> {
  await openTestProject(page, { "data/levels.json": LEVELS, "scripts/Racer.ts": RACER, "tools/build.js": "console.log('build');\n", "tools/generate.mjs": TOOL, "tools/README.md": "# Tools\n\nRun `node tools/generate.mjs`.\n" });
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

// Their highlighting language (codeLanguageOf) is unit-tested: Monaco tokenizes when the page is idle, which a rendering headless page rarely is.
test("tool modules (.mjs) and Markdown are listed, open in the Code panel, and save", async ({ page }) => {
  await openProject(page);
  await page.locator(".asset-folder", { hasText: /^tools$/ }).click();
  await expect(page.locator(".asset-tile", { hasText: "generate.mjs" })).toContainText("JS");
  await expect(page.locator(".asset-tile", { hasText: "README.md" })).toContainText("Text");
  await page.locator(".asset-tile", { hasText: "generate.mjs" }).dblclick();
  await expect(page.locator(".code-tab.active")).toContainText("generate.mjs");
  await expect(editor(page).locator(".view-lines")).toContainText("writeFileSync", { timeout: 20_000 });
  await typeAtEnd(page, "// edited\n");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".status-text")).toHaveText("Saved tools/generate.mjs.");
  expect(await page.evaluate(() => (window as unknown as Hooks).testFolder.read("tools/generate.mjs"))).toContain("// edited");
  // It isn't a script: no script problems from its Node import.
  await expect(page.locator(".status-text")).not.toContainText("node:fs");

  await page.locator(".dock-tab", { hasText: "Assets" }).click();
  await page.locator(".asset-tile", { hasText: "README.md" }).dblclick();
  await expect(page.locator(".code-tab.active")).toContainText("README.md");
  await expect(editor(page).locator(".view-lines")).toContainText("# Tools");
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
