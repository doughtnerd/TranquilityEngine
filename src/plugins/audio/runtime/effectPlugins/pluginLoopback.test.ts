// ADR 0352 (B3, B4) amended by 0358, on the loopback host with the real core wasm and the real plugin modules: a project's
// plugin with an `audio` section goes through `loadEffectPlugin` (the catalogue, the validator and instrumenter, the core
// backend's `effectPlugins` capability, the worklet glue) and its effect runs inside a bus chain of the page's mix.
//
// - the tremolo sample (`samples/fx-tremolo`) modulates a bus at its declared rate, and an automated parameter (the mix's
//   `fx:` automation, a global parameter) reaches it;
// - the SDK's test plugin (`native/fx-sdk/test-fx`, kind 3 `trap`) faults on demand: a trapping block passes dry, the
//   module comes back, three faults within a second turn the effect off until it is reset, and memory growth, a NaN, an
//   out-of-range sample and a runaway loop are each a fault; all read through `Audio.debug().plugins`;
// - the effect is "loading", passing dry, until the worklet compiled it and ran its warm-up.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePluginAudio } from "../../../../engine/audio/effects/pluginEffects";
import { registerPluginEffects, unregisterPluginEffects } from "../../../../engine/audio/effects/catalogue";
import { AUDIO_PROJECT_FORMAT } from "../../../../engine/audio/project/types";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import type { AudioPluginDebug } from "../debugTypes";
import { presetFromSettings } from "../core/context";
import { Audio } from "../index";
import { closeLoopbackAudio, loopbackAudio } from "../testing";
import { loadEffectPlugin, unloadEffectPlugin, type EffectPluginPackage } from "./load";

const LEVEL = 0.25;
const RATE = 48_000;
const TREMOLO_DIR = new URL("../../../../../samples/fx-tremolo/plugins/tremolo/", import.meta.url);
const TEST_FX = new URL("../../../../../native/fx-sdk/wasm/test_fx.wasm", import.meta.url);

/** A turn of the event loop: Node resolves WebAssembly compiles (the validator's, the glue's) and the rig's clip decode there. */
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(async () => {
  unloadEffectPlugin("example.tremolo", null);
  unloadEffectPlugin("test.fx", null);
  unregisterPluginEffects("example.tremolo");
  unregisterPluginEffects("test.fx");
  await closeLoopbackAudio();
  vi.restoreAllMocks();
});

/** The tremolo sample's plugin, as the plugin set would hand it over. */
function tremoloPackage(): EffectPluginPackage {
  const manifest = JSON.parse(readFileSync(new URL("plugin.json", TREMOLO_DIR), "utf8")) as { name: string; version: string; title: string; audio: unknown };
  const problems: string[] = [];
  const audio = parsePluginAudio(manifest.audio, { name: manifest.name, version: manifest.version, title: manifest.title }, problems);
  expect(problems).toEqual([]);
  return { plugin: manifest.name, title: manifest.title, version: manifest.version, enabled: true, audio, read: async (path) => new Uint8Array(readFileSync(new URL(path, TREMOLO_DIR))) };
}

/** The SDK's test plugin with its `trap` kind (3) declared: one stepped parameter, `mode`. */
function trapPackage(): EffectPluginPackage {
  const problems: string[] = [];
  const audio = parsePluginAudio(
    {
      abi: 1,
      modules: { dsp: { wasm: "test_fx.wasm", memoryMB: 4 } },
      effects: [
        {
          type: "test.fx.trap", module: "dsp", kind: 3, label: "Trap", levels: ["bus", "instance"], maxInstances: 4, budget: { instructionsPerFrame: 200 },
          params: [{ name: "mode", label: "Mode", choices: ["halve", "trap", "nan", "grow", "spin", "range"], default: 0 }],
        },
      ],
    },
    { name: "test.fx", version: "1.0.0" },
    problems,
  );
  expect(problems).toEqual([]);
  return { plugin: "test.fx", version: "1.0.0", enabled: true, audio, read: async () => new Uint8Array(readFileSync(TEST_FX)) };
}

/**
 * The real host and core backend on the page's mixer, configured from a mix whose bus "Fx" runs `effect` with `params`,
 * its parameter `param` automated by the global parameter `amount` through `curve`; one main frame a quantum.
 */
async function rig(effect: string, params: Record<string, number>, param: string, curve: [number, number][], amount: number) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const mix = {
    format: AUDIO_PROJECT_FORMAT,
    parameters: [{ name: "amount", min: 0, max: 100, default: amount, seekSpeed: 1_000_000 }],
    buses: [{ name: "Master" }, { name: "Fx", parent: "Master", effects: [{ id: "p1", type: effect, on: true, params }] }],
    automation: [{ on: "Fx", target: `fx:p1:${param}`, parameter: "amount", curve }],
  };
  const settings: AudioSettings = { ...defaultAudioSettings(), mix };
  const audio = await loopbackAudio({
    settings,
    preset: { ...presetFromSettings(settings), limiterLookaheadMs: 0 },
    decode: () => ({ channelData: [new Float32Array(4 * RATE).fill(LEVEL)] }),
    recovery: { now: () => 0, warn: () => {} },
    quantaPerFrame: 1,
  });
  if (!audio) return null;
  const row = (type: string): AudioPluginDebug | undefined => Audio.debug().plugins?.find((p) => p.type === type);
  /** Main frames (one quantum each) until `type` is live; how many it took. */
  const live = async (type: string): Promise<number> => {
    for (let q = 0; q < 400; q++) {
      if (row(type)?.state === "live") return q;
      await audio.step();
      await turn();
    }
    throw new Error(`${type} never went live: ${JSON.stringify(row(type))}`);
  };
  /** `n` main frames: the left output over the clip's level. */
  const step = async (n: number): Promise<Float32Array> => {
    const out = new Float32Array(n * 128);
    for (let f = 0; f < n; f++) {
      out.set((await audio.step()).left, f * 128);
      if (f % 16 === 0) await turn();
    }
    return out.map((v) => v / LEVEL);
  };
  /**
   * Sets the global parameter to `mode` (the trap kind's mode through the mix's automation) and renders one quantum at a
   * time until a block passes dry (the fault: the plugin halves every healthy block), then sets it back to 0. Returns the
   * blocks rendered: every one but the last halved, the last dry.
   */
  const fault = async (mode: number): Promise<Float32Array[]> => {
    Audio.setParameter("amount", mode);
    const blocks: Float32Array[] = [];
    for (let q = 0; q < 32; q++) {
      const b = await step(1);
      blocks.push(b);
      if (b.some((v) => v !== 0.5)) break;
    }
    Audio.setParameter("amount", 0);
    return blocks;
  };
  /** Starts the looping DC voice on "Fx" and renders until it sounds (its clip decodes on the event loop), then a little more. */
  const play = async (): Promise<void> => {
    audio.backend.play({ path: "dc.wav", url: "dc.wav", loop: true, stream: false, bus: "Fx" });
    for (let q = 0; q < 400 && (await step(1)).at(-1) === 0; q++) await turn();
    await step(8);
  };
  return { audio, row, live, step, play, fault };
}

/** Local minima of `x` under `floor` (the tremolo's troughs). */
const troughs = (x: Float32Array, floor: number): number => {
  let n = 0;
  for (let i = 1; i < x.length - 1; i++) if (x[i]! < floor && x[i]! < x[i - 1]! && x[i]! <= x[i + 1]!) n++;
  return n;
};

describe("plugin effects on the core (ADR 0352, 0358)", () => {
  it("the tremolo sample modulates a bus at its declared rate, and an automated parameter reaches it", async (ctx) => {
    // The plugin set enables the sample's plugin before the core exists: the specs join the catalogue at once (so the mix
    // runs the effect) and the module registers with the core backend when it is installed.
    const loading = loadEffectPlugin(tremoloPackage());
    const r = await rig("example.tremolo", { rate: 4, depth: 100, shape: 0 }, "depth", [[0, 0], [100, 100]], 100);
    if (!r) return ctx.skip();
    expect((await loading).problems).toEqual([]);
    await r.live("example.tremolo");
    await r.play();
    // One second: a sine LFO at 4 Hz, depth 100%, swings the bus from silence to unity four times.
    const second = await r.step(RATE / 128);
    expect(Math.max(...second)).toBeGreaterThan(0.99);
    expect(Math.min(...second)).toBeLessThan(0.01);
    expect(troughs(second, 0.05)).toBe(4);
    const row = r.row("example.tremolo")!;
    expect(row).toMatchObject({ plugin: "example.tremolo", state: "live", warmUps: 1, inUse: 1 });
    expect(row.instructionsPerQuantum).toBeGreaterThan(0);
    expect(row.instructionsPerQuantum).toBeLessThanOrEqual(300 * 128);
    // The global parameter drives `depth` to 0 (the mix's `fx:p1:depth` automation, run by the core): unity, bit for bit.
    Audio.setParameter("amount", 0);
    await r.step(16);
    const flat = await r.step(64);
    expect(Math.min(...flat)).toBe(1);
    expect(Math.max(...flat)).toBe(1);
  });

  it("a trapping plugin passes dry, recovers, and is off after three faults within a second until it is reset", async (ctx) => {
    void loadEffectPlugin(trapPackage());
    const r = await rig("test.fx.trap", { mode: 0 }, "mode", [[0, 0], [5, 5]], 0);
    if (!r) return ctx.skip();
    await r.live("test.fx.trap");
    await r.play();
    expect((await r.step(4)).every((v) => v === 0.5), "a healthy block is halved").toBe(true);
    // The plugin traps on the block its mode arrives in: that block is dry, and the glue re-instantiates the module
    // (from the Module it kept) before the next quantum, so the next block is the plugin's again.
    const faulted = (await r.fault(1)).at(-1)!;
    expect(faulted.every((v) => v === 1), "the faulting block passed dry").toBe(true);
    expect((await r.step(4)).every((v) => v === 0.5), "recovered").toBe(true);
    expect(r.row("test.fx.trap")).toMatchObject({ state: "live", faults: { trap: 1 } });
    // Two more within the second: the third fault turns the effect off; it passes dry even once the plugin is healthy.
    await r.fault(1);
    expect((await r.step(4)).every((v) => v === 0.5), "a second fault: still on").toBe(true);
    await r.fault(1);
    await r.step(4);
    expect((await r.step(8)).every((v) => v === 1), "off: dry").toBe(true);
    const off = r.row("test.fx.trap")!;
    expect(off.state).toBe("disabled");
    expect(off.faults.trap).toBe(3);
    // The Studio's Reset plugin: back on.
    r.audio.backend.effectPlugins.reset("test.fx.trap");
    await r.step(4);
    expect((await r.step(4)).every((v) => v === 0.5), "reset: wet again").toBe(true);
    expect(r.row("test.fx.trap")!.state).toBe("live");
  });

  it("memory growth in process is a module fault; a NaN, a sample past ±64 and a runaway loop are faults too", async (ctx) => {
    void loadEffectPlugin(trapPackage());
    const r = await rig("test.fx.trap", { mode: 0 }, "mode", [[0, 0], [5, 5]], 0);
    if (!r) return ctx.skip();
    await r.live("test.fx.trap");
    await r.play();
    // Each fault once, a second of audio apart (so none of them turns the effect off), each followed by recovery.
    for (const [mode, reason] of [[3, "grow"], [2, "nonFinite"], [5, "range"], [4, "budget"]] as const) {
      const block = (await r.fault(mode)).at(-1)!;
      expect(block.every((v) => v === 1), `${reason}: the block passed dry`).toBe(true);
      expect((await r.step(2)).every((v) => v === 0.5), `${reason}: recovered`).toBe(true);
      await r.step(RATE / 128);
      expect(r.row("test.fx.trap")!.faults[reason], reason).toBe(1);
    }
    expect(r.row("test.fx.trap")).toMatchObject({ state: "live", faults: { trap: 0, grow: 1, nonFinite: 1, range: 1, budget: 1 } });
  });

  it("an effect is loading, and its slot passes dry, until the worklet compiled it and ran its warm-up", async (ctx) => {
    // The plugin set read the manifest (its specs are in the catalogue, so the mix names the effect) before the module is
    // registered with the core: the core doesn't run the effect yet, and the bus is dry.
    const pkg = trapPackage();
    registerPluginEffects({ plugin: pkg.plugin, version: pkg.version, enabled: true, effects: pkg.audio.effects });
    const r = await rig("test.fx.trap", { mode: 0 }, "mode", [[0, 0], [5, 5]], 0);
    if (!r) return ctx.skip();
    await r.play();
    expect((await r.step(2)).every((v) => v === 1)).toBe(true);
    void loadEffectPlugin(pkg, r.audio.backend);
    // The validator's async instantiate, then the registration (the tree goes out again with the plugin's kind).
    for (let i = 0; i < 50 && r.row("test.fx.trap") === undefined; i++) await turn();
    expect(r.row("test.fx.trap")).toMatchObject({ state: "loading", warmUps: 0 });
    // The core's slot asks for an instance each block and gets none until the module is live: dry meanwhile.
    const waited = await r.live("test.fx.trap");
    expect(waited).toBeGreaterThan(0);
    expect(r.row("test.fx.trap")).toMatchObject({ state: "live", warmUps: 1, instances: 4 });
    await r.step(8);
    expect((await r.step(4)).every((v) => v === 0.5), "live: wet").toBe(true);
  });
});
