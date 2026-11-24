import { expect, openEditor, type Page, test, type Hooks } from "./fixtures";
import { showTab } from "./tabs";

// The Worlds panel (ADR 0032) on a writable in-memory copy of the demo project: building a
// client + server layout writes project.json's bootstrap section, and undo takes it back.

async function openProject(page: Page): Promise<void> {
  await openEditor(page, { files: {} });
  await showTab(page, /^Worlds/);
}

const panel = (page: Page) => page.locator(".panel.worlds");
const read = (page: Page, path: string) => page.evaluate((p) => (window as unknown as Hooks).testFolder.read(p), path);
const bootstrap = async (page: Page) => JSON.parse((await read(page, "project.json"))!).bootstrap;

test("building a client + server layout writes project.json, and Ctrl+Z undoes it", async ({ page }) => {
  await openProject(page);
  const p = panel(page);
  await expect(p.locator('.worlds-node[data-world="Default"]')).toBeVisible();
  await expect(p.locator(".section-status")).toHaveText("Default bootstrap");
  expect(await bootstrap(page)).toBeUndefined();

  // A Server World tagged server.
  await p.getByRole("button", { name: "+ World" }).click();
  await p.getByRole("textbox", { name: "World name" }).fill("Server");
  await p.getByRole("textbox", { name: "World name" }).press("Enter");
  await p.getByRole("button", { name: "Add tag server" }).click();
  await expect(p.locator('.worlds-node[data-world="Server"] .worlds-chip')).toHaveText(["server"]);
  await expect(p.locator(".section-status")).toHaveText("Saved");
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

  // Link options: collapsed until opened; setting latencyMs writes options.
  await p.locator("[data-link-options] summary").click();
  await p.getByRole("textbox", { name: "Link 1 latencyMs" }).fill("80");
  await p.getByRole("textbox", { name: "Link 1 latencyMs" }).press("Enter");
  await expect(p.locator("[data-link-options] summary")).toHaveText("Options (1)");
  await expect.poll(async () => (await bootstrap(page)).links).toEqual([{ from: "Default", to: "Server", transport: "loopback", options: { latencyMs: 80 } }]);
  await p.getByRole("textbox", { name: "Link 1 latencyMs" }).fill("");
  await p.getByRole("textbox", { name: "Link 1 latencyMs" }).press("Enter");
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
  await expect(p.locator(".section-status")).toHaveText(/Not saved: 1 problem/);
  await expect(p.locator(".worlds-details .worlds-problems")).toContainText('another World is already named "Default"');
  expect((await bootstrap(page)).worlds.map((w: { name: string }) => w.name)).toEqual(["Default", "World"]);

  await p.getByRole("textbox", { name: "World name" }).fill("Server");
  await p.getByRole("textbox", { name: "World name" }).press("Enter");
  await expect(p.locator(".section-status")).toHaveText("Saved");
  await expect.poll(async () => (await bootstrap(page)).worlds.map((w: { name: string }) => w.name)).toEqual(["Default", "Server"]);
});

test("the read-only sample shows its Worlds without editing", async ({ page }) => {
  await openEditor(page, { sample: "flappy" });
  await showTab(page, /^Worlds/);
  const p = panel(page);
  await expect(p.locator('.worlds-node[data-world="Default"]')).toBeVisible();
  await expect(p.locator(".section-status")).toHaveText("Read-only");
  await expect(p.getByRole("button", { name: "+ World" })).toBeDisabled();
  await expect(p.getByRole("textbox", { name: "World name" })).toBeDisabled();
});

test("Arena's Spawnable Worlds show how they're created, and links to them draw dashed (ADR 0062)", async ({ page }) => {
  await openEditor(page, { sample: "arena" });
  await showTab(page, /^Worlds/);
  const p = panel(page);
  // One graph: Spawnable Worlds are dashed nodes with a "spawnable" tag, explained by the legend.
  await expect(p.locator('.worlds-node.template[data-template="Server"] .worlds-node-tag')).toHaveText("spawnable");
  await expect(p.locator('.worlds-node[data-world="Client"] .worlds-node-tag')).toHaveCount(0);
  // The bootstrap topology (ADR 0256): Server is the Host template play creates and the dedicated server starts.
  await expect(p.locator('.worlds-node.template[data-template="Server"] .worlds-node-role')).toHaveText("Host");
  await expect(p.locator('.worlds-node[data-world="Client"] .worlds-node-role')).toHaveCount(0);
  await expect(p.locator(".worlds-legend")).toContainText("spawnable");
  await expect(p.locator('.worlds-link.spawnable[data-link-arrow="Client>Server"]')).toHaveCount(1);
  await expect(p.locator('.worlds-link.spawnable[data-link-arrow="Client 2>Server"]')).toHaveCount(1);
  // Each link's label pill is clear of every node, so it stays readable.
  const nodes = await p.locator(".worlds-node").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
  for (const pair of ["Client>Server", "Client 2>Server"]) {
    const pill = await p.locator(`[data-label-for="${pair}"] rect`).evaluate((e) => e.getBoundingClientRect().toJSON() as DOMRect);
    await expect(p.locator(`[data-label-for="${pair}"] text`)).toHaveText("loopback");
    for (const n of nodes) expect(pill.right <= n.left || n.right <= pill.left || pill.bottom <= n.top || n.bottom <= pill.top, `${pair}'s label overlaps a node`).toBe(true);
  }
  await p.locator('.worlds-node[data-template="Server"]').click();
  await expect(p.locator(".worlds-spawn code").first()).toHaveText('Engine.createWorld("Server")');
  await expect(p.locator(".worlds-spawn")).toContainText("scripts/data.ts");
  await expect(p.getByRole("region", { name: "Links" })).toContainText("Applies when game code creates Server");
});

test("the graph draws and deletes links, and keeps where Worlds are moved out of project.json (ADR 0382)", async ({ page }) => {
  await openProject(page);
  const p = panel(page);
  await p.getByRole("button", { name: "+ World" }).click();
  await p.getByRole("textbox", { name: "World name" }).fill("Server");
  await p.getByRole("textbox", { name: "World name" }).press("Enter");
  await expect(p.locator('.worlds-node[data-world="Server"]')).toBeVisible();
  await p.getByRole("button", { name: "Frame all" }).click();

  // Drag from Default's out port (right edge) to Server's in port (left edge): Default → Server over loopback.
  const from = (await p.locator('.worlds-node[data-world="Default"] .worlds-port.out').boundingBox())!;
  const to = (await p.locator('.worlds-node[data-world="Server"] .worlds-port.in').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await bootstrap(page)).links).toEqual([{ from: "Default", to: "Server", transport: "loopback" }]);
  await expect(p.locator('[data-label-for="Default>Server"] text')).toHaveText("loopback");

  // Pick the link by its label and delete it.
  await p.locator('[data-label-for="Default>Server"] text').click();
  await expect(p.locator('.worlds-link.selected[data-link-arrow="Default>Server"]')).toHaveCount(1);
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await bootstrap(page)).links ?? []).toEqual([]);

  // Move Server: where it's drawn is the editor's (.myco/worlds-graph.json), not the bootstrap's.
  const node = (await p.locator('.worlds-node[data-world="Server"]').boundingBox())!;
  await page.mouse.move(node.x + 30, node.y + 10);
  await page.mouse.down();
  await page.mouse.move(node.x + 90, node.y + 50, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => JSON.parse((await read(page, ".myco/worlds-graph.json")) ?? "{}").positions?.["world:Server"]).toBeTruthy();
  expect(JSON.stringify(await bootstrap(page))).not.toMatch(/position/);
});
