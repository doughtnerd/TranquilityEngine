import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "./fixtures";
import { bender, benderFiles, scene, stage } from "./animationAssets";
import { captureView } from "./viewCapture";

// An exported game with animation, cold-loaded in a fresh browser (ADR 0370, 0371, 0376): a project with the skinned
// column (its Animator plays the looping "Bend" clip on start) is exported for the web by the export CLI and served
// with the build's own serve.mjs. The game draws the column in more than one pose over time (captures of the game's
// canvas). A release export leaves out the player's debug link files (`files.json`'s `debug` list); an export with
// `--debug-link` carries them.

test.describe.configure({ mode: "serial", timeout: 120_000 });

interface Served {
  url: string;
  out: string;
  server: ChildProcess;
}

const temps: string[] = [];

/** The test project, written to a temporary folder. */
function writeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "myco-anim-export-"));
  temps.push(dir);
  const files: Record<string, string | Uint8Array> = {
    ...benderFiles(),
    "project.json": JSON.stringify({ name: "Bend", mainScene: "scenes/main.scene.json" }),
    "scenes/main.scene.json": scene([...stage(), ...bender()]),
  };
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), data);
  }
  return dir;
}

/** Exports `project` with `extra` options into a new folder; the output folder. */
function exportProject(project: string, extra: string[]): string {
  const out = join(mkdtempSync(join(tmpdir(), "myco-anim-export-out-")), "web");
  temps.push(dirname(out));
  const result = spawnSync(process.execPath, ["src/export/cli.mjs", project, "--out", out, ...extra], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`export failed:\n${result.stdout}\n${result.stderr}`);
  return out;
}

function serve(out: string): Promise<Served> {
  const server = spawn(process.execPath, [join(out, "serve.mjs"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    let text = "";
    server.stdout!.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      const match = /http:\/\/[\d.]+:\d+\//.exec(text);
      if (match) resolve({ url: match[0], out, server });
    });
    server.on("exit", (code) => reject(new Error(`serve.mjs exited (${code}): ${text}`)));
  });
}

/** The prebuilt player's debug link files (`dist/player/files.json`'s `debug` list). */
const debugFiles = (): string[] => (JSON.parse(readFileSync("dist/player/files.json", "utf8")) as { debug?: string[] }).debug ?? [];

test.describe("an exported game with animation", { tag: "@slow" }, () => {
  let project = "";
  let release: Served | undefined;
  test.beforeAll(async () => {
    project = writeProject();
    release = await serve(exportProject(project, []));
  });
  test.afterAll(() => {
    release?.server.kill();
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("cold-loaded, it plays the skinned model's clip", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    expect(JSON.parse(readFileSync(join(release!.out, "game.json"), "utf8"))).not.toHaveProperty("debug");
    await page.goto(release!.url);
    const canvas = page.locator("#game canvas").first();
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    // The column's painted width at successive captures: it bends and straightens (widest / narrowest > 1.5).
    const widths: number[] = [];
    await expect
      .poll(
        async () => {
          const c = await captureView(canvas);
          let x0 = Infinity, x1 = -1;
          for (let y = 0; y < c.height; y++)
            for (let x = 0; x < c.width; x++) {
              const i = (y * c.width + x) * c.channels;
              const [r, g, b] = [c.data[i]!, c.data[i + 1]!, c.data[i + 2]!];
              if (r > 90 && r > g * 1.4 && r > b * 2) (x0 = Math.min(x0, x)), (x1 = Math.max(x1, x));
            }
          if (x1 >= 0) widths.push(x1 - x0 + 1);
          return widths.length > 1 ? Math.max(...widths) / Math.min(...widths) : 0;
        },
        { timeout: 60_000, intervals: [250], message: "the column's painted width changes as it bends (widest / narrowest)" },
      )
      .toBeGreaterThan(1.5);
    expect(errors).toEqual([]);
  });

  test("a release export carries no debug link files; a --debug-link export does", () => {
    const linkFiles = debugFiles();
    expect(linkFiles.length, "the prebuilt player lists its debug link files").toBeGreaterThan(0);
    for (const f of linkFiles) expect(existsSync(join(release!.out, f)), `release build: ${f}`).toBe(false);
    const debug = exportProject(project, ["--debug-link", "7790"]);
    expect(JSON.parse(readFileSync(join(debug, "game.json"), "utf8")).debug).toEqual({ link: "ws://localhost:7790/myco-debug" });
    for (const f of linkFiles) expect(existsSync(join(debug, f)), `debug build: ${f}`).toBe(true);
  });
});
