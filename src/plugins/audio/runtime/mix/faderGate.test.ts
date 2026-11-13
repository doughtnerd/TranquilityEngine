// ADR 0171 amended by 0172 (task Fg1; api-and-models §6.6, architecture §4.7 and §7): the fader gate. p95 <= 50 ms from the
// input event's audio-clock timestamp to the first changed core sample, over 100 seeded drags on the loopback host, through
// the preview path (`mixer.apply` + `flushNow()`, one post per `FADER_COALESCE_MS`). Measured in frames the host rendered,
// converted at its rate (`faderGateHarness.ts`); no assertion reads a wall clock.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAudioBackend } from "../backend";
import { events } from "../events/eventRuntime";
import { FADER_COALESCE_MS } from "../wire.generated";
import { runFaderGate, summarize } from "./faderGateHarness";

afterEach(() => {
  events()._reset();
  setAudioBackend(null);
  vi.restoreAllMocks();
});

const GATE_MS = 50;
const fmt = (n: number) => n.toFixed(2);

describe("the fader gate on the audio clock (Fg1)", () => {
  it("p95 <= 50 ms over 100 drags, event to first changed sample, with the latency's parts", { timeout: 120_000 }, async (ctx) => {
    const rs = await runFaderGate({ seed: 1717, drags: 100 });
    if (!rs) return ctx.skip();
    expect(rs).toHaveLength(100);
    const total = summarize(rs, "totalMs");
    const post = summarize(rs, "toPostMs");
    const applied = summarize(rs, "toAppliedMs");
    const sample = summarize(rs, "toSampleMs");
    const row = (name: string, s: { p50: number; p95: number; max: number }) => `${name.padEnd(28)} p50 ${fmt(s.p50)}  p95 ${fmt(s.p95)}  max ${fmt(s.max)} ms`;
    console.info(
      [
        "fader gate (audio clock, loopback, 100 drags, seed 1717)",
        row("event -> first changed sample", total),
        row("  event -> post", post),
        row("  post -> batch applied", applied),
        row("  batch -> first changed", sample),
      ].join("\n"),
    );

    // The drags are real: each held the no-edit render until its batch arrived, changed after it, and settled on its target.
    expect(rs.every((r) => r.baselineHeld)).toBe(true);
    expect(Math.max(...rs.map((r) => r.settleError))).toBeLessThan(1e-5);
    // Variety: both start phases inside the coalescing window and outside it, and every main-thread cadence.
    expect(rs.some((r) => r.precursor)).toBe(true);
    expect(rs.some((r) => !r.precursor)).toBe(true);
    expect(new Set(rs.map((r) => r.cadenceMs)).size).toBe(4);
    expect(new Set(rs.map((r) => Math.round(((r.eventMs * 48) % 128) / 16))).size).toBeGreaterThan(4); // phases inside a quantum
    // Coalescing is exercised and bounded: an event inside the window waits for its end, never longer.
    expect(Math.max(...rs.filter((r) => r.precursor).map((r) => r.toPostMs))).toBeGreaterThan(0);
    expect(post.max).toBeLessThanOrEqual(FADER_COALESCE_MS + 1e-6);
    // The parts add up to the whole.
    for (const r of rs) expect(r.toPostMs + r.toAppliedMs + r.toSampleMs).toBeCloseTo(r.totalMs, 9);
    // The gate (R2).
    expect(total.p95).toBeLessThanOrEqual(GATE_MS);
  });

  it("is deterministic: the same seed draws the same drags and measures the same latencies", { timeout: 60_000 }, async (ctx) => {
    const a = await runFaderGate({ seed: 99, drags: 12 });
    if (!a) return ctx.skip();
    const b = await runFaderGate({ seed: 99, drags: 12 });
    expect(b).toEqual(a);
    const c = await runFaderGate({ seed: 100, drags: 12 });
    expect(c!.map((r) => r.totalMs)).not.toEqual(a.map((r) => r.totalMs));
  });

  it("measures the path it names: without flushNow a drag waits for the main-thread frame, far above the preview path's figure", { timeout: 60_000 }, async (ctx) => {
    const preview = await runFaderGate({ seed: 5, drags: 30, preview: true });
    if (!preview) return ctx.skip();
    const frameOnly = (await runFaderGate({ seed: 5, drags: 30, preview: false }))!;
    const p = summarize(preview, "totalMs");
    const f = summarize(frameOnly, "totalMs");
    console.info(`fader gate sensitivity: preview p95 ${fmt(p.p95)} ms, frame-batch only p95 ${fmt(f.p95)} ms`);
    // The frame's BATCH leaves at the next main-thread frame (up to 50 ms at 20 fps): the harness sees the difference.
    expect(f.p95).toBeGreaterThan(p.p95 + 5);
    expect(summarize(frameOnly, "toPostMs").max).toBeGreaterThan(FADER_COALESCE_MS);
  });
});
