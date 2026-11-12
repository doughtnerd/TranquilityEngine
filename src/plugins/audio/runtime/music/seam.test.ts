// ADR 0166 M4b, task T2 (api-and-models §10 row T2; waves plan, Wave 8 exit "every seam nulls to 1e-5"): every music
// seam, played by the whole runtime on the real core (`Audio.play`, `setParameter`, `trigger` and the engine's audio
// systems on T1's deterministic-clock fixture, `testing/loopbackClock.ts`), nulls to 1e-5 against an offline
// reference of the intended mix (`golden/seamReference.ts`): the cut; the three crossfade laws (linear, sCurve,
// equalPower); a bridge, both legs; a loop exit with its tail; a stinger over a segment; a switch change under the
// default rule.
//
// The reference knows the rule and the grid, not the runtime: each term is a clip level as the core holds it (int16 on
// the wire: `fakeDecoder` scales by 32,767 and rounds, the core reads v / 32,768; every level here is exact both ways)
// times its fades, each Z3's same-knot control-rate law (the core retargets a shaped fade's linear ramp at each quantum
// boundary). The seam frames come from the plan (`t.bridge.point`, `t.incoming.point`, the stinger's `at`) and are
// checked against the grid (a whole number of beats or bars from the segment's start, after the request).
//
// `UPDATE_GOLDENS=1` also writes each seam as a fixture, `golden/seams/seam-<case>.json`: every message the core received at
// its frame, replayed on the wasm (`golden/audioGoldenSeams.test.ts`) and natively
// (`native/audio/crates/audio-core/tests/seam_goldens.rs`), which must agree on its digest. Without it this file never
// writes and never reads the fixtures, so a runtime change that keeps every seam exact needs no re-record.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreDriver } from "../worklet/coreDriver";
import { fnv1a64, replaySeam, SeamRecorder, seamNull, type SeamFixture, type SeamLaw, type SeamReference, type SeamTerm } from "../golden/seamReference";
import { musicLoopback, resetMusicLoopback, RATE, type MusicLoopback, type MusicLoopbackOptions } from "./testing/loopbackClock";
import type { Transition } from "./transition";

afterEach(() => resetMusicLoopback());

/** 120 bpm 4/4 at 48 kHz: a beat is 24,000 frames, a bar 96,000. */
const BEAT = RATE / 2;
const BAR = 4 * BEAT;
const TOLERANCE = 1e-5;
/** A 50 ms crossfade: 2,400 frames, about 19 quanta, so the control-rate knots show. */
const XFADE_SECONDS = 0.05;
const XFADE = Math.round(XFADE_SECONDS * RATE);
const PRESET = { maxLogical: 256, maxMixed: 32, maxBuses: 8, arenaInitialBytes: 1 << 20, limiterLookaheadMs: 0 };
const GOLDEN_DIR = fileURLToPath(new URL("../golden/seams/", import.meta.url));

/** A level as the core holds it: `fakeDecoder`'s int16 (round(v · 32,767)), read back as v / 32,768. */
const held = (v: number): number => Math.fround(Math.round(Math.fround(v) * 32767) / 32768);
const LEVEL = { a: held(0.25), b: held(0.5), r: held(0.125), hit: held(0.375), tail: held(0.125) };

const TEMPO = [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }];
const seg = (id: string, clip: string, extra: Record<string, unknown> = {}) => ({ type: "segment", id, value: id, tempo: TEMPO, tracks: [{ name: "t", clip }], ...extra });

/** A switch on `zone` over A and B; `rule` A to B when given (else the default rule), `library` its library. */
function switchEvent(rule: Record<string, unknown> | null, a: Record<string, unknown> = seg("A", "a.wav"), library: unknown[] = []) {
  return {
    format: "myco.audioevent@1",
    bus: "Music",
    parameters: [{ name: "zone", labels: ["A", "B"] }],
    root: { type: "musicSwitch", id: "sw", parameter: "zone", children: [a, seg("B", "b.wav")], library, transitions: rule ? [{ from: "A", to: "B", ...rule }] : [] },
  };
}

const clips = { "a.wav": { level: 0.25, seconds: 8 }, "b.wav": { level: 0.5, seconds: 8 } };

/** The curve's two laws: the outgoing's and the incoming's. */
const laws = (curve: "linear" | "sCurve" | "equalPower"): [SeamLaw, SeamLaw] => (curve === "equalPower" ? ["equalPowerOut", "equalPowerIn"] : [curve, curve]);

interface SeamCase {
  readonly name: string;
  readonly about: string;
  readonly options: MusicLoopbackOptions;
  /** Drives the seam; returns the reference and the frame to render to. */
  readonly drive: (r: MusicLoopback) => Promise<{ reference: SeamReference; end: number }>;
}

/** A plays; once it is a bar and 5,000 frames in, `zone` goes to B. A's start frame, the request frame, the transition. */
async function switchToB(r: MusicLoopback): Promise<{ start: number; asked: number; t: Transition }> {
  const h = r.play("sw.audioevent.json");
  await r.stepUntil(() => r.player()?.run?.state === "playing");
  const start = r.frameOfTime(r.player()!.run!.startAt);
  const asked = start + BAR + 5000;
  await r.stepToFrame(asked);
  h.setParameter("zone", "B");
  await r.stepUntil(() => !!r.player()?.transition);
  const t = r.player()!.transition!;
  await r.stepUntil(() => t.incoming !== null && t.state !== "pending");
  return { start, asked: r.out.length, t };
}

/** A direct change A → B under `rule`: the seam T, checked on the `unit` grid. */
async function direct(r: MusicLoopback, unit: number): Promise<{ start: number; seam: number; t: Transition }> {
  const { start, asked, t } = await switchToB(r);
  expect(t.bridge).toBeNull();
  const seam = r.frameOfTime(t.incoming!.point);
  expect((seam - start) % unit, "the seam is on the grid").toBe(0);
  expect(seam).toBeGreaterThan(asked);
  return { start, seam, t };
}

/** A crossfade case of `curve` over `seconds` (default 50 ms) on the next beat. */
function crossfade(curve: "linear" | "sCurve" | "equalPower", seconds = XFADE_SECONDS): SeamCase {
  const [out, into] = laws(curve);
  const n = Math.round(seconds * RATE);
  const ms = Math.round(seconds * 1000);
  return {
    name: `seam-crossfade-${curve === "sCurve" ? "s-curve" : curve === "equalPower" ? "equal-power" : "linear"}${seconds === XFADE_SECONDS ? "" : `-${ms}ms`}`,
    about: `A to B on the next beat, a ${ms} ms ${curve} crossfade (A ${out} to 0 with stopAtEnd, B ${into} from silence)`,
    options: { clips, events: { "sw.audioevent.json": switchEvent({ exit: "beat", fadeOut: { seconds, curve }, fadeIn: { seconds, curve } }) } },
    async drive(r) {
      const { start, seam } = await direct(r, BEAT);
      const end = seam + n + BEAT;
      await r.stepToFrame(end);
      const terms: SeamTerm[] = [
        { what: "A", level: LEVEL.a, from: start, to: seam + n, fades: [{ law: out, a: 1, b: 0, f: seam, n }] },
        { what: "B", level: LEVEL.b, from: seam, fades: [{ law: into, a: 0, b: 1, f: seam, n }] },
      ];
      return { reference: { from: start - 4 * 128, to: end, tolerance: TOLERANCE, terms }, end };
    },
  };
}

const CASES: SeamCase[] = [
  {
    name: "seam-cut",
    about: "A to B on the next beat with 0-beat fades: A through frame(T) - 1, B from frame(T)",
    options: { clips, events: { "sw.audioevent.json": switchEvent({ exit: "beat", fadeOut: { beats: 0 }, fadeIn: { beats: 0 } }) } },
    async drive(r) {
      const { start, seam } = await direct(r, BEAT);
      const end = seam + BEAT;
      await r.stepToFrame(end);
      const terms: SeamTerm[] = [
        { what: "A", level: LEVEL.a, from: start, to: seam },
        { what: "B", level: LEVEL.b, from: seam },
      ];
      return { reference: { from: start - 4 * 128, to: end, tolerance: TOLERANCE, terms }, end };
    },
  },
  crossfade("linear"),
  crossfade("sCurve"),
  crossfade("equalPower"),
  {
    name: "seam-bridge",
    about: "A to a 1.5 s bridge on the bar (the rule's 50 ms equal-power crossfade), the bridge to B on its exit cue at 1 s (the bridge's 50 ms S-curve crossfade)",
    options: {
      clips: { ...clips, "r.wav": { level: 0.125, seconds: 1.5 } },
      events: {
        "sw.audioevent.json": switchEvent(
          {
            exit: "bar",
            fadeOut: { seconds: XFADE_SECONDS, curve: "equalPower" },
            fadeIn: { seconds: XFADE_SECONDS, curve: "equalPower" },
            bridge: { segment: "R", fadeOut: { seconds: XFADE_SECONDS, curve: "sCurve" }, fadeIn: { seconds: XFADE_SECONDS, curve: "sCurve" } },
          },
          seg("A", "a.wav"),
          [{ type: "segment", id: "R", tempo: TEMPO, cues: [{ name: "out", at: "1:3:0" }], exit: "out", tracks: [{ name: "t", clip: "r.wav" }] }],
        ),
      },
    },
    async drive(r) {
      const { start, asked, t } = await switchToB(r);
      expect(t.bridge).not.toBeNull();
      const t1 = r.frameOfTime(t.bridge!.point);
      expect((t1 - start) % BAR, "leg 1 on A's bar").toBe(0);
      expect(t1).toBeGreaterThan(asked);
      const t2 = r.frameOfTime(t.incoming!.point);
      expect(t2 - t1, "leg 2 on the bridge's exit cue, one second in").toBe(RATE);
      const end = t2 + XFADE + BEAT;
      await r.stepToFrame(end);
      expect(t.state).toBe("done");
      const terms: SeamTerm[] = [
        { what: "A", level: LEVEL.a, from: start, to: t1 + XFADE, fades: [{ law: "equalPowerOut", a: 1, b: 0, f: t1, n: XFADE }] },
        {
          what: "bridge", level: LEVEL.r, from: t1, to: t2 + XFADE,
          fades: [{ law: "equalPowerIn", a: 0, b: 1, f: t1, n: XFADE }, { law: "sCurve", a: 1, b: 0, f: t2, n: XFADE }],
        },
        { what: "B", level: LEVEL.b, from: t2, fades: [{ law: "sCurve", a: 0, b: 1, f: t2, n: XFADE }] },
      ];
      return { reference: { from: start - 4 * 128, to: end, tolerance: TOLERANCE, terms }, end };
    },
  },
  {
    name: "seam-loop-exit-tail",
    about: "A loops bar 1 forever with a 2-beat tail; the change to B leaves on the bar, at a wrap: A cut there, B from there, the wrap's tail ringing under B",
    options: {
      // A's file: bar 1 (the loop) at 0.25, then half a bar of tail audio at 0.125.
      clips: { "a.wav": { signal: (i) => (i < BAR ? 0.25 : 0.125), seconds: 3 }, "b.wav": { level: 0.5, seconds: 8 } },
      events: {
        "sw.audioevent.json": switchEvent(
          { exit: "bar", fadeOut: { beats: 0 }, fadeIn: { beats: 0 } },
          seg("A", "a.wav", { regions: [{ id: "loop", from: "1:1:0", to: "2:1:0", count: 0, tailBeats: 2 }] }),
        ),
      },
    },
    async drive(r) {
      const { start, seam } = await direct(r, BAR);
      const end = seam + BAR;
      await r.stepToFrame(end);
      const terms: SeamTerm[] = [{ what: "A, bar 1 looping", level: LEVEL.a, from: start, to: seam }];
      // A tail at every wrap up to and including the exit's: the region's end, 2 beats, from the wrap's sample.
      for (let w = start + BAR; w <= seam; w += BAR) terms.push({ what: `tail at ${w}`, level: LEVEL.tail, from: w, to: w + 2 * BEAT });
      terms.push({ what: "B", level: LEVEL.b, from: seam });
      expect(terms.length).toBeGreaterThanOrEqual(4);
      return { reference: { from: start - 4 * 128, to: end, tolerance: TOLERANCE, terms }, end };
    },
  },
  {
    name: "seam-stinger",
    about: "a 1 s stinger on the next beat over a playing segment: A alone, A plus the stinger for exactly its length, A alone",
    options: {
      clips: { "a.wav": { level: 0.25, seconds: 8 }, "hit.wav": { level: 0.375, seconds: 1 } },
      events: {
        "st.audioevent.json": {
          format: "myco.audioevent@1",
          bus: "Music",
          root: { type: "playlist", id: "p", mode: "sequence", children: [seg("A", "a.wav")], library: [seg("hit", "hit.wav")], stingers: [{ trigger: "hit", segment: "hit", at: "beat" }] },
        },
      },
    },
    async drive(r) {
      const h = r.play("st.audioevent.json");
      await r.stepUntil(() => r.player()?.run?.state === "playing");
      const start = r.frameOfTime(r.player()!.run!.startAt);
      const asked = start + BAR + Math.round(BEAT / 3);
      await r.stepToFrame(asked);
      expect(h.trigger("hit")).toBe(true);
      const st = r.player()!.stingers!;
      await r.stepUntil(() => st.sounding.length > 0 && Number.isFinite(st.sounding[0]!.at));
      const s = r.frameOfTime(st.sounding[0]!.at);
      expect((s - start) % BEAT, "the stinger is on the beat grid").toBe(0);
      expect(s).toBeGreaterThan(asked);
      const end = s + RATE + BEAT;
      await r.stepToFrame(end);
      const terms: SeamTerm[] = [
        { what: "A", level: LEVEL.a, from: start },
        { what: "stinger", level: LEVEL.hit, from: s, to: s + RATE },
      ];
      return { reference: { from: start - 4 * 128, to: end, tolerance: TOLERANCE, terms }, end };
    },
  },
  {
    name: "seam-switch-default",
    about: "a musicSwitch change with no rule: the default rule, on the bar, 1-beat equal-power fades both ways",
    options: { clips, events: { "sw.audioevent.json": switchEvent(null) } },
    async drive(r) {
      const { start, seam, t } = await direct(r, BAR);
      expect(t.match.rule).toBe(-1);
      const end = seam + 2 * BEAT;
      await r.stepToFrame(end);
      const terms: SeamTerm[] = [
        { what: "A", level: LEVEL.a, from: start, to: seam + BEAT, fades: [{ law: "equalPowerOut", a: 1, b: 0, f: seam, n: BEAT }] },
        { what: "B", level: LEVEL.b, from: seam, fades: [{ law: "equalPowerIn", a: 0, b: 1, f: seam, n: BEAT }] },
      ];
      return { reference: { from: start - 4 * 128, to: end, tolerance: TOLERANCE, terms }, end };
    },
  },
];

/** Writes `golden/seams/<name>.json` from what the core received, after checking the wasm replay gives the same output. */
async function writeFixture(c: SeamCase, recorder: SeamRecorder, r: MusicLoopback, reference: SeamReference): Promise<void> {
  const frames = r.out.length;
  const base = { scene: c.name, about: c.about, preset: PRESET, clips: recorder.clipList(), steps: recorder.steps, frames };
  const replay = await replaySeam({ ...base, fnv1a64: "", reference, null: { maxError: 0, exact: 0 } });
  expect(replay.left.length).toBe(frames);
  for (let i = 0; i < frames; i++) if (replay.left[i] !== Math.fround(r.out[i]!)) throw new Error(`${c.name}: the replay departs from the run at frame ${i}`);
  const fixture: SeamFixture = {
    ...base,
    fnv1a64: fnv1a64(replay.left, replay.right),
    reference,
    null: { maxError: seamNull(r.out, reference).maxError, exact: seamNull(r.out, reference, true).maxError },
  };
  writeFileSync(`${GOLDEN_DIR}${c.name}.json`, `${JSON.stringify(fixture)}\n`);
}

/**
 * Plays `c` on the loopback core and nulls it against its reference. The core's messages are recorded on the way in
 * (the spy is restored before the fixture's replay, and by `resetMusicLoopback` after a failure); with `record` and
 * `UPDATE_GOLDENS=1` they become the fixture.
 */
async function runSeam(c: SeamCase, ctx: { skip(): void }, record: boolean): Promise<void> {
  const recorder = new SeamRecorder();
  const onMessage = CoreDriver.prototype.onMessage;
  const spy = vi.spyOn(CoreDriver.prototype, "onMessage").mockImplementation(function (this: CoreDriver, buffer, frame, date) {
    recorder.onMessage(buffer, frame);
    return onMessage.call(this, buffer, frame, date);
  });
  const r = await musicLoopback(c.options);
  if (!r) return ctx.skip();
  const { reference } = await c.drive(r);
  const { maxError, at } = seamNull(r.out, reference);
  const exact = seamNull(r.out, reference, true).maxError;
  console.info(`${c.name}: null ${maxError.toExponential(2)} at frame ${at} (exact curve ${exact.toExponential(2)})`);
  expect(r.late().groupsLate).toBe(0);
  expect(maxError, `${c.name}: null at frame ${at}`).toBeLessThanOrEqual(TOLERANCE);
  spy.mockRestore();
  if (record && process.env.UPDATE_GOLDENS === "1") await writeFixture(c, recorder, r, reference);
  r.dispose();
}

describe("every seam nulls to 1e-5 against the offline reference (T2)", () => {
  it.for(CASES)("$name", (c, ctx) => runSeam(c, ctx, true));
});

describe("long crossfades (T2; not goldens)", () => {
  // The shaped laws are re-aimed at every quantum boundary, so a 500 ms fade (24,000 frames) nulls as well as a 50 ms
  // one: measured 2.0e-6 (sCurve) and 2.4e-6 (equalPower).
  it.for([crossfade("sCurve", 0.5), crossfade("equalPower", 0.5)])("$name", (c, ctx) => runSeam(c, ctx, false));

  // F-21: measured 1.68e-5 before (the 50 ms golden: 9.0e-6). The core ran a linear FADE as one f32 `Ramp` over the
  // whole fade, and the running sum `value += step` drifted from a + (b − a)u, past 1e-5 somewhere after the golden's
  // 2,400 frames. Now each quantum boundary puts a linear ramp back on its line (`curves::linear_knot`), so it drifts
  // one quantum's worth at most, however long the fade.
  it("seam-crossfade-linear-500ms", (ctx) => runSeam(crossfade("linear", 0.5), ctx, false));
});
