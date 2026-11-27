// The Babylon fallback's clip loader: a play request in, a playable buffer out (decoded, ambisonic W, generator render),
// each kind cached, and the clip durations behind the backend's `clipCache.clipDuration`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultGeneratorParams, generatorWireValues } from "../../../engine/audio/generators/catalogue";
import type { GeneratorKind } from "../../../engine/audio/generators/types";
import { babylonMock, MockEngine } from "../testing/babylonMocks";
import { decodingContext, fakeDecoded, warningsOf } from "../testing/babylonRig";
import type { GeneratorSource } from "./backend";
import { BabylonClipLoader, type ClipLoaderContext } from "./babylonClipLoader";

/** A loader on a mock engine and a decoding fake context (`decoded`: what any ambisonic clip decodes to). */
function loader(decoded = fakeDecoded(4, 48_000)) {
  const engine = new MockEngine({});
  const { context, created, fetched } = decodingContext(decoded);
  const clips = new BabylonClipLoader(engine as unknown as ConstructorParameters<typeof BabylonClipLoader>[0], context as unknown as ClipLoaderContext);
  return { clips, engine, created, fetched };
}

const clip = (path: string) => ({ path, url: `asset://${path}` });
const ambisonic = (path: string) => ({ ...clip(path), ambisonic: true });
const source = (kind: GeneratorKind, params: Record<string, number>, seed: number): GeneratorSource => ({ kind, values: generatorWireValues(kind, { ...defaultGeneratorParams(kind), ...params }), seed });
const generator = (g: GeneratorSource) => ({ path: "beep.generator.json", url: "", generator: g });

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  babylonMock.reset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BabylonClipLoader: decoded clips", () => {
  it("decodes a clip once per URL however many plays ask, and keeps its length by path", async () => {
    const { clips, engine } = loader();
    expect(clips.duration("a.wav")).toBeNull();
    const [a, b] = await Promise.all([clips.load(clip("a.wav")), clips.load(clip("a.wav"))]);
    expect(a).toBe(b);
    expect(engine.bufferLoads).toEqual(["asset://a.wav"]);
    expect(clips.decodedClips).toBe(1);
    expect(clips.duration("a.wav")).toBe(1);
  });

  it("forgets a failed decode, so the next load tries again", async () => {
    const { clips, engine } = loader();
    babylonMock.failUrls.add("asset://bad.wav");
    await expect(clips.load(clip("bad.wav"))).rejects.toThrow(/cannot decode/);
    babylonMock.failUrls.clear();
    await expect(clips.load(clip("bad.wav"))).resolves.not.toBeNull();
    expect(engine.bufferLoads).toEqual(["asset://bad.wav", "asset://bad.wav"]);
    expect(clips.duration("bad.wav")).toBe(1);
  });

  it("warms a clip ahead of its play, and a failed warm is left to the play", async () => {
    const { clips, engine } = loader();
    babylonMock.failUrls.add("asset://bad.wav");
    clips.warm("asset://a.wav");
    clips.warm("asset://bad.wav");
    await clips.load(clip("a.wav"));
    expect(engine.bufferLoads.filter((u) => u === "asset://a.wav")).toHaveLength(1);
    babylonMock.failUrls.clear();
    await expect(clips.load(clip("bad.wav"))).resolves.not.toBeNull();
  });

  it("forgets every clip and length on clear", async () => {
    const { clips, engine } = loader();
    await clips.load(clip("a.wav"));
    clips.clear();
    expect(clips.decodedClips).toBe(0);
    expect(clips.duration("a.wav")).toBeNull();
    await clips.load(clip("a.wav"));
    expect(engine.bufferLoads).toHaveLength(2);
  });
});

describe("BabylonClipLoader: ambisonic clips (ADR 0162 §8)", () => {
  it("fetches and decodes once per URL, and hands over channel 0 as a mono buffer at the clip's rate", async () => {
    const { clips, engine, created, fetched } = loader(fakeDecoded(16, 24_000, 44_100));
    const [a, b] = await Promise.all([clips.load(ambisonic("amb.wav")), clips.load(ambisonic("amb.wav"))]);
    expect(a).toBe(b);
    expect(fetched).toEqual(["asset://amb.wav"]);
    expect(engine.bufferLoads).toEqual([]);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ channels: 1, length: 24_000, rate: 44_100 });
    expect(Array.from(created[0]!.copied!.subarray(0, 3))).toEqual([1, 1, 1]);
    expect(clips.duration("amb.wav")).toBeCloseTo(24_000 / 44_100, 9);
  });

  it("refuses a clip over 64 MB decoded with null and one warning, and keeps the refusal", async () => {
    const { clips, created } = loader(fakeDecoded(16, 1_100_000)); // 70.4 MB
    expect(await clips.load(ambisonic("big.wav"))).toBeNull();
    expect(await clips.load(ambisonic("big.wav"))).toBeNull();
    expect(created).toHaveLength(0);
    expect(warningsOf(warn, "64 MB")).toHaveLength(1);
    expect(warningsOf(warn, "64 MB")[0]).toContain("big.wav");
    expect(clips.duration("big.wav")).toBeNull();
  });

  it("takes a clip right at the limit", async () => {
    const { clips } = loader(fakeDecoded(4, 4_000_000)); // 64,000,000 bytes
    expect(await clips.load(ambisonic("edge.wav"))).not.toBeNull();
  });

  it("forgets a failed fetch, so the next load tries again", async () => {
    const { clips, fetched } = loader();
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    });
    await expect(clips.load(ambisonic("gone.wav"))).rejects.toThrow("HTTP 404");
    await expect(clips.load(ambisonic("gone.wav"))).rejects.toThrow("HTTP 404");
    expect(fetched).toEqual(["asset://gone.wav", "asset://gone.wav"]);
  });
});

describe("BabylonClipLoader: generator renders (ADR 0360 §8)", () => {
  it("renders at the context's rate, once per patch and seed, keeping the 64 most recently used", async () => {
    const { clips, created } = loader();
    const tick = (seed: number) => generator(source("blip", { decay: 0.01 }, seed));
    const first = await clips.load(tick(0));
    expect(created[0]).toMatchObject({ channels: 1, rate: 48_000 });
    expect(await clips.load(tick(0))).toBe(first);
    expect(created).toHaveLength(1);
    for (let seed = 1; seed < 64; seed++) await clips.load(tick(seed));
    expect(created).toHaveLength(64);
    // Using seed 0 again makes seed 1 the least recently used: a 65th render pushes it out, not seed 0.
    await clips.load(tick(0));
    await clips.load(tick(64));
    expect(created).toHaveLength(65);
    expect(await clips.load(tick(0))).toBe(first);
    expect(created).toHaveLength(65);
    await clips.load(tick(1));
    expect(created).toHaveLength(66);
  }, 30_000);
});
