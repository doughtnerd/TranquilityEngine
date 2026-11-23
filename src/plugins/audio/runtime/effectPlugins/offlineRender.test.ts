// ADR 0352 §7 (B5): plugin effects at the sample level render offline through the worklet's glue, in Node as in the
// browser. The tremolo sample's plugin, loaded as the plugin set loads it (`loadEffectPlugin`), is the offline host's;
// a sample whose baked chain holds the tremolo renders modulated at its rate (`renderSample`, the real offline wasm and
// the real plugin module). The render cache key names the plugin's module hash, so a rebuilt module renders again; a
// plugin that isn't loaded where the render runs passes the audio through with a warning, and such a render isn't
// cached. A sample render in a build runs on the build's own modules (`offlineHostOf`).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unregisterPluginEffects } from "../../../../engine/audio/effects/catalogue";
import { parsePluginAudio } from "../../../../engine/audio/effects/pluginEffects";
import { parseSampleEdits } from "../../../../engine/audio/sample/format";
import { cachedRender, renderKey } from "../../../../engine/audio/sample/renderCache";
import { PLUGIN_NOT_RENDERED, renderSample } from "../../../../engine/audio/sample/sampleRender";
import { loadEffectPlugin, unloadEffectPlugin, type EffectPluginPackage } from "./load";
import { offlineHostOf } from "./offline";

const DIR = new URL("../../../../../samples/fx-tremolo/plugins/tremolo/", import.meta.url);
const WASM = new Uint8Array(readFileSync(new URL("dsp/tremolo.wasm", DIR)));
const RATE = 48_000;

function tremolo(bytes: Uint8Array = WASM): EffectPluginPackage {
  const manifest = JSON.parse(readFileSync(new URL("plugin.json", DIR), "utf8")) as { name: string; version: string; title: string; audio: unknown };
  const audio = parsePluginAudio(manifest.audio, { name: manifest.name, version: manifest.version, title: manifest.title }, []);
  return { plugin: manifest.name, title: manifest.title, version: manifest.version, enabled: true, audio, read: async () => bytes };
}

/** One second of stereo DC at 0.5, and a chain of the tremolo at 4 Hz, depth 100 %, sine. */
const input = { pcm: new Float32Array(2 * RATE).fill(0.5), channels: 2, rate: RATE };
const edits = () => parseSampleEdits({ effects: [{ id: "t", type: "example.tremolo", on: true, params: { rate: 4, depth: 100, shape: 0 } }] }, "s", []);

/** Local minima of the left channel under `floor`, over the first `frames` frames. */
function troughs(pcm: Float32Array, frames: number, floor: number): number {
  let n = 0;
  for (let f = 1; f < frames - 1; f++) {
    const [a, b, c] = [pcm[2 * (f - 1)]!, pcm[2 * f]!, pcm[2 * (f + 1)]!];
    if (b < floor && b < a && b <= c) n++;
  }
  return n;
}

/** The tremolo module with a custom section appended: other bytes, the same code (a rebuilt plugin). */
const rebuilt = () => new Uint8Array([...WASM, 0, 4, 3, 0x61, 0x62, 0x63]);

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(() => {
  unloadEffectPlugin("example.tremolo", null);
  unregisterPluginEffects("example.tremolo");
  vi.restoreAllMocks();
});

describe("plugin effects in offline sample renders", () => {
  it("the tremolo at the sample level renders modulated at its rate, through the plugin glue", async () => {
    await loadEffectPlugin(tremolo(), null);
    const out = await renderSample(input, edits());
    expect(out.warnings).toEqual([]);
    expect(out.frames).toBe(RATE);
    const left = out.pcm.filter((_, i) => i % 2 === 0);
    expect(Math.max(...left)).toBeGreaterThan(0.49);
    expect(Math.min(...left)).toBeLessThan(0.01);
    expect(troughs(out.pcm, RATE, 0.02)).toBe(4);
    // Both channels of the pair move together.
    for (let f = 0; f < RATE; f += 997) expect(out.pcm[2 * f + 1]).toBeCloseTo(out.pcm[2 * f]!, 6);
  });

  it("the cache key names the plugin's module hash: a rebuilt module, or no plugin, keys another render", async () => {
    const source = new Uint8Array([1, 2, 3, 4]);
    await loadEffectPlugin(tremolo(), null);
    const loaded = await renderKey(source, edits());
    expect(await renderKey(source, edits())).toBe(loaded);
    await loadEffectPlugin(tremolo(rebuilt()), null);
    const updated = await renderKey(source, edits());
    expect(updated).not.toBe(loaded);
    unloadEffectPlugin("example.tremolo", null);
    expect(await renderKey(source, edits())).not.toBe(loaded);
    // A chain without plugin effects keys as before (built-in renders keep their cache).
    const builtIn = parseSampleEdits({ effects: [{ id: "g", type: "gain", on: true, params: { gain: 6 } }] }, "s", []);
    expect(await renderKey(source, builtIn, null)).toBe(await renderKey(source, builtIn));
  });

  it("a plugin effect with no module where the render runs passes through with a warning, and isn't cached", async () => {
    const out = await renderSample(input, edits(), { plugins: null });
    expect(Array.from(out.pcm.subarray(0, 64))).toEqual(new Array(64).fill(0.5));
    expect(out.warnings).toEqual([`The plugin effect example.tremolo passed through: ${PLUGIN_NOT_RENDERED}.`]);
    const writes: string[] = [];
    const store = { read: async () => null, write: async (path: string) => void writes.push(path) };
    await loadEffectPlugin(tremolo(), null); // the page knows the plugin (the key names it) but the renderer doesn't
    const cached = await cachedRender(store, new Uint8Array([9]), edits(), async () => input, (p, e) => renderSample(p, e, { plugins: null }));
    expect(cached.hit).toBe(false);
    expect(writes).toEqual([]);
    // Rendered with the plugin, it is kept.
    await cachedRender(store, new Uint8Array([9]), edits(), async () => input, renderSample);
    expect(writes).toHaveLength(1);
  });

  it("a build's sample renders run on the build's modules, keyed by their hash", async () => {
    const { audio } = tremolo();
    const decl = { plugin: "example.tremolo", version: "1.0.0", module: "dsp", memoryMB: 1, effects: audio.effects };
    const { host, problems } = await offlineHostOf([{ ...decl, bytes: WASM }]);
    expect(problems).toEqual([]);
    const out = await renderSample(input, edits(), { plugins: host });
    expect(out.warnings).toEqual([]);
    expect(troughs(out.pcm, RATE, 0.02)).toBe(4);
    const other = (await offlineHostOf([{ ...decl, bytes: rebuilt() }])).host;
    expect(await renderKey(new Uint8Array([1]), edits(), host)).not.toBe(await renderKey(new Uint8Array([1]), edits(), other));
    const refused = await offlineHostOf([{ ...decl, bytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]) }]);
    expect(refused.problems.join("\n")).toContain("The plugin example.tremolo's module dsp was refused");
  });
});
