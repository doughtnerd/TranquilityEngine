// @internal Tests only (Pf6): a recorded scene's STATUS stream with loudness sections, saved as a capture file, and what the
// live meter read at the same times. The scene feeds a real `LoudnessHub` (decoded STATUS blocks, float32 energies as on the
// wire) while it writes the records, so a test can open the file through the Worker and compare. Never imported by runtime code.
import { LoudnessHub } from "../../runtime/mix/loudnessHub";
import { LoudnessTrackModel } from "./loudnessTrackModel";
import { LOUD_OUTPUT_TAP, readStatus } from "../../runtime/wire.generated";
import {
  RecordType, assembleCapture, type CaptureRecordInit, type KeyframeMetered, type KeyframePayload,
} from "../../runtime/capture/format";
import { EMPTY_KEYFRAME_PAYLOAD, SAMPLE_HEADER, SAMPLE_META, SAMPLE_RATE, statusBytesWith } from "../../runtime/capture/testSupport";

export const MUSIC_SLOT = 1;
/** STATUS blocks in the scene; each carries `PER_STATUS` sub-blocks (0.5 s of audio). */
export const STATUSES = 80;
export const PER_STATUS = 5;
export const FRAMES_PER_STATUS = (SAMPLE_RATE * PER_STATUS) / 10;
const NO_NAME = 0xffffffff;
const PARAM_MUSIC = 7;
const PARAM_MASTER = 8;

/** Mean-square energy whose LUFS is `lufs`. */
const energyOf = (lufs: number): number => Math.pow(10, (lufs + 0.691) / 10);

/** What a live `BusLoudness` reads. */
export interface Reading {
  momentary: number;
  shortTerm: number;
  integrated: number;
  lra: number;
  maxTruePeak: number;
  incomplete: boolean;
}

/** One comparison point: the live hub's reading of `slot` at axis time `t`. */
export interface Expected {
  slot: number;
  t: number;
  /** The status index (-1 for a point after a control EVENT only). */
  status: number;
  /** True for a point read after a loudnessControl EVENT. */
  afterEvent: boolean;
  live: Reading;
  /** The newest KEYFRAME's integrated reading of the bus at that point (as stored: f32), null before the first. */
  keyframeIntegrated: number | null;
}

export interface Scene {
  file: Uint8Array;
  records: CaptureRecordInit[];
  expected: Expected[];
  /** A model fed the scene's records directly (the Worker's walk written out by hand), for series and marks. */
  reference: LoudnessTrackModel;
  /** The STATUS times, seconds. */
  statusTimes: number[];
}

export interface SceneOptions {
  /** Cut the capture to start at the KEYFRAME written before this status (a ring-truncated file). */
  cutFromStatus?: number;
}

function read(hub: LoudnessHub, name: string): Reading {
  const b = hub.busLoudness(name)!;
  return { momentary: b.momentary, shortTerm: b.shortTerm, integrated: b.integrated, lra: b.lra, maxTruePeak: b.maxTruePeak, incomplete: b.incomplete };
}

export function buildScene(opts: SceneOptions = {}): Scene {
  const hub = new LoudnessHub();
  hub.configure({
    available: true, root: "Master",
    buses: [{ name: "Master", parent: null, slot: 0, metered: true }, { name: "Music", parent: "Master", slot: MUSIC_SLOT, metered: true }],
  });
  const reference = new LoudnessTrackModel(opts.cutFromStatus === undefined ? "replay" : "seek");
  const records: CaptureRecordInit[] = [];
  const expected: Expected[] = [];
  const statusTimes: number[] = [];
  let seq = 0;
  const push = (x: Omit<CaptureRecordInit, "seq">): void => void records.push({ ...x, seq: ++seq } as CaptureRecordInit);
  push({ type: RecordType.EPOCH, epoch: 0, frame: 0, payload: { reason: 0, sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0, perfMs: 1000 } });

  const lastKeyframe = new Map<number, KeyframeMetered>();
  const cut = opts.cutFromStatus ?? 0;
  let k = 0; // the status being written (the reference and the keyframe memory only take the records the file keeps)
  const kept = (): boolean => k >= cut;
  const points = (t: number, status: number, afterEvent: boolean): void => {
    for (const [name, slot] of [["Music", MUSIC_SLOT], ["Master", LOUD_OUTPUT_TAP]] as const) {
      const kf = lastKeyframe.get(slot);
      expected.push({ slot, t, status, afterEvent, live: read(hub, name), keyframeIntegrated: kf ? kf.integrated : null });
    }
  };
  const control = (afterStatus: number, frame: number, nameId: number, reason: number, apply: () => void, slot: number | undefined): void => {
    push({ type: RecordType.EVENT, epoch: 0, frame, payload: { perfMs: 1000 + frame / 48, kind: 16, reason, args: [nameId] } });
    apply();
    if (kept()) reference.control(frame / SAMPLE_RATE, reason === 1 ? { kind: "reset" } : reason === 2 ? { kind: "pause" } : { kind: "resume" }, slot);
    points(frame / SAMPLE_RATE + 0.01, afterStatus, true);
  };

  let sub = 0; // next sub-block index per bus (both buses advance together)
  for (k = 0; k < STATUSES; k++) {
    const frame = FRAMES_PER_STATUS * (k + 1);
    const time = frame / SAMPLE_RATE;
    const shed = k >= 30 && k < 35 ? 1 : 0;
    if (k % 2 === 0) {
      const metered: KeyframeMetered[] = [];
      for (const [name, slot] of [["Music", MUSIC_SLOT], ["Master", LOUD_OUTPUT_TAP]] as const) {
        const r = read(hub, name);
        // As stored on the wire: f32.
        const m: KeyframeMetered = {
          slot, flags: r.incomplete ? 2 : 0, momentary: Math.fround(r.momentary), shortTerm: Math.fround(r.shortTerm), integrated: Math.fround(r.integrated),
          lra: Math.fround(r.lra), maxTruePeak: Math.fround(r.maxTruePeak), maxMomentary: 0, elapsed: 0,
        };
        metered.push(m);
      }
      const payload: KeyframePayload = { ...EMPTY_KEYFRAME_PAYLOAD, metered };
      push({ type: RecordType.KEYFRAME, epoch: 0, frame, payload });
      if (kept()) {
        reference.addKeyframe(time, metered);
        for (const m of metered) lastKeyframe.set(m.slot, m);
      }
    }
    const count = shed ? 0 : PER_STATUS;
    const energies: number[] = [];
    for (const lufs of [(b: number) => (b < 200 ? -30 : -20), (b: number) => (b < 200 ? -23 : -14)]) for (let j = 0; j < count; j++) energies.push(energyOf(lufs(sub + j)));
    const peak = k === 25 ? 1.2 : 0.3 + 0.01 * (k % 7);
    const loudBuses = [
      { slot: MUSIC_SLOT, flags: count, firstSeq: sub, truePeak: peak, gatedQuanta: 0 },
      { slot: LOUD_OUTPUT_TAP, flags: count, firstSeq: sub, truePeak: peak, gatedQuanta: 0 },
    ];
    const bytes = statusBytesWith({ currentFrame: frame, loudShed: shed, loudBuses, loudEnergies: energies });
    push({ type: RecordType.STATUS, epoch: 0, frame, payload: bytes });
    // The live path: the decoded block (float32 energies) goes to the hub.
    const decoded = readStatus(bytes);
    hub.feed(decoded);
    if (kept()) reference.feed({ time, loudShed: decoded.loudShed, loudBuses: decoded.loudBuses, loudEnergies: decoded.loudEnergies });
    sub += PER_STATUS;
    statusTimes.push(time);
    points(time + 0.01, k, false);
    const at = frame + 1000;
    if (k === 20) control(k, at, PARAM_MUSIC, 2, () => hub.busLoudness("Music")!.pause(), MUSIC_SLOT);
    if (k === 24) control(k, at, PARAM_MUSIC, 3, () => hub.busLoudness("Music")!.resume(), MUSIC_SLOT);
    if (k === 40) control(k, at, PARAM_MASTER, 2, () => hub.busLoudness("Master")!.pause(), LOUD_OUTPUT_TAP);
    if (k === 42) control(k, at, PARAM_MASTER, 3, () => hub.busLoudness("Master")!.resume(), LOUD_OUTPUT_TAP);
    if (k === 60) control(k, at, NO_NAME, 1, () => { hub.busLoudness("Music")!.reset(); hub.busLoudness("Master")!.reset(); }, undefined);
  }

  let init = records;
  let header = SAMPLE_HEADER;
  if (opts.cutFromStatus !== undefined) {
    const at0 = records.findIndex((r) => r.type === RecordType.KEYFRAME && r.frame === FRAMES_PER_STATUS * (opts.cutFromStatus! + 1));
    if (at0 < 0) throw new Error(`no keyframe before status ${opts.cutFromStatus}`);
    init = records.slice(at0);
    header = { ...SAMPLE_HEADER, truncated: true };
  }
  const meta = { ...SAMPLE_META, names: { ...SAMPLE_META.names, parameters: { [PARAM_MUSIC]: "Music", [PARAM_MASTER]: "Master" } } };
  return { file: assembleCapture(header, meta, init, { index: true, truncatedFromSeq: opts.cutFromStatus === undefined ? 0 : init[0]!.seq }), records: init, expected, reference, statusTimes };
}
