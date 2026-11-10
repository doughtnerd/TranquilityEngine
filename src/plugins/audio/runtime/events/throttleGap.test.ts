// ADR 0158 M2 bug report: on the Sound Lab events page, the blended engine (E, `engine.audioevent.json`) has a gap of
// silence when the throttle changes ("E, press & release Right, then Up": RPM 0 -> 0.5 -> 0 -> 1 -> 0). The single-clip
// engine (T) is smooth. This plays the sample's real event files and clips through the real event runtime and the real
// `CoreBackend` on the loopback host (the committed wasm), with `setParameter` on frames as key presses would, and
// measures the output per quantum (128 frames) and the voice table's states.
//
// Cause: `CoreAutomation.setParam` -> `reevaluate` (core/coreAutomation.ts) stores each bound voice's curves evaluated
// at the parameter's *target* into `table.autoGain`, once, when the parameter is set. Selection (core/selection.ts
// `run`) then demotes a mixed voice whose audibility is under MIN_AUDIBILITY as soon as its dwell allows, and never
// promotes a virtual voice whose audibility is under it. In a blend, a child whose range the target is outside has
// target gain 0, so:
//  - the child being left (idle when RPM goes up, high or mid when it comes down) is demoted on the frame of the
//    `setParameter`, a 5 ms cut, while the core's smoothed RPM still has it at full level;
//  - the child being approached is promoted at once but its core gain follows the smoothed RPM (seekSpeed 1.5/s), so it
//    is silent until RPM reaches its fade (0.5 for high from below, 0.5 for idle from above);
//  - a child the sweep only passes through (mid on 0 -> 1) has target gain 0 at both ends and is never mixed.
// The result is silence from the cut until the smoothed RPM reaches the next child's fade: about 0.33 s for a sweep
// from 0 to 1 and back, 0.22 s for "Up" pressed while RPM is still near 0.15 after the Right press.
// T has one voice whose volume curve never reaches 0 (0.6..1), so selection never demotes it.
// Visiting RPM 0.5 (Right) changes nothing lasting: mid is demoted to virtual (never stopped, still in the instance)
// and every later "Up" from a settled idle gaps by the same ~330 ms with or without it. "Up" pressed during the start
// clip is near-smooth because RPM has already reached 1 when the loop's voices start (they are admitted at their gain).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { mixer } from "../../../../engine/audio/mixer";
import { evalCurve, type Curve } from "../../../../engine/core/curve";
import { setAudioBackend, type AudioEventHandle } from "../backend";
import { Audio } from "../index";
import { _resetHandleWarningsForTests } from "../core/handle";
import { createClipRegistry } from "../core/clipRegistry";
import { fakeDecoder, type PlanarClip } from "../core/fakeDecoder";
import type { AudioHost } from "../core/context";
import { CoreBackend, type CoreBackendHost } from "../core/coreBackend";
import { VoiceState } from "../core/voiceTable";
import { createLoopbackHost } from "../testing";
import { events } from "./eventRuntime";

const SAMPLE = fileURLToPath(new URL("../../../../../samples/sound-lab/", import.meta.url));
const RATE = 48_000;
const QUANTUM = 128;
/** One frame of the script: 4 quanta (512 samples, 10.7 ms), as in the event goldens. */
const FRAME_QUANTA = 4;
const FRAME_SECONDS = (FRAME_QUANTA * QUANTUM) / RATE;
const QUANTUM_MS = (QUANTUM / RATE) * 1000;
/** A quantum quieter than this (RMS, about -60 dBFS) counts as silence; the engine loops sit around 0.1..0.3. */
const SILENT = 1e-3;

const SINGLE = "audio/events/engine-single.audioevent.json";
const BLEND = "audio/events/engine.audioevent.json";
const WAVS = ["start", "idle", "mid", "high", "off", "single"].map((n) => `audio/events/engine-${n}.wav`);

// --- Real clips: the sample's 16-bit PCM WAVs, parsed here (the fake decoder hands them to the registry as the worker would).

function parseWav(bytes: ArrayBuffer): PlanarClip {
  const v = new DataView(bytes);
  let off = 12;
  let rate = 0;
  let channels = 1;
  for (;;) {
    const id = String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
    const size = v.getUint32(off + 4, true);
    if (id === "fmt ") {
      channels = v.getUint16(off + 10, true);
      rate = v.getUint32(off + 12, true);
    } else if (id === "data") {
      const frames = size / 2 / channels;
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) data[c]![f] = v.getInt16(off + 8 + (f * channels + c) * 2, true) / 32768;
      return { frames, channels, sampleRate: rate, channelData: data };
    }
    off += 8 + size + (size & 1);
  }
}
const decode = fakeDecoder(async (b) => parseWav(b));
const fetchBytes = async (path: string) => {
  const b = readFileSync(SAMPLE + path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const eventJson = (path: string) => JSON.parse(readFileSync(SAMPLE + path, "utf8")) as Record<string, unknown>;

async function boot(): Promise<Engine> {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({
    "s.json": { format: "myco.scene@1", nodes: [] },
    ...Object.fromEntries(WAVS.map((w) => [w, "data:,"])),
    [SINGLE]: eventJson(SINGLE),
    [BLEND]: eventJson(BLEND),
  }));
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }, { name: "Engine", parent: "Master" }], seed: 7, backend: "core" } } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
  return engine;
}

// --- A model of the proposed fix, applied from the test (runtime files are owned elsewhere) -------------------------

/** The blend's children (from engine.audioevent.json) and the event's volume curve on RPM. */
const blend = eventJson(BLEND) as { automation: { curve: Curve }[]; root: { loop: { children: { clip: string; range: [number, number]; fade: number }[] } } };
const EVENT_VOLUME = blend.automation[0]!.curve;
const CHILD_CURVES = new Map<string, Curve>();

/**
 * `selection: "target"` is today's behaviour. The other two overwrite `table.autoGain` of the blend's voices every
 * frame, before selection runs, from an estimate of the core's smoothed RPM (the same seek as the core):
 *  - "maxGain": the larger of the curves' gain at the estimate and at the target (the proposed fix);
 *  - "maxParam": the curves evaluated at the larger of the estimate and the target parameter *value* (one reading of
 *    E4.5's planned change; it still fails on the way up).
 */
type Selection = "target" | "maxGain" | "maxParam";

interface Row {
  frame: number;
  /** RMS of the left channel per quantum. */
  rms: number[];
  /** Per blend child (idle, mid, high) or "single": the table state (2 mixed, 3 virtual). */
  states: Record<string, number>;
}

async function render(event: string, script: Record<number, number>, total: number, selection: Selection = "target"): Promise<Row[] | null> {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  _resetHandleWarningsForTests();
  events()._reset();
  const engine = await boot();
  let loop;
  try {
    loop = await createLoopbackHost({ preset: { maxLogical: 64, maxMixed: 32, maxBuses: 8, arenaInitialBytes: 1 << 20, clipCeilingBytes: 16 << 20, limiterLookaheadMs: 0 } });
  } catch {
    engine.dispose();
    return null;
  }
  const link = loop.link;
  const clips = createClipRegistry({ send: (m) => link.post(m), nextSeq: () => link.nextSeq(), fetchBytes, decodeWorker: decode, nextFrame: (cb) => cb(), nextQuantum: (cb) => cb() });
  const host: CoreBackendHost = { link, status: "running", preset: { maxLogical: 64, maxMixed: 32 }, worldCount: 1, sampleRate: RATE, addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"] };
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer });
  setAudioBackend(backend);
  if (CHILD_CURVES.size === 0) for (const c of blend.root.loop.children) CHILD_CURVES.set(c.clip, events().blendCurve(c as never)!);
  const t = backend.table;
  const rows: Row[] = [];
  let h!: AudioEventHandle;
  let target = 0;
  let estimate = 0;
  try {
    for (let f = 0; f < total; f++) {
      if (f === 0) h = Audio.play(event, { bus: "Engine", parameters: { RPM: 0 } });
      if (script[f] !== undefined) {
        target = script[f]!;
        h.setParameter("RPM", target);
      }
      events().update(FRAME_SECONDS);
      if (selection !== "target") {
        for (let i = 0; i < t.capacity; i++) {
          if (t.state[i] === VoiceState.FREE) continue;
          const curve = CHILD_CURVES.get(backend.clips.info(t.clip[i]!)?.path ?? "");
          if (!curve) continue;
          const gain = (x: number) => Math.max(0, evalCurve(curve, x)) * evalCurve(EVENT_VOLUME, x);
          t.autoGain[i] = selection === "maxGain" ? Math.max(gain(estimate), gain(target)) : gain(Math.max(estimate, target));
        }
      }
      backend.update(FRAME_SECONDS);
      const out = loop.renderQuanta(FRAME_QUANTA);
      // The core smooths RPM at 1.5/s per quantum; the estimate follows it frame by frame.
      const step = 1.5 * FRAME_SECONDS;
      estimate = Math.abs(target - estimate) <= step ? target : estimate + Math.sign(target - estimate) * step;
      const rms: number[] = [];
      for (let q = 0; q < FRAME_QUANTA; q++) {
        let s = 0;
        for (let k = q * QUANTUM; k < (q + 1) * QUANTUM; k++) s += out.left[k]! ** 2;
        rms.push(Math.sqrt(s / QUANTUM));
      }
      const states: Record<string, number> = {};
      for (let i = 0; i < t.capacity; i++) {
        if (t.state[i] === VoiceState.FREE) continue;
        const name = (backend.clips.info(t.clip[i]!)?.path ?? "?").replace(/.*engine-/, "").replace(".wav", "");
        states[name] = t.state[i]!;
      }
      rows.push({ frame: f, rms, states });
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  } finally {
    backend.dispose();
    events()._reset();
    setAudioBackend(null);
    engine.dispose();
  }
  if (process.env.THROTTLE_GAP_DUMP) {
    writeFileSync(`${process.env.THROTTLE_GAP_DUMP}/${event.replace(/.*\//, "")}-${selection}-${Object.values(script).join("_")}.txt`,
      rows.map((r) => `${r.frame}\t${r.rms.map((x) => x.toFixed(4)).join(" ")}\t${JSON.stringify(r.states)}`).join("\n"));
  }
  return rows;
}

/** The longest run of silent quanta (in ms) from frame `from` on. */
function longestGapMs(rows: readonly Row[], from: number): number {
  let run = 0;
  let worst = 0;
  for (const r of rows) {
    if (r.frame < from) continue;
    for (const v of r.rms) {
      run = v < SILENT ? run + 1 : 0;
      worst = Math.max(worst, run);
    }
  }
  return worst * QUANTUM_MS;
}

/** The loudest quantum RMS in frames `[from, to)`. */
function peakRms(rows: readonly Row[], from: number, to: number): number {
  let m = 0;
  for (const r of rows) if (r.frame >= from && r.frame < to) for (const v of r.rms) m = Math.max(m, v);
  return m;
}

// Key presses at frame times, after the engine has settled into its loop (the blend's start clip is 0.9 s).
const S = 150;
/** "Up" from rest: RPM 0 -> 1, held 1 s (94 frames), released -> 0. */
const SEQ_A = { [S]: 1, [S + 94]: 0 };
/** "Right, release, Up": 0 -> 0.5 (held 0.25 s) -> 0 (0.15 s) -> 1 (held 1 s) -> 0; each retarget lands mid-seek. */
const SEQ_B = { [S]: 0.5, [S + 23]: 0, [S + 37]: 1, [S + 37 + 94]: 0 };
const TOTAL = S + 300;
/** The longest silence a smooth transition may have: none, beyond a couple of zero crossings of the clips. */
const SMOOTH_MS = 10;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("throttle changes on the Sound Lab engines (the core, loopback)", () => {
  it("T (one clip, volume 0.6..1): both sequences are gapless and the voice stays mixed", { timeout: 120_000 }, async (ctx) => {
    for (const seq of [SEQ_A, SEQ_B]) {
      const rows = await render(SINGLE, seq, TOTAL);
      if (!rows) return ctx.skip();
      expect(peakRms(rows, S - 20, S)).toBeGreaterThan(0.1);
      expect(longestGapMs(rows, S - 20)).toBeLessThan(SMOOTH_MS);
      expect(rows.filter((r) => r.frame >= S).every((r) => r.states.single === VoiceState.PLAYING)).toBe(true);
    }
  });

  it("E settles into its blend loop audibly before the throttle moves (the rig is sound)", { timeout: 60_000 }, async (ctx) => {
    const rows = await render(BLEND, SEQ_B, S + 1);
    if (!rows) return ctx.skip();
    expect(peakRms(rows, S - 20, S)).toBeGreaterThan(0.1);
    expect(longestGapMs(rows, S - 20)).toBeLessThan(SMOOTH_MS);
    expect(rows[S - 1]!.states).toEqual({ idle: VoiceState.PLAYING, mid: VoiceState.VIRTUAL, high: VoiceState.VIRTUAL });
  });

  // The bug: selection reads autoGain evaluated at RPM's target (coreAutomation.ts `reevaluate`, called once from
  // `setParam`), so the blend child being left is demoted (cut in 5 ms) on the frame of the setParameter while the
  // core's smoothed RPM still has it at full level, and silence lasts until the smoothed RPM reaches the next child's
  // fade. Measured: sequence B 224 ms going to Up and 320 ms coming back; sequence A 320 ms both ways.
  it.fails("E, sequence B (Right, release, Up): no gap going to or from Up [fails: target-gain demotion in selection]", { timeout: 60_000 }, async (ctx) => {
    const rows = await render(BLEND, SEQ_B, TOTAL);
    if (!rows) return ctx.skip();
    expect(longestGapMs(rows, S - 20)).toBeLessThan(SMOOTH_MS);
  });

  it.fails("E, sequence A (Up from rest): no gap going to or from Up [fails: target-gain demotion in selection]", { timeout: 60_000 }, async (ctx) => {
    const rows = await render(BLEND, SEQ_A, TOTAL);
    if (!rows) return ctx.skip();
    expect(longestGapMs(rows, S - 20)).toBeLessThan(SMOOTH_MS);
  });

  it.fails("E: the blend child being left stays mixed while the core still has it audible [fails: demoted on the setParameter frame]", { timeout: 60_000 }, async (ctx) => {
    const rows = await render(BLEND, SEQ_A, S + 10);
    if (!rows) return ctx.skip();
    // RPM moves 0.016 a frame; idle is at full level up to 0.1 and fades out to 0.5, so it must still be mixed 5 frames on.
    expect(rows[S + 5]!.states.idle).toBe(VoiceState.PLAYING);
  });

  it("visiting RPM 0.5 leaves mid virtual (not stopped), and a later Up gaps the same as one without the visit", { timeout: 120_000 }, async (ctx) => {
    const withRight = await render(BLEND, { [S]: 0.5, [S + 100]: 0, [S + 250]: 1 }, S + 350);
    const without = await render(BLEND, { [S + 250]: 1 }, S + 350);
    if (!withRight || !without) return ctx.skip();
    expect(withRight.some((r) => r.frame > S && r.states.mid === VoiceState.PLAYING)).toBe(true);
    expect(withRight[S + 249]!.states).toEqual({ idle: VoiceState.PLAYING, mid: VoiceState.VIRTUAL, high: VoiceState.VIRTUAL });
    const a = longestGapMs(withRight, S + 250);
    const b = longestGapMs(without, S + 250);
    expect(a).toBeGreaterThan(250); // the bug, with the visit...
    expect(b).toBeGreaterThan(250); // ...and without it
    expect(Math.abs(a - b)).toBeLessThan(15);
  });

  it("the proposed fix, modelled (selection gain = max of the curves at the smoothed estimate and at the target, every frame while seeking): both sequences are gapless", { timeout: 120_000 }, async (ctx) => {
    for (const seq of [SEQ_A, SEQ_B]) {
      const rows = await render(BLEND, seq, TOTAL, "maxGain");
      if (!rows) return ctx.skip();
      expect(longestGapMs(rows, S - 20)).toBeLessThan(SMOOTH_MS);
      // mid, which the 0 -> 1 sweep only passes through, is mixed on the way.
      expect(rows.some((r) => r.frame > S && r.states.mid === VoiceState.PLAYING)).toBe(true);
    }
  });

  it("evaluating the curves at the larger parameter *value* (estimate or target) is not enough: rising RPM still cuts idle", { timeout: 60_000 }, async (ctx) => {
    const rows = await render(BLEND, SEQ_A, TOTAL, "maxParam");
    if (!rows) return ctx.skip();
    expect(longestGapMs(rows, S - 20)).toBeGreaterThan(200);
  });
});
