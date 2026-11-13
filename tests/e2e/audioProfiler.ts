import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import {
  CAPTURE_HEADER_BYTES,
  CAPTURE_FLAG_COMPRESSED,
  EventKind,
  RecordType,
  assembleCapture,
  type CaptureMetaInit,
  type CaptureRecordInit,
  type KeyframePayload,
} from "../../src/plugins/audio/runtime/capture/format";
import { STATUS_BUFFER_BYTES, writeStatus, type StatusBlock } from "../../src/plugins/audio/runtime/wire.generated";
import type { Locator, Page } from "./fixtures";

// Fixtures and helpers of the Audio Profiler e2e spec (ADR 0171 amended by 0172, task E1; `audio-mix-a.spec.ts`).
//
// The captures here are made by the runtime's own encoders (`assembleCapture` and the records' writers of `format.ts`,
// `statusBytesWith` of the capture tests' support), never stored as binaries: `profilerCapture` builds a ten-second file
// whose every table row, underrun, late command, ladder step and marker is at a frame this file chooses, so a test says
// exactly where the cursor should land and what the tables should show there. The refusals are that same file with a
// header field changed, a cut, or a name that isn't `.mycap`.

/**
 * A STATUS block with every header field 0 and every section empty, `fields` laid over it: the same object `makeStatusBlock`
 * (`core/mirror.ts`, a test helper) builds. It is copied here because that module reaches the editor's worker imports, which
 * `tsconfig.node.json`'s typecheck of these specs can't resolve; a field added to `StatusBlock` is a type error here.
 */
function statusBlock(fields: Partial<StatusBlock> & { currentFrame: number }): StatusBlock {
  return {
    dateMs: 0,
    pingSeq: 0,
    pingFrameLo: 0,
    underruns: 0,
    lateCommands: 0,
    workUnits: 0,
    workUnitsMax: 0,
    mixedVoices: 0,
    liveVoices: 0,
    flags: 0,
    mixedCap: 0,
    loadPermille: 0,
    traps: 0,
    minSlackFrames: 0,
    underrunFrames: 0,
    arenaUsedKB: 0,
    arenaLargestFreeKB: 0,
    abiVersion: 0,
    maxLatenessFrames: 0,
    hrtfVoices: 0,
    hrtfLoadFailure: 0,
    bedVoices: 0,
    fxVoices: 0,
    ambisonicVoices: 0,
    zonesActive: 0,
    zonesRinging: 0,
    bedsRefused: 0,
    m3Shed: 0,
    zoneUsedKB: 0,
    workBed: 0,
    workZones: 0,
    musicRingsOpen: 0,
    streamStartsLate: 0,
    groupsLate: 0,
    groupsHeld: 0,
    groupsAbandoned: 0,
    curvePoolFull: 0,
    maxSlipFrames: 0,
    splitQuanta: 0,
    voiceSplits: 0,
    reserved: 0,
    busyMsTotal: 0,
    quantaTotal: 0,
    wuVoices: 0,
    wuBuses: 0,
    wuSpatial: 0,
    wuMusic: 0,
    wuLoudness: 0,
    clockStepMs: 0,
    loudSubBlockFrames: 0,
    clockSteps: 0,
    loudShed: 0,
    busRecordsEarly: 0,
    sidechainLate: 0,
    reserved2: 0,
    ended: [],
    demoted: [],
    starved: [],
    playheads: [],
    clipEvents: [],
    streamEvents: [],
    peaks: [],
    beds: [],
    zones: [],
    zoneEvents: [],
    musicRings: [],
    groupStarts: [],
    loudBuses: [],
    loudEnergies: [],
    busDuck: [],
    ...fields,
  };
}

/** A real wire STATUS block's bytes (what the recorder copies) with `fields` set. */
function statusBytesWith(fields: Partial<StatusBlock> & { currentFrame: number }): Uint8Array {
  const buf = new Uint8Array(STATUS_BUFFER_BYTES);
  const n = writeStatus(new DataView(buf.buffer), 0, statusBlock(fields), 1);
  return buf.slice(0, n);
}

const SAMPLE_HEADER = { sampleRate: 48_000, preset: 1, startDateMs: 1_763_000_000_000, ringBytes: 16 * 1024 * 1024, firstFrame: 0 };

export const RATE = 48_000;
/** One STATUS block: `STATUS_EVERY_QUANTA` (6) quanta of 128 frames. */
export const BLOCK = 768;
export const SECONDS = 10;
export const BLOCKS = Math.floor((SECONDS * RATE) / BLOCK);

/** The sound-lab project's `audio` section: the same one the open project has, so the capture shows no mismatch banner. */
const SOUND_LAB = JSON.parse(readFileSync(join(process.cwd(), "samples/sound-lab/project.json"), "utf8")) as { audio: { buses: { name: string }[] } };
export const PROJECT_AUDIO = SOUND_LAB.audio;
const BUS_NAMES = PROJECT_AUDIO.buses.map((b) => b.name);
const slot = (name: string): number => BUS_NAMES.indexOf(name);

/** The STATUS blocks the markers and counters sit at (block `k` is at frame `k * BLOCK`). */
export const AT = {
  underrun1: 188,
  underrun2: 438,
  lateCommand: 300,
  ladderShed: 520,
  ladderRestored: 560,
} as const;
export const blockSeconds = (k: number): number => (k * BLOCK) / RATE;
/** Markers (frames) and their texts. */
export const MARKERS = [
  { frame: 96_000, text: "intro ends" },
  { frame: 432_000, text: "boss phase 2" },
] as const;

/** One voice of the capture: alive for `start <= frame < stop`. Ids stay in a name so a test finds the row. */
interface CapVoice {
  id: number;
  clip: string;
  bus: string;
  start: number;
  stop: number;
}

const CLIPS = ["jump.ogg", "theme-loop.ogg", "rain-loop.ogg", "underrun-1.ogg", "underrun-2.ogg", "late-1.ogg", "ladder-shed.ogg", "marker-1.ogg", "marker-2.ogg", "scrub-a.ogg", "scrub-b.ogg"];
const clipId = (name: string): number => CLIPS.indexOf(name) + 1;
const EVENTS = ["Explosion", "Footstep", "Boss theme"];
const eventId = (name: string): number => EVENTS.indexOf(name) + 1;

/**
 * Three voices that live the whole capture, one voice just before each jump target (alive until a thousand frames past it, so
 * the cursor at the target sees it and the cursor one STATUS block earlier does not), and two long ones for the scrub (3.5 to 4.5 s and 5.5 to 6.8 s: clear of every target).
 */
export const VOICES: readonly CapVoice[] = [
  { id: 1, clip: "jump.ogg", bus: "SFX", start: 1000, stop: Infinity },
  { id: 2, clip: "theme-loop.ogg", bus: "Music", start: 1000, stop: Infinity },
  { id: 3, clip: "rain-loop.ogg", bus: "Ambience", start: 1000, stop: Infinity },
  { id: 10, clip: "underrun-1.ogg", bus: "UI", start: AT.underrun1 * BLOCK - 100, stop: AT.underrun1 * BLOCK + 1000 },
  { id: 11, clip: "underrun-2.ogg", bus: "UI", start: AT.underrun2 * BLOCK - 100, stop: AT.underrun2 * BLOCK + 1000 },
  { id: 12, clip: "late-1.ogg", bus: "UI", start: AT.lateCommand * BLOCK - 100, stop: AT.lateCommand * BLOCK + 1000 },
  { id: 13, clip: "ladder-shed.ogg", bus: "UI", start: AT.ladderShed * BLOCK - 100, stop: AT.ladderShed * BLOCK + 1000 },
  { id: 14, clip: "marker-1.ogg", bus: "UI", start: MARKERS[0].frame - 100, stop: MARKERS[0].frame + 1000 },
  { id: 15, clip: "marker-2.ogg", bus: "UI", start: MARKERS[1].frame - 100, stop: MARKERS[1].frame + 1000 },
  { id: 20, clip: "scrub-a.ogg", bus: "SFX", start: 3.5 * RATE, stop: 4.5 * RATE },
  { id: 21, clip: "scrub-b.ogg", bus: "SFX", start: 5.5 * RATE, stop: 6.8 * RATE },
];

export const EVENT_INSTANCES = [
  { id: 1, name: "Explosion", voices: 2 },
  { id: 2, name: "Footstep", voices: 1 },
] as const;

const aliveAt = (frame: number): CapVoice[] => VOICES.filter((v) => v.start <= frame && frame < v.stop);

function keyframe(frame: number, rich: boolean): KeyframePayload {
  const bus = (name: string, volume: number) => ({
    slot: slot(name),
    gen: 1,
    flags: 0,
    lanes: [volume, volume, 1, 1, 1, 1, 1, 1, 1, 1],
    duck: 1,
    automation: 1,
  });
  return {
    voices: rich
      ? aliveAt(frame).map((v) => ({ id: v.id, clip: clipId(v.clip), slot: slot(v.bus), state: 0, priority: 128, reason: 0, gain: 0.5, pitch: 4096, audibility: 32768, playheadFrames: frame - v.start }))
      : [],
    buses: rich ? PROJECT_AUDIO.buses.map((b) => bus(b.name, (b as { volume?: number }).volume ?? 1)) : [],
    metered: [],
    events: rich ? EVENT_INSTANCES.map((e) => ({ id: e.id, asset: eventId(e.name), voices: e.voices, state: 0, paramsHash: 0 })) : [],
    music: rich ? [{ id: 1, segment: eventId("Boss theme"), state: 1, pass: 1, bar: 1, beat: 1, tick: 0, tempo: 120, pendingTo: 0xffffffff, pendingTimeSec: 0 }] : [],
    mix: { slotTableVersion: 0, monitorActive: 0, loudnessPausedMask: 0, targetIndex: 0, snapshotName: 0, masterVolume: 1, hiddenMute: 0 },
  };
}

export interface CaptureOptions {
  /** The header's `truncated` flag, and the first keyframe at `firstKeyframeSeconds` rather than at the start. */
  truncated?: boolean;
  /** The Babylon fallback: no STATUS records, `mainSideOnly`. */
  babylon?: boolean;
  /** A keyframe with no rows at all (every table's empty text). */
  empty?: boolean;
  /** The META `audio` section (default: the sound-lab's, which the open project has too). */
  audio?: unknown;
  /** The seconds before which the file has no keyframe (default 0: one at the first STATUS). */
  firstKeyframeSeconds?: number;
}

/** The ten-second capture, stored (uncompressed) with its INDEX. */
export function profilerCapture(opts: CaptureOptions = {}): Uint8Array {
  const rich = !opts.empty;
  const meta: CaptureMetaInit = {
    project: { name: "sound-lab", version: "1.0.0" },
    engine: "myco e2e",
    device: { preset: 1, sampleRate: RATE, deviceMemory: 8, userAgent: "playwright" },
    audio: opts.audio ?? PROJECT_AUDIO,
    target: null,
    names: {
      clips: Object.fromEntries(CLIPS.map((c, i) => [i + 1, c])),
      buses: Object.fromEntries(BUS_NAMES.map((n, i) => [i, n])),
      events: Object.fromEntries(EVENTS.map((n, i) => [i + 1, n])),
      parameters: {},
      snapshots: {},
      targets: {},
    },
  };
  // Everything with a frame, sorted by frame (events before the keyframe and STATUS of the same frame, so a keyframe at `f` holds what happened up to `f`).
  type Item = { frame: number; order: number; make: (seq: number) => CaptureRecordInit };
  const items: Item[] = [];
  const add = (frame: number, order: number, make: (seq: number) => CaptureRecordInit) => items.push({ frame, order, make });
  add(0, 0, (seq) => ({ type: RecordType.EPOCH, epoch: 0, seq, frame: 0, payload: { reason: 0, sampleRate: RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0, perfMs: 1000 } }));
  if (rich) {
    for (const v of VOICES) {
      add(v.start, 1, (seq) => ({ type: RecordType.EVENT, epoch: 0, seq, frame: v.start, payload: { perfMs: 1000 + v.start / 48, kind: EventKind.voiceStart, reason: 0, args: [v.id, clipId(v.clip), (1 << 8) | slot(v.bus), 0, v.start], f32: 0.5 } }));
      if (Number.isFinite(v.stop)) add(v.stop, 1, (seq) => ({ type: RecordType.EVENT, epoch: 0, seq, frame: v.stop, payload: { perfMs: 1000 + v.stop / 48, kind: EventKind.voiceStop, reason: 2, args: [v.id] } }));
    }
  }
  for (const m of MARKERS) add(m.frame, 1, (seq) => ({ type: RecordType.MARKER, epoch: 0, seq, frame: m.frame, payload: { perfMs: 1000 + m.frame / 48, text: m.text } }));
  const firstKeyframe = Math.round((opts.firstKeyframeSeconds ?? 0) * RATE);
  let second = -1;
  for (let k = 1; k <= BLOCKS; k++) {
    const frame = k * BLOCK;
    const s = Math.floor(frame / RATE);
    if (s !== second) {
      second = s;
      if (frame >= firstKeyframe) add(frame, 2, (seq) => ({ type: RecordType.KEYFRAME, epoch: 0, seq, frame, payload: keyframe(frame, rich) }));
    }
    if (!opts.babylon) {
      const underruns = (k >= AT.underrun1 ? 1 : 0) + (k >= AT.underrun2 ? 1 : 0);
      const fields = {
        currentFrame: frame,
        underruns,
        lateCommands: k >= AT.lateCommand ? 1 : 0,
        minSlackFrames: k === AT.underrun1 || k === AT.underrun2 ? -50 : 400,
        m3Shed: k >= AT.ladderShed && k < AT.ladderRestored ? 1 : 0,
        loadPermille: 300,
        mixedVoices: aliveAt(frame).length,
        liveVoices: aliveAt(frame).length,
      };
      add(frame, 3, (seq) => ({ type: RecordType.STATUS, epoch: 0, seq, frame, payload: statusBytesWith(fields) }));
    }
  }
  items.sort((a, b) => a.frame - b.frame || a.order - b.order);
  const records = items.map((it, i) => it.make(i + 1));
  return assembleCapture(
    { ...SAMPLE_HEADER, truncated: opts.truncated ?? false, mainSideOnly: opts.babylon ?? false },
    meta,
    records,
    { index: true },
  );
}

// --- the refusals: the same file with something wrong ------------------------------------------------------------------

const withHeader = (bytes: Uint8Array, edit: (view: DataView) => void): Uint8Array => {
  const out = bytes.slice();
  edit(new DataView(out.buffer));
  return out;
};

/** A file that isn't a capture at all (the magic differs). */
export const notACapture = (): Uint8Array => new TextEncoder().encode("this is not a Myco capture, only text ".repeat(8));
/** `format` above this build's. */
export const newerFormat = (bytes: Uint8Array): Uint8Array => withHeader(bytes, (v) => v.setUint16(8, 2, true));
/** `format` below this build's. */
export const olderFormat = (bytes: Uint8Array): Uint8Array => withHeader(bytes, (v) => v.setUint16(8, 0, true));
/** Another audio build's wire: one byte of the schema hash differs. */
export const wireMismatch = (bytes: Uint8Array): Uint8Array => withHeader(bytes, (v) => v.setUint8(12, v.getUint8(12) ^ 0xff));
/** The file cut short: the header's sizes now disagree with what is there. */
export const cutShort = (bytes: Uint8Array): Uint8Array => bytes.slice(0, bytes.byteLength - 4000);
/** A header that names more uncompressed bytes than any capture can hold (64 MiB cap). */
export const tooLargeHeader = (bytes: Uint8Array): Uint8Array => withHeader(bytes, (v) => v.setUint32(68, 70 * 1024 * 1024, true));
/** A compressed file whose header lies about its size (a deflate bomb's shape): the inflater runs past it. */
export function inflateOverrun(bytes: Uint8Array): Uint8Array {
  const body = deflateRawSync(bytes.subarray(CAPTURE_HEADER_BYTES));
  const out = new Uint8Array(CAPTURE_HEADER_BYTES + body.byteLength);
  out.set(bytes.subarray(0, CAPTURE_HEADER_BYTES));
  out.set(body, CAPTURE_HEADER_BYTES);
  const v = new DataView(out.buffer);
  // The header claims the payload is smaller than it inflates to (meta + records must still add up to it).
  const meta = v.getUint32(60, true);
  v.setUint32(64, 40, true);
  v.setUint32(68, meta + 40, true);
  v.setUint32(72, 1, true);
  v.setUint32(76, 0, true);
  // Compressed, and no INDEX (indexBytes is 0 above).
  v.setUint16(10, (v.getUint16(10, true) & ~0b100) | CAPTURE_FLAG_COMPRESSED, true);
  return out;
}

// --- page helpers -------------------------------------------------------------------------------------------------------

export const panelOf = (page: Page): Locator => page.locator("section.profiler");
export const barButton = (page: Page, name: string): Locator => panelOf(page).locator(`.profiler-bar [data-action=${name}]`);
export const banner = (page: Page, id: string): Locator => panelOf(page).locator(`.profiler-banner[data-banner=${id}]`);
export const table = (page: Page, name: "voices" | "buses" | "events" | "music"): Locator => panelOf(page).locator(`.ptable[data-table=${name}]`);
/** The cells' texts of every body row of a table (the head row is `.pgrid-head`). */
export const clipsIn = async (page: Page, name: "voices" | "buses" | "events" | "music"): Promise<string[]> =>
  (await table(page, name).locator(".pgrid-row").allInnerTexts()).map((t) => t.replace(/\n/g, " | "));
export const filterBox = (page: Page): Locator => panelOf(page).getByRole("searchbox", { name: "Filter tables by name" });

/** Drops `bytes` as a file called `name` on the panel, the way the browser does (a `drop` event carrying a `DataTransfer`). */
export async function dropFile(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.evaluate(
    ([n, b64]) => {
      const raw = atob(b64 as string);
      const data = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([data], n as string));
      const panel = document.querySelector("section.profiler")!;
      panel.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      panel.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    [name, Buffer.from(bytes).toString("base64")] as const,
  );
}
