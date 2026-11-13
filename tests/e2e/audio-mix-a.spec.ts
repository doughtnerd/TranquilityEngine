import { readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { expect, openTestProject, type Page, test } from "./fixtures";
import { showTab } from "./tabs";
import {
  BLOCK,
  EVENT_INSTANCES,
  PROJECT_AUDIO,
  banner,
  barButton,
  clipsIn,
  cutShort,
  dropFile,
  filterBox,
  inflateOverrun,
  newerFormat,
  notACapture,
  olderFormat,
  panelOf,
  profilerCapture,
  table,
  tooLargeHeader,
  wireMismatch,
} from "./audioProfiler";
import { EMPTY_STATES } from "../../src/plugins/audio/editor/mix/emptyStates";

// M5a, task E1 (ADR 0171 amended by 0172; docs/guide/audio-profiler.md): the Audio Profiler panel in the real editor. It records
// in Play (the live view follows the ring), pauses and resumes on Space, scrubs on the ruler, steps one STATUS block, jumps to
// underruns, late commands, ladder steps and markers, saves a take (the web download), reopens it with the Open button, takes a
// dropped file, says why a view is empty and filters its four tables.
//
// **What is real and what is made.** The recording, pause, scrub, save and reopen run on a real take of the Sound Lab in Play.
// The cases that need a known place on the timeline (the step of exactly one block, the jump to an underrun, a truncated or a
// wire-mismatched file) use `profilerCapture` (`audioProfiler.ts`): a ten-second capture built with the runtime's own encoders
// (`assembleCapture`, the record writers, `statusBytesWith`), so the voice that starts a hundred frames before an underrun is
// in the table at the underrun and not one STATUS block earlier. A real underrun can't be had on demand in a headless page
// (the audio thread falls behind only when the machine does), so the underrun jump is on the made file.
//
// **Timing is on the audio clock.** A live wait is on `Audio.time` (what the audio thread has rendered) or on a table showing a
// row; the polls only pace the reads. A file case waits on the table, never on a span. The panel's cursor has no DOM of its own
// (its state is the canvas and the tables), so each case reads the tables at the cursor: the rows that exist there and not
// beside it say where the cursor is. (Nothing here adds a product hook.)

test.describe.configure({ timeout: 180_000 });

/** The legend (`KEY_BINDINGS` in `profilerKeys.ts`, which reaches the panel's TSX and so can't be imported here; the guide's table gives the same keys). */
const KEY_BINDINGS = [
  { id: "stepBack", keys: "Left", label: "Step back one STATUS block" },
  { id: "stepForward", keys: "Right", label: "Step forward one STATUS block" },
  { id: "underrunPrev", keys: "U", label: "Previous underrun" },
  { id: "underrunNext", keys: "Shift+U", label: "Next underrun" },
  { id: "lateCommandPrev", keys: "L", label: "Previous late command" },
  { id: "lateCommandNext", keys: "Shift+L", label: "Next late command" },
  { id: "ladderPrev", keys: "D", label: "Previous ladder step" },
  { id: "ladderNext", keys: "Shift+D", label: "Next ladder step" },
  { id: "markerPrev", keys: "M", label: "Previous marker" },
  { id: "markerNext", keys: "Shift+M", label: "Next marker" },
  { id: "toggleLive", keys: "Space", label: "Play or pause the live view" },
] as const;

/** The banners' words (`BANNER_TEXT` in `ProfilerPanel.tsx`, which pulls in CSS and so can't be imported here; the guide's table gives the same). */
const BANNER_TEXT = {
  viewing: "Viewing, not replaying",
  truncated: "Truncated: the ring wrapped. This capture starts at a later keyframe, not at Play.",
  projectMismatch: "This capture was recorded with a different audio section than the open project's. It is shown as recorded.",
  babylon: "Babylon fallback: main-side events and keyframes only. The CPU, underrun and loudness tracks are absent.",
} as const;

const LAB = "/editor.html?sample=sound-lab";
const TAB = /^Audio Profiler/;

type Api = { __myco: { Audio: { time: number; capture: { state: string; seconds: number; mark(t: string): void }; play(e: string, o?: object): unknown } } };

/** The editor's own Stop button (the panel has a "Stop recording" one too). */
const editorStop = (page: Page) => page.getByRole("button", { name: "■ Stop", exact: true });

async function playGame(page: Page): Promise<void> {
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(editorStop(page)).toBeVisible({ timeout: 30_000 });
  await page.mouse.click(480, 250); // the user gesture that unlocks the audio context
}

/** Opens the Sound Lab with the Audio Profiler tab showing (and its canvas text recorded for the label checks). */
async function openProfiler(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __labels: Set<string> };
    w.__labels = new Set();
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text: string, ...rest: [number, number, number?]) {
      w.__labels.add(text);
      return fill.call(this, text, ...rest);
    };
  });
  await page.goto(LAB);
  await page.waitForFunction(() => ((window as unknown as { engine?: { world: { time: { frameCount: number } } } }).engine?.world.time.frameCount ?? 0) > 10);
  await showTab(page, TAB);
  await expect(panelOf(page)).toBeVisible();
  return errors;
}

/** Opens `bytes` through the bar's Open button (the browser's file chooser). */
async function openViaButton(page: Page, name: string, bytes: Uint8Array | string): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), barButton(page, "open").click()]);
  await chooser.setFiles(typeof bytes === "string" ? bytes : { name, mimeType: "application/octet-stream", buffer: Buffer.from(bytes) });
}

/** The ids of the banners showing, in order. */
const bannerIds = (page: Page) => panelOf(page).locator(".profiler-banner").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.banner));

/** The ruler's drag target: x on the canvas at `fraction` of its width, y inside the ruler (the top 18 px). */
async function rulerAt(page: Page, fraction: number): Promise<{ x: number; y: number }> {
  const canvas = panelOf(page).locator("canvas.profiler-timeline");
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  return { x: box.x + Math.max(1, Math.min(box.width - 2, box.width * fraction)), y: box.y + 8 };
}

const focusPanel = (page: Page) => panelOf(page).focus();

/** Rows of the voice table that name `clip`. */
const voiceRow = (page: Page, clip: string) => table(page, "voices").locator(".pgrid-row", { hasText: clip });

/** Opens the made capture with the Open button and waits for its timeline; the cursor starts at 0. */
async function openMade(page: Page, bytes = profilerCapture(), name = "made.mycap"): Promise<void> {
  await openViaButton(page, name, bytes);
  // The bar shows the file's name once it is open (a capture that was open before shows its own name until then).
  await expect(panelOf(page).locator(".profiler-status")).toHaveText(name);
  await expect(panelOf(page).locator("canvas.profiler-timeline")).toBeVisible();
}

/** The voices at the cursor, as clip names (every row of the voice table). */
const voicesAtCursor = async (page: Page): Promise<string[]> => (await table(page, "voices").locator(".pgrid-row").allInnerTexts()).map((t) => t.split("\n")[1]!);

test("no capture: the panel says Not playing, the bar and the key legend are there, and Save has nothing to save", async ({ page }) => {
  const errors = await openProfiler(page);
  const panel = panelOf(page);
  await expect(panel.locator(".profiler-empty")).toHaveText(EMPTY_STATES.notPlaying);
  await expect(panel.locator("canvas.profiler-timeline")).toHaveCount(0);
  await expect(panel.locator(".profiler-banner")).toHaveCount(0);
  // The bar: Record and Open are live, Stop and Save have nothing to act on.
  await expect(barButton(page, "record")).toBeEnabled();
  await expect(barButton(page, "open")).toBeEnabled();
  await expect(barButton(page, "stop")).toBeDisabled();
  await expect(barButton(page, "save")).toBeDisabled();
  // The legend lists every key the panel binds (the table the keys read).
  const legend = panel.locator(".profiler-keys li");
  await expect(legend).toHaveCount(KEY_BINDINGS.length);
  for (const b of KEY_BINDINGS) {
    const item = panel.locator(`.profiler-keys li[data-key=${b.id}]`);
    await expect(item.locator("kbd")).toHaveText(b.keys);
    await expect(item.locator("span")).toHaveText(b.label);
  }
  // The panel is focusable, so Tab reaches it, and says which keys it takes.
  await expect(panel).toHaveAttribute("tabindex", "0");
  expect(await panel.getAttribute("aria-keyshortcuts")).toContain("Shift+U");
  expect(errors).toEqual([]);
});

test("Play with the recorder still loading: Recording starts when the panel opens in Play, then the live view follows and Stop returns to Not playing", async ({ page }) => {
  // The recorder is a lazy chunk the panel's join fetches. Held, the panel is in Play with no capture yet.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/assets/recorder-*.js", async (route) => {
    await gate;
    await route.continue();
  });
  const errors = await openProfiler(page);
  await playGame(page);
  await expect(panelOf(page).locator(".profiler-empty")).toHaveText(EMPTY_STATES.notRecording);
  await expect(panelOf(page).locator("canvas.profiler-timeline")).toHaveCount(0);
  release();
  // The live view follows: the timeline and the voice table (the lab's music and ambience loops) appear, with no "Viewing" banner (a live view is this session's own ring).
  await expect(panelOf(page).locator("canvas.profiler-timeline")).toBeVisible({ timeout: 30_000 });
  await expect(panelOf(page).locator(".profiler-empty")).toHaveCount(0);
  await expect(voiceRow(page, "audio/music-loop.wav")).toHaveCount(1, { timeout: 30_000 });
  await expect(voiceRow(page, "audio/hum-loop.wav")).toHaveCount(1);
  expect(await bannerIds(page)).toEqual([]);
  // Stopping Play ends the live view: no capture again, Not playing.
  await editorStop(page).click();
  await expect(panelOf(page).locator(".profiler-empty")).toHaveText(EMPTY_STATES.notPlaying, { timeout: 30_000 });
  await expect(panelOf(page).locator("canvas.profiler-timeline")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("record in Play, pause and resume on Space, scrub, save the take, reopen it with Open", async ({ page }) => {
  const errors = await openProfiler(page);
  await playGame(page);
  const panel = panelOf(page);
  const audioTime = () => page.evaluate(() => (globalThis as unknown as Api).__myco.Audio.time);
  /** Waits until the audio thread has rendered `seconds` more (`Audio.time`; the polling only paces the reads). */
  const audioFor = async (seconds: number) => {
    const t0 = await audioTime();
    await page.waitForFunction(([t, s]) => (globalThis as unknown as Api).__myco.Audio.time > (t as number) + (s as number), [t0, seconds] as const, { timeout: 60_000, polling: 50 });
  };
  // Two sound events that run until Play stops (a one-shot would end by itself in a second or two): the lab's intensity music (three looping stems) and its engine (a sustained loop).
  const startEvent = (asset: string) => page.evaluate((a) => void (globalThis as unknown as Api).__myco.Audio.play(a), asset);
  const MUSIC = "audio/events/music-intensity.audioevent.json";
  const ENGINE = "audio/events/engine-single.audioevent.json";
  const musicRow = voiceRow(page, "audio/events/music-pad.wav");
  const engineRow = voiceRow(page, "audio/events/engine-single.wav");

  await test.step("the live view follows the ring while the panel is open in Play", async () => {
    await expect(voiceRow(page, "audio/music-loop.wav")).toHaveCount(1, { timeout: 30_000 });
    await expect(voiceRow(page, "audio/hum-loop.wav")).toHaveCount(1);
    expect(await bannerIds(page)).toEqual([]);
  });

  await test.step("Record starts a take: the bar follows it and the ring grows on the audio clock", async () => {
    await barButton(page, "record").click();
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as Api).__myco.Audio.capture.state)).toBe("recording");
    await expect(barButton(page, "record")).toBeDisabled();
    await expect(barButton(page, "stop")).toBeEnabled();
    await expect(barButton(page, "save")).toBeEnabled();
    // The take's seconds are the rendered frames since the ring began: they pass two seconds when the audio clock has.
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as Api).__myco.Audio.capture.seconds), { timeout: 60_000 }).toBeGreaterThan(2);
  });

  await test.step("a sound started now shows in the live voice table", async () => {
    await audioFor(1);
    await startEvent(MUSIC);
    await expect(musicRow).toHaveCount(1, { timeout: 30_000 });
  });

  await test.step("a marker is dropped on the timeline, then the engine starts after it", async () => {
    await audioFor(1);
    await page.evaluate(() => (globalThis as unknown as Api).__myco.Audio.capture.mark("e2e marker"));
    await audioFor(1);
  });

  await test.step("Space pauses the live view: a sound started now stays out of the table until Space resumes it", async () => {
    await focusPanel(page);
    await page.keyboard.press("Space");
    await startEvent(ENGINE);
    // A second and a half of the audio clock passes: the paused view reads the state at the cursor, which is before the engine started.
    await audioFor(1.5);
    await expect(engineRow).toHaveCount(0);
    await expect(musicRow).toHaveCount(1);
    await page.keyboard.press("Space");
    await expect(engineRow).toHaveCount(1, { timeout: 30_000 });
  });

  await test.step("scrubbing the ruler pauses the live view at the time under the pointer, and the tables follow the drag", async () => {
    // A live timeline shows its newest moments (the span it opened with); the wheel zooms out to the whole take.
    const over = await rulerAt(page, 0.5);
    await page.mouse.move(over.x, over.y);
    await page.mouse.wheel(0, 6000);
    const left = await rulerAt(page, 0);
    await page.mouse.move(left.x, left.y);
    await page.mouse.down();
    // At the left end neither event had started; the lab's own loops are in the table from the first keyframe.
    await expect(musicRow).toHaveCount(0);
    await expect(engineRow).toHaveCount(0);
    await expect(voiceRow(page, "audio/music-loop.wav")).toHaveCount(1);
    const right = await rulerAt(page, 1);
    await page.mouse.move(right.x, right.y, { steps: 6 });
    await expect(engineRow).toHaveCount(1);
    await expect(musicRow).toHaveCount(1);
    await page.mouse.move(left.x, left.y, { steps: 6 });
    await page.mouse.up();
    await expect(musicRow).toHaveCount(0);
    // Released, the cursor stays where it was dropped (paused): more audio passes and the table does not follow.
    await audioFor(1);
    await expect(musicRow).toHaveCount(0);
    // Space goes live again.
    await focusPanel(page);
    await page.keyboard.press("Space");
    await expect(musicRow).toHaveCount(1, { timeout: 30_000 });
    await expect(engineRow).toHaveCount(1);
  });

  await test.step("Stop ends the take and Save downloads a .mycap", async () => {
    await barButton(page, "stop").click();
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as Api).__myco.Audio.capture.state)).toBe("stopped");
    await expect(barButton(page, "record")).toBeEnabled();
    await expect(barButton(page, "stop")).toBeDisabled();
    await expect(barButton(page, "save")).toBeEnabled();
    const [download] = await Promise.all([page.waitForEvent("download"), barButton(page, "save").click()]);
    expect(download.suggestedFilename()).toMatch(/^capture-\d{8}-\d{6}\.mycap$/);
    const bytes = readFileSync((await download.path())!);
    expect([...bytes.subarray(0, 8)]).toEqual([0x4d, 0x59, 0x43, 0x41, 0x50, 0x00, 0x01, 0x1a]); // "MYCAP\0", 0x01, 0x1A
    expect(bytes.byteLength).toBeGreaterThan(96 + 1000);
    expect(bytes.readUInt16LE(10) & 0b1000, "compressed").toBeTruthy();
    expect(bytes.readUInt16LE(10) & 0b0001, "not truncated").toBe(0);
    expect(inflateRawSync(bytes.subarray(96)).byteLength, "the header's size is what inflates").toBe(bytes.readUInt32LE(68));
    await expect(panel.locator(".profiler-status")).toHaveText(`Saved ${download.suggestedFilename()}`);
    const path = test.info().outputPath("take.mycap");
    await download.saveAs(path);

    await test.step("Open reopens the file: Viewing banner, the tables at its start, then the marker and the end", async () => {
      await openViaButton(page, "take.mycap", path);
      await expect(banner(page, "viewing")).toHaveText(BANNER_TEXT.viewing);
      // The same project: no mismatch banner, and a take of a game's own ring isn't truncated.
      expect(await bannerIds(page)).toEqual(["viewing"]);
      await expect(voiceRow(page, "audio/music-loop.wav")).toHaveCount(1);
      await expect(voiceRow(page, "audio/hum-loop.wav")).toHaveCount(1);
      await expect(musicRow).toHaveCount(0);
      // The markers: pressing Record with the panel already recording writes one at the take's start (before the music), then the one this test dropped (the intensity music was playing, the engine had not started).
      await focusPanel(page);
      await page.keyboard.press("Shift+M");
      await expect(musicRow).toHaveCount(0);
      await page.keyboard.press("Shift+M");
      await expect(musicRow).toHaveCount(1);
      await expect(engineRow).toHaveCount(0);
      await page.keyboard.press("Shift+M"); // no third marker: the cursor stays
      await expect(musicRow).toHaveCount(1);
      await expect(engineRow).toHaveCount(0);
      // The end of the file: both.
      const end = await rulerAt(page, 1);
      await page.mouse.click(end.x, end.y);
      await expect(engineRow).toHaveCount(1);
      await expect(musicRow).toHaveCount(1);
      // A file has no live mode: Space leaves the cursor where it is.
      await focusPanel(page);
      await page.keyboard.press("Space");
      await audioFor(1);
      await expect(engineRow).toHaveCount(1);
      await expect(musicRow).toHaveCount(1);
    });
  });
  expect(errors).toEqual([]);
});

test("Stop of Play, then Save: a take survives the end of Play once", async ({ page }) => {
  const errors = await openProfiler(page);
  await playGame(page);
  await barButton(page, "record").click();
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as Api).__myco.Audio.capture.seconds), { timeout: 60_000 }).toBeGreaterThan(2);
  await barButton(page, "stop").click();
  await editorStop(page).click();
  await expect(panelOf(page).locator(".profiler-empty")).toHaveText(EMPTY_STATES.notPlaying, { timeout: 30_000 });
  await expect(barButton(page, "save")).toBeEnabled();
  const [download] = await Promise.all([page.waitForEvent("download"), barButton(page, "save").click()]);
  expect(download.suggestedFilename()).toMatch(/\.mycap$/);
  const bytes = readFileSync((await download.path())!);
  expect([...bytes.subarray(0, 8)]).toEqual([0x4d, 0x59, 0x43, 0x41, 0x50, 0x00, 0x01, 0x1a]);
  expect(bytes.byteLength).toBeGreaterThan(96 + 1000);
  expect(errors).toEqual([]);
});

test("a made capture opens with the Open button: the tracks are drawn, the bar and banners say it is a file, and each table says why it is empty at the start", async ({ page }) => {
  const errors = await openProfiler(page);
  await openMade(page);
  const panel = panelOf(page);
  expect(await bannerIds(page)).toEqual(["viewing"]);
  await expect(banner(page, "viewing")).toHaveText(BANNER_TEXT.viewing);
  await expect(panel.locator(".profiler-status")).toHaveText("made.mycap");
  await expect(panel.locator(".profiler-empty")).toHaveCount(0);
  // The cursor starts at the first record, before any keyframe: every table says there is nothing at the cursor.
  await expect(table(page, "voices").locator(".ptable-empty")).toHaveText("No voices at the cursor");
  await expect(table(page, "buses").locator(".ptable-empty")).toHaveText("No bus data at the cursor");
  await expect(table(page, "events").locator(".ptable-empty")).toHaveText("No event instances at the cursor");
  await expect(table(page, "music").locator(".ptable-empty")).toHaveText("No music playing at the cursor");
  // The timeline draws its tracks (the labels are canvas text).
  await expect
    .poll(() => page.evaluate(() => [...(window as unknown as { __labels: Set<string> }).__labels]))
    .toEqual(expect.arrayContaining(["Voices", "Underruns", "Late commands", "Min slack (frames)", "Ladder steps", "Bus levels", "Bus gain", "Event instances", "Music state", "Markers"]));
  const labels = await page.evaluate(() => [...(window as unknown as { __labels: Set<string> }).__labels]);
  expect(labels.some((l) => /^CPU \(\d+ ms\)$/.test(l)), "the CPU track's label carries its window").toBe(true);
  expect(errors).toEqual([]);
});

test("a dropped .mycap opens like the Open button's; a dropped file that isn't one is turned away and the open capture stays", async ({ page }) => {
  const errors = await openProfiler(page);
  await dropFile(page, "dropped.mycap", profilerCapture());
  await expect(panelOf(page).locator("canvas.profiler-timeline")).toBeVisible();
  await expect(banner(page, "viewing")).toBeVisible();
  expect(await bannerIds(page)).toEqual(["viewing"]);
  await expect(table(page, "voices").locator(".ptable-empty")).toHaveText("No voices at the cursor");
  await focusPanel(page);
  await page.keyboard.press("Shift+U");
  await expect(voiceRow(page, "underrun-1.ogg")).toHaveCount(1);
  // A file with another extension is refused before it is read.
  await dropFile(page, "notes.txt", new TextEncoder().encode("not a capture"));
  await expect(banner(page, "error")).toContainText("Can't open notes.txt");
  await expect(banner(page, "error")).toContainText("is not a capture file");
  await expect(banner(page, "error")).toHaveAttribute("data-code", "notCapture");
  // ...and leaves the capture that was open: still viewing, the table still at the underrun.
  await expect(banner(page, "viewing")).toBeVisible();
  await expect(voiceRow(page, "underrun-1.ogg")).toHaveCount(1);
  // Dropping a capture again replaces it and clears the refusal.
  await dropFile(page, "again.mycap", profilerCapture());
  await expect(banner(page, "error")).toHaveCount(0);
  await expect(table(page, "voices").locator(".ptable-empty")).toHaveText("No voices at the cursor");
  expect(errors).toEqual([]);
});

test("keys: jump to the next and previous underrun, late command, ladder step and marker, and step one STATUS block", async ({ page }) => {
  const errors = await openProfiler(page);
  await openMade(page);
  const baseline = ["jump.ogg", "theme-loop.ogg", "rain-loop.ogg"];
  const at = (extra: string[]) => expect.poll(async () => (await voicesAtCursor(page)).sort()).toEqual([...baseline, ...extra].sort());
  await focusPanel(page);

  await test.step("underruns: previous before the first does nothing; next lands on each, then stops at the last", async () => {
    await page.keyboard.press("u");
    await expect(table(page, "voices").locator(".ptable-empty")).toHaveText("No voices at the cursor");
    await page.keyboard.press("Shift+U");
    await at(["underrun-1.ogg"]);
    await page.keyboard.press("Shift+U");
    await at(["underrun-2.ogg"]);
    await page.keyboard.press("Shift+U"); // the last: nowhere to go
    await at(["underrun-2.ogg"]);
    await page.keyboard.press("u");
    await at(["underrun-1.ogg"]);
  });

  await test.step("step: Left is one STATUS block earlier, Right one later", async () => {
    // The voice at the underrun started a hundred frames before it: a block (768 frames) earlier it hasn't.
    expect(BLOCK).toBeGreaterThan(100);
    await page.keyboard.press("ArrowLeft");
    await at([]);
    await page.keyboard.press("ArrowRight");
    await at(["underrun-1.ogg"]);
    await page.keyboard.press("ArrowRight"); // the next block: the voice is still there (it lives a thousand frames past)
    await at(["underrun-1.ogg"]);
    await page.keyboard.press("ArrowLeft");
    await at(["underrun-1.ogg"]);
    await page.keyboard.press("ArrowLeft");
    await at([]);
  });

  await test.step("late commands", async () => {
    await page.keyboard.press("Shift+L");
    await at(["late-1.ogg"]);
    await page.keyboard.press("Shift+L"); // the only one
    await at(["late-1.ogg"]);
    await page.keyboard.press("l"); // nothing before it
    await at(["late-1.ogg"]);
  });

  await test.step("ladder steps: the shed, then the restore; D goes back", async () => {
    await page.keyboard.press("Shift+D");
    await at(["ladder-shed.ogg"]);
    await page.keyboard.press("Shift+D");
    await at([]);
    await page.keyboard.press("d");
    await at(["ladder-shed.ogg"]);
    await page.keyboard.press("d"); // nothing before the shed
    await at(["ladder-shed.ogg"]);
  });

  await test.step("markers", async () => {
    await page.keyboard.press("m"); // the first marker is before the shed
    await at(["marker-1.ogg"]);
    await page.keyboard.press("m"); // nothing before it
    await at(["marker-1.ogg"]);
    await page.keyboard.press("Shift+M");
    await at(["marker-2.ogg"]);
    await page.keyboard.press("Shift+M");
    await at(["marker-2.ogg"]);
  });

  await test.step("Space on a file does nothing (a file has no live mode)", async () => {
    await page.keyboard.press("Space");
    await at(["marker-2.ogg"]);
  });
  expect(errors).toEqual([]);
});

test("keys are the panel's alone: not in the filter box, not with Ctrl, Alt or Meta, not with focus outside the panel", async ({ page }) => {
  const errors = await openProfiler(page);
  await openMade(page);
  await focusPanel(page);
  await page.keyboard.press("Shift+U");
  await expect(voiceRow(page, "underrun-1.ogg")).toHaveCount(1);
  const unchanged = async () => {
    await page.waitForTimeout(300); // a negative: give a wrongly handled key time to show
    expect(await voicesAtCursor(page)).toContain("underrun-1.ogg");
    expect(await voicesAtCursor(page)).not.toContain("underrun-2.ogg");
  };
  // In the filter box the keys are typing.
  await filterBox(page).click();
  await page.keyboard.type("U");
  await expect(filterBox(page)).toHaveValue("U");
  await page.keyboard.press("ArrowRight");
  await unchanged();
  await filterBox(page).fill("");
  // Held modifiers belong to the editor.
  await focusPanel(page);
  for (const mod of ["Control", "Alt", "Meta"]) {
    await page.keyboard.down(mod);
    await page.keyboard.press("Shift+U");
    await page.keyboard.up(mod);
  }
  await unchanged();
  // Focus outside the panel: the key is not ours.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator("body").press("Shift+U");
  await unchanged();
  // And with focus back in the panel the same key works.
  await focusPanel(page);
  await page.keyboard.press("Shift+U");
  await expect(voiceRow(page, "underrun-2.ogg")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("scrub: dragging the cursor along the ruler moves the tables with it, and a click in a track sets it", async ({ page }) => {
  const errors = await openProfiler(page);
  await openMade(page);
  // The ten-second file spans the canvas: 0.4 of its width is about 4 s (scrub-a lives 3.5 to 4.5 s), 0.62 about 6.2 s (scrub-b lives 5.5 to 6.8 s), 0.5 about 5 s (neither).
  const only = (extra: string[]) => expect.poll(async () => (await voicesAtCursor(page)).filter((c) => c.startsWith("scrub-"))).toEqual(extra);
  const a = await rulerAt(page, 0.4);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await only(["scrub-a.ogg"]);
  const b = await rulerAt(page, 0.62);
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await only(["scrub-b.ogg"]);
  const mid = await rulerAt(page, 0.5);
  await page.mouse.move(mid.x, mid.y, { steps: 4 });
  await only([]);
  await page.mouse.up();
  await only([]);
  // Released, it stays: the keys step from where the drag ended.
  await focusPanel(page);
  await page.keyboard.press("Shift+U"); // from about 5 s the next underrun is the second (7.008 s)
  await expect.poll(async () => await voicesAtCursor(page)).toContain("underrun-2.ogg");
  // A click in the track area (below the ruler) sets the cursor the same way.
  const canvas = panelOf(page).locator("canvas.profiler-timeline");
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.4, box.y + 40);
  await only(["scrub-a.ogg"]);
  expect(errors).toEqual([]);
});

test("filter: by clip, by bus, by event, by segment, case and spaces ignored, no match, cleared", async ({ page }) => {
  const errors = await openProfiler(page);
  await openMade(page);
  await focusPanel(page);
  await page.keyboard.press("Shift+U"); // the first underrun: four voices, ten buses, two event instances, one music instance
  const summary = (name: "voices" | "buses" | "events" | "music") => table(page, name).locator(".ptable-summary");
  const sums = async () => [await summary("voices").innerText(), await summary("buses").innerText(), await summary("events").innerText(), await summary("music").innerText()];
  await expect.poll(() => sums()).toEqual(["4 voices", `${PROJECT_AUDIO.buses.length} buses`, "2 event instances", "1 music instance"]);
  expect(await voicesAtCursor(page)).toHaveLength(4);
  expect(await clipsIn(page, "buses")).toHaveLength(PROJECT_AUDIO.buses.length);
  expect(await clipsIn(page, "events")).toEqual(EVENT_INSTANCES.map((e) => expect.stringContaining(e.name)));
  const noMatch = "No rows match the filter";
  const empty = (name: "voices" | "buses" | "events" | "music") => table(page, name).locator(".ptable-empty");
  const total = PROJECT_AUDIO.buses.length;

  await test.step("by clip name", async () => {
    await filterBox(page).fill("jump");
    await expect(summary("voices")).toHaveText("1 of 4 voices");
    expect(await voicesAtCursor(page)).toEqual(["jump.ogg"]);
    for (const t of ["buses", "events", "music"] as const) await expect(empty(t)).toHaveText(noMatch);
    await expect(summary("buses")).toHaveText(`0 of ${total} buses`);
  });

  await test.step("by bus name: the bus's voices and its row", async () => {
    await filterBox(page).fill("SFX");
    await expect(summary("voices")).toHaveText("1 of 4 voices");
    expect(await voicesAtCursor(page)).toEqual(["jump.ogg"]);
    await expect(summary("buses")).toHaveText(`1 of ${total} buses`);
    expect(await clipsIn(page, "buses")).toEqual([expect.stringContaining("SFX")]);
    await expect(empty("events")).toHaveText(noMatch);
    await filterBox(page).fill("ambience");
    await expect(summary("voices")).toHaveText("1 of 4 voices");
    expect(await voicesAtCursor(page)).toEqual(["rain-loop.ogg"]);
    expect(await clipsIn(page, "buses")).toEqual([expect.stringContaining("Ambience")]);
  });

  await test.step("by event name", async () => {
    await filterBox(page).fill("explo");
    await expect(summary("events")).toHaveText("1 of 2 event instances");
    expect(await clipsIn(page, "events")).toEqual([expect.stringContaining("Explosion")]);
    await expect(empty("voices")).toHaveText(noMatch);
    await expect(empty("buses")).toHaveText(noMatch);
    await expect(empty("music")).toHaveText(noMatch);
  });

  await test.step("by music segment name", async () => {
    await filterBox(page).fill("boss");
    await expect(summary("music")).toHaveText("1 of 1 music instance");
    expect(await clipsIn(page, "music")).toEqual([expect.stringContaining("Boss theme")]);
    await expect(empty("voices")).toHaveText(noMatch);
    await expect(empty("events")).toHaveText(noMatch);
  });

  await test.step("case and surrounding spaces don't matter", async () => {
    await filterBox(page).fill("  JUMP  ");
    await expect(summary("voices")).toHaveText("1 of 4 voices");
    expect(await voicesAtCursor(page)).toEqual(["jump.ogg"]);
  });

  await test.step("no match anywhere, then cleared", async () => {
    await filterBox(page).fill("zzz-nothing");
    for (const t of ["voices", "buses", "events", "music"] as const) await expect(empty(t)).toHaveText(noMatch);
    await filterBox(page).fill("");
    await expect.poll(() => sums()).toEqual(["4 voices", `${total} buses`, "2 event instances", "1 music instance"]);
  });
  expect(errors).toEqual([]);
});

test("banners of an opened capture: truncated (and its empty tables), another audio section, the Babylon fallback", async ({ page }) => {
  const errors = await openProfiler(page);

  await test.step("truncated: the ring wrapped, the file starts at a later keyframe", async () => {
    await openMade(page, profilerCapture({ truncated: true, firstKeyframeSeconds: 2 }), "truncated.mycap");
    expect(await bannerIds(page)).toEqual(["truncated", "viewing"]);
    await expect(banner(page, "truncated")).toHaveText(BANNER_TEXT.truncated);
    // Before its first keyframe the tables say why they have nothing: the empty state of a truncated capture.
    for (const t of ["voices", "buses", "events", "music"] as const) await expect(table(page, t).locator(".ptable-empty")).toHaveText(EMPTY_STATES.truncated);
    // After it they have rows.
    await focusPanel(page);
    await page.keyboard.press("Shift+U");
    await expect(voiceRow(page, "underrun-1.ogg")).toHaveCount(1);
    await expect(table(page, "buses").locator(".ptable-empty")).toHaveCount(0);
  });

  await test.step("a different audio section than the open project's: shown as recorded, a warning only", async () => {
    const audio = { ...PROJECT_AUDIO, buses: [...PROJECT_AUDIO.buses, { name: "Extra", parent: "Master", volume: 1, mute: false, effects: [] }] };
    await openMade(page, profilerCapture({ audio }), "other-audio.mycap");
    expect(await bannerIds(page)).toEqual(["projectMismatch", "viewing"]);
    await expect(banner(page, "projectMismatch")).toHaveText(BANNER_TEXT.projectMismatch);
    await expect(banner(page, "projectMismatch")).toHaveAttribute("data-severity", "warn");
    // The capture is shown anyway (the tables read it as recorded).
    await focusPanel(page);
    await page.keyboard.press("Shift+U");
    await expect(voiceRow(page, "underrun-1.ogg")).toHaveCount(1);
  });

  await test.step("the Babylon fallback: main-side events and keyframes only (no STATUS), a warning, and the tables still read the keyframes", async () => {
    await openMade(page, profilerCapture({ babylon: true }), "babylon.mycap");
    expect(await bannerIds(page)).toEqual(["babylon", "viewing"]);
    await expect(banner(page, "babylon")).toHaveText(BANNER_TEXT.babylon);
    // Without STATUS there are no blocks to step or jump to; the cursor reads the keyframe at the file's end.
    const end = await rulerAt(page, 1);
    await page.mouse.click(end.x, end.y);
    await expect(voiceRow(page, "jump.ogg")).toHaveCount(1);
    await expect(voiceRow(page, "theme-loop.ogg")).toHaveCount(1);
    await expect(table(page, "buses").locator(".ptable-empty")).toHaveCount(0);
  });
  expect(errors).toEqual([]);
});

test("every refusal of the open path has its banner, names the file, and leaves the capture that was open", async ({ page }) => {
  const errors = await openProfiler(page);
  await openMade(page);
  await focusPanel(page);
  await page.keyboard.press("Shift+U");
  await expect(voiceRow(page, "underrun-1.ogg")).toHaveCount(1);
  const good = profilerCapture();
  const refused = async (name: string, bytes: Uint8Array, code: string, text: RegExp | string, id = "error") => {
    await openViaButton(page, name, bytes);
    const b = banner(page, id);
    await expect(b, `${name} is refused`).toBeVisible();
    if (code) await expect(b).toHaveAttribute("data-code", code);
    await expect(b).toContainText(`Can't open ${name}`);
    await expect(b).toContainText(text);
    await expect(b).toHaveAttribute("data-severity", "error");
    await expect(b).toHaveAttribute("role", "alert");
    // The capture that was open is still open and still at the underrun.
    await expect(banner(page, "viewing")).toBeVisible();
    await expect(voiceRow(page, "underrun-1.ogg")).toHaveCount(1);
  };

  await test.step("not a capture: the magic differs", () => refused("junk.mycap", notACapture(), "badMagic", /Not a Myco capture file/));
  await test.step("saved by a newer build", () => refused("newer.mycap", newerFormat(good), "newerFormat", /newer build/));
  await test.step("saved by an older build", () => refused("older.mycap", olderFormat(good), "olderFormat", /older build/));
  await test.step("recorded by a different audio build: the message says re-record, and the banner has its own id", () => refused("wire.mycap", wireMismatch(good), "wireMismatch", /re-record with this build/i, "wireMismatch"));
  await test.step("cut short: damaged files are refused whole", async () => {
    await refused("cut.mycap", cutShort(good), "sizeMismatch", /./);
  });
  await test.step("a header naming more than any capture can hold", () => refused("big-header.mycap", tooLargeHeader(good), "tooLarge", /./));
  await test.step("a header that lies about its size: the inflater is stopped past it", () => refused("bomb.mycap", inflateOverrun(good), "inflateOverrun", /./));
  await test.step("a file too big to be a capture is turned away unread", async () => {
    const path = test.info().outputPath("huge.mycap");
    writeFileSync(path, "");
    truncateSync(path, 66 * 1024 * 1024 + 4096); // sparse: more than the header, a META chunk and 64 MiB
    try {
      await openViaButton(page, "huge.mycap", path);
      await expect(banner(page, "error")).toHaveAttribute("data-code", "tooLarge");
      await expect(banner(page, "error")).toContainText("Can't open huge.mycap");
      await expect(banner(page, "viewing")).toBeVisible();
      await expect(voiceRow(page, "underrun-1.ogg")).toHaveCount(1);
    } finally {
      rmSync(path, { force: true });
    }
  });
  await test.step("a good file clears the refusal", async () => {
    await openMade(page, good, "good.mycap");
    await expect(page.locator(".profiler-banner[data-severity=error]")).toHaveCount(0);
    expect(await bannerIds(page)).toEqual(["viewing"]);
  });
  expect(errors).toEqual([]);
});

test("the Babylon backend live: the Audio Profiler follows the main-side ring and says so", async ({ page }) => {
  const project = JSON.stringify({ ...JSON.parse(readFileSync("samples/flappy/project.json", "utf8")), audio: { backend: "babylon" } });
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await openTestProject(page, { "project.json": project });
  await showTab(page, TAB);
  await expect(panelOf(page).locator(".profiler-empty")).toHaveText(EMPTY_STATES.notPlaying);
  await playGame(page);
  await expect(panelOf(page).locator("canvas.profiler-timeline")).toBeVisible({ timeout: 30_000 });
  await expect(banner(page, "babylon")).toHaveText(BANNER_TEXT.babylon);
  // A live view isn't a file: no "Viewing" banner.
  await expect(banner(page, "viewing")).toHaveCount(0);
  await expect(table(page, "voices")).toBeVisible();
  expect(errors).toEqual([]);
});

// The design's views each say why they are empty ("CPU not yet measured", "Not metered", "Truncated: the ring wrapped",
// "Babylon fallback: no CPU line"; guide, "What the panel shows"): the canvas reports the hovered track and time once per
// frame and the panel shows that track's `tooltipAt` string in a `role="tooltip"` element, hidden on leave.
test("hovering a track with nothing to show says why (the Babylon fallback has no CPU line)", async ({ page }) => {
  await openProfiler(page);
  await openMade(page, profilerCapture({ babylon: true }), "babylon.mycap");
  const canvas = panelOf(page).locator("canvas.profiler-timeline");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  const tip = panelOf(page).getByRole("tooltip");
  await expect(tip).toHaveText(EMPTY_STATES.babylonNoCpu);
  await expect(canvas).toHaveAttribute("aria-describedby", (await tip.getAttribute("id"))!);
  await page.mouse.move(box.x + box.width / 2, box.y - 20);
  await expect(tip).toBeHidden();
});
