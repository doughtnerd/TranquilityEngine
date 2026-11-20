// ADR 0171 amended by 0172 (task Ck1; architecture §4.7, §3.3; spike S4's live-edit method): the loopback rig the click
// tests run live edits on. The real host and core backend over the page's mixer, on the real wasm (the test-hooks build),
// with no limiter look-ahead (output frames are core frames); every BATCH posted is decoded with each record's opcode,
// sequence tag and absolute frame. Clips are named by path: S4's two tones (`toneA.wav`, `toneB.wav`: every partial at or
// under 1760 Hz, so a smooth change reads `abrupt` <= 0.23) or a constant 0.5 (`const.wav`).
//
// Timing is the audio clock's: `step(n)` runs n main-thread frames of 4 quanta each (`mixer.update`, the backend frame `tick`,
// `events().update`, then the loopback renders), never a wall clock. Two rigs given the same steps render the same
// samples, so a run without the edit is the reference S4's `abrupt` compares with.
//
// ADR 0221: the rig is `loopbackAudio` (the production assembly on the loopback); this file keeps only the measurement.
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { Kind, Op, readBusRamp, readBusSlot, rampSequenceId } from "../wire.generated";
import { presetFromSettings, type CoreLink } from "../core/context";
import { CommandWriter } from "../core/commandWriter";
import { closeLoopbackAudio, loopbackAudio } from "../testing";

export const RATE = 48_000;
export const QUANTUM = 128;
const CLIP_FRAMES = 48_000;
/** S4: a smooth change of the tones reads at or under this. */
export const SMOOTH = 0.23;
/** S4's click threshold. */
export const CLICK = 0.3;

const tone = (spec: readonly (readonly [number, number])[]): Float32Array => {
  const out = new Float32Array(CLIP_FRAMES);
  for (let i = 0; i < CLIP_FRAMES; i++) {
    let v = 0;
    for (const [hz, a] of spec) v += a * Math.sin((2 * Math.PI * hz * i) / RATE);
    out[i] = v;
  }
  return out;
};

const CLIPS: Record<string, () => Float32Array> = {
  "toneA.wav": () => tone([[220, 0.15], [880, 0.1], [1760, 0.05]]),
  "toneB.wav": () => tone([[330, 0.15], [990, 0.1], [1650, 0.05]]),
  "const.wav": () => new Float32Array(CLIP_FRAMES).fill(0.5),
};

/** One record of a posted BATCH: opcode, sequence tag (0 none), absolute frame (-1 asap). */
export interface PostedRecord {
  op: number;
  seq: number;
  frame: number;
}

/** A posted BATCH: the core frame when it was posted and its records. */
export interface PostedBatch {
  frame: number;
  records: PostedRecord[];
}

/** Closes every rig (its backend and host) and ends the audio session. */
export async function closeRigs(): Promise<void> {
  await closeLoopbackAudio();
}

export type Rig = NonNullable<Awaited<ReturnType<typeof liveRig>>>;

/** The rig over `project`'s audio settings (`parseAudioSettings`); null when the wasm isn't built. */
export async function liveRig(project: unknown) {
  const parsed = parseAudioSettings(project);
  if (parsed.problems.length > 0) throw new Error(parsed.problems.join("; "));
  const settings = parsed.settings;
  const audio = await loopbackAudio({
    settings,
    preset: { ...presetFromSettings(settings), limiterLookaheadMs: 0 },
    decode: (path) => ({ channelData: [(CLIPS[path] ?? CLIPS["const.wav"]!)()] }),
    recovery: { now: () => 0, warn: () => {} },
    dt: 0.003,
  });
  if (!audio) return null;
  const { backend, host } = audio;
  const batches: PostedBatch[] = [];
  const watch = audio.watch();
  /** Moves what the core received since the last call into `batches`: each BATCH's records with their sequence tags. */
  const collect = () => {
    for (const { frame, batch } of watch.takeReceived()) {
      if (batch.kind !== Kind.BATCH) continue;
      const records: PostedRecord[] = batch.records.map((x) => ({
        op: x.opcode,
        seq: x.opcode === Op.BUS_RAMP ? rampSequenceId(readBusRamp(x.view, x.off).shape) : x.opcode === Op.BUS_SLOT ? readBusSlot(x.view, x.off).sequenceId : 0,
        frame: x.frame,
      }));
      batches.push({ frame, records });
    }
  };
  const settle = async () => {
    await audio.settle();
    collect();
  };
  /** `n` main-thread frames of 4 quanta: the rendered left samples, the core frame of the first, the batches posted meanwhile. */
  const step = async (n: number) => {
    collect();
    const from = batches.length;
    const start = audio.frame;
    const out = Array.from((await audio.step(n)).left);
    collect();
    return { start, out, last: out[out.length - 1]!, posted: batches.slice(from) };
  };
  /** Renders `n` single quanta with no main-thread frame (shifts the next frame's phase against the tones). */
  const quanta = async (n: number) => {
    const out: number[] = [];
    for (let k = 0; k < n; k++) for (const v of audio.render(1).left) out.push(v);
    await settle();
    return out;
  };
  const play = (bus: string, path = "const.wav") => backend.play({ path, url: path, loop: true, stream: false, bus });
  return {
    audio,
    host,
    backend,
    step,
    quanta,
    settle,
    /** Every BATCH the core received so far. */
    get batches() {
      collect();
      return batches;
    },
    play,
  };
}

/**
 * The abrupt controls: `write`'s records go out on the rig's link now, in one batch of their own (asap), as a second
 * sender's would, past the backend (no dip, no lane writer).
 */
export function sendRaw(r: { readonly audio: { readonly link: CoreLink; readonly frame: number } }, write: (w: CommandWriter) => void): void {
  const w = new CommandWriter(r.audio.link, RATE);
  write(w);
  w.flush(r.audio.frame);
}

/**
 * The structural sequences among `batches` (each batch holding records with a sequence id), in order: id, F0 (the
 * earliest stamped ramp: the dip-downs), B (the `BUS_SLOT` records' frame) and the planned end (B + `DIP_FRAMES`).
 */
export function sequencesIn(batches: readonly PostedBatch[]): { id: number; f0: number; b: number; end: number }[] {
  const out: { id: number; f0: number; b: number; end: number }[] = [];
  for (const batch of batches) {
    const recs = batch.records.filter((x) => x.seq !== 0);
    if (recs.length === 0) continue;
    const b = recs.find((x) => x.op === Op.BUS_SLOT)?.frame ?? -1;
    out.push({ id: recs[0]!.seq, f0: Math.min(...recs.filter((x) => x.op === Op.BUS_RAMP).map((x) => x.frame)), b, end: b + Math.round(0.02 * RATE) });
  }
  return out;
}

/**
 * S4's measure: `abrupt` = the largest step of (got − reference) over that difference's peak, from `from` on (0 when the
 * difference stays under 1e-5); `pre` whether the two agree exactly before `from`.
 */
export function abrupt(reference: ArrayLike<number>, got: ArrayLike<number>, from: number): { abrupt: number; peak: number; pre: boolean } {
  let step = 0;
  let peak = 0;
  const n = Math.min(reference.length, got.length);
  for (let i = Math.max(from, 1); i < n; i++) {
    const d = got[i]! - reference[i]!;
    const dp = got[i - 1]! - reference[i - 1]!;
    step = Math.max(step, Math.abs(d - dp));
    peak = Math.max(peak, Math.abs(d));
  }
  let pre = true;
  for (let i = 0; i < Math.min(from, n); i++) if (got[i] !== reference[i]) pre = false;
  return { abrupt: peak > 1e-5 ? step / peak : 0, peak, pre };
}
