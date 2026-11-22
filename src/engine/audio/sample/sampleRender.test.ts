// The offline sample render (ADR 0328): the edit, the baked chain with its automation and tails, normalisation, through
// `renderSample` and the committed `myco_audio_offline.wasm`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultEffect } from "../effects/catalogue";
import type { Effect } from "../effects/types";
import { defaultSampleEdits } from "./format";
import { renderSample, TAIL_CAP_SECONDS } from "./sampleRender";
import { renderTime, renderTimeMap, sampleEditPlan, sourceTimeAt } from "./sampleTimeMap";
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
  it("applies the trim, closes gaps and silences deleted snippets", async () => {
    // A ramp: sample i holds i / 48000 (its own source second).
    const src = mono(2, (i) => i / RATE);
    const out = await renderSample(src, edits({ trim: [0.5, 1.8], closedGaps: [[1, 0.25]], cuts: [1.5], deleted: [1.5] }));
    expect(out.frames).toBe(Math.round((1.3 - 0.25) * RATE));
    expect(out.pcm[0]).toBeCloseTo(0.5, 6); // starts at the trim
    expect(out.pcm[Math.round(0.5 * RATE) - 1]).toBeCloseTo(1 - 1 / RATE, 6); // up to the gap
    expect(out.pcm[Math.round(0.5 * RATE)]).toBeCloseTo(1.25, 6); // the gap is closed
    expect(out.pcm[Math.round(0.6 * RATE)]).toBeCloseTo(1.35, 6);
    // 1.5 .. 1.8 (to the trim's end) is the deleted snippet: silent, in place.
    const del = Math.round((1.5 - 0.5 - 0.25) * RATE);
    expect(out.pcm[del - 10]).toBeGreaterThan(1.4);
    expect(Array.from(out.pcm.subarray(del, out.frames)).every((v) => v === 0)).toBe(true);
    expect(out.warnings).toEqual([]);
  });

  it("ramps a gain by its automation lane over source time, through the trim", async () => {
    // A lane from −24 dB at 0 s to 0 dB at 2 s; the sample is trimmed to start at 1 s (where the lane is at −12 dB).
    const e = edits({ trim: [1, 2], effects: [fx("gain", "fx1")], automation: [lane("fx:fx1:gain", [[0, -24], [2, 0]])] });
    const out = await renderSample(mono(2, 0.5), e);
    expect(out.frames).toBe(RATE);
    for (const [t, want] of [[0, -12], [0.25, -9], [0.5, -6], [0.9, -1.2]] as const) {
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

  it("reverses, fades and normalises after the effects", async () => {
    const ramp = mono(1, (i) => i / RATE);
    const rev = await renderSample(ramp, edits({ effects: [fx("reverse", "r")] }));
    expect(rev.pcm[0]).toBeCloseTo(1 - 1 / RATE, 6);
    expect(rev.pcm[RATE - 1]).toBe(0);
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

describe("sample time map", () => {
  const e = edits({ trim: [0.5, 2], closedGaps: [[1, 0.25]] });
  it("plans the pieces and maps source seconds into a render and back", () => {
    const plan = sampleEditPlan(e, 3);
    expect(plan.pieces).toEqual([{ srcStart: 0.5, srcEnd: 1, outStart: 0 }, { srcStart: 1.25, srcEnd: 2, outStart: 0.5 }]);
    expect(plan.length).toBe(1.25);
    const map = renderTimeMap(e, 3, 1.5);
    expect(renderTime(map, 0.75)).toBe(0.25);
    expect(renderTime(map, 1.5)).toBe(0.75);
    expect(renderTime(map, 1.1)).toBeNull(); // in the gap
    expect(renderTime(map, 0.2)).toBeNull(); // before the trim
    expect(sourceTimeAt(map, 0.75)).toBe(1.5);
    expect(sourceTimeAt(map, 1.4)).toBeCloseTo(2.15, 9); // a tail continues the last piece
    const rev = renderTimeMap({ ...e, effects: [fx("reverse", "r")] }, 3, 1.5);
    expect(renderTime(rev, 0.75)).toBe(1.25);
    expect(sourceTimeAt(rev, 1.25)).toBe(0.75);
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
    const { instance } = await WebAssembly.instantiate(wasm, {});
    const x = instance.exports as { memory: WebAssembly.Memory; myco_offline_source_hash(): number };
    expect(Buffer.from(x.memory.buffer, x.myco_offline_source_hash(), 16).toString("hex")).toBe(hash.sourceHash);
  });
});
