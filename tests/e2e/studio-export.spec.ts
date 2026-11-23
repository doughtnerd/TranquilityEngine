import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportProjectAndServe, stopServed, type Served } from "./audioExport";
import { expect, test } from "./fixtures";
import { trackErrors } from "./studio";

// A game build with an audio package (ADR 0351 §5–§9): a copy of the Flappy sample whose audio.json puts the town music
// in a preloaded package, exported with the game build. The build has the package and its audio report
// (`audio-report.json`), and the exported player loads the package and plays the music from it (read through the
// public `myco` API, `Audio.package()` and `Audio.debug()`).

test.describe.configure({ mode: "serial", timeout: 240_000 });

type GameApi = { Audio: { package(n: string): { state: string; bytes: number }; debug(): { voices: { clip: string; state: string }[] } } };

test.describe("a build with an audio package", { tag: "@slow" }, () => {
  let project = "";
  let served: Served | undefined;
  test.beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), "myco-studio-export-"));
    cpSync("samples/flappy", project, { recursive: true });
    const audio = JSON.parse(readFileSync(join(project, "audio.json"), "utf8"));
    if (!process.env.NOPKG) audio.packages = [{ name: "Music", include: ["music/town.playlist.json"], preload: true }];
    writeFileSync(join(project, "audio.json"), JSON.stringify(audio, null, 2));
    served = await exportProjectAndServe(project, [], "packages");
  });
  test.afterAll(() => {
    stopServed(served);
    if (project) rmSync(project, { recursive: true, force: true });
  });

  test("ships the package and its report, and the player plays the music from the package", async ({ page }) => {
    const web = join(served!.dir, "web");
    if (!process.env.NOPKG) expect(existsSync(join(web, "audio/packages/Music.mycopak"))).toBe(true);
    const report = readFileSync(join(web, "audio-report.json"), "utf8");
    if (!process.env.NOPKG) expect(report).toContain("Music");
    expect(report).toContain("town");

    const errors = trackErrors(page);
    await page.goto(served!.url);
    await page.locator("#game canvas").click();
    if (!process.env.NOPKG) await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __myco?: GameApi }).__myco?.Audio.package("Music").state ?? "none"), { timeout: 30_000 }).toBe("loaded");
    await page.waitForTimeout(5000);
    console.log("DEBUG", JSON.stringify(await page.evaluate(() => { const d = (globalThis as unknown as { __myco: { Audio: { debug(): Record<string, unknown> } } }).__myco.Audio.debug(); return { voices: d.voices, events: d.events, music: d.music, packages: d.packages, memory: d.memory, counters: d.counters, status: d.status }; })).slice(0, 4000));
    await expect
      .poll(() => page.evaluate(() => (globalThis as unknown as { __myco?: GameApi }).__myco?.Audio.debug().voices.some((v) => v.clip.includes("town") && v.state === "playing") ?? false), { timeout: 30_000 })
      .toBe(true);
    expect(errors).toEqual([]);
  });
});
