// The offline sample render (ADR 0328): the edit, the baked chain with its automation and tails, normalisation, through
// `renderSample` and the committed `myco_audio_offline.wasm`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultEffect } from "../effects/catalogue";
import type { Effect } from "../effects/types";
import { defaultSampleEdits } from "./format";
import { renderSample, TAIL_CAP_SECONDS } from "./sampleRender";
import type { SampleAutomation, SampleEdits } from "./types";
import { readWavMetadata } from "./wavChunks";
import { encodeWavFloat32 } from "./wavEncode";

const RATE = 48000;

const edits = (over: Partial<SampleEdits> = {}): SampleEdits => ({ ...defaultSampleEdits("oneshot"), ...over });
const fx = (type: Effect["type"], id: string, params: Record<string, number> = {}): Effect => {
  const e = defaultEffect(type, id);
  return { ...e, params: { ...e.params, ...params } };
};
const lane = (target: SampleAutomation["target"], curve: SampleAutomation["curve"]): SampleAutomation => ({ id: target, target, input: "clipTime", curve, bypass: false });
/** `seconds` of mono `value` (or `f(frame)`). */
const mono = (seconds: number, f: number | ((i: number) => number)) => {
  const pcm = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < pcm.length; i++) pcm[i] = typeof f === "number" ? f : f(i);
  return { pcm, channels: 1, rate: RATE };
};
const db = (v: number, ref: number) => 20 * Math.log10(Math.abs(v) / ref);

describe("renderSample", () => {
  it("keeps the source's timeline: trim, cuts, deleted snippets and gaps aren't baked", async () => {
    // A ramp: sample i holds i / 48000 (its own source second).
    const src = mono(2, (i) => i / RATE);
    const out = await renderSample(src, edits({ trim: [0.5, 1.8], closedGaps: [[1, 0.25]], cuts: [1.5], deleted: [1.5], effects: [fx("gain", "g", { gain: 0 })] }));
    expect(out.frames).toBe(2 * RATE);
    expect(Array.from(out.pcm)).toEqual(Array.from(src.pcm));
    expect(out.warnings).toEqual([]);
  });

  it("ramps a gain by its automation lane over source time, through the trim", async () => {
    // A lane from −24 dB at 0 s to 0 dB at 2 s over a 2 s sample (the trim doesn't move it: source seconds).
    const e = edits({ trim: [1, 2], effects: [fx("gain", "fx1")], automation: [lane("fx:fx1:gain", [[0, -24], [2, 0]])] });
    const out = await renderSample(mono(2, 0.5), e);
    expect(out.frames).toBe(2 * RATE);
    for (const [t, want] of [[0.5, -18], [1, -12], [1.5, -6], [1.9, -1.2]] as const) {
      expect(Math.abs(db(out.pcm[Math.round(t * RATE)], 0.5) - want)).toBeLessThan(0.1);
    }
    // A bypassed lane leaves the effect's own value.
    const off = await renderSample(mono(1, 0.5), edits({ effects: [fx("gain", "fx1", { gain: -6 })], automation: [{ ...lane("fx:fx1:gain", [[0, -24], [1, 0]]), bypass: true }] }));
    expect(db(off.pcm[24000], 0.5)).toBeCloseTo(-6, 3);
  });

  it("places a delay's echo at its time and renders its tail past the end", async () => {
    const src = mono(0.01, (i) => (i === 0 ? 1 : 0));
    const out = await renderSample(src, edits({ effects: [fx("delay", "d", { time: 250, feedback: 0, mix: 50 })] }));
    const echo = 0.25 * RATE;
    expect(out.frames).toBeGreaterThan(echo);
    let peakAt = 480;
    for (let i = 480; i < out.frames; i++) if (Math.abs(out.pcm[i]) > Math.abs(out.pcm[peakAt])) peakAt = i;
    expect(Math.abs(peakAt - echo)).toBeLessThanOrEqual(1);
    expect(out.pcm[peakAt]).toBeCloseTo(0.5, 1);
    expect(out.frames).toBeLessThan(echo + 0.1 * RATE);
  });

  it("leaves reverse out with a warning, fades the file and normalises after the effects", async () => {
    const ramp = mono(1, (i) => i / RATE);
    const rev = await renderSample(ramp, edits({ effects: [fx("reverse", "r")] }));
    expect(Array.from(rev.pcm)).toEqual(Array.from(ramp.pcm));
    expect(rev.warnings[0]).toMatch(/Reverse isn't baked/);
    const faded = await renderSample(mono(1, 1), edits({ effects: [fx("fades", "f", { in: 100, out: 0 })], normalize: { mode: "peak", target: -6, gainDb: -6 } }));
    const g = Math.pow(10, -6 / 20);
    expect(faded.pcm[0]).toBe(0);
    expect(faded.pcm[2400]).toBeCloseTo(0.5 * g, 4);
    expect(faded.pcm[24000]).toBeCloseTo(g, 6);
  });

  it("keeps stereo, and reports what it couldn't render", async () => {
    const pcm = new Int16Array(2 * 4800);
    for (let i = 0; i < 4800; i++) {
      pcm[2 * i] = 16384;
      pcm[2 * i + 1] = -8192;
    }
    const out = await renderSample({ pcm, channels: 2, rate: RATE }, edits({ effects: [fx("gain", "g", { gain: 6 })], automation: [lane("fx:nope:gain", [[0, 0]])] }));
    const g = Math.pow(10, 6 / 20);
    expect(out.channels).toBe(2);
    expect(out.pcm[200]).toBeCloseTo(0.5 * g, 5);
    expect(out.pcm[201]).toBeCloseTo(-0.25 * g, 5);
    expect(out.warnings).toEqual(["Automation fx:nope:gain: no such effect parameter in the chain; not rendered."]);
    const capped = await renderSample(mono(0.1, (i) => (i === 0 ? 1 : 0)), edits({ effects: [fx("reverb", "rv", { size: 1, decay: 20, mix: 100 })] }));
    expect(capped.frames).toBe(Math.round(0.1 * RATE) + TAIL_CAP_SECONDS * RATE);
    expect(capped.warnings[0]).toMatch(/still sounding/);
  });
});

describe("float WAV", () => {
  it("writes a 32-bit float WAV a reader takes back", () => {
    const pcm = new Float32Array([0.5, -0.25, 1.5, 0]);
    const bytes = encodeWavFloat32(pcm, 2, 44100);
    const meta = readWavMetadata(bytes);
    expect(meta.sampleRate).toBe(44100);
    const v = new DataView(bytes.buffer);
    expect(v.getUint16(20, true)).toBe(3);
    expect(v.getFloat32(58 + 8, true)).toBe(1.5);
    expect(bytes.length).toBe(58 + 16);
  });
});

describe("the committed offline wasm", () => {
  it("was built from the audio core's current sources (the hash hash.json records)", async () => {
    const hash = JSON.parse(readFileSync(new URL("../../../plugins/audio/runtime/wasm/hash.json", import.meta.url), "utf8")) as { sourceHash: string; bytes: Record<string, number> };
    const wasm = readFileSync(new URL("./wasm/myco_audio_offline.wasm", import.meta.url));
    expect(wasm.length).toBe(hash.bytes["myco_audio_offline.wasm"]);
    // ABI 1.1: plugin effects go through the `myco_ext` import (stubs: no plugins).
    const myco_ext = { acquire: () => 0, release: () => {}, describe: () => 0, process: () => -1, sweep: () => {} };
    const { instance } = await WebAssembly.instantiate(wasm, { myco_ext });
    const x = instance.exports as { memory: WebAssembly.Memory; myco_offline_source_hash(): number };
    expect(Buffer.from(x.memory.buffer, x.myco_offline_source_hash(), 16).toString("hex")).toBe(hash.sourceHash);
  });
});
