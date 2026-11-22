import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Hooks } from "./fixtures";
import {
  MARKER_TEXT,
  captureState,
  exportAndServe,
  filesUnder,
  openCaptureFile,
  openProfilerTab,
  planCursor,
  press,
  readTruth,
  audioClockRuns,
  recordScene,
  rulerAt,
  expectTablesAt,
  stopServed,
  type Served,
} from "./audioExport";
import { panelOf } from "./audioProfiler";

// M5d, task X3 (ADR 0171 amended by 0172, owner decision 7; docs/guide/audio-profiler.md): the export round trip. The Sound Lab is
// exported with `--audio-capture` and played in its exported page by its own keys (a known scene: voices on known buses, a fade and
// a mute, a marker); F9 records and F9 saves a `.mycap`; the editor's Audio Profiler opens that file with the Open button, and at five
// cursor positions (the start, just after a keyframe, between two voice events, at the marker, the end) the voice table and the bus
// factors read what the exported game's own `Audio.debug()` said it was playing, read in the game at that plateau of the scene.
// A game exported without the option loads no part of the recorder. No wall-clock assertion anywhere: the scene is paced on the
// audio clock and on the work each key did (`audioExport.ts`), and the editor's tables are polled until the seek answers.

test.describe.configure({ mode: "serial", timeout: 240_000 });

const isRecorderOrTrigger = (url: string) => /(^|\/)(recorder|trigger)-[\w-]+\.js(\?|$)/.test(url);

test.describe("a game exported with --audio-capture, opened in the editor", { tag: "@slow" }, () => {
  let served: Served | undefined;
  test.beforeAll(async () => void (served = await exportAndServe("sound-lab", ["--audio-capture"])));
  test.afterAll(() => stopServed(served));

  test("F9 records a known scene; the editor opens the .mycap and its tables match the game at five cursor positions", async ({ page, context }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    expect(JSON.parse(readFileSync(join(served!.dir, "web", "game.json"), "utf8")).audioCapture).toBe(true);

    const scene = await recordScene(page, served!.url);
    // The option's own chunks were fetched: the trigger when the game booted, the recorder when F9 started the take.
    expect(requests.filter((u) => /trigger-[\w-]+\.js/.test(u)).length, "the trigger chunk is loaded by an export with the option").toBeGreaterThan(0);
    expect(requests.filter((u) => /recorder-[\w-]+\.js/.test(u)).length, "the recorder chunk is fetched by F9").toBeGreaterThan(0);
    expect(errors).toEqual([]);

    await test.step("the file the game saved is the take: named by time, one marker, a keyframe about a second, the scene's voices", async () => {
      const p = scene.parsed;
      expect(scene.fileName).toMatch(/^capture-\d{8}-\d{6}\.mycap$/);
      expect(p.meta.project?.name).toBe("sound-lab");
      expect(p.flags & 1, "not truncated").toBe(0);
      expect(p.flags & 2, "not main-side only: the core backend recorded it").toBe(0);
      expect(p.markers.map((m) => m.text)).toEqual([MARKER_TEXT]);
      expect(p.keyframes.length, "a keyframe a second of rendered audio, over the scene's ten seconds").toBeGreaterThanOrEqual(8);
      expect(p.keyframes[0]!, "a keyframe leads the take: the start has a state to show").toBeLessThan(p.status[0]!);
      expect(p.voiceStarts.map((v) => v.clip)).toEqual(["audio/drum-loop.wav", "audio/noise-loop.wav", "audio/drum-loop.wav"]);
      expect(p.voiceStops.length, "the first drums and the noise stopped inside the take").toBe(2);
    });

    const plan = planCursor(scene.parsed);
    const editor = await context.newPage();
    const editorErrors: string[] = [];
    editor.on("pageerror", (err) => editorErrors.push(err.message));
    editor.on("console", (msg) => {
      if (msg.type() === "error") editorErrors.push(msg.text());
    });
    await openProfilerTab(editor);
    await openCaptureFile(editor, scene.file, scene.fileName);
    await expect(editor.locator("section.profiler .profiler-banner[data-banner=viewing]")).toBeVisible();

    await test.step("1. the start: the lab's own loops, from the take's first keyframe", async () => {
      await expectTablesAt(editor, "start", scene.truths.start);
    });
    await test.step("2. at the marker: the noise has joined, Music is back (Shift+M lands on the marker's block)", async () => {
      await panelOf(editor).focus();
      // The keys act once the file's targets are loaded; pressing again is harmless (no marker after this one).
      await expect
        .poll(async () => {
          await editor.keyboard.press("Shift+M");
          return (await editor.locator("section.profiler .ptable[data-table=voices] .pgrid-row").allInnerTexts()).some((t) => t.includes("noise-loop"));
        }, { timeout: 20_000 })
        .toBe(true);
      await expectTablesAt(editor, "marker", scene.truths.marker);
    });
    await test.step("3. between two voice events: the drums have stopped, the noise has not started, Music is muted", async () => {
      await press(editor, "ArrowLeft", plan.leftToBetween);
      await expectTablesAt(editor, "between", scene.truths.between);
    });
    await test.step("4. just after a keyframe: the drums in, Music faded to a quarter", async () => {
      await press(editor, "ArrowLeft", plan.leftToKeyframe);
      await expectTablesAt(editor, "keyframe", scene.truths.keyframe);
    });
    await test.step("5. the end: the drums again, the noise gone, Ambience faded", async () => {
      const at = await rulerAt(editor, 1);
      await editor.mouse.click(at.x, at.y);
      await press(editor, "ArrowRight", 40); // the click lands within a few blocks of the end; Right stops at the last block
      await expectTablesAt(editor, "end", scene.truths.end);
    });
    expect(editorErrors).toEqual([]);
  });
});

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
