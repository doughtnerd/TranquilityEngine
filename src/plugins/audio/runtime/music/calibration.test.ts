import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "../../../../engine/platform/Storage";

// Each case starts on a fresh module (`vi.resetModules`), as a page load does; `reload()` mid-case is a reload: the
// calibration's memory is gone and Storage (the same `store`) keeps what was written.
let cal: typeof import("./calibration");
let storage: typeof import("../../../../engine/platform/Storage").Storage;
let store: MemoryStorage;
async function reload(): Promise<void> {
  vi.resetModules();
  ({ Storage: storage } = await import("../../../../engine/platform/Storage"));
  storage.use(store);
  cal = await import("./calibration");
}
/** Lets a storage read or write land (a few promise turns). */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// The spike's simulated taps (spikes/audio-music/rhythm/calibrate-sim.mjs): same generator and model.
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
function simTaps(used: number, trueOffset: number, sd: number, outliers: number): number[] {
  const x: number[] = [];
  for (let i = 0; i < used + 4; i++) {
    let e = trueOffset + gauss() * sd * (i < 4 ? 2 : 1);
    if (rnd() < outliers) e += (rnd() < 0.5 ? -1 : 1) * (0.15 + rnd() * 0.25);
    x.push(e);
  }
  return x;
}
const p95 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(0.95 * a.length))];

beforeEach(async () => {
  store = new MemoryStorage();
  await reload();
});

describe("cal.Calibration.fromTaps", () => {
  it("is the public namespace", () => expect(cal.Calibration.fromTaps).toBe(cal.fromTaps));

  it("p95 error is under 10 ms on the spike's simulated taps (sd 15 ms, 10% outliers, the 24 usable taps of the recommended flow)", () => {
    // 16 taps is the spike's "about 10 ms" row (9.7 there, 10.2 on this seed): reported, not gated; 24 is the flow's length.
    for (const used of [24, 32]) {
      const errs: number[] = [];
      for (let k = 0; k < 5000; k++) errs.push(Math.abs(cal.fromTaps(simTaps(used, 0.04, 0.015, 0.1)).offset - 0.04));
      const e = p95(errs) * 1000;
      console.log(`calibration p95 with ${used} taps: ${e.toFixed(2)} ms`);
      expect(e).toBeLessThan(10);
    }
  });

  it("drops non-finite taps, then the warmup; takes median and MAD; counts discards", () => {
    const taps = [0.5, 0.5, 0.5, Number.NaN, 0.5, 0.01, 0.02, 0.03, 0.04, 0.05, Infinity];
    const r = cal.fromTaps(taps);
    expect(r.used).toBe(5);
    expect(r.discarded).toBe(6);
    expect(r.offset).toBeCloseTo(0.03, 12);
    expect(r.spread).toBeCloseTo(0.01, 12);
  });

  it("honours options.warmup, including 0, and falls back to 4 for a bad value", () => {
    expect(cal.fromTaps([1, 0.02, 0.02, 0.02], { warmup: 0 }).used).toBe(4);
    expect(cal.fromTaps([1, 0.02, 0.02, 0.02], { warmup: 1 }).offset).toBeCloseTo(0.02, 12);
    expect(cal.fromTaps([1, 1, 1, 1, 0.03], { warmup: Number.NaN }).offset).toBeCloseTo(0.03, 12);
  });

  it("shrugs off outliers the way a median does", () => {
    const clean = Array.from({ length: 20 }, (_, i) => 0.04 + (i % 2 ? 0.005 : -0.005));
    expect(cal.fromTaps([0, 0, 0, 0, ...clean, 0.4, -0.4, 0.4]).offset).toBeCloseTo(0.04, 2);
  });

  it("too few taps: none or only warmup gives a zero, unconfident, unsteady result without throwing", () => {
    for (const taps of [[], [0.1, 0.1], [0.1, 0.1, 0.1, 0.1]]) {
      expect(cal.fromTaps(taps)).toEqual({ offset: 0, spread: 0, confidence: 0, used: 0, discarded: taps.length, steady: false });
    }
  });

  it("a few usable taps give a value but low confidence and not steady", () => {
    const r = cal.fromTaps([0, 0, 0, 0, 0.04, 0.04, 0.04, 0.04]);
    expect(r.offset).toBeCloseTo(0.04, 12);
    expect(r.spread).toBe(0);
    expect(r.confidence).toBeCloseTo(0.25, 12); // 4 of 16
    expect(r.steady).toBe(false);
  });

  it("confidence and steady follow the formula", () => {
    const tight = cal.fromTaps([0, 0, 0, 0, ...Array.from({ length: 16 }, () => 0.03)]);
    expect(tight.confidence).toBe(1);
    expect(tight.steady).toBe(true);
    const mid = cal.fromTaps([0, 0, 0, 0, ...Array.from({ length: 16 }, (_, i) => (i % 2 ? 0.02 : -0.02))]);
    expect(mid.spread).toBeCloseTo(0.02, 12);
    expect(mid.confidence).toBeCloseTo(0.5, 12);
    expect(mid.steady).toBe(true);
    const wild = cal.fromTaps([0, 0, 0, 0, ...Array.from({ length: 16 }, (_, i) => (i % 2 ? 0.06 : -0.06))]);
    expect(wild.confidence).toBe(0);
    expect(wild.steady).toBe(false);
  });
});

describe("Audio.calibration persistence", () => {
  it("defaults to 0, not stale, and ignores non-finite values", () => {
    expect(cal.getCalibration()).toBe(0);
    expect(cal.isCalibrationStale()).toBe(false);
    cal.setCalibration(Number.NaN);
    cal.setCalibration(Infinity);
    expect(cal.getCalibration()).toBe(0);
  });

  it("writes to settings under the device key and reads back after a simulated reload", async () => {
    await cal.initCalibration("sinkA");
    cal.setCalibration(0.045);
    await settle();
    expect(await storage.load("audio.calibration.sinkA", "settings")).toEqual({ seconds: 0.045 });
    await reload(); // the reload: memory gone, Storage stays
    expect(cal.getCalibration()).toBe(0);
    await cal.initCalibration("sinkA");
    expect(cal.getCalibration()).toBe(0.045);
    expect(cal.isCalibrationStale()).toBe(false);
  });

  it("keeps one value per device", async () => {
    await cal.initCalibration("");
    cal.setCalibration(0.03);
    await settle();
    await cal.calibrationDeviceChanged("bt");
    cal.setCalibration(0.18);
    await settle();
    await reload();
    await cal.initCalibration("");
    expect(cal.getCalibration()).toBe(0.03);
    await reload();
    await cal.initCalibration("bt");
    expect(cal.getCalibration()).toBe(0.18);
  });

  it("a device change to an uncalibrated sink keeps the value and goes stale until set", async () => {
    await cal.initCalibration("a");
    cal.setCalibration(0.04);
    await cal.calibrationDeviceChanged("b");
    expect(cal.getCalibration()).toBe(0.04);
    expect(cal.isCalibrationStale()).toBe(true);
    cal.setCalibration(0.12);
    expect(cal.isCalibrationStale()).toBe(false);
    expect(cal.getCalibration()).toBe(0.12);
  });

  it("a devicechange on the same sink goes stale, value kept", async () => {
    await cal.initCalibration("");
    cal.setCalibration(0.02);
    await cal.calibrationDeviceChanged("");
    expect(cal.isCalibrationStale()).toBe(true);
    expect(cal.getCalibration()).toBe(0.02);
  });

  it("a change back to a calibrated sink adopts its stored value and is not stale", async () => {
    await cal.initCalibration("a");
    cal.setCalibration(0.04);
    await cal.calibrationDeviceChanged("b");
    cal.setCalibration(0.15);
    await settle();
    await cal.calibrationDeviceChanged("a");
    expect(cal.getCalibration()).toBe(0.04);
    expect(cal.isCalibrationStale()).toBe(false);
  });

  it("survives a storage that throws", async () => {
    storage.use({
      save: () => Promise.reject(new Error("no")),
      load: () => Promise.reject(new Error("no")),
      delete: async () => undefined,
      list: async () => [],
    });
    await cal.initCalibration("x");
    cal.setCalibration(0.01);
    await settle();
    expect(cal.getCalibration()).toBe(0.01);
  });
});
