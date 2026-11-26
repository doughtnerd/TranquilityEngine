import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  CAPTURE_HEADER_BYTES,
  CAPTURE_FLAG_COMPRESSED,
  EventKind,
  RecordType,
  decodeEvent,
  decodeMarker,
  decodeNames,
  NAME_TABLES,
} from "../../src/plugins/audio/runtime/capture/format";
import { expect, type Page, type Hooks } from "./fixtures";

// Helpers of the export round-trip spec (ADR 0171 amended by 0172, task X3; `audio-mix-d.spec.ts`): export a sample with
// the game build (`src/export/cli.mjs`), serve it with its own `serve.mjs`, drive the exported page's recorder, and read the
// `.sporesample` it saves back in node, so the editor's tables can be checked against what the game was playing.

export interface Served {
  url: string;
  /** The temp directory holding the export (`web/`). */
  dir: string;
  server: ChildProcess;
}

/** Exports `samples/<sample>` into a temp directory (`extra` are the CLI's flags) and serves it on a free port. */
export function exportAndServe(sample: string, extra: string[], port = 0): Promise<Served> {
  return exportProjectAndServe(`samples/${sample}`, extra, sample, port);
}

/**
 * Exports the project folder `project` (a sample, or a copy a spec made) into a temp directory and serves it on `port`
 * (0: a free one).
 */
export function exportProjectAndServe(project: string, extra: string[], label = "project", port = 0): Promise<Served> {
  const dir = mkdtempSync(join(tmpdir(), `myco-export-x3-${label}-`));
  const out = join(dir, "web");
  const result = spawnSync(process.execPath, ["src/export/cli.mjs", project, "--out", out, ...extra], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`export of ${project} failed:\n${result.stdout}\n${result.stderr}`);
  const server = spawn(process.execPath, [join(out, "serve.mjs"), String(port)], { stdio: ["ignore", "pipe", "inherit"] });
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

export function stopServed(s: Served | undefined): void {
  if (!s) return;
  s.server.kill();
  rmSync(s.dir, { recursive: true, force: true });
}

/** Every file under `dir` (relative paths with `/`), for the release export's "no recorder chunk" check. */
export function filesUnder(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full, base) : [full.slice(base.length + 1).replace(/\\/g, "/")];
  });
}

// --- the exported page ------------------------------------------------------------------------------------------------

/** What the exported page's `Audio.debug()` says at one moment: the voices as the game plays them, and each bus's gain. */
export interface Truth {
  /** The heard audio clock (seconds) the reading was taken at. */
  time: number;
  voices: { clip: string; bus: string; state: string }[];
  buses: { name: string; effectiveGain: number; volume: number; mute: boolean }[];
}

type GameApi = {
  Audio: {
    time: number;
    bus(n: string): { volume: number; mute: boolean; effectiveGain: number };
    debug(): { voices: { clip: string; bus: string; state: string }[]; buses: { name: string }[] };
    capture: { state: string; mark(t: string): void };
  };
};

/** `Audio.debug()` of the game, condensed (voices sorted so two readings compare). Read in the page, in one call. */
export function readTruth(page: Page): Promise<Truth> {
  return page.evaluate(() => {
    const { Audio } = (globalThis as unknown as { __myco: GameApi }).__myco;
    const d = Audio.debug();
    const voices = d.voices.map((v) => ({ clip: v.clip, bus: v.bus, state: v.state })).sort((a, b) => (a.clip + a.bus).localeCompare(b.clip + b.bus));
    const buses = d.buses.map((b) => {
      const bus = Audio.bus(b.name);
      return { name: b.name, effectiveGain: bus.effectiveGain, volume: bus.volume, mute: bus.mute };
    });
    return { time: Audio.time, voices, buses };
  });
}

/** Waits until the heard audio clock has run `seconds` (the poll only paces the reads: the bound is audio time, never a wall-clock span). */
export function audioClockRuns(page: Page, seconds: number): Promise<number> {
  return page.evaluate(async (span) => {
    const A = (globalThis as unknown as { __myco: GameApi }).__myco.Audio;
    const t0 = A.time;
    while (A.time < t0 + span) await new Promise((r) => setTimeout(r, 20));
    return A.time - t0;
  }, seconds);
}

export const captureState = (page: Page): Promise<string> => page.evaluate(() => (globalThis as unknown as { __myco: GameApi }).__myco.Audio.capture.state);
export const markCapture = (page: Page, text: string): Promise<void> => page.evaluate((t) => (globalThis as unknown as { __myco: GameApi }).__myco.Audio.capture.mark(t), text);

// --- reading a .sporesample in node ------------------------------------------------------------------------------------------

export interface ParsedVoiceEvent {
  frame: number;
  id: number;
  /** The clip's name (from the file's NAMES), for a start. */
  clip?: string;
}

export interface ParsedCapture {
  sampleRate: number;
  /** Frames of every STATUS record, in file order (what Left and Right step through). */
  status: number[];
  /** Frames of every KEYFRAME. */
  keyframes: number[];
  markers: { frame: number; text: string }[];
  voiceStarts: ParsedVoiceEvent[];
  voiceStops: ParsedVoiceEvent[];
  /** The META chunk's JSON. */
  meta: { project?: { name?: string }; audio?: { buses?: { name: string }[] }; names?: Record<string, Record<string, string>> };
  firstFrame: number;
  flags: number;
}

const CLIP_TABLE = NAME_TABLES.indexOf("clips");

/** Reads the header, META and the records of a saved `.sporesample` (deflate-raw or stored). Frames are core frames. */
export function parseMycap(file: Uint8Array | string): ParsedCapture {
  const bytes = typeof file === "string" ? readFileSync(file) : Buffer.from(file);
  const hv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = hv.getUint16(10, true);
  const metaBytes = hv.getUint32(60, true);
  const body = bytes.subarray(CAPTURE_HEADER_BYTES);
  const payload = flags & CAPTURE_FLAG_COMPRESSED ? inflateRawSync(body) : body;
  const meta = JSON.parse(payload.subarray(0, metaBytes).toString("utf8")) as ParsedCapture["meta"];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const out: ParsedCapture = { sampleRate: hv.getUint32(40, true), status: [], keyframes: [], markers: [], voiceStarts: [], voiceStops: [], meta, firstFrame: hv.getFloat64(88, true), flags };
  const clipNames = new Map<number, string>();
  for (const [id, name] of Object.entries(meta.names?.clips ?? {})) clipNames.set(Number(id), name);
  for (let off = metaBytes; off < payload.byteLength; ) {
    const type = view.getUint8(off);
    const recFlags = view.getUint8(off + 1);
    const len = view.getUint32(off + 4, true);
    const frame = view.getFloat64(off + 12, true);
    const at = off + 20 + (recFlags & 1 ? 8 : 0); // a deferred record starts with an 8 B stamp
    const plen = len - (recFlags & 1 ? 8 : 0);
    if (type === RecordType.STATUS) out.status.push(frame);
    else if (type === RecordType.KEYFRAME) out.keyframes.push(frame);
    else if (type === RecordType.MARKER) out.markers.push({ frame, text: decodeMarker(view, at, plen).text });
    else if (type === RecordType.NAMES) {
      const n = decodeNames(view, at, plen);
      if (n.table === CLIP_TABLE) clipNames.set(n.id, n.name);
    } else if (type === RecordType.EVENT) {
      const e = decodeEvent(view, at, plen);
      if (e.kind === EventKind.voiceStart) out.voiceStarts.push({ frame, id: e.args[0]!, clip: clipNames.get(e.args[1]!) ?? `#${e.args[1]}` });
      else if (e.kind === EventKind.voiceStop) out.voiceStops.push({ frame, id: e.args[0]! });
    }
    off += 20 + len;
  }
  return out;
}

// --- the known scene ----------------------------------------------------------------------------------------------------
//
// The exported Sound Lab, played by its own keys (`samples/sound-lab/scenes/main.scene.json`): the Music loop and the hum play
// from the first frame; B toggles the drum loop on Music, A the noise loop on Ambience, 2 mutes Music, 3 fades it to 0.25 of
// its volume (and back), Z does that for Ambience. Five plateaus, each held on the audio clock well past the 0.5 s fade and
// the core's lookahead, and each read from `Audio.debug()` once it has settled:
//
//   start    music + hum                          (the recording begins)
//   keyframe music + hum + drums, Music faded     (B, 3)
//   between  music (muted) + hum                  (B, 3, 2: the drums stop; the gap before the next voice starts)
//   marker   music + hum + noise, Music back      (A, 2; the marker is dropped inside it)
//   end      music + hum + drums, Ambience faded  (A, B, Z)

export type Position = "start" | "keyframe" | "between" | "marker" | "end";
export const POSITIONS: readonly Position[] = ["start", "keyframe", "between", "marker", "end"];

export interface RecordedScene {
  truths: Record<Position, Truth>;
  /** The saved `.sporesample` (Playwright's download path; it lives until the context closes). */
  file: string;
  fileName: string;
  parsed: ParsedCapture;
}

export const MARKER_TEXT = "x3 marker";

const engineUp = (page: Page) => page.evaluate(() => Boolean((window as unknown as Hooks).engine));
const voicesOf = (t: Truth) => t.voices.map((v) => `${v.clip}@${v.bus}:${v.state}`);

/** Polls the game until `want` holds (the work a key did), then lets the audio clock run `hold` seconds and reads the plateau. */
async function plateau(page: Page, label: string, want: { voices: string[]; gains: Record<string, number> }, hold: number): Promise<Truth> {
  await expect
    .poll(
      async () => {
        const t = await readTruth(page);
        const gains = Object.fromEntries(Object.keys(want.gains).map((b) => [b, Math.round(t.buses.find((x) => x.name === b)!.effectiveGain * 1000) / 1000]));
        return { voices: voicesOf(t), gains };
      },
      { message: `the game reaches the "${label}" plateau`, timeout: 30_000 },
    )
    .toEqual({ voices: want.voices.slice().sort(), gains: want.gains });
  await audioClockRuns(page, hold);
  return readTruth(page);
}

/**
 * Plays the scene above in the exported game at `url` and records it with F9 (start) and F9 (save). Every wait is on the audio
 * clock or on what a key did; nothing is a wall-clock span.
 */
export async function recordScene(page: Page, url: string): Promise<RecordedScene> {
  await page.goto(url);
  await expect.poll(() => engineUp(page), { timeout: 30_000 }).toBe(true);
  await page.locator("#game canvas").click(); // the first gesture starts the audio core
  await expect.poll(async () => (await readTruth(page)).voices.length, { timeout: 30_000, message: "the lab's own loops are playing" }).toBeGreaterThanOrEqual(2);
  await audioClockRuns(page, 1);
  await page.keyboard.press("F9");
  await expect.poll(() => captureState(page), { timeout: 20_000 }).toBe("recording");
  const lab = ["audio/hum-loop.wav@Ambience:playing", "audio/music-loop.wav@Music:playing"];
  const truths = {} as Record<Position, Truth>;
  truths.start = await plateau(page, "start", { voices: lab, gains: { Music: 0.6, Ambience: 0.8 } }, 2);
  await page.keyboard.press("b");
  await page.keyboard.press("3");
  truths.keyframe = await plateau(page, "keyframe", { voices: [...lab, "audio/drum-loop.wav@Music:playing"], gains: { Music: 0.15, Ambience: 0.8 } }, 2.4);
  await page.keyboard.press("b");
  await page.keyboard.press("3");
  await page.keyboard.press("2");
  truths.between = await plateau(page, "between", { voices: ["audio/hum-loop.wav@Ambience:playing", "audio/music-loop.wav@Music:busMuted"], gains: { Music: 0, Ambience: 0.8 } }, 1.6);
  await page.keyboard.press("a");
  await page.keyboard.press("2");
  truths.marker = await plateau(page, "marker", { voices: [...lab, "audio/noise-loop.wav@Ambience:playing"], gains: { Music: 0.6, Ambience: 0.8 } }, 1);
  await markCapture(page, MARKER_TEXT);
  await audioClockRuns(page, 1);
  await page.keyboard.press("a");
  await page.keyboard.press("b");
  await page.keyboard.press("z");
  truths.end = await plateau(page, "end", { voices: [...lab, "audio/drum-loop.wav@Music:playing"], gains: { Music: 0.6, Ambience: 0.2 } }, 1.8);
  const download = page.waitForEvent("download");
  await page.keyboard.press("F9");
  const file = await download;
  const path = (await file.path())!;
  return { truths, file: path, fileName: file.suggestedFilename(), parsed: parseMycap(path) };
}

// --- the cursor positions in the file ------------------------------------------------------------------------------------

export interface CursorPlan {
  /** Frame of each position's anchor (the marker, the chosen keyframe, the block in the middle of the gap), for the report. */
  frames: Record<"keyframe" | "between" | "marker", number>;
  /** ArrowLeft presses from the marker to "between", then from "between" to "keyframe". */
  leftToBetween: number;
  leftToKeyframe: number;
}

/**
 * Where the cursor positions are in the saved file, from the file's own records: the marker (Shift+M lands on it); the block
 * just after the keyframe with the most room inside the drums' plateau (the voice has been in for the fade and a margin, and
 * is not yet stopped); the block in the middle of the gap between the drums' stop and the noise's start (between two voice
 * events). The start and the end are the file's own ends. Left steps one STATUS block back from the cursor.
 */
export function planCursor(p: ParsedCapture): CursorPlan {
  const rate = p.sampleRate;
  const drum = p.voiceStarts.filter((v) => v.clip === "audio/drum-loop.wav");
  const noise = p.voiceStarts.filter((v) => v.clip === "audio/noise-loop.wav");
  const marker = p.markers.find((m) => m.text === MARKER_TEXT);
  if (drum.length < 2 || noise.length < 1 || !marker) throw new Error(`the capture lacks the scene's voices or marker: ${JSON.stringify({ drum, noise, markers: p.markers })}`);
  const drumStop = p.voiceStops.find((s) => s.id === drum[0]!.id);
  if (!drumStop) throw new Error("the first drum voice never stopped in the capture");
  // The keyframe with the largest room: at least the fade (0.5 s) after the drums started, 0.25 s before they stop.
  const lo = drum[0]!.frame + 0.5 * rate;
  const room = (k: number) => Math.min(k - lo, drumStop.frame - 0.25 * rate - k);
  const kf = p.keyframes.reduce((best, k) => (room(k) > room(best) ? k : best), p.keyframes[0]!);
  if (room(kf) <= 0) throw new Error(`no keyframe inside the drums' plateau: ${JSON.stringify({ keyframes: p.keyframes, drum: drum[0], stop: drumStop })}`);
  const midGap = (drumStop.frame + noise[0]!.frame) / 2;
  const firstAfter = (frame: number) => p.status.findIndex((s) => s > frame);
  const kfIdx = firstAfter(kf);
  const gapIdx = p.status.reduce((best, s, i) => (Math.abs(s - midGap) < Math.abs(p.status[best]! - midGap) ? i : best), 0);
  const markerIdx = firstAfter(marker.frame - 1); // the first block at or after the marker: Left from the marker lands one before it
  if (kfIdx < 0 || markerIdx < 0 || !(kfIdx < gapIdx && gapIdx < markerIdx)) throw new Error(`the blocks are out of order: ${JSON.stringify({ kfIdx, gapIdx, markerIdx })}`);
  return {
    frames: { keyframe: kf, between: p.status[gapIdx]!, marker: marker.frame },
    leftToBetween: markerIdx - gapIdx,
    leftToKeyframe: gapIdx - kfIdx,
  };
}

export async function press(page: Page, key: string, times: number): Promise<void> {
  for (let i = 0; i < times; i++) await page.keyboard.press(key);
}
