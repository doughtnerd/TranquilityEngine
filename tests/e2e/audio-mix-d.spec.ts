import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Hooks } from "./fixtures";
import { audioClockRuns, captureState, exportAndServe, filesUnder, readTruth, stopServed, type Served } from "./audioExport";

// M5d, task X3 (ADR 0171 amended by 0172, owner decision 7): a game exported without `--audio-capture` loads no part of the
// recorder. (The round trip that opened the saved `.sporesample` in the editor's Audio Profiler went with that panel, ADR 0341:
// captures open on the Audio Studio's Profiler screen.) No wall-clock assertion: the scene is paced on the audio clock.

test.describe.configure({ mode: "serial", timeout: 240_000 });

const isRecorderOrTrigger = (url: string) => /(^|\/)(recorder|trigger)-[\w-]+\.js(\?|$)/.test(url);

test.describe("a game exported without the option", { tag: "@slow" }, () => {
  let served: Served | undefined;
  test.beforeAll(async () => void (served = await exportAndServe("sound-lab", [])));
  test.afterAll(() => stopServed(served));

  test("loads no part of the recorder: nothing in the page's static graph, no request, F9 does nothing", async ({ page }) => {
    const web = join(served!.dir, "web");
    expect(JSON.parse(readFileSync(join(web, "game.json"), "utf8")), "the manifest has no capture flag").not.toHaveProperty("audioCapture");

    await test.step("the built files: the page and its static imports never name the recorder or the trigger", async () => {
      const html = readFileSync(join(web, "index.html"), "utf8");
      expect(html, "no script or preload for the recorder in the page").not.toMatch(/(recorder|trigger)-[\w-]+\.js/);
      // The chunks are lazy targets of the shared player (on disk, loaded only on demand); the entry's static closure must not reach them.
      const files = filesUnder(web);
      expect(files.filter(isRecorderOrTrigger).length, "the recorder and the trigger are separate chunks, never folded into an entry").toBeGreaterThanOrEqual(2);
      const entry = /<script type="module"[^>]* src="\.\/([^"]+)"/.exec(html)![1]!;
      const seen = new Set<string>();
      const walk = (file: string): void => {
        if (seen.has(file)) return;
        seen.add(file);
        const text = readFileSync(join(web, file), "utf8");
        for (const m of text.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)) walk(`assets/${m[1]}`);
      };
      walk(entry);
      expect(seen.size, "the static closure was walked").toBeGreaterThan(5);
      expect([...seen].filter(isRecorderOrTrigger), "no recorder or trigger chunk in the static closure of the entry").toEqual([]);
    });

    await test.step("the network and the page: a played session, two F9 presses, no recorder request, no toast, no download", async () => {
      const requests: string[] = [];
      page.on("request", (r) => requests.push(r.url()));
      const downloads: string[] = [];
      page.on("download", (d) => downloads.push(d.suggestedFilename()));
      await page.goto(served!.url);
      await expect.poll(() => page.evaluate(() => Boolean((window as unknown as Hooks).engine)), { timeout: 30_000 }).toBe(true);
      await page.locator("#game canvas").click();
      await expect.poll(async () => (await readTruth(page)).voices.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
      await audioClockRuns(page, 1.5);
      await page.keyboard.press("F9");
      await page.keyboard.press("F9");
      await audioClockRuns(page, 0.5);
      expect(await captureState(page), "the capture never started: its state is the work done").toBe("idle");
      await expect(page.locator('[data-myco-toast="audio-capture"]')).toHaveCount(0);
      expect(downloads).toEqual([]);
      expect(requests.filter(isRecorderOrTrigger), "no recorder or trigger chunk was requested").toEqual([]);
      expect(requests.some((u) => /\.wav(\?|$)/.test(u)), "the page did load its audio (the check ran against a playing game)").toBe(true);
    });
  });
});
