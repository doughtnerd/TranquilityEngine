// `CpuMeter` (api-and-models §10, the `CpuMeter` row; architecture §4.3). Every case drives the meter with a fake
// `Date.now` through a small shell model, never a wall clock.
import { describe, expect, it } from "vitest";
import { CPU_FIT_MIN_WINDOWS, CPU_FIT_WINDOWS, CpuMeter } from "./cpuMeter";

const SAMPLE_RATE = 48000;
/** One render quantum, ms: 128 frames at 48 kHz. */
const QUANTUM_MS = (128 * 1000) / SAMPLE_RATE;

/** §4.3's figure: 1,000 × Δbusy / (Δquanta × quantum ms). */
function figure(dBusyMs: number, dQuanta: number): number {
  return (1000 * dBusyMs) / (dQuanta * QUANTUM_MS);
}

/**
 * The shell model: a fake `Date.now` the test advances, and the counters the worklet keeps around `driver.process`
 * (§4.3). `quantum(workMs, periodMs)` reads t0, runs `workMs` of work so t1 = t0 + workMs, and puts the next quantum's
 * t0 `periodMs` after this one (the fake clock's step). A d outside 0..1,000 (a wall-clock step, modelled by a negative
 * or huge `workMs`) counts 0 and one clockSteps, as the shell does.
 */
class FakeShell {
  clock = 0;
  busyMsTotal = 0;
  quantaTotal = 0;
  clockStepMs = 0;
  clockSteps = 0;
  wuVoices = 0;
  wuBuses = 0;
  private prevT0: number | null = null;

  quantum(workMs: number, periodMs: number): void {
    const t0 = this.clock;
    let d = workMs;
    if (d < 0 || d > 1000) {
      this.clockSteps = Math.min(65535, this.clockSteps + 1);
      d = 0;
    }
    this.busyMsTotal += d;
    this.quantaTotal += 1;
    if (this.prevT0 !== null) {
      const step = t0 - this.prevT0;
      if (step > 0 && (this.clockStepMs === 0 || step < this.clockStepMs)) this.clockStepMs = step;
    }
    this.prevT0 = t0;
    this.clock = t0 + periodMs;
  }

  /** A driver restart: the shell and core counters go back to 0 (an epoch). */
  restart(): void {
    this.busyMsTotal = 0;
    this.quantaTotal = 0;
    this.clockStepMs = 0;
    this.clockSteps = 0;
    this.wuVoices = 0;
    this.wuBuses = 0;
    this.prevT0 = null;
  }

  /** Posts a STATUS block carrying the current totals. */
  feed(meter: CpuMeter): void {
    meter.feed({
      busyMsTotal: this.busyMsTotal,
      quantaTotal: this.quantaTotal,
      wuVoices: this.wuVoices,
      wuBuses: this.wuBuses,
      wuSpatial: 0,
      wuMusic: 0,
      wuLoudness: 0,
      clockStepMs: this.clockStepMs,
      clockSteps: this.clockSteps,
    });
  }
}

interface Run {
  /** Driver time of the quantum that starts when `n` quanta have run, ms. */
  work: (n: number) => number;
  /** Spacing of the fake Date.now between quanta, ms (the step). */
  periodMs: number;
  /** STATUS cadence in quanta (1 = every quantum). */
  cadence?: number;
  /** Drops the STATUS posted at this quanta count. */
  skip?: (quanta: number) => boolean;
}

/** Runs `count` quanta, posting a STATUS at each cadence multiple that is not skipped. */
function run(shell: FakeShell, meter: CpuMeter, count: number, r: Run): void {
  const cadence = r.cadence ?? 1;
  for (let i = 0; i < count; i++) {
    shell.quantum(r.work(shell.quantaTotal), r.periodMs);
    if (shell.quantaTotal % cadence === 0 && !(r.skip?.(shell.quantaTotal) ?? false)) shell.feed(meter);
  }
}

describe("CpuMeter (fake Date.now)", () => {
  it("null before the first 96-quantum window; then the figure", () => {
    const shell = new FakeShell();
    const meter = new CpuMeter(SAMPLE_RATE);
    const r: Run = { work: (n) => (n % 4 === 0 ? 1 : 0), periodMs: 1 };
    shell.feed(meter);
    run(shell, meter, 95, r);
    expect(meter.loadPermille).toBeNull();
    expect(meter.debug().loadPermille).toBeNull();
    run(shell, meter, 1, r);
    // 96 quanta: 24 of them carry 1 ms of work.
    expect(meter.loadPermille).toBeCloseTo(figure(24, 96), 9);
    expect(meter.debug().hidden).toBeNull();
  });

  it("a 96-quantum window at a 1 ms step: 1000 x busy / (quanta x quantum ms)", () => {
    const shell = new FakeShell();
    const meter = new CpuMeter(SAMPLE_RATE);
    const r: Run = { work: (n) => (n % 4 === 0 ? 1 : 0), periodMs: 1 };
    shell.feed(meter);
    // Irregular stops, so the window's newest sample moves through every phase of the pattern.
    for (const stop of [96, 133, 150, 211]) {
      run(shell, meter, stop - shell.quantaTotal, r);
      expect(meter.loadPermille).toBeCloseTo(figure(24, 96), 9);
    }
    expect(meter.debug().windowMs).toBeCloseTo(96 * QUANTUM_MS, 9);
    expect(meter.debug().clockStepMs).toBe(1);
  });

  it("a 2 ms step uses a 384-quantum window and reports windowMs 1 s at 48 kHz", () => {
    const shell = new FakeShell();
    const meter = new CpuMeter(SAMPLE_RATE);
    // STATUS every 6 quanta: a 384-quantum window spans 64 samples, which the ring holds.
    const r: Run = { work: (n) => (n % 2 === 0 ? 0 : 2), periodMs: 2, cadence: 6 };
    shell.feed(meter);
    run(shell, meter, 96, r);
    expect(meter.debug().clockStepMs).toBe(2);
    // The 96-quantum window is not used at a 2 ms step.
    expect(meter.loadPermille).toBeNull();
    run(shell, meter, 287, r);
    expect(meter.loadPermille).toBeNull();
    run(shell, meter, 1, r);
    // 384 quanta, mean 1 ms of work each: 375 permille. The window is 1.024 s ("1 s" in §4.3).
    expect(meter.loadPermille).toBeCloseTo(figure(384, 384), 9);
    expect(meter.debug().windowMs).toBeCloseTo(384 * QUANTUM_MS, 9);
    expect(meter.debug().hidden).toBeNull();
  });

  it("a 6 to 48 cadence switch changes the samples a window spans, not the figure", () => {
    const shell = new FakeShell();
    const meter = new CpuMeter(SAMPLE_RATE);
    const r: Run = { work: (n) => (n % 4 === 0 ? 1 : 0), periodMs: 1, cadence: 6 };
    shell.feed(meter);
    run(shell, meter, 192, r);
    expect(meter.loadPermille).toBeCloseTo(figure(24, 96), 9);
    expect(meter.debug().windowMs).toBeCloseTo(96 * QUANTUM_MS, 9);
    run(shell, meter, 192, { ...r, cadence: 48 });
    expect(meter.loadPermille).toBeCloseTo(figure(24, 96), 9);
    expect(meter.debug().windowMs).toBeCloseTo(96 * QUANTUM_MS, 9);
  });

  it("a skipped post leaves the figure unbiased", () => {
    const shell = new FakeShell();
    const meter = new CpuMeter(SAMPLE_RATE);
    const r: Run = { work: (n) => n % 2, periodMs: 1, cadence: 6, skip: (q) => q === 6 };
    shell.feed(meter);
    // Newest post at 102 needs a sample at or before quantum 6, which was skipped: the window falls back to quantum 0
    // (102 quanta). The count stays even, so the mean is still exactly one half.
    run(shell, meter, 102, r);
    expect(meter.loadPermille).toBeCloseTo(figure(51, 102), 9);
    run(shell, meter, 6, r);
    expect(meter.loadPermille).toBeCloseTo(figure(48, 96), 9);
  });

  it("a backwards clock step is clamped by the shell model and counted in clockSteps", () => {
    const shell = new FakeShell();
    const meter = new CpuMeter(SAMPLE_RATE);
    // Quantum 50 reads t1 3 ms before t0 (a step back); quantum 70 reads 5,000 ms after (a step forward). Both count 0,
    // and the pattern's own work at those quanta is 0 too, so the exact figure is unchanged.
    const r: Run = { work: (n) => (n === 50 ? -3 : n === 70 ? 5000 : n % 4 === 0 ? 1 : 0), periodMs: 1 };
    shell.feed(meter);
    run(shell, meter, 96, r);
    expect(meter.debug().clockSteps).toBe(2);
    expect(meter.debug().clockStepMs).toBe(1);
    expect(meter.loadPermille).toBeCloseTo(figure(24, 96), 9);
    expect(meter.loadPermille).toBeGreaterThanOrEqual(0);
  });

  it("a step above 2 ms hides the figure with 'clock too coarse (n ms)'", () => {
    const shell = new FakeShell();
    const meter = new CpuMeter(SAMPLE_RATE);
    const r: Run = { work: (n) => n % 2, periodMs: 3 };
    shell.feed(meter);
    run(shell, meter, 96, r);
    expect(meter.debug().clockStepMs).toBe(3);
    expect(meter.loadPermille).toBeNull();
    expect(meter.debug().windowMs).toBe(0);
    expect(meter.debug().hidden).toBe("clock too coarse (3 ms)");
    run(shell, meter, 288, r);
    expect(meter.loadPermille).toBeNull();
    expect(meter.debug().hidden).toBe("clock too coarse (3 ms)");
  });

  it("no step after 1 s of quanta hides the figure", () => {
    const shell = new FakeShell();
    const meter = new CpuMeter(SAMPLE_RATE);
    // The clock never moves: no t0 difference, so clockStepMs stays 0.
    const r: Run = { work: () => 0, periodMs: 0 };
    shell.feed(meter);
    run(shell, meter, 374, r);
    expect(meter.debug().clockStepMs).toBe(0);
    expect(meter.debug().hidden).toBeNull();
    expect(meter.loadPermille).toBe(0);
    // 375 quanta are 1,000 ms; 400 is past it.
    run(shell, meter, 26, r);
    expect(meter.loadPermille).toBeNull();
    expect(meter.debug().windowMs).toBe(0);
    expect(meter.debug().hidden).toBe("clock too coarse (no step in 1 s)");
  });

  it("the live refit follows the work-unit constants and reports sections and refitResidual", () => {
    const shell = new FakeShell();
    const meter = new CpuMeter(SAMPLE_RATE);
    // One window = 96 quanta at 1 ms of work each, with 10 work units of one section per quantum.
    const window = (section: "voices" | "buses") => {
      for (let i = 0; i < 96; i++) {
        shell.quantum(1, 1);
        if (section === "voices") shell.wuVoices += 10;
        else shell.wuBuses += 10;
      }
      shell.feed(meter);
    };
    shell.feed(meter);
    window("voices");
    expect(meter.debug().sections).toBeNull();
    expect(meter.debug().refitResidual).toBeNull();
    for (let w = 1; w < CPU_FIT_MIN_WINDOWS; w++) window("voices");
    const fitted = meter.debug();
    expect(fitted.sections).not.toBeNull();
    expect(fitted.refitResidual).toBeGreaterThanOrEqual(0);
    const first = fitted.sections!;
    expect(first.voices).toBeGreaterThan(first.buses);
    // Switch the work to buses for a full fit span: the shares follow the work.
    for (let w = 0; w < CPU_FIT_WINDOWS; w++) window("buses");
    const second = meter.debug().sections!;
    expect(second.buses).toBeGreaterThan(second.voices);
    expect(meter.debug().refitResidual).toBeGreaterThanOrEqual(0);
  });

  it("an epoch restart (counters back to 0) never yields a negative delta and restarts the window", () => {
    const shell = new FakeShell();
    const meter = new CpuMeter(SAMPLE_RATE);
    const r: Run = { work: (n) => (n % 4 === 0 ? 1 : 0), periodMs: 1 };
    shell.feed(meter);
    run(shell, meter, 200, r);
    expect(meter.loadPermille).toBeCloseTo(figure(24, 96), 9);
    shell.restart();
    shell.feed(meter);
    expect(meter.loadPermille).toBeNull();
    expect(meter.debug().loadPermille).toBeNull();
    // Fewer than 96 quanta of the new epoch: the window may not reach back across the restart.
    run(shell, meter, 50, r);
    expect(meter.loadPermille).toBeNull();
    run(shell, meter, 46, r);
    expect(meter.loadPermille).toBeCloseTo(figure(24, 96), 9);
    expect(meter.loadPermille).toBeGreaterThanOrEqual(0);
  });
});
