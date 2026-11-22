// The timeline components' models: time displays and parsing, ruler ticks, the waveform's view and columns, and the
// playhead from the audio clock.
import { describe, expect, it } from "vitest";
import { buildMips } from "../../plugins/audio/editor/music/peaksMip";
import { playheadAt, runSeconds } from "./playheadModel";
import { formatTime, parseTime, rulerTicks, TICKS_PER_BEAT } from "./timeRulerModel";
import { bandRect, clampView, fitView, followTime, MIN_VIEW_SECONDS, timeToX, waveColumns, xToTime, zoomAt, zoomTo } from "./waveformModel";

const ctx = { rate: 48000, bpm: 120, meter: "4/4" };

describe("time displays", () => {
  it("writes timecode, samples and bars", () => {
    expect(formatTime(62.3456, "timecode", ctx)).toBe("1:02.346");
    expect(formatTime(1, "samples", ctx)).toBe("48 000");
    // 120 BPM: a beat is 0.5 s, a bar 2 s.
    expect(formatTime(0, "bars", ctx)).toBe("1:1:000");
    expect(formatTime(2.25, "bars", ctx)).toBe("2:1:480");
    expect(TICKS_PER_BEAT).toBe(960);
    expect(formatTime(-0.5, "timecode", ctx)).toBe("-0:00.500");
  });

  it("falls back to timecode for bars without a tempo", () => {
    expect(formatTime(1.5, "bars", { rate: 48000 })).toBe("0:01.500");
  });

  it("parses what it writes, plain seconds, ms and samples", () => {
    expect(parseTime("1:02.346", "timecode", ctx)).toBeCloseTo(62.346, 6);
    expect(parseTime("2:1:480", "bars", ctx)).toBeCloseTo(2.25, 6);
    expect(parseTime("1.25", "timecode", ctx)).toBe(1.25);
    expect(parseTime("1.25s", "samples", ctx)).toBe(1.25);
    expect(parseTime("120ms", "timecode", ctx)).toBeCloseTo(0.12, 9);
    expect(parseTime("48 000", "samples", ctx)).toBe(1);
    expect(parseTime("48000", "timecode", ctx)).toBe(48000);
    expect(parseTime("1:5:0", "bars", ctx)).toBeNull(); // beat 5 of a 4/4 bar
    expect(parseTime("abc", "timecode", ctx)).toBeNull();
    expect(parseTime("", "timecode", ctx)).toBeNull();
  });
});

describe("ruler ticks", () => {
  it("labels ticks at least 70 px apart in timecode", () => {
    const ticks = rulerTicks({ start: 0, end: 2.6 }, 640, "timecode", ctx);
    const majors = ticks.filter((t) => t.major);
    expect(majors[0]).toMatchObject({ t: 0, label: "0:00.000" });
    const step = majors[1].t - majors[0].t;
    expect(step * (640 / 2.6)).toBeGreaterThanOrEqual(70);
    expect(ticks.length).toBeGreaterThan(majors.length);
  });

  it("puts bar lines on bars when bars are wide enough", () => {
    const ticks = rulerTicks({ start: 0, end: 16 }, 800, "bars", ctx);
    expect(ticks.filter((t) => t.major).map((t) => t.label).slice(0, 3)).toEqual(["1:1:000", "2:1:000", "3:1:000"]);
  });

  it("returns nothing for an empty span", () => {
    expect(rulerTicks({ start: 1, end: 1 }, 600, "timecode", ctx)).toEqual([]);
  });
});

describe("waveform view", () => {
  it("maps time and pixels both ways", () => {
    const v = { start: 1, end: 3 };
    expect(timeToX(2, v, 200)).toBe(100);
    expect(xToTime(50, v, 200)).toBe(1.5);
  });

  it("zooms at a point keeping it under the pointer, never below 5 ms and inside the sample", () => {
    const v = zoomAt({ start: 0, end: 2 }, 2, 1, 2);
    expect(v).toEqual({ start: 0.5, end: 1.5 });
    const tiny = zoomAt({ start: 0, end: 0.01 }, 100, 0.005, 2);
    expect(tiny.end - tiny.start).toBeCloseTo(MIN_VIEW_SECONDS, 9);
    expect(clampView({ start: -1, end: 5 }, 2)).toEqual({ start: 0, end: 2 });
    expect(clampView({ start: 1.8, end: 2.3 }, 2).start).toBeCloseTo(1.5, 9);
    expect(fitView(3)).toEqual({ start: 0, end: 3 });
    expect(zoomTo({ start: 1, end: 2 }, 10)).toEqual({ start: 0.95, end: 2.05 });
  });

  it("follows the playhead a page at a time", () => {
    expect(followTime({ start: 0, end: 1 }, 0.5, 4)).toEqual({ start: 0, end: 1 });
    expect(followTime({ start: 0, end: 1 }, 1.2, 4)).toEqual({ start: 1.2, end: 2.2 });
  });

  it("draws one column per pixel from the peaks, merging channels", () => {
    const data = new Int16Array([-100, 100, -32768, 32767, -10, 10, -5, 5]); // 2 channels × 2 bins
    const mips = { rate: 4, channels: 2, frames: 4, levels: buildMips({ binFrames: 2, bins: 2, channels: 2, data }) };
    const cols = waveColumns(mips, { start: 0, end: 1 }, 2);
    expect(cols.max[0]).toBeCloseTo(100 / 32767, 6); // bin 0: ±100 on channel 0, ±10 on channel 1
    expect(cols.max[1]).toBeCloseTo(1, 4);
    expect(cols.min[1]).toBeCloseTo(-1, 4);
    expect(Number.isNaN(waveColumns(null, { start: 0, end: 1 }, 3).min[0])).toBe(true);
  });

  it("places bands, a hold point 2 px wide", () => {
    expect(bandRect({ start: 1, end: 2, color: "--range-loop" }, { start: 0, end: 4 }, 400)).toEqual({ x: 100, w: 100 });
    expect(bandRect({ start: 1, end: 1, color: "--range-loop" }, { start: 0, end: 4 }, 400)).toEqual({ x: 100, w: 2 });
    expect(bandRect({ start: 5, end: 6, color: "--range-loop" }, { start: 0, end: 4 }, 400)).toBeNull();
  });
});

describe("playhead", () => {
  it("runs from a point to the end", () => {
    const run = { startedAt: 10, from: 1, to: 3 };
    expect(playheadAt(run, 10.5)).toMatchObject({ t: 1.5, done: false });
    expect(playheadAt(run, 13)).toMatchObject({ t: 3, done: true });
    expect(runSeconds(run)).toBe(2);
  });

  it("counts in during a pre-roll", () => {
    expect(playheadAt({ startedAt: 0, from: 1, to: 2, preRoll: 1 }, 0.5)).toMatchObject({ t: 1, counting: true });
    expect(playheadAt({ startedAt: 0, from: 1, to: 2, preRoll: 1 }, 1.25)).toMatchObject({ t: 1.25, counting: false });
  });

  it("cycles an endless loop and runs a counted one out to the end", () => {
    const loop = { start: 1, end: 2, count: 0 };
    expect(playheadAt({ startedAt: 0, from: 0, to: 3, loop }, 2.5).t).toBeCloseTo(1.5, 9);
    expect(playheadAt({ startedAt: 0, from: 0, to: 3, loop }, 10.25).t).toBeCloseTo(1.25, 9);
    expect(runSeconds({ startedAt: 0, from: 0, to: 3, loop })).toBe(Infinity);
    const twice = { startedAt: 0, from: 0, to: 3, loop: { ...loop, count: 2 } };
    expect(playheadAt(twice, 2.5)).toMatchObject({ pass: 2 });
    expect(playheadAt(twice, 3.5).t).toBeCloseTo(2.5, 9);
    expect(playheadAt(twice, 9)).toMatchObject({ t: 3, done: true });
    expect(runSeconds(twice)).toBe(4);
  });
});
