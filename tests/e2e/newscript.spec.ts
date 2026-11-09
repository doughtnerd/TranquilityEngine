import { expect, openTestProject, type Page, test } from "./fixtures";


type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  openTestProject(extra: Record<string, string>): Promise<void>;
  testFolder: { read(path: string): string | undefined };
};

const WHEEL = `import { GameBehavior, behavior, field } from "myco";
@behavior("game.Wheel")
export class Wheel extends GameBehavior {
  @field(Number) speed = 1;
}
`;

async function openProject(page: Page): Promise<void> {
  await openTestProject(page, { "scripts/Wheel.ts": WHEEL });
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "New script" });
const read = (page: Page, path: string) => page.evaluate((p) => (window as unknown as Hooks).testFolder.read(p), path);

test("New Script in the Assets panel writes a script from a template and opens it", async ({ page }) => {
  await openProject(page);
  await page.getByRole("button", { name: "New Script" }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole("radio")).toHaveCount(3); // script, data component, system
  const name = dialog(page).getByRole("textbox", { name: "Script name" });
  await expect(name).toBeFocused();

  await name.fill("wheel");
  await expect(dialog(page)).toContainText("scripts/Wheel.ts already exists.");
  await expect(dialog(page).getByRole("button", { name: "Create" })).toBeDisabled();

  await name.fill("enemy spawner");
  await expect(dialog(page)).toContainText("scripts/EnemySpawner.ts · registers game.EnemySpawner");
  await name.press("Enter");
  await expect(dialog(page)).toHaveCount(0);

  await expect(page.locator(".status-text")).toHaveText("Created scripts/EnemySpawner.ts.");
  await expect(page.locator(".code-tab.active")).toContainText("EnemySpawner.ts");
  await expect(page.locator(".code-editor .view-lines")).toContainText('@behavior("game.EnemySpawner")', { timeout: 20_000 });
  expect(await read(page, "scripts/EnemySpawner.ts")).toContain("export class EnemySpawner extends GameBehavior");
});

test("New script… in Add Component creates a component and adds it to the selected nodes", async ({ page }) => {
  await openProject(page);
  await page.locator('.tree .row[data-key="ceiling"]').click();
  await page.locator('.tree .row[data-key="ground-collider"]').click({ modifiers: ["ControlOrMeta"] });
  await page.locator(".dock-tab", { hasText: "Inspector" }).click();
  await page.getByRole("button", { name: "Add Component" }).click();
  await page.getByRole("button", { name: "New script…" }).click();
  await expect(dialog(page).getByRole("radio")).toHaveCount(2); // nodes can't take a system
  await dialog(page).getByRole("radio", { name: "Data component" }).check();
  await dialog(page).getByRole("textbox", { name: "Script name" }).fill("Heat");
  await dialog(page).getByRole("button", { name: "Create" }).click();

  await expect(page.locator(".status-text")).toHaveText("Created scripts/Heat.ts and added Heat.");
  await page.locator(".dock-tab", { hasText: "Inspector" }).click();
  await expect(page.locator(".multi-name")).toHaveText("2 nodes selected");
  await expect(page.locator(".inspector-body .component h3", { hasText: "Heat" })).toBeVisible(); // shared by both
  expect(await read(page, "scripts/Heat.ts")).toContain('defineComponent("game.Heat"');
});

test("Escape cancels without writing anything", async ({ page }) => {
  await openProject(page);
  await page.getByRole("button", { name: "New Script" }).click();
  await dialog(page).getByRole("textbox", { name: "Script name" }).fill("Nope");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  expect(await read(page, "scripts/Nope.ts")).toBeUndefined();
});
