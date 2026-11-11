// ADR 0166 M4 (Z4; api-and-models §3.1, §3.2, architecture §3.7): the voice table's log of stamped ramps and the REPLAY
// of them. Acceptance: a REPLAY re-sends a running curve fade with its current phase.
import { describe, expect, it } from "vitest";
import { FadeLaw, FADE_FLAGS_STOP_AT_END, Op, packShape, readFade, readSetParams, readStop, shapeLaw, shapeStartPhase } from "../wire.generated";
import { PlayheadTracker, Replayer, type ReplaySource } from "./replay";
import { MAX_STAMPED, StampedKind, VoiceFlag, VoiceReason, VoiceState, VoiceTable } from "./voiceTable";

const RATE = 1000;

/** The records of the last posted REPLAY message, decoded generically (op, then the generated reader for the three shaped ones). */
function lastRecords(messages: ArrayBuffer[]) {
  const out: { op: number; frameOffset: number; rec: ReturnType<typeof readFade> | ReturnType<typeof readStop> | ReturnType<typeof readSetParams> | null }[] = [];
  const buf = messages[messages.length - 1]!;
  const view = new DataView(buf);
  let off = 32;
  while (off < view.byteLength) {
    const op = view.getUint16(off, true);
    const len = view.getUint16(off + 2, true) * 4;
    const rec = op === Op.FADE ? readFade(view, off) : op === Op.STOP ? readStop(view, off) : op === Op.SET_PARAMS ? readSetParams(view, off) : null;
    out.push({ op, frameOffset: view.getUint32(off + 8, true), rec });
    off += len;
  }
  return out;
}

function rig(now = 1000) {
  const table = new VoiceTable(8);
  const info = { frames: 1_000_000, sampleRate: RATE, channels: 1, state: "ready" };
  const clips = { info: () => info, onResident: (_c: number, cb: (i: typeof info) => void) => cb(info) };
  const clockMap = { framesNow: () => now, lookaheadFrames: () => 0, sampleRate: RATE, timeOffset: 0, carryPending: false, reset() {} };
  const posted: ArrayBuffer[] = [];
  const src = {
    table,
    clips,
    clockMap,
    mirror: { frameAudio: now },
    mixer: { resolveAll: () => [] },
    writer: { clear() {} },
    playheads: new PlayheadTracker(table, clips as never, RATE),
    masterVolume: 1,
    muted: false,
    host: { sampleRate: RATE },
    busConfigWire: () => [],
  } as unknown as ReplaySource;
  const replayer = new Replayer(src, { post: (b) => posted.push(b), nextSeq: () => 1 });
  const voice = () => {
    const id = table.allocate(0, 128, 0, VoiceState.PLAYING);
    const i = id & 0xffff;
    table.clip[i] = 1;
    table.flags[i] = VoiceFlag.LOOP;
    table.gain[i] = 1;
    return id;
  };
  return { table, replayer, posted, voice };
}

describe("the voice table's stamped log", () => {
  it("keeps entries in frame order, drops the finished ones and the oldest past MAX_STAMPED, and clears on free", () => {
    const t = new VoiceTable(4);
    const id = t.allocate(0, 1, 0, VoiceState.PLAYING);
    const i = id & 0xffff;
    expect(t.logStamped(id, StampedKind.FADE, 300, RATE, 0, 0, 1, 0.1, 0, 0)).toBe(true);
    expect(t.logStamped(id, StampedKind.FADE, 100, RATE, 0, 1, 0, 0.1, 0, 0)).toBe(true);
    expect([t.stampedFrame[i * MAX_STAMPED], t.stampedFrame[i * MAX_STAMPED + 1]]).toEqual([100, 300]);
    expect(t.stampedTotal).toBe(2);
    t.pruneStamped(i, 250); // the first ended at 200
    expect(t.stampedCount[i]).toBe(1);
    for (let k = 0; k < 6; k++) t.logStamped(id, StampedKind.GAIN, 1000 + k, RATE, 0, 0, 1, 1, 0, 0);
    expect(t.stampedCount[i]).toBe(MAX_STAMPED);
    expect(t.stampedFrame[i * MAX_STAMPED]).toBe(1002); // the oldest were dropped
    t.free(id, VoiceReason.NONE);
    expect(t.stampedCount[i]).toBe(0);
    expect(t.stampedTotal).toBe(0);
    expect(t.logStamped(id, StampedKind.FADE, 1, RATE, 0, 0, 1, 1, 0, 0)).toBe(false); // a stale id
  });

  it("carries entries through a context swap as seconds and back at the new rate", () => {
    const t = new VoiceTable(4);
    const id = t.allocate(0, 1, 0, VoiceState.PLAYING);
    const i = id & 0xffff;
    t.logStamped(id, StampedKind.FADE, 2000, 1000, 0, 0, 1, 1, 0, 0); // starts at 2 s, ends at 3 s
    t.stampedToTimeline(1000, 5); // Audio.time = frame / rate + 5
    expect(t.logStamped(id, StampedKind.FADE, 1, 1000, 0, 0, 1, 1, 0, 0)).toBe(false);
    t.stampedFromTimeline(2000, 4); // new context: 48 kHz-like rate 2000, offset 4
    expect(t.stampedFrame[i * MAX_STAMPED]).toBe((2 + 5 - 4) * 2000);
    expect(t.stampedEnd[i * MAX_STAMPED]).toBe((3 + 5 - 4) * 2000);
  });
});

describe("Replayer, stamped ramps", () => {
  it("re-sends a running curve fade with its current phase: asap, from set first, the remaining frames", () => {
    const { table, replayer, posted, voice } = rig(1000);
    const id = voice();
    // A fade-in 0 -> 1 over 1000 frames, equal-power, that began at frame 500: half done at the replay's frame 1000.
    table.logStamped(id, StampedKind.FADE, 500, RATE, 0, 0, 1, 1, packShape(FadeLaw.EqualPowerIn, 0), 0);
    replayer.begin();
    replayer.restore();
    expect(replayer.flush()).toBe(1);
    const fades = lastRecords(posted).filter((r) => r.op === Op.FADE);
    expect(fades).toHaveLength(2);
    const [setFrom, ramp] = fades.map((r) => r.rec as ReturnType<typeof readFade>);
    expect(setFrom).toMatchObject({ target: 0, frames: 0, shape: 0 });
    expect(ramp!.target).toBe(1);
    expect(ramp!.frames).toBe(500);
    expect(shapeLaw(ramp!.shape!)).toBe(FadeLaw.EqualPowerIn);
    expect(shapeStartPhase(ramp!.shape!)).toBe(32768);
    expect(fades[1]!.frameOffset).toBe(0xffffffff); // asap
  });

  it("composes with an earlier start phase: p0 + (1 - p0) * elapsed", () => {
    const { table, replayer, posted, voice } = rig(1000);
    const id = voice();
    table.logStamped(id, StampedKind.FADE, 500, RATE, 0, 0, 1, 1, packShape(FadeLaw.SCurve, 32768), 0);
    replayer.begin();
    replayer.restore();
    replayer.flush();
    const ramp = lastRecords(posted).filter((r) => r.op === Op.FADE)[1]!.rec as ReturnType<typeof readFade>;
    expect(shapeStartPhase(ramp.shape!)).toBe(49152); // 0.5 + 0.5 * 0.5
  });

  it("re-sends a ramp that has not begun at its own frame, offset from the REPLAY's frame, with its full length and shape", () => {
    const { table, replayer, posted, voice } = rig(1000);
    const id = voice();
    table.logStamped(id, StampedKind.FADE, 1400, RATE, 0, 1, 0, 0.25, packShape(FadeLaw.EqualPowerOut, 0), 0);
    replayer.begin();
    replayer.restore();
    replayer.flush();
    const fades = lastRecords(posted).filter((r) => r.op === Op.FADE);
    const ramp = fades[1]!.rec as ReturnType<typeof readFade>;
    expect(fades[1]!.frameOffset).toBe(400);
    expect(ramp.frames).toBe(250);
    expect(shapeStartPhase(ramp.shape!)).toBe(0);
    expect((fades[0]!.rec as ReturnType<typeof readFade>).target).toBe(1); // held at `from` until then
  });

  it("applies a finished fade as its final value, and drops a voice whose stop-at-end finished during the gap", () => {
    const { table, replayer, posted, voice } = rig(1000);
    const a = voice();
    const b = voice();
    table.logStamped(a, StampedKind.FADE, 100, RATE, 0, 0, 0.5, 0.1, 0, 0);
    table.logStamped(b, StampedKind.FADE, 100, RATE, 0, 1, 0, 0.1, packShape(FadeLaw.EqualPowerOut, 0), 1);
    replayer.begin();
    replayer.restore();
    expect(replayer.flush()).toBe(1);
    expect(table.isLive(b)).toBe(false);
    expect(replayer.stats.dropped).toBe(1);
    const fades = lastRecords(posted).filter((r) => r.op === Op.FADE).map((r) => r.rec as ReturnType<typeof readFade>);
    expect(fades).toHaveLength(1);
    expect(fades[0]).toMatchObject({ target: 0.5, frames: 0 });
  });

  it("replays a shaped STOP under way and a gain ramp as SET_PARAMS with the same phase rule", () => {
    const { table, replayer, posted, voice } = rig(1000);
    const a = voice();
    const b = voice();
    table.logStamped(a, StampedKind.STOP, 500, RATE, 0, 1, 0, 1, packShape(FadeLaw.EqualPowerOut, 0), 0);
    table.logStamped(b, StampedKind.GAIN, 750, RATE, 0, 0.2, 1, 1, packShape(FadeLaw.SCurve, 0), 0);
    replayer.begin();
    replayer.restore();
    replayer.flush();
    const recs = lastRecords(posted);
    const stop = recs.find((r) => r.op === Op.STOP)!.rec as ReturnType<typeof readStop>;
    expect(stop.fadeFrames).toBe(500);
    expect(shapeStartPhase(stop.shape!)).toBe(32768);
    const gains = recs.filter((r) => r.op === Op.SET_PARAMS).map((r) => r.rec as ReturnType<typeof readSetParams>);
    expect(gains).toHaveLength(2);
    expect(gains[0]).toMatchObject({ gain: expect.closeTo(0.2, 5), rampFrames: 0 });
    expect(gains[1]!.rampFrames).toBe(750);
    expect(shapeStartPhase(gains[1]!.shape!)).toBe(16384);
  });

  it("lists a decoded music member with the streams (reopenGroups) instead of waiting for its clip, and sends no PLAY for it", () => {
    const { table, replayer, posted, voice } = rig(1000);
    const id = voice();
    table.musicGroup[id & 0xffff] = 5;
    let reopened: readonly number[] = [];
    (replayer as unknown as { src: ReplaySource }).src.reopenStreams = (ids) => {
      reopened = ids;
    };
    replayer.begin();
    replayer.restore();
    expect(replayer.flush()).toBe(0);
    expect(reopened).toEqual([id]);
    expect(FADE_FLAGS_STOP_AT_END).toBe(1);
    expect(posted.length).toBe(1); // the header only
  });
});
