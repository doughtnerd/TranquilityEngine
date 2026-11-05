import { expect, test, type Page } from "@playwright/test";

// ADR 0042: list fields, dropdowns, Euler-angle quaternions, a component's Worlds and node tags in the Inspector.

const EDITOR = "/editor.html?sample=flappy"; // opens the Flappy sample (ADR 0031); relative to baseURL (E2E_PORT)

type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  openTestProject(extra: Record<string, string>): Promise<void>;
};

const ROUTE = `import { GameBehavior, GameObject, Quaternion, Vector2, behavior, field } from "myco";

@behavior("game.Route")
export class Route extends GameBehavior {
  @field([Number]) weights: number[] = [];
  @field([Vector2]) points: Vector2[] = [];
  @field([GameObject]) stops: (GameObject | null)[] = [];
  @field([String], { choices: ["slow", "fast"] }) speeds: string[] = [];
  @field(Quaternion) facing = new Quaternion();
}
`;

async function openEditor(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

/** Open the sample as a project folder with the Route script, so its component can be added. */
async function openProject(page: Page): Promise<void> {
  await openEditor(page);
  await page.evaluate((route) => (window as unknown as Hooks).openTestProject({ "scripts/Route.ts": route }), ROUTE);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

const row = (page: Page, key: string) => page.locator(`.tree .row[data-key="${key}"]`);
const card = (page: Page, name: string) => page.locator(".inspector-body .component", { has: page.locator("h3", { hasText: name }) });

async function addRoute(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Add Component" }).click();
  await page.getByRole("searchbox", { name: "Search components" }).fill("Route");
  await page.getByRole("dialog", { name: "Add component" }).getByRole("option", { name: "Route" }).click();
  await expect(card(page, "Route")).toBeVisible();
}

test("enum-like engine fields are dropdowns; sorting layers come from the project", async ({ page }) => {
  await openEditor(page);
  await row(page, "bird").click();
  const bodyType = card(page, "RigidBody2D").getByRole("combobox", { name: "bodyType" });
  await expect(bodyType.locator("option")).toHaveText(["dynamic", "kinematic", "static"]);
  await bodyType.selectOption("kinematic");
  await expect(bodyType.locator("option:checked")).toHaveText("kinematic");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(bodyType.locator("option:checked")).toHaveText("dynamic");

  await row(page, "bird-sprite").click();
  const layer = card(page, "SpriteRenderer").getByRole("combobox", { name: "sortingLayer" });
  await expect(layer.locator("option")).toHaveText(["Background", "Pipes", "Default", "Foreground", "Player"]);
  await expect(layer.locator("option:checked")).toHaveText("Player");
});

test("list fields add, edit, reorder and remove items, each one undo step", async ({ page }) => {
  test.setTimeout(60_000); // opening a project compiles its scripts
  await openProject(page);
  await row(page, "ceiling").click();
  await addRoute(page);
  const route = card(page, "Route");
  const weights = route.getByRole("group", { name: "Weights list" });
  await expect(weights).toContainText("0 items");
  await route.getByRole("button", { name: "Add weights item" }).click();
  await expect(weights).toContainText("1 item");
  await weights.getByRole("textbox", { name: "weights[0]" }).fill("5");
  await weights.getByRole("textbox", { name: "weights[0]" }).press("Enter");
  await route.getByRole("button", { name: "Add weights item" }).click(); // repeats the last item
  await expect(weights.getByRole("textbox", { name: "weights[1]" })).toHaveValue("5");
  await weights.getByRole("textbox", { name: "weights[1]" }).fill("7");
  await weights.getByRole("textbox", { name: "weights[1]" }).press("Enter");
  await route.getByRole("button", { name: "Move weights item 1 up" }).click();
  await expect(weights.getByRole("textbox", { name: "weights[0]" })).toHaveValue("7");
  await expect(weights.getByRole("textbox", { name: "weights[1]" })).toHaveValue("5");
  await route.getByRole("button", { name: "Remove weights item 0" }).click();
  await expect(weights).toContainText("1 item");
  await expect(weights.getByRole("textbox", { name: "weights[0]" })).toHaveValue("5");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(weights.getByRole("textbox", { name: "weights[0]" })).toHaveValue("7");
});

test("list items of vectors, nodes and choices use their own editors; a quaternion edits as degrees", async ({ page }) => {
  test.setTimeout(60_000); // opening a project compiles its scripts
  await openProject(page);
  await row(page, "ceiling").click();
  await addRoute(page);
  const route = card(page, "Route");
  await route.getByRole("button", { name: "Add points item" }).click();
  await route.getByRole("textbox", { name: "points[0] y" }).fill("3");
  await route.getByRole("textbox", { name: "points[0] y" }).press("Enter");
  await expect(route.getByRole("textbox", { name: "points[0] y" })).toHaveValue("3");
  await route.getByRole("button", { name: "Add stops item" }).click();
  await route.getByRole("combobox", { name: "stops[0]" }).selectOption({ label: "Bird" });
  await expect(route.getByRole("combobox", { name: "stops[0]" }).locator("option:checked")).toHaveText("Bird");
  await route.getByRole("button", { name: "Add speeds item" }).click();
  await expect(route.getByRole("combobox", { name: "speeds[0]" }).locator("option:checked")).toHaveText("slow");

  // A quaternion edits as Euler degrees.
  await route.getByRole("textbox", { name: "facing z" }).fill("45");
  await route.getByRole("textbox", { name: "facing z" }).press("Enter");
  await expect(route.getByRole("textbox", { name: "facing z" })).toHaveValue("45");
});

test("with several nodes, lists that differ show a dash and an edit replaces each list", async ({ page }) => {
  test.setTimeout(60_000); // opening a project compiles its scripts
  await openProject(page);
  await row(page, "ceiling").click();
  await row(page, "ground-collider").click({ modifiers: ["ControlOrMeta"] });
  await addRoute(page);
  await card(page, "Route").getByRole("button", { name: "Add weights item" }).click();
  await row(page, "ceiling").click();
  await card(page, "Route").getByRole("button", { name: "Add weights item" }).click();
  await row(page, "ground-collider").click({ modifiers: ["ControlOrMeta"] }); // active: ground-collider, 1 item
  const weights = card(page, "Route").getByRole("group", { name: "Weights list" });
  await expect(weights).toContainText("lists differ");
  await card(page, "Route").getByRole("button", { name: "Add weights item" }).click();
  await expect(weights).toContainText("2 items"); // both now hold the active node's list plus one
  await row(page, "ceiling").click();
  await expect(card(page, "Route").getByRole("group", { name: "Weights list" })).toContainText("2 items");
});

test("a component's Worlds are set from its header menu and shown as a badge", async ({ page }) => {
  await openEditor(page);
  await row(page, "bird").click();
  const body = card(page, "RigidBody2D");
  await body.getByRole("button", { name: "RigidBody2D options" }).click();
  const menu = page.getByRole("dialog", { name: "Worlds for RigidBody2D" });
  await menu.getByRole("checkbox", { name: "World tag server" }).check();
  await expect(body.locator(".worlds-badge")).toHaveText("server");
  await menu.getByRole("checkbox", { name: "World tag client" }).check();
  await expect(body.locator(".worlds-badge")).toHaveText("server, client");
  await menu.getByRole("button", { name: /Use default/ }).click();
  await expect(body.locator(".worlds-badge")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(body.locator(".worlds-badge")).toHaveText("server, client");

  // On a prefab instance it's an override.
  await row(page, "bg-a").click();
  await expect(page.locator(".override-count")).toHaveText("No overrides");
  await card(page, "SpriteRenderer").getByRole("button", { name: "SpriteRenderer options" }).click();
  await page.getByRole("dialog", { name: "Worlds for SpriteRenderer" }).getByRole("checkbox", { name: "World tag client" }).check();
  await expect(card(page, "SpriteRenderer").locator(".worlds-badge")).toHaveText("client");
  await expect(page.locator(".override-count")).toHaveText("1 override");
});

test("node tags show as chips that can be added and removed", async ({ page }) => {
  await openEditor(page);
  await row(page, "bird").click();
  const tags = page.getByRole("group", { name: "Tags" });
  await expect(tags.locator(".tag-chip .tag-name")).toHaveText(["Player"]);
  await tags.getByRole("textbox", { name: "Add tag" }).fill("hero");
  await tags.getByRole("textbox", { name: "Add tag" }).press("Enter");
  await expect(tags.locator(".tag-chip .tag-name")).toHaveText(["Player", "hero"]);
  await tags.getByRole("button", { name: "Remove tag Player" }).click();
  await expect(tags.locator(".tag-chip .tag-name")).toHaveText(["hero"]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(tags.locator(".tag-chip .tag-name")).toHaveText(["Player", "hero"]);

  // On a prefab instance the tags are an override, which ↺ reverts.
  await row(page, "bg-a").click();
  await tags.getByRole("textbox", { name: "Add tag" }).fill("scenery");
  await tags.getByRole("textbox", { name: "Add tag" }).press("Enter");
  await expect(tags.locator(".tag-chip .tag-name")).toHaveText(["scenery"]);
  await tags.getByRole("button", { name: "Revert tags" }).click();
  await expect(tags.locator(".tag-chip .tag-name")).toHaveCount(0);
});
