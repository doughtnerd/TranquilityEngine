import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "./fixtures";
import { menu } from "./menus";

// Game builds (ADR 0041): `npm run export` turns a sample into a static web build, served here by
// the build's own serve.mjs on a free port, and the game boots in the browser with no editor:
// Flappy reaches its start screen (and plays), Arena shows its menu and Host creates its Server
// World at runtime from a template. The player comes from dist/player/, which the webServer's
// build:editor builds first.

test.describe.configure({ mode: "serial" }); // one export per sample per worker

interface Served {
  url: string;
  dir: string;
  server: ChildProcess;
}

function exportAndServe(sample: string): Promise<Served> {
  const dir = mkdtempSync(join(tmpdir(), `myco-export-${sample}-`));
  const out = join(dir, "web");
  const result = spawnSync(process.execPath, ["src/export/cli.mjs", `samples/${sample}`, "--out", out], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`export of ${sample} failed:\n${result.stdout}\n${result.stderr}`);
  const server = spawn(process.execPath, [join(out, "serve.mjs"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    let text = "";
    server.stdout!.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      const match = /http:\/\/[\d.]+:\d+\//.exec(text);
      if (match) resolve({ url: match[0], dir, server });
    });
    server.on("exit", (code) => reject(new Error(`serve.mjs exited (${code}): ${text}`)));
  });
}

function stop(served: Served | undefined): void {
  if (!served) return;
  served.server.kill();
  rmSync(served.dir, { recursive: true, force: true });
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

type Hooks = { engine?: { world: { time: { frameCount: number } }; worlds(): { name: string }[] } };
type Engine = { GameObject: { findObjectOfType(type: unknown): Record<string, unknown> | null }; getComponentClass(id: string): unknown };

const frames = (page: Page) => page.evaluate(() => (window as unknown as Hooks).engine?.world.time.frameCount ?? 0);
const worldNames = (page: Page) => page.evaluate(() => (window as unknown as Hooks).engine?.worlds().map((w) => w.name) ?? null);
/** The first component of a script type in the running game, or null. */
const findScript = (page: Page, id: string, field: string) =>
  page.evaluate(
    ([id, field]) => {
      const t = (globalThis as unknown as { __myco?: Engine }).__myco;
      const type = t?.getComponentClass(id);
      try {
        const c = type ? t!.GameObject.findObjectOfType(type) : null;
        return c ? (c[field] as unknown) : null;
      } catch {
        return null; // the player's Engine isn't up yet: no active World
      }
    },
    [id, field],
  );

test.describe("Flappy web build", { tag: "@slow" }, () => {
  let served: Served | undefined;
  test.beforeAll(async () => {
    served = await exportAndServe("flappy");
  });
  test.afterAll(() => stop(served));

  test("boots to the start screen full-window, and a click starts the game", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(served!.url);
    await expect(page).toHaveTitle("flappy");
    await expect.poll(() => findScript(page, "game.GameManager", "state"), { timeout: 20_000 }).toBe("ready");
    await expect.poll(() => frames(page)).toBeGreaterThan(10);

    // The canvas fills the window at the project's aspect ratio (720×680), letterboxed.
    const box = (await page.locator("#game canvas").boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(Math.max(box.width / viewport.width, box.height / viewport.height)).toBeGreaterThan(0.98);
    expect(box.width / box.height).toBeCloseTo(720 / 680, 1);

    await page.locator("#game canvas").click();
    await expect.poll(() => findScript(page, "game.GameManager", "state")).toBe("playing");
    expect(errors).toEqual([]);
  });

  test("a file:// page explains how to serve it", async ({ page }) => {
    await page.goto(`file://${join(served!.dir, "web", "index.html").replace(/\\/g, "/").replace(/^\/?/, "/")}`);
    await expect(page.getByRole("alert")).toContainText("served over HTTP");
  });
});

test("the editor's Export… dialog: the player ships beside the editor; a browser editor without folder access explains, and shows the desktop command", { tag: "@slow" }, async ({ page, browserName }) => {
  const errors = trackErrors(page);
  await page.goto("/editor.html?sample=flappy"); // relative to baseURL (E2E_PORT)
  await expect(page.locator(".project-name")).toHaveText("Flappy Bird (sample, read-only)");
  const player = await page.evaluate(async () => ((await (await fetch("player/files.json")).json()) as { files: string[] }).files);
  expect(player).toContain("player.html");
  expect(player).toContain("myco.js");

  await menu(page, "File", "Build and Export…");
  const dialog = page.getByRole("dialog", { name: "Build / Export" });
  await expect(dialog).toBeVisible();
  if (browserName === "chromium") {
    // Chromium opens folders through File System Access (ADR 0038), so the web build can be written.
    await expect(dialog.getByRole("button", { name: "Choose Folder and Export…" })).toBeEnabled();
  } else {
    await expect(dialog).toContainText("this browser editor can't do");
    await expect(dialog.getByRole("button", { name: "Choose Folder and Export…" })).toBeDisabled();
  }
  await dialog.getByLabel("Desktop app").check();
  await expect(dialog.locator(".export-command")).toContainText("npm run export -- \"<projectDir>\" --target desktop");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

test.describe("Arena web build", { tag: "@slow" }, () => {
  let served: Served | undefined;
  test.beforeAll(async () => {
    served = await exportAndServe("arena");
  });
  test.afterAll(() => stop(served));

  test("boots to the menu; Host creates the Server World at runtime", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(served!.url);
    await expect.poll(() => findScript(page, "arena.Menu", "serverUrl"), { timeout: 20_000 }).toBeTruthy();
    expect(await worldNames(page)).toEqual(["Client"]);
    await expect.poll(() => frames(page)).toBeGreaterThan(10);

    await page.keyboard.press("h");
    await expect.poll(() => worldNames(page), { timeout: 15_000 }).toEqual(["Client", "Server"]);
    expect(errors).toEqual([]);
  });
});

test.describe("3D Playground web build", { tag: "@slow" }, () => {
  let served: Served | undefined;
  test.beforeAll(async () => {
    served = await exportAndServe("playground3d");
  });
  test.afterAll(() => stop(served));

  test("loads its OBJ and FBX models and materials, and the crates fall under 3D physics (ADR 0043–0045)", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto(served!.url);
    await expect(page).toHaveTitle("3D Playground");
    await expect.poll(() => frames(page), { timeout: 20_000 }).toBeGreaterThan(10);
    type Myco = {
      MeshRenderer: unknown;
      RigidBody: unknown;
      GameObject: { findObjectsOfType(type: unknown): { node: { name: string; transform: { position: { y: number } } } }[] };
    };
    const state = () =>
      page.evaluate(() => {
        const m = (globalThis as unknown as { __myco: Myco }).__myco;
        const drawn = m.GameObject.findObjectsOfType(m.MeshRenderer).map((r) => r.node.name);
        const heights = m.GameObject.findObjectsOfType(m.RigidBody).map((b) => b.node.transform.position.y);
        return { drawn: drawn.sort(), highest: Math.max(...heights) };
      });
    await expect.poll(async () => (await state()).drawn).toEqual(["Ball", "Body", "Crate 1", "Crate 2", "Crate 3", "Crate 4", "Ground", "Head", "Orb", "Pillar", "Street Lamp"]);
    // Everything starts 3 m or higher; after a few seconds it has all landed on the ground.
    await expect.poll(async () => (await state()).highest, { timeout: 15_000 }).toBeLessThan(3);
    expect(errors).toEqual([]);
  });
});
