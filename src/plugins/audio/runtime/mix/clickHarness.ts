// ADR 0171 amended by 0172 (task Ck1; architecture §4.7, §3.3; spike S4's live-edit method): the loopback rig the click
// tests run live edits on. The real host and core backend over the page's mixer, on the real wasm (the test-hooks build),
// with no limiter look-ahead (output frames are core frames); every BATCH posted is decoded with each record's opcode,
// sequence tag and absolute frame. Clips are named by path: S4's two tones (`toneA.wav`, `toneB.wav`: every partial at or
// under 1760 Hz, so a smooth change reads `abrupt` <= 0.23) or a constant 0.5 (`const.wav`).
//
// Timing is the audio clock's: `step(n)` runs n main-thread frames of 4 quanta each (`mixer.update`, `backend.update`,
// `events().update`, then the loopback renders), never a wall clock. Two rigs given the same steps render the same
// samples, so a run without the edit is the reference S4's `abrupt` compares with.
import { mixer } from "../../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { Kind, Op, readBatchHeader, readBusRamp, readBusSlot, readEnvelope, readRecordHead, rampSequenceId } from "../wire.generated";
import { setAudioBackend } from "../backend";
import { events } from "../events/eventRuntime";
import { fakeDecoder } from "../core/fakeDecoder";
import { createClipRegistry } from "../core/clipRegistry";
import { AudioHost, presetFromSettings } from "../core/context";
import { createCoreBackend, type CoreBackend } from "../core/coreBackend";
import { watchForTraps } from "../core/recovery";
import { Unlock, type UnlockContext } from "../core/unlock";

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

/** Every host the rigs made, for `closeRigs` in an `afterEach`. */
const hosts: AudioHost[] = [];

/** Closes every rig's host and clears the page's backend. */
export async function closeRigs(): Promise<void> {
  events()._reset();
  setAudioBackend(null);
  for (const host of hosts.splice(0)) await host.close();
}

function fakeContext() {
  const ctx = {
    state: "running",
    sampleRate: RATE,
    destination: {},
    resume: () => Promise.resolve(),
    close: () => {
      ctx.state = "closed";
      return Promise.resolve();
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return ctx;
}

export type Rig = NonNullable<Awaited<ReturnType<typeof liveRig>>>;

/** The rig over `project`'s audio settings (`parseAudioSettings`); null when the wasm isn't built. */
export async function liveRig(project: unknown) {
  const testing = await import("../testing");
  const parsed = parseAudioSettings(project);
  if (parsed.problems.length > 0) throw new Error(parsed.problems.join("; "));
  const settings = parsed.settings;
  const preset = { ...presetFromSettings(settings), limiterLookaheadMs: 0 };
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>>;
  try {
    loop = await testing.createLoopbackHost({ testHooks: true, preset });
  } catch {
    return null;
  }
  const context = fakeContext();
  const node = Object.assign(new EventTarget(), { connect() {}, disconnect() {} }) as unknown as AudioWorkletNode;
  const unlock = new Unlock({ target: new EventTarget(), context: context as unknown as UnlockContext });
  const host = AudioHost._create({ context: context as unknown as AudioContext, node, link: loop.link, unlock, preset, respawn: () => loop.respawn() });
  hosts.push(host);
  const link = loop.link;
  const batches: PostedBatch[] = [];
  const post = link.post.bind(link);
  link.post = ((buffer: ArrayBuffer, ...rest: unknown[]) => {
    const view = new DataView(buffer);
    if (readEnvelope(view, 0).kind === Kind.BATCH) {
      const header = readBatchHeader(view, 0);
      const records: PostedRecord[] = [];
      let off = 32;
      for (let i = 0; i < header.count; i++) {
        const head = readRecordHead(view, off);
        const seq = head.opcode === Op.BUS_RAMP ? rampSequenceId(readBusRamp(view, off).shape) : head.opcode === Op.BUS_SLOT ? readBusSlot(view, off).sequenceId : 0;
        records.push({ op: head.opcode, seq, frame: head.frameOffset === 0xffffffff ? -1 : header.firstFrame + head.frameOffset });
        off += head.words * 4;
      }
      batches.push({ frame: loop.frame, records });
    }
    return (post as (b: ArrayBuffer, ...r: unknown[]) => void)(buffer, ...rest);
  }) as typeof link.post;
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async (path) => new TextEncoder().encode(path).buffer as ArrayBuffer,
    decodeWorker: fakeDecoder((bytes) => {
      const make = CLIPS[new TextDecoder().decode(bytes)] ?? CLIPS["const.wav"]!;
      return { frames: CLIP_FRAMES, channels: 1, sampleRate: RATE, channelData: [make()] };
    }),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  mixer.configure(settings);
  const backend: CoreBackend = createCoreBackend(host, { clips, clock: loop.clock, mixer });
  watchForTraps(host, { now: () => 0, warn: () => {} });
  events()._reset();
  setAudioBackend(backend);
  const settle = async () => {
    for (let k = 0; k < 8; k++) await Promise.resolve();
  };
  /** `n` main-thread frames of 4 quanta: the rendered left samples, the core frame of the first, the batches posted meanwhile. */
  const step = async (n: number) => {
    const from = batches.length;
    const out: number[] = [];
    const start = loop.frame;
    for (let f = 0; f < n; f++) {
      mixer.update(0.003);
      backend.update(0.003);
      events().update(0.003);
      const { left } = loop.renderQuanta(4);
      for (const v of left) out.push(v);
      await settle();
    }
    return { start, out, last: out[out.length - 1]!, posted: batches.slice(from) };
  };
  /** Renders `n` single quanta with no main-thread frame (shifts the next frame's phase against the tones). */
  const quanta = async (n: number) => {
    const out: number[] = [];
    for (let k = 0; k < n; k++) for (const v of loop.renderQuanta(1).left) out.push(v);
    await settle();
    return out;
  };
  const play = (bus: string, path = "const.wav") => backend.play({ path, url: path, loop: true, stream: false, bus });
  return { loop, host, backend, step, quanta, settle, batches, play };
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
