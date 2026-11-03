import { expect, test, type Page } from "@playwright/test";
import { installFakeFolders, listFolder, nextFolder, readFile, removeFile, removeFolderPicker } from "./fakeFolders";

// Projects in the browser editor (ADR 0038): New Project, Open Project, recent projects and Make a
// Copy write real folders through the File System Access API. Playwright can't drive the native
// picker, so `showDirectoryPicker` is replaced with in-memory folders (fakeFolders.ts).
const START = "/editor.html"; // relative to baseURL (E2E_PORT)

test.describe.configure({ timeout: 60_000 }); // WebKit renders on the CPU: the longer tests take 15–25 s there

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

const start = (page: Page) => page.getByRole("dialog", { name: "Start" });
const treeRow = (page: Page, name: string) => page.locator(".tree .row .name", { hasText: new RegExp(`^${name}$`) });

async function createProject(page: Page, name: string, folder: string, template: "Empty 2D" | "Empty 3D" = "Empty 2D"): Promise<void> {
  await start(page).getByRole("button", { name: "New Project…" }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByRole("textbox", { name: "Project name" }).fill(name);
  await dialog.getByRole("radio", { name: new RegExp(template) }).check();
  await expect(dialog.getByRole("button", { name: "Create" })).toBeDisabled(); // no location yet
  await nextFolder(page, folder);
  await dialog.getByRole("button", { name: "Choose…" }).click();
  await expect(dialog.locator(".new-project-path")).toHaveText(`/${folder}`);
  await expect(dialog.locator(".new-project-preview")).toHaveText(`Creates /${folder}/${name}`);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(start(page)).toHaveCount(0);
}

test("New Project creates a project folder, opens it, and saves edits back to it", async ({ page }) => {
  const errors = trackErrors(page);
  await installFakeFolders(page);
  await page.goto(START);
  await createProject(page, "Space Game", "Games");

  await expect(page.locator(".project-name")).toHaveText("Space Game");
  await expect(treeRow(page, "Camera")).toHaveCount(1);
  const files = await listFolder(page, "Games");
  expect(files).toEqual(expect.arrayContaining(["Space Game/project.json", "Space Game/scenes/main.scene.json", "Space Game/tsconfig.json", "Space Game/.gitignore", "Space Game/.myco/types/myco/index.d.ts"]));
  expect(JSON.parse((await readFile(page, "Games/Space Game/project.json"))!)).toMatchObject({ name: "Space Game", display: { width: 1280, height: 720 } });

  // A scene edit saves into the folder.
  await treeRow(page, "Camera").click();
  await page.locator(".inspector").getByRole("checkbox", { name: "Active" }).first().uncheck();
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(async () => JSON.parse((await readFile(page, "Games/Space Game/scenes/main.scene.json"))!).nodes[0].active).toBe(false);
  // The edit history is kept in the folder too (ADR 0027).
  await expect.poll(async () => (await listFolder(page, "Games")).some((f) => f.startsWith("Space Game/.myco/history/"))).toBe(true);
  expect(errors).toEqual([]);
});

test("a new project refuses a folder that's already there and not empty", async ({ page }) => {
  await installFakeFolders(page, { Games: { "Taken/notes.txt": "mine" } });
  await page.goto(START);
  await start(page).getByRole("button", { name: "New Project…" }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByRole("textbox", { name: "Project name" }).fill("Taken");
  await nextFolder(page, "Games");
  await dialog.getByRole("button", { name: "Choose…" }).click();
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog.locator(".new-project-preview")).toContainText("isn't empty");
  await dialog.getByRole("textbox", { name: "Project name" }).fill("a/b");
  await expect(dialog.locator(".new-project-preview")).toContainText("can't contain");
  await expect(dialog.getByRole("button", { name: "Create" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});

test("recent projects: reopen, missing folders, remove from the list", async ({ page }) => {
  const errors = trackErrors(page);
  await installFakeFolders(page, {
    Existing: { "project.json": '{ "name": "Existing" }\n', "scenes/main.scene.json": '{ "format": "myco.scene@1", "nodes": [] }\n' },
  });
  await page.goto(START);
  // Open Project… picks a folder that holds a project.
  await nextFolder(page, "Existing");
  await start(page).getByRole("button", { name: "Open Project…" }).click();
  await expect(page.locator(".project-name")).toHaveText("Existing");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await createProject(page, "Second", "Games");
  await page.getByRole("button", { name: "Close", exact: true }).click();

  const recent = start(page).getByRole("list", { name: "Recent projects" });
  await expect(recent.locator(".recent-name")).toHaveText(["Second", "Existing"]);
  // Reopen.
  await recent.getByRole("button", { name: /^Existing/ }).click();
  await expect(page.locator(".project-name")).toHaveText("Existing");
  // The Project menu lists the other recent project.
  await page.getByRole("button", { name: "Project ▾" }).click();
  await expect(page.getByRole("menu", { name: "Project" }).getByRole("menuitem", { name: "Second" })).toBeVisible();
  // A folder that loses its project.json shows as missing.
  await removeFile(page, "Games/Second/project.json");
  await page.getByRole("menu", { name: "Project" }).getByRole("menuitem", { name: "Close Project" }).click();
  await expect(recent.locator(".recent-name")).toHaveText(["Existing", "Second"]);
  await expect(recent.locator('.recent[data-state="missing"] .recent-name')).toHaveText(["Second"]);
  await expect(recent.locator(".recent.missing .recent-state")).toHaveText("Missing");
  await expect(recent.getByRole("button", { name: /^Second/ })).toBeDisabled();
  await recent.getByRole("button", { name: "Remove Second from recent projects" }).click();
  await expect(recent.locator(".recent-name")).toHaveText(["Existing"]);
  expect(errors).toEqual([]);
});

test("Make a Copy writes a sample into a folder and opens the copy for editing", async ({ page }) => {
  const errors = trackErrors(page);
  await installFakeFolders(page);
  await page.goto(START);
  const sample = start(page).locator(".sample", { hasText: "Flappy Bird" });
  await nextFolder(page, "MyFlappy");
  await sample.getByRole("button", { name: "Make a Copy…" }).click();
  await expect(page.locator(".project-name")).toHaveText("flappy");
  await expect(treeRow(page, "Bird")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Reload Scripts" })).toBeVisible(); // a folder project
  const files = await listFolder(page, "MyFlappy");
  expect(files).toEqual(expect.arrayContaining(["project.json", "scenes/main.scene.json", "images/flappyBird.png"]));
  expect(files.some((f) => f.startsWith("scripts/"))).toBe(true);
  expect(errors).toEqual([]);
});

test("cancelling the folder picker changes nothing", async ({ page }) => {
  await installFakeFolders(page);
  await page.goto(START);
  await nextFolder(page, null);
  await start(page).getByRole("button", { name: "Open Project…" }).click();
  await expect(start(page)).toBeVisible();
  await expect(page.locator(".project-name")).toHaveText("No project");
});

test("without a folder picker (Safari, Firefox) the start screen says so and samples stay read-only", async ({ page }) => {
  await removeFolderPicker(page);
  await page.goto(START);
  await expect(start(page).getByRole("button", { name: "New Project…" })).toBeDisabled();
  await expect(start(page).getByRole("button", { name: "Open Project…" })).toBeDisabled();
  await expect(start(page)).toContainText("can't open project folders");
  const sample = start(page).locator(".sample", { hasText: "Flappy Bird" });
  await expect(sample.getByRole("button", { name: "Open" })).toBeEnabled();
  await expect(sample.getByRole("button", { name: "Make a Copy…" })).toHaveCount(0);
});
