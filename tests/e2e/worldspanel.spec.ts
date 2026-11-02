import { expect, test, type Page } from "@playwright/test";

// The Worlds panel (ADR 0032) on a writable in-memory copy of the demo project: building a
// client + server layout writes project.json's bootstrap section, and undo takes it back.
const EDITOR = "/editor.html?sample=flappy"; // opens the Flappy sample (ADR 0031); relative to baseURL (E2E_PORT)

type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  openTestProject(extra: Record<string, string>): Promise<void>;
  testFolder: { read(path: string): string | undefined };
};

async function openProject(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await page.evaluate(() => (window as unknown as Hooks).openTestProject({}));
  await page.getByRole("tab", { name: /^Worlds/ }).click();
}

const panel = (page: Page) => page.locator(".panel.worlds");
const read = (page: Page, path: string) => page.evaluate((p) => (window as unknown as Hooks).testFolder.read(p), path);
const bootstrap = async (page: Page) => JSON.parse((await read(page, "project.json"))!).bootstrap;

test("building a client + server layout writes project.json, and Ctrl+Z undoes it", async ({ page }) => {
  await openProject(page);
  const p = panel(page);
  await expect(p.locator('.worlds-node[data-world="Default"]')).toBeVisible();
  await expect(p.locator(".worlds-status")).toHaveText("Default bootstrap");
  expect(await bootstrap(page)).toBeUndefined();

  // A Server World tagged server.
  await p.getByRole("button", { name: "+ World" }).click();
  await p.getByRole("textbox", { name: "World name" }).fill("Server");
  await p.getByRole("textbox", { name: "World name" }).press("Enter");
  await p.getByRole("button", { name: "Add tag server" }).click();
  await expect(p.locator('.worlds-node[data-world="Server"] .worlds-chip')).toHaveText(["server"]);
  await expect(p.locator(".worlds-status")).toHaveText("Saved");
  await expect.poll(() => bootstrap(page)).toEqual({
    worlds: [
      { name: "Default", tags: ["default", "local"] },
      { name: "Server", tags: ["server"] },
    ],
  });

  // Default → Server over loopback.
  await p.getByRole("button", { name: "+ Link" }).click();
  await expect(p.getByRole("combobox", { name: "Link 1 from" })).toHaveValue("Default");
  await expect(p.getByRole("combobox", { name: "Link 1 to" })).toHaveValue("Server");
  await p.getByRole("combobox", { name: "Link 1 transport" }).selectOption("loopback");
  await expect(p.locator(".worlds-link text")).toHaveText(["loopback"]);
  await expect.poll(async () => (await bootstrap(page)).links).toEqual([{ from: "Default", to: "Server", transport: "loopback" }]);

  // The server leaves out physics stepping.
  const physics = p.locator('.worlds-system[data-system="engine.PhysicsStep"]');
  await expect(physics.locator(".worlds-system-reason")).toHaveText("every World (engine)");
  await physics.getByRole("checkbox").uncheck();
  await expect(physics.locator(".worlds-system-reason")).toHaveText("excluded here");
  await expect.poll(async () => (await bootstrap(page)).worlds[1]).toEqual({ name: "Server", tags: ["server"], systems: { exclude: ["engine.PhysicsStep"] } });

  // The rest of the file keeps its text.
  const text = (await read(page, "project.json"))!;
  expect(text).toContain('"gravity": [0, -32]');
  expect(text).toMatch(/\}\r?\n$/);
  if (text.includes("\r\n")) expect(text).not.toMatch(/[^\r]\n/); // a Windows checkout keeps its line endings

  // Ctrl+Z in the panel undoes the panel's edit (not the scene's).
  await page.keyboard.press("ControlOrMeta+z");
  await expect(physics.getByRole("checkbox")).toBeChecked();
  await expect.poll(async () => (await bootstrap(page)).worlds[1]).toEqual({ name: "Server", tags: ["server"] });
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(physics.getByRole("checkbox")).not.toBeChecked();
});

test("an invalid edit stays unsaved, with its problem shown, until it's fixed", async ({ page }) => {
  await openProject(page);
  const p = panel(page);
  await p.getByRole("button", { name: "+ World" }).click();
  await expect.poll(async () => (await bootstrap(page))?.worlds.length).toBe(2);
  await p.getByRole("textbox", { name: "World name" }).fill("Default");
  await p.getByRole("textbox", { name: "World name" }).press("Enter");
  await expect(p.locator(".worlds-status")).toHaveText(/Not saved: 1 problem/);
  await expect(p.locator(".worlds-details .worlds-problems")).toContainText('another World is already named "Default"');
  expect((await bootstrap(page)).worlds.map((w: { name: string }) => w.name)).toEqual(["Default", "World"]);

  await p.getByRole("textbox", { name: "World name" }).fill("Server");
  await p.getByRole("textbox", { name: "World name" }).press("Enter");
  await expect(p.locator(".worlds-status")).toHaveText("Saved");
  await expect.poll(async () => (await bootstrap(page)).worlds.map((w: { name: string }) => w.name)).toEqual(["Default", "Server"]);
});

test("the read-only sample shows its Worlds without editing", async ({ page }) => {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await page.getByRole("tab", { name: /^Worlds/ }).click();
  const p = panel(page);
  await expect(p.locator('.worlds-node[data-world="Default"]')).toBeVisible();
  await expect(p.locator(".worlds-status")).toHaveText("Read-only");
  await expect(p.getByRole("button", { name: "+ World" })).toBeDisabled();
  await expect(p.getByRole("textbox", { name: "World name" })).toBeDisabled();
});
