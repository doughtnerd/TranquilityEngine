import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "./fixtures";

// X1 (ADR 0172 owner decision 7). UNVERIFIED DRAFT: no Chromium in the X1 worktree, so this was never run.
// A game exported with --audio-capture: F9 records and the second F9 downloads a .mycap; without the option F9 does nothing
// (no toast, no download, no recorder chunk requested).

test.describe.configure({ mode: "serial" });

interface Served { url: string; dir: string; server: ChildProcess }

function exportAndServe(sample: string, extra: string[]): Promise<Served> {
  const dir = mkdtempSync(join(tmpdir(), `myco-export-cap-${sample}-`));
  const out = join(dir, "web");
  const result = spawnSync(process.execPath, ["src/export/cli.mjs", `samples/${sample}`, "--out", out, ...extra], { encoding: "utf8" });
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

const stop = (s: Served | undefined) => {
  s?.server.kill();
  if (s) rmSync(s.dir, { recursive: true, force: true });
};

const engineUp = (page: Page) => page.evaluate(() => Boolean((window as unknown as { engine?: unknown }).engine));
const toast = (page: Page) => page.locator('[data-myco-toast="audio-capture"]');

test.describe("a game exported with --audio-capture", { tag: "@slow" }, () => {
  let served: Served | undefined;
  test.beforeAll(async () => void (served = await exportAndServe("flappy", ["--audio-capture"])));
  test.afterAll(() => stop(served));

  test("F9 records, F9 again saves a .mycap download", async ({ page }) => {
    expect(JSON.parse(readFileSync(join(served!.dir, "web", "game.json"), "utf8")).audioCapture).toBe(true);
    await page.goto(served!.url);
    await expect.poll(() => engineUp(page), { timeout: 20_000 }).toBe(true);
    await page.locator("#game canvas").click(); // the first gesture starts the audio core
    await page.keyboard.press("F9");
    await expect(toast(page)).toHaveText("Recording audio…");
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __myco: { Audio: { capture: { state: string } } } }).__myco.Audio.capture.state), { timeout: 20_000 }).toBe("recording");
    const download = page.waitForEvent("download");
    await page.keyboard.press("F9");
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^capture-\d{8}-\d{6}\.mycap$/);
    await expect(toast(page)).toContainText("Saved capture-");
  });
});

test.describe("a game exported without the option", { tag: "@slow" }, () => {
  let served: Served | undefined;
  test.beforeAll(async () => void (served = await exportAndServe("flappy", [])));
  test.afterAll(() => stop(served));

  test("F9 does nothing: no toast, no download, no recorder chunk", async ({ page }) => {
    expect(JSON.parse(readFileSync(join(served!.dir, "web", "game.json"), "utf8"))).not.toHaveProperty("audioCapture");
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    const downloads: string[] = [];
    page.on("download", (d) => downloads.push(d.suggestedFilename()));
    await page.goto(served!.url);
    await expect.poll(() => engineUp(page), { timeout: 20_000 }).toBe(true);
    await page.locator("#game canvas").click();
    await page.keyboard.press("F9");
    await page.keyboard.press("F9");
    const state = await page.evaluate(() => (globalThis as unknown as { __myco: { Audio: { capture: { state: string } } } }).__myco.Audio.capture.state);
    expect(state).toBe("idle"); // the capture never started: its state is the work done, not a wait
    await expect(toast(page)).toHaveCount(0);
    expect(downloads).toEqual([]);
    expect(requests.filter((u) => /recorder/i.test(u))).toEqual([]);
  });
});
