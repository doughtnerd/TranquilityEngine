// The render cache (ADR 0342): keys follow exactly what a render bakes, a second render of the same inputs is read
// back from the store, and a store that can't write still renders.
import { describe, expect, it } from "vitest";
import { defaultEffect } from "../effects/catalogue";
import { defaultSampleEdits } from "./format";
import { cachedRender, renderCachePath, renderKey, type RenderStore } from "./renderCache";
import { renderSample } from "./sampleRender";
import type { SampleEdits } from "./types";

const RATE = 48000;
const source = new Uint8Array([1, 2, 3, 4]);
const pcm = { pcm: new Float32Array(RATE / 20).fill(0.25), channels: 1, rate: RATE };
const gained = (db: number): SampleEdits => ({ ...defaultSampleEdits(), effects: [{ ...defaultEffect("gain", "g"), params: { gain: db } }] });

function memoryStore(): RenderStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return { files, read: async (p) => files.get(p) ?? null, write: async (p, b) => void files.set(p, b) };
}

describe("renderKey", () => {
  it("changes with the source bytes and the baked edits, not with what the runtime applies", async () => {
    const base = await renderKey(source, gained(6));
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await renderKey(source, gained(6))).toBe(base);
    expect(await renderKey(new Uint8Array([1, 2, 3, 5]), gained(6))).not.toBe(base);
    expect(await renderKey(source, gained(5))).not.toBe(base);
    // Loops, markers, trim, tempo and a bypassed lane don't change what is rendered.
    const e = { ...gained(6), trim: [0.1, 0.2] as [number, number], markers: [{ id: "m", type: "exit" as const, name: "Exit", at: 0.1, file: null }] };
    expect(await renderKey(source, { ...e, automation: [{ id: "a", target: "fx:g:gain", input: "clipTime", curve: [[0, 0]], bypass: true }] })).toBe(base);
    expect(await renderKey(source, { ...e, automation: [{ id: "a", target: "fx:g:gain", input: "clipTime", curve: [[0, 0]], bypass: false }] })).not.toBe(base);
    expect(await renderKey(source, { ...gained(6), normalize: { mode: "peak", target: -1, gainDb: 2 } })).not.toBe(base);
  });
});

describe("cachedRender", () => {
  it("renders on a miss, stores it under its key, and reads it back on a hit without decoding", async () => {
    const store = memoryStore();
    let decoded = 0;
    const read = async () => (decoded++, pcm);
    const miss = await cachedRender(store, source, gained(6), read, renderSample);
    expect(miss.hit).toBe(false);
    expect(store.files.get(renderCachePath(miss.key))).toEqual(miss.bytes);
    const hit = await cachedRender(store, source, gained(6), read, renderSample);
    expect(hit).toEqual({ bytes: miss.bytes, hit: true, key: miss.key, warnings: [] });
    expect(decoded).toBe(1);
    const other = await cachedRender(store, source, gained(-6), read, renderSample);
    expect(other.hit).toBe(false);
    expect(decoded).toBe(2);
    expect(store.files.size).toBe(2);
  });

  it("still returns the render when the store can't read or write", async () => {
    const broken: RenderStore = { read: () => Promise.reject(new Error("no")), write: () => Promise.reject(new Error("no")) };
    const r = await cachedRender(broken, source, gained(0), async () => pcm, renderSample);
    expect(r.hit).toBe(false);
    expect(r.bytes.length).toBe(58 + pcm.pcm.length * 4);
  });
});
