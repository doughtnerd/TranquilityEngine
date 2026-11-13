// ADR 0171 amended by 0172 (task Fg1; api-and-models §6.6, architecture §4.7 and §7): the fader gate's harness.
//
// The gate is measured on the AUDIO CLOCK: from the input event's timestamp to the first core sample that differs from the
// no-edit render, in frames the loopback host rendered converted at its rate. Nothing here reads a wall clock: the
// simulated main thread keeps one virtual time in audio-clock milliseconds, `LiveMix`'s `nowMs` and `setTimer` are
// pointed at it, and a drag's events, the coalescing timer and the main-thread frames are all events on it.
//
// The model (the loopback host has no threads): between two quanta the main thread runs every event whose time is at or
// before the next quantum's first frame (an event inside a quantum is seen by the worklet before the next one, as a posted
// message is); the host then renders one quantum. So an event at time `e` posts at `max(e, window end)`, reaches the core
// at the first quantum start at or after that, and the first changed sample follows from the core's own asap rule.
//
// A drag = 3..10 `setBus volume` events (`mixer.apply` + `backend.flushNow()`, the preview path) at 1..16.7 ms spacing,
// from the volume the bus holds to a new one. Variation (seeded): the start phase inside a quantum (fractional ms), the
// phase and cadence of the main-thread frame (8.3, 16.7, 33.3, 50 ms: `mixer.update`, `backend.update`), and, on half the
// drags, an edit of a silent bus posted 0.2..3.8 ms before the first event so the first event lands inside the coalescing
// window and waits for its end.
import { mixer, DRAG_RAMP_MS } from "../../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { Kind, LANE_AUTHORED, Op, readBatchHeader, readBusRamp, readEnvelope, readRecordHead } from "../wire.generated";
import { setAudioBackend } from "../backend";
import { events } from "../events/eventRuntime";
import { fakeDecoder } from "../core/fakeDecoder";
import { createClipRegistry } from "../core/clipRegistry";
import { AudioHost, presetFromSettings } from "../core/context";
import { createCoreBackend, type CoreBackend } from "../core/coreBackend";
import { Unlock, type UnlockContext } from "../core/unlock";

export const RATE = 48_000;
export const QUANTUM = 128;
export const LEVEL = 0.5;
export const CLIP_FRAMES = 48_000;
/** Main-thread frame lengths: 120, 60, 30 and 20 fps. */
const CADENCES_MS = [8.333, 16.667, 33.333, 50];
/** Pointer-move spacings: 1 kHz mouse to a 60 Hz one. */
const SPACINGS_MS = [1, 2, 4, 8.333, 16.667];

const PROJECT = {
  buses: [{ name: "Master" }, { name: "Music", parent: "Master" }, { name: "Voice", parent: "Master" }],
};
const VOICE_SLOT = 2;

/** mulberry32: the gate's seeded stream, so every run draws the same drags. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nearest-rank percentile of `xs` (`p` in 0..1). */
export function percentile(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(p * s.length) - 1)]!;
}

export interface DragResult {
  /** The first event's audio-clock time, ms. */
  eventMs: number;
  /** Event to the post that carried its ramp (the coalescing wait, or a frame's BATCH when `preview` is off), ms. */
  toPostMs: number;
  /** That post to the first frame of the quantum that applies it (the worklet picks it up between quanta), ms. */
  toAppliedMs: number;
  /** That quantum's first frame to the first changed sample (the core's asap start and the ramp's first step), ms. */
  toSampleMs: number;
  /** The whole gate figure: event to first changed sample, ms. */
  totalMs: number;
  /** The first changed core frame. */
  changedFrame: number;
  cadenceMs: number;
  /** Whether the first event fell inside the coalescing window of a precursor post. */
  precursor: boolean;
  /** The settled output after the drag minus `LEVEL x` the drag's final volume. */
  settleError: number;
  /** The output was constant before the batch reached the core (the no-edit render). */
  baselineHeld: boolean;
}

export interface GateOptions {
  seed: number;
  drags: number;
  /** The preview path (`flushNow` after each `apply`); false leaves the batch for the main-thread frame (the commit path). */
  preview?: boolean;
}

interface Ev {
  t: number;
  seq: number;
  fn: () => void;
}

/** Builds the loopback rig (as `liveMixLoopback.test.ts`'s `rig`); null where the wasm cannot be built. */
async function build() {
  const testing = await import("../testing");
  const settings = parseAudioSettings(PROJECT).settings;
  const preset = { ...presetFromSettings(settings), limiterLookaheadMs: 0 };
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>>;
  try {
    loop = await testing.createLoopbackHost({ preset });
  } catch {
    return null;
  }
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
  const node = Object.assign(new EventTarget(), { connect() {}, disconnect() {} }) as unknown as AudioWorkletNode;
  const unlock = new Unlock({ target: new EventTarget(), context: ctx as unknown as UnlockContext });
  const host = AudioHost._create({ context: ctx as unknown as AudioContext, node, link: loop.link, unlock, preset, respawn: () => loop.respawn() });
  const link = loop.link;
  /** Every BATCH posted: its virtual post time (set by the sim), the core frame it arrived at and its Voice authored ramps. */
  const posts: { atMs: number; frame: number; voiceRamp: boolean }[] = [];
  let simNow = 0;
  const post = link.post.bind(link);
  link.post = ((buffer: ArrayBuffer, ...rest: unknown[]) => {
    const view = new DataView(buffer);
    if (readEnvelope(view, 0).kind === Kind.BATCH) {
      const header = readBatchHeader(view, 0);
      let off = 32;
      let voiceRamp = false;
      for (let i = 0; i < header.count; i++) {
        const head = readRecordHead(view, off);
        if (head.opcode === Op.BUS_RAMP) {
          const r = readBusRamp(view, off);
          if (r.voiceId === VOICE_SLOT && r.lane === LANE_AUTHORED) voiceRamp = true;
        }
        off += head.words * 4;
      }
      posts.push({ atMs: simNow, frame: loop.frame, voiceRamp });
    }
    return (post as (b: ArrayBuffer, ...r: unknown[]) => void)(buffer, ...rest);
  }) as typeof link.post;
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async (path) => new TextEncoder().encode(path).buffer as ArrayBuffer,
    decodeWorker: fakeDecoder(() => ({ frames: CLIP_FRAMES, channels: 1, sampleRate: RATE, channelData: [new Float32Array(CLIP_FRAMES).fill(LEVEL)] })),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  mixer.configure(settings);
  const backend: CoreBackend = createCoreBackend(host, { clips, clock: loop.clock, mixer });
  events()._reset();
  setAudioBackend(backend);
  return {
    loop,
    host,
    backend,
    posts,
    setNow: (t: number) => {
      simNow = t;
    },
  };
}

/** Runs the seeded drags on a fresh loopback rig and returns one result per drag; null when the wasm is unavailable. */
export async function runFaderGate(options: GateOptions): Promise<DragResult[] | null> {
  const rig = await build();
  if (!rig) return null;
  const { loop, host, backend, posts, setNow } = rig;
  const preview = options.preview ?? true;
  const rand = rng(options.seed);
  const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;

  // The virtual main thread: one time in audio-clock ms, a queue of events and the frame tick.
  let now = 0;
  let seq = 0;
  const queue: Ev[] = [];
  const at = (t: number, fn: () => void) => {
    queue.push({ t, seq: seq++, fn });
    queue.sort((a, b) => a.t - b.t || a.seq - b.seq);
  };
  let cadence = 16.667;
  let nextTick = cadence;
  // `LiveMix` reads the injected time and timer (its host object is the backend's literal; no source is changed).
  const liveHost = (backend.liveMix as unknown as { host: { nowMs?: () => number; setTimer?: (fn: () => void, ms: number) => void } }).host;
  liveHost.nowMs = () => now;
  liveHost.setTimer = (fn, ms) => at(now + ms, fn);

  const trace: number[] = [];
  let traceBase = 0;
  const settle = async () => {
    for (let k = 0; k < 8; k++) await Promise.resolve();
  };
  /** Runs the main thread and renders until the host's next quantum starts at or after `untilMs`. */
  const runTo = async (untilMs: number) => {
    while ((loop.frame * 1000) / RATE < untilMs) {
      const start = (loop.frame * 1000) / RATE;
      for (;;) {
        const e = queue[0];
        const tickDue = nextTick <= start && (!e || nextTick <= e.t);
        if (tickDue) {
          now = nextTick;
          setNow(now);
          mixer.update(cadence / 1000);
          backend.update(cadence / 1000);
          events().update(cadence / 1000);
          nextTick += cadence;
        } else if (e && e.t <= start) {
          queue.shift();
          now = e.t;
          setNow(now);
          e.fn();
        } else break;
      }
      now = start;
      setNow(now);
      const { left } = loop.renderQuanta(1);
      for (let i = 0; i < left.length; i++) trace.push(left[i]!);
      await settle();
    }
  };

  backend.play({ path: "const.wav", url: "const.wav", loop: true, stream: false, bus: "Voice" });
  await runTo(200);
  let volume = 1;
  const results: DragResult[] = [];

  for (let d = 0; d < options.drags; d++) {
    // The no-edit render: the output holds one value since the last settle.
    const base = trace[trace.length - 1]!;
    trace.length = 0;
    traceBase = loop.frame;
    const postsBefore = posts.length;
    cadence = pick(CADENCES_MS);
    const e0 = now + between(8, 40);
    nextTick = e0 + rand() * cadence;
    const precursor = rand() < 0.5;
    if (precursor) {
      // A silent bus's edit, posted just ahead: the first Voice event lands inside its coalescing window.
      const lead = between(0.2, 3.8);
      const musicTo = 0.2 + rand() * 0.8;
      at(e0 - lead, () => {
        mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: musicTo });
        if (preview) backend.flushNow();
      });
    }
    let target = 0.1 + rand() * 0.9;
    while (Math.abs(target - volume) < 0.2) target = 0.1 + rand() * 0.9;
    const n = 3 + Math.floor(rand() * 8);
    let t = e0;
    for (let i = 1; i <= n; i++) {
      const v = volume + ((target - volume) * i) / n;
      at(t, () => {
        mixer.apply({ op: "setBus", bus: "Voice", key: "volume", value: v });
        if (preview) backend.flushNow();
      });
      if (i < n) t += pick(SPACINGS_MS);
    }
    // Run until every event, timer and the 10 ms ramp have passed, plus a margin to read the settled level.
    await runTo(t + 4 + DRAG_RAMP_MS + 60);
    if (queue.length > 0 && queue[0]!.t <= now) throw new Error("fader gate harness: an event was left unprocessed");
    volume = target;

    const post = posts.slice(postsBefore).find((p) => p.voiceRamp && p.atMs >= e0)!;
    const firstIdx = trace.findIndex((v) => v !== base);
    const changedFrame = traceBase + firstIdx;
    const appliedMs = (post.frame * 1000) / RATE;
    const changedMs = (changedFrame * 1000) / RATE;
    const last = trace.slice(-QUANTUM);
    results.push({
      eventMs: e0,
      toPostMs: post.atMs - e0,
      toAppliedMs: appliedMs - post.atMs,
      toSampleMs: changedMs - appliedMs,
      totalMs: changedMs - e0,
      changedFrame,
      cadenceMs: cadence,
      precursor,
      settleError: Math.max(...last.map((v) => Math.abs(v - LEVEL * target))),
      baselineHeld: firstIdx >= 0 && trace.slice(0, firstIdx).every((v) => v === base) && changedFrame >= post.frame,
    });
  }
  backend.dispose();
  setAudioBackend(null);
  events()._reset();
  await host.close();
  return results;
}

/** p50, p95, max of one field over the drags. */
export function summarize(rs: readonly DragResult[], field: "totalMs" | "toPostMs" | "toAppliedMs" | "toSampleMs") {
  const xs = rs.map((r) => r[field]);
  return { p50: percentile(xs, 0.5), p95: percentile(xs, 0.95), max: Math.max(...xs) };
}
