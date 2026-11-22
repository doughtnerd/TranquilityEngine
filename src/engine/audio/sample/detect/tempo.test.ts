// Tempo detection (ADR 0328) on synthetic signals: click tracks at known tempos, their half and double candidates, a
// tempo change, and noise and a lone hit with low confidence.
import { describe, expect, it } from "vitest";
import { detectTempo, TEMPO_CONFIDENCE_FLOOR } from "./tempo";

const RATE = 44100;

/** A click track: a 10 ms decaying 2 kHz burst every beat (accented each `accentEvery`), `seconds` long, from `offset`. */
function clicks(bpm: number | ((t: number) => number), seconds: number, offset = 0.1): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  let t = offset;
  let n = 0;
  while (t < seconds) {
    const start = Math.round(t * RATE);
    const amp = n % 4 === 0 ? 0.9 : 0.6;
    for (let i = 0; i < 0.01 * RATE && start + i < out.length; i++) out[start + i] += amp * Math.exp(-i / (0.002 * RATE)) * Math.sin((2 * Math.PI * 2000 * i) / RATE);
    t += 60 / (typeof bpm === "number" ? bpm : bpm(t));
    n++;
  }
  return out;
}

/** Deterministic white noise. */
function noise(seconds: number, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  let s = seed;
  for (let i = 0; i < out.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s / 2 ** 32 - 0.5) * 0.8;
  }
  return out;
}

const mono = (pcm: Float32Array) => ({ pcm, channels: 1, rate: RATE });

describe("detectTempo", () => {
  it.each([90, 100, 120, 128, 140, 160])("finds a %d BPM click track to within 0.5 BPM, confidently", (bpm) => {
    const d = detectTempo(mono(clicks(bpm, 20)));
    expect(d).not.toBeNull();
    expect(Math.abs(d!.bpm - bpm)).toBeLessThan(0.5);
    expect(d!.confidence).toBeGreaterThan(0.7);
    expect(d!.map).toEqual([]);
  });

  it("offers half and double as candidates, the double one weaker for a plain click track", () => {
    const d = detectTempo(mono(clicks(120, 20)))!;
    const half = d.candidates.find((c) => c.relation === "half")!;
    const double = d.candidates.find((c) => c.relation === "double")!;
    expect(half.bpm).toBeCloseTo(d.bpm / 2, 1);
    expect(double.bpm).toBeCloseTo(d.bpm * 2, 1);
    expect(double.confidence).toBeLessThan(d.confidence);
  });

  it("doesn't take a slow click track for its double, or a fast one for its half", () => {
    expect(Math.abs(detectTempo(mono(clicks(70, 30)))!.bpm - 70)).toBeLessThan(0.5);
    expect(Math.abs(detectTempo(mono(clicks(180, 20)))!.bpm - 180)).toBeLessThan(0.7);
  });

  it("reads stereo and int16 the same as mono float", () => {
    const m = clicks(120, 12);
    const stereo = new Int16Array(m.length * 2);
    for (let i = 0; i < m.length; i++) stereo[2 * i] = stereo[2 * i + 1] = Math.round(m[i] * 32767);
    expect(Math.abs(detectTempo({ pcm: stereo, channels: 2, rate: RATE })!.bpm - 120)).toBeLessThan(0.5);
  });

  it("maps a clear tempo change (100 → 130 BPM) and keeps the first tempo as the base", () => {
    const d = detectTempo(mono(clicks((t) => (t < 30 ? 100 : 130), 60)))!;
    expect(d.map).toHaveLength(1);
    expect(Math.abs(d.map[0].bpm - 130)).toBeLessThan(1);
    expect(Math.abs(d.map[0].at - 30)).toBeLessThan(6);
    expect(Math.abs(d.bpm - 100)).toBeLessThan(1);
  });

  it("gives noise and a single hit low confidence", () => {
    const n = detectTempo(mono(noise(15)));
    expect(n === null || n.confidence < TEMPO_CONFIDENCE_FLOOR).toBe(true);
    const hit = new Float32Array(RATE * 2);
    for (let i = 0; i < 4000; i++) hit[i + 1000] = Math.exp(-i / 800) * Math.sin(i * 0.3);
    const h = detectTempo(mono(hit));
    expect(h === null || h.confidence < TEMPO_CONFIDENCE_FLOOR).toBe(true);
  });

  it("is null for silence and nothing", () => {
    expect(detectTempo(mono(new Float32Array(RATE * 5)))).toBeNull();
    expect(detectTempo(mono(new Float32Array(0)))).toBeNull();
  });
});
