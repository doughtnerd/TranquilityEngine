// ADR 0171/0172 (Pf3c; api-and-models §7): the voices track against the recorded scene's keyframe table. At every keyframe
// instant, each state's count on the track equals the count of the rows `reconstructVoices` builds there and of the
// keyframe's own rows; the lanes, the empty capture and the tooltip.
import { describe, expect, it } from "vitest";
import { RecordType, assembleCapture } from "../../../runtime/capture/format";
import { SAMPLE_HEADER, SAMPLE_META, SAMPLE_RATE } from "../../../runtime/capture/testSupport";
import { CaptureSource } from "../profilerSource";
import { nameLookup, reconstructVoices } from "../voiceTableModel";
import { KEYFRAME_FRAMES, inProcessWorker, openScene, truthAt } from "../voiceSceneSupport";
import { VOICES_TRACK_ID, voiceCountsAt, voicesTracks, voiceTooltip } from "./voices";
import { voiceSeries } from "../cpuTrack";
import type { TrackContext } from "./types";

const seconds = (frame: number): number => frame / SAMPLE_RATE;

/** STATUS counts a scene's ground truth implies: playing (state 0), virtual (state 1); stolen voices are not live. */
function statusAt(_block: number, frame: number) {
  const truth = truthAt(frame);
  const playing = truth.filter((v) => v.state === 0).length;
  const virtual = truth.filter((v) => v.state === 1).length;
  return { mixedVoices: playing, liveVoices: playing + virtual, mixedCap: 64, hrtfVoices: playing > 1 ? 1 : 0, bedVoices: virtual };
}

async function open() {
  const source = await openScene(statusAt);
  const ctx: TrackContext = { source, names: nameLookup(source.summary.names) };
  const [mod] = voicesTracks(ctx);
  await mod!.refresh();
  return { source, ctx, mod: mod! };
}

describe("the voices track", () => {
  it("is a lanes track with the five lanes: playing, virtual, cap, HRTF, bed", async () => {
    const { source, mod } = await open();
    expect(mod.track).toMatchObject({ id: VOICES_TRACK_ID, kind: "lanes", visible: true });
    const data = mod.data()!;
    expect(data.lines).toHaveLength(5);
    expect(data.lines!.map((l) => l.color)).toEqual(["accent", "muted", "warning", "accent2", "accentSoft"]);
    for (const l of data.lines!) expect(l.times.length).toBe(l.values.length);
    expect(data.lines![0]!.times.length).toBe(source.summary.statusCount);
    expect(Array.from(data.lines![2]!.values as ArrayLike<number>).every((v) => v === 64)).toBe(true);
    source.close();
  });

  it("counts equal the keyframe table at every keyframe of the scene", async () => {
    const { source, ctx, mod } = await open();
    const lines = mod.data()!.lines!;
    const at = (lane: number, t: number): number => {
      const i = Array.from(lines[lane]!.times as ArrayLike<number>).lastIndexOf(t);
      expect(i, `a sample at ${t}`).toBeGreaterThanOrEqual(0);
      return lines[lane]!.values[i]!;
    };
    let checked = 0;
    for (const kf of KEYFRAME_FRAMES) {
      const state = await source.seek(seconds(kf) + source.startSeconds);
      const replay = reconstructVoices(state, ctx.names);
      expect(replay.fromKeyframe).toBe(true);
      const byState = (rows: readonly { state: number }[], s: number): number => rows.filter((r) => r.state === s).length;
      const keyRows = state.keyframe!.voices;
      const t = seconds(kf) - source.startSeconds;
      // The voice table and the keyframe's own rows agree with each other and with the track.
      expect(byState(replay.rows, 0)).toBe(byState(keyRows, 0));
      expect(byState(replay.rows, 1)).toBe(byState(keyRows, 1));
      expect(at(0, t), `playing at keyframe ${kf}`).toBe(byState(replay.rows, 0));
      expect(at(1, t), `virtual at keyframe ${kf}`).toBe(byState(replay.rows, 1));
      checked += byState(replay.rows, 0) + byState(replay.rows, 1);
    }
    expect(checked).toBeGreaterThan(0);
    source.close();
  });

  it("reads the counts and the tooltip of the STATUS in force", async () => {
    const { source, mod } = await open();
    const t = seconds(KEYFRAME_FRAMES[2]!) - source.startSeconds;
    const truth = truthAt(KEYFRAME_FRAMES[2]!);
    const playing = truth.filter((v) => v.state === 0).length;
    const virtual = truth.filter((v) => v.state === 1).length;
    expect(mod.tooltipAt!(t + 0.001)).toBe(`playing ${playing}, virtual ${virtual}, cap 64, HRTF ${playing > 1 ? 1 : 0}, bed ${virtual} (${playing + virtual} live)`);
    expect(mod.tooltipAt!(-1)).toBeNull();
    source.close();
  });

  it("clamps virtual at 0 when more are mixed than live, and has no counts before the first STATUS", () => {
    const series = voiceSeries({ seconds: Float64Array.of(1, 2), liveVoices: Float64Array.of(2, 5), mixedVoices: Float64Array.of(3, 1), mixedCap: Float64Array.of(8, 8), hrtfVoices: Float64Array.of(0, 1), bedVoices: Float64Array.of(0, 0), fxVoices: Float64Array.of(0, 0) });
    expect(voiceCountsAt(series, 0.5)).toBeNull();
    expect(voiceTooltip(series, 0.5)).toBeNull();
    expect(voiceCountsAt(series, 1.5)).toEqual({ playing: 3, virtual: 0, cap: 8, hrtf: 0, bed: 0, live: 2 });
    expect(voiceCountsAt(series, 99)).toMatchObject({ playing: 1, virtual: 4 });
  });

  it("has no data for a capture without a STATUS", async () => {
    const meta = { ...SAMPLE_META };
    const bytes = assembleCapture(SAMPLE_HEADER, meta, [{ seq: 1, type: RecordType.EPOCH, epoch: 0, frame: 0, payload: { reason: 0, sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0, perfMs: 1000 } }], { index: true });
    const source = await CaptureSource.openFile(bytes.slice().buffer, { worker: inProcessWorker() });
    const [mod] = voicesTracks({ source, names: nameLookup(source.summary.names) });
    await mod!.refresh();
    expect(mod!.data()).toBeUndefined();
    expect(mod!.tooltipAt!(0)).toBeNull();
    source.close();
  });
});
