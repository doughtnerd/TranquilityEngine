// Root note detection (ADR 0342) on synthetic signals: sines and harmonic tones at known notes, detuned by known cents,
// across the range; noise and a click with low confidence.
import { describe, expect, it } from "vitest";
import { noteNameToMidi } from "../noteNames";
import { detectRoot, ROOT_CONFIDENCE_FLOOR } from "./pitch";

const hzOf = (midi: number, cents = 0) => 440 * Math.pow(2, (midi - 69 + cents / 100) / 12);

/** A tone at `hz` with `harmonics` amplitudes (1/k by default), a 5 ms attack and a slow decay. */
function tone(hz: number, seconds: number, rate: number, harmonics: number[] = [1]): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    let s = 0;
    harmonics.forEach((a, k) => (s += a * Math.sin(2 * Math.PI * hz * (k + 1) * t)));
    out[i] = 0.5 * s * Math.min(1, t / 0.005) * Math.exp(-t / 3);
  }
  return out;
}

function noise(seconds: number, rate: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  let s = 7;
  for (let i = 0; i < out.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s / 2 ** 32 - 0.5) * 0.8;
  }
  return out;
}

describe("detectRoot", () => {
  it.each(["A1", "E2", "C3", "A3", "C4", "F#4", "A4", "C5", "G5", "C6", "B6"])("finds a sine at %s exactly, confidently", (name) => {
    const midi = noteNameToMidi(name)!;
    const d = detectRoot({ pcm: tone(hzOf(midi), 1.5, 48000), channels: 1, rate: 48000 })!;
    expect(d.note).toBe(name);
    expect(Math.abs(d.cents)).toBeLessThanOrEqual(2);
    expect(d.confidence).toBeGreaterThan(0.8);
  });

  it.each([[60, 25], [57, -30], [64, 45], [48, -12]] as const)("reads MIDI %d detuned by %d cents to within 3 cents", (midi, cents) => {
    const d = detectRoot({ pcm: tone(hzOf(midi, cents), 1, 44100), channels: 1, rate: 44100 })!;
    expect(d.midi).toBe(midi);
    expect(Math.abs(d.cents - cents)).toBeLessThanOrEqual(3);
  });

  it("finds the fundamental of harmonic tones (sawtooth-like and a weak fundamental), not an overtone", () => {
    const saw = [1, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 7, 1 / 8];
    expect(detectRoot({ pcm: tone(hzOf(45), 1, 44100, saw), channels: 1, rate: 44100 })!.note).toBe("A2");
    const weak = [0.3, 1, 0.8, 0.5, 0.3];
    const d = detectRoot({ pcm: tone(hzOf(55), 1, 48000, weak), channels: 1, rate: 48000 })!;
    expect(d.note).toBe("G3");
    expect(Math.abs(d.cents)).toBeLessThanOrEqual(3);
  });

  it("reads stereo int16", () => {
    const m = tone(hzOf(62), 1, 44100);
    const st = new Int16Array(m.length * 2);
    for (let i = 0; i < m.length; i++) st[2 * i] = st[2 * i + 1] = Math.round(m[i] * 32767);
    expect(detectRoot({ pcm: st, channels: 2, rate: 44100 })!.note).toBe("D4");
  });

  it("gives noise and a click low confidence", () => {
    const n = detectRoot({ pcm: noise(1, 44100), channels: 1, rate: 44100 });
    expect(n === null || n.confidence < ROOT_CONFIDENCE_FLOOR).toBe(true);
    const click = new Float32Array(44100);
    for (let i = 0; i < 200; i++) click[1000 + i] = (i % 2 ? 1 : -1) * Math.exp(-i / 40);
    const c = detectRoot({ pcm: click, channels: 1, rate: 44100 });
    expect(c === null || c.confidence < ROOT_CONFIDENCE_FLOOR).toBe(true);
  });

  it("is null for silence and too little audio", () => {
    expect(detectRoot({ pcm: new Float32Array(44100), channels: 1, rate: 44100 })).toBeNull();
    expect(detectRoot({ pcm: new Float32Array(100), channels: 1, rate: 44100 })).toBeNull();
  });
});
