// ADR 0171/0172 (Pf3c; api-and-models §7): the bus level lanes and the bus gain factors line, over a recorded capture whose
// STATUS blocks carry bus peaks and whose keyframes carry bus rows (a duck on Music from the third keyframe; a bus,
// slot 3, tombstoned from the third keyframe and named only by META's project section).
import { describe, expect, it } from "vitest";
import { RecordType, assembleCapture, type CaptureRecordInit, type KeyframeBus } from "../../../runtime/capture/format";
import { SAMPLE_HEADER, SAMPLE_META, SAMPLE_RATE, statusBytesWith } from "../../../runtime/capture/testSupport";
import { busFactors } from "../busFactorsModel";
import { CaptureSource } from "../profilerSource";
import { nameLookup } from "../voiceTableModel";
import { BLOCKS, FRAMES, KEYFRAME_FRAMES, inProcessWorker } from "../voiceSceneSupport";
import {
  BUS_GAIN_TRACK_ID, BUS_LEVEL_TRACK_ID, BusSampler, GRID_BASE_S, MAX_GRID_SAMPLES, busFactorsText, busName, busTracks, gridStride,
} from "./buses";
import type { TrackContext } from "./types";

const TOMBSTONE = 1 << 4;
const metered = 1 << 5;

/** Bus rows at keyframe `k` (0..3): Master at unity, Music authored 0.5 and (from k = 2) duck 0.8, SFX at unity, slot 3 live then tombstoned. */
function busRows(k: number): KeyframeBus[] {
  const unity = Array.from({ length: 10 }, () => 1);
  const row = (slot: number, flags: number, over: Partial<KeyframeBus> = {}): KeyframeBus => ({ slot, gen: 2, flags, lanes: unity, duck: 1, automation: 1, ...over });
  const musicLanes = [...unity];
  musicLanes[0] = 0.5;
  musicLanes[1] = 0.5;
  const dead = [...unity];
  dead[8] = 0;
  dead[9] = 0;
  return [
    row(0, metered),
    row(1, 0, { lanes: musicLanes, duck: k >= 2 ? 0.8 : 1 }),
    row(2, 0),
    k >= 2 ? row(3, TOMBSTONE, { lanes: dead }) : row(3, 0),
  ];
}

/** Peaks of block `i` by slot: Master steady (0.5, 0.25), Music rising on the left, SFX silent, slot 3 quiet until its tombstone. */
function peaksAt(i: number, frame: number): { l: number; r: number }[] {
  return [{ l: 0.5, r: 0.25 }, { l: i / BLOCKS, r: 0.1 }, { l: 0, r: 0 }, { l: frame < KEYFRAME_FRAMES[2]! ? 0.2 : 0, r: 0 }];
}

function records(): CaptureRecordInit[] {
  const out: CaptureRecordInit[] = [];
  let seq = 0;
  out.push({ seq: ++seq, type: RecordType.EPOCH, epoch: 0, frame: 0, payload: { reason: 0, sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0, perfMs: 1000 } });
  for (let i = 1; i <= BLOCKS; i++) {
    const frame = i * FRAMES;
    const k = KEYFRAME_FRAMES.indexOf(frame);
    if (k >= 0) {
      out.push({
        seq: ++seq, type: RecordType.KEYFRAME, epoch: 0, frame,
        payload: { voices: [], buses: busRows(k), metered: [], events: [], music: [], mix: { slotTableVersion: 1, monitorActive: 0, loudnessPausedMask: 0, targetIndex: 0, snapshotName: 0, masterVolume: 1, hiddenMute: 0 } },
      });
    }
    out.push({ seq: ++seq, type: RecordType.STATUS, epoch: 0, frame, payload: statusBytesWith({ currentFrame: frame, peaks: peaksAt(i, frame) }) });
  }
  return out;
}

const NAMES = { buses: { 0: "Master", 1: "Music", 2: "SFX" } };

async function open(names: Record<number, string> = NAMES.buses, audioBuses: { name: string }[] = [{ name: "Master" }, { name: "Music" }, { name: "SFX" }, { name: "Ambience" }]) {
  const meta = { ...SAMPLE_META, audio: { buses: audioBuses }, names: { ...SAMPLE_META.names, buses: names } };
  const source = await CaptureSource.openFile(assembleCapture(SAMPLE_HEADER, meta, records(), { index: true }).slice().buffer, { worker: inProcessWorker() });
  const ctx: TrackContext = { source, names: nameLookup(source.summary.names) };
  const [level, gain] = busTracks(ctx);
  await level!.refresh();
  await gain!.refresh();
  return { source, ctx, level: level!, gain: gain! };
}

/** The meter's scale, written out here: -60 dB is empty, 0 dB full. */
const fill = (peak: number): number => (peak > 0 ? Math.min(1, Math.max(0, (20 * Math.log10(peak) + 60) / 60)) : 0);

/** The STATUS block in force at grid time `t`, as the index of `peaksAt` (block i is at frame i * 768). */
const blockAt = (t: number): number => Math.floor((t * SAMPLE_RATE) / FRAMES);

describe("the bus level lanes", () => {
  it("has a line per bus, each sample the meter scale of the STATUS peak in force", async () => {
    const { source, level } = await open();
    expect(level.track).toMatchObject({ id: BUS_LEVEL_TRACK_ID, kind: "lanes" });
    const lines = level.data()!.lines!;
    expect(lines).toHaveLength(4); // Master, Music, SFX (named, silent) and slot 3 (loud until its tombstone)
    // The grid starts at 0, before the first STATUS (nothing measured there: no sample, never a 0).
    const times = Array.from(lines[0]!.times as ArrayLike<number>);
    expect(times[0]).toBe(GRID_BASE_S);
    expect(times.at(-1)).toBeLessThanOrEqual(source.duration);
    for (const [j, t] of times.entries()) {
      const i = blockAt(t);
      const p = peaksAt(i, i * FRAMES);
      for (let slot = 0; slot < 4; slot++) {
        // the wire carries f32 peaks
        expect(lines[slot]!.values[j]!, `slot ${slot} at ${t}`).toBeCloseTo(fill(Math.max(p[slot]!.l, p[slot]!.r)), 5);
      }
    }
    expect(Array.from(lines[2]!.values as ArrayLike<number>).every((v) => v === 0)).toBe(true);
    expect(lines[1]!.values[times.length - 1]!).toBeGreaterThan(lines[1]!.values[0]!);
    source.close();
  });

  it("names every bus's peak in dB in the tooltip, a tombstone from the project section", async () => {
    const { source, level } = await open();
    const early = level.tooltipAt!(1.2)!.split("\n");
    expect(early).toEqual([
      "Master: peak -6.0 dB", `Music: peak ${(20 * Math.log10(blockAt(1) / BLOCKS > 0.1 ? blockAt(1) / BLOCKS : 0.1)).toFixed(1)} dB`,
      "SFX: peak -inf dB", "Ambience: peak -14.0 dB",
    ]);
    const late = level.tooltipAt!(3.2)!.split("\n");
    expect(late[3]).toBe("Ambience: peak -inf dB");
    expect(level.tooltipAt!(0.1)).toBeNull();
    source.close();
  });
});

describe("the bus gain factors", () => {
  it("draws each bus's effective gain from the keyframe in force", async () => {
    const { source, gain } = await open();
    expect(gain.track).toMatchObject({ id: BUS_GAIN_TRACK_ID, kind: "line" });
    const lines = gain.data()!.lines!;
    expect(lines).toHaveLength(4);
    const times = Array.from(lines[1]!.times as ArrayLike<number>);
    expect(times[0]).toBe(GRID_BASE_S); // before the first keyframe at 0.016 s there is none
    const music = Array.from(lines[1]!.values as ArrayLike<number>);
    // authored 0.5 throughout; the duck of 0.8 from the third keyframe (2.016 s): 0.5 before, 0.4 after
    expect(music[times.indexOf(2)]).toBeCloseTo(0.5, 6);
    expect(music[times.indexOf(2.5)]).toBeCloseTo(0.4, 6);
    expect(Array.from(lines[0]!.values as ArrayLike<number>).every((v) => v === 1)).toBe(true);
    // the tombstone's product is 0 (its dip lane)
    expect(lines[3]!.values[times.indexOf(3)]!).toBe(0);
    expect(lines[3]!.values[times.indexOf(1)]!).toBe(1);
    source.close();
  });

  it("lists the lanes off unity and the product in the tooltip", async () => {
    const { source, gain } = await open();
    const rows = gain.tooltipAt!(3.2)!.split("\n");
    expect(rows[0]).toBe("Master: product 1.000 (0.0 dB), every lane at unity");
    expect(rows[1]).toBe("Music: product 0.400 (-8.0 dB) = authored -6.0 dB x duck -1.9 dB");
    expect(rows[2]).toBe("SFX: product 1.000 (0.0 dB), every lane at unity");
    expect(rows[3]).toBe("Ambience (removed): product 0.000 (-inf dB) = dip -inf dB");
    expect(gain.tooltipAt!(1.2)!.split("\n")[1]).toBe("Music: product 0.500 (-6.0 dB) = authored -6.0 dB");
    expect(gain.tooltipAt!(0.1)).toBeNull();
    source.close();
  });

  it("builds its text from busFactorsModel: a muted lane reads -inf and counts as off unity", () => {
    const f = busFactors({ slot: 1, gen: 1, flags: 1, lanes: Array.from({ length: 10 }, () => 1), duck: 1, automation: 0.5 });
    expect(busFactorsText("Music", f)).toBe("Music: product 0.000 (-inf dB) = authored -inf dB x automation -6.0 dB");
  });
});

describe("naming", () => {
  it("names a bus tombstoned mid-capture from META's project section, not the recycled slot's name", async () => {
    const { ctx, source } = await open({ ...NAMES.buses, 3: "Recycled" });
    expect(busName(ctx, 3, true)).toBe("Ambience");
    expect(busName(ctx, 3, false)).toBe("Recycled");
    source.close();
  });

  it("falls back to META's name, then to the slot", async () => {
    const { ctx, source } = await open(NAMES.buses, [{ name: "Master" }]);
    expect(busName(ctx, 1, true)).toBe("Music");
    expect(busName(ctx, 3, true)).toBe("bus 3");
    source.close();
  });

  it("names the tombstone in both tooltips when META's names lack it", async () => {
    const { source, level, gain } = await open();
    expect(gain.tooltipAt!(3.2)!).toContain("Ambience (removed)");
    expect(level.tooltipAt!(3.2)!).toContain("Ambience: peak");
    source.close();
  });
});

describe("the sampler", () => {
  it("doubles the grid step while the capture would need more than the most samples", () => {
    expect(gridStride(10)).toBe(GRID_BASE_S);
    const long = gridStride(600);
    expect(long).toBe(2);
    expect(600 / long + 1).toBeLessThanOrEqual(MAX_GRID_SAMPLES);
    expect(600 / (long / 2) + 1).toBeGreaterThan(MAX_GRID_SAMPLES);
  });

  it("seeks each grid point once: a second refresh does no work", async () => {
    const { source, ctx } = await open();
    let seeks = 0;
    const real = source.seek.bind(source);
    source.seek = (t) => {
      seeks++;
      return real(t);
    };
    const sampler = new BusSampler(ctx.source);
    await sampler.refresh();
    const first = seeks;
    expect(first).toBe(Math.floor(source.duration / GRID_BASE_S) + 1);
    await sampler.refresh();
    expect(seeks).toBe(first);
    expect(sampler.samples).toHaveLength(first);
    source.close();
  });

  it("has no data for a capture without a STATUS or a keyframe", async () => {
    const bytes = assembleCapture(SAMPLE_HEADER, SAMPLE_META, [{ seq: 1, type: RecordType.EPOCH, epoch: 0, frame: 0, payload: { reason: 0, sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0, perfMs: 1000 } }], { index: true });
    const source = await CaptureSource.openFile(bytes.slice().buffer, { worker: inProcessWorker() });
    const mods = busTracks({ source, names: nameLookup(source.summary.names) });
    for (const m of mods) {
      await m.refresh();
      expect(m.data()).toBeUndefined();
      expect(m.tooltipAt!(0)).toBeNull();
    }
    source.close();
  });
});
