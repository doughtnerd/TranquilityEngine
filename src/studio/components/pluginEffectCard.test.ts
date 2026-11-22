// ADR 0338 §9 (B6): a plugin effect's card and the Add effect menu, through the chain model. The menu groups plugin
// effects under their plugin's title after the built-ins; a card carries its plugin's chip, is greyed with the
// catalogue's reason while its plugin is off or missing, and reads its health row (`Audio.debug().plugins`): the status
// line for each unhealthy state, the row's text (instructions per frame against the declared budget, memory, faults)
// and whether Reset plugin applies.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerPluginEffects, unregisterPluginEffects } from "../../engine/audio/effects/catalogue";
import { parsePluginAudio } from "../../engine/audio/effects/pluginEffects";
import type { Effect, EffectType } from "../../engine/audio/effects/types";
import type { AudioPluginDebug } from "../../plugins/audio/runtime/debugTypes";
import { effectMenuGroups, faultsText, memoryText, pluginCardView, pluginHealthView } from "./effectChainModel";

const decl = (type: string, label: string, budget = 300, kind = 0) => ({
  type, module: "dsp", kind, label, levels: ["bus", "instance"], budget: { instructionsPerFrame: budget },
  params: [{ name: "rate", label: "Rate", min: 0.1, max: 20, default: 5, unit: "Hz" }, { name: "shape", label: "Shape", choices: ["Sine", "Square"], default: 0 }],
});

function register(plugin: string, title: string, enabled: boolean, effects: ReturnType<typeof decl>[]) {
  const problems: string[] = [];
  const audio = parsePluginAudio({ modules: { dsp: { wasm: "dsp.wasm" } }, effects }, { name: plugin, title, version: "1.2.0" }, problems);
  expect(problems).toEqual([]);
  registerPluginEffects({ plugin, title, version: "1.2.0", enabled, effects: audio.effects });
}

const row = (over: Partial<AudioPluginDebug> = {}): AudioPluginDebug => ({
  plugin: "example.tremolo", type: "example.tremolo", module: "dsp", e: 0, state: "live", warmUps: 1, instances: 32, inUse: 2,
  instructionsPerQuantum: 2 * 41 * 128, faults: { trap: 0, budget: 0, grow: 0, nonFinite: 0, range: 0 }, starved: 0, noInstance: 0, memoryBytes: 64 * 1024, ...over,
});

const fx = (type: string): Effect => ({ id: "fx1", type: type as EffectType, on: true, params: {} });

beforeEach(() => {
  register("example.tremolo", "Tremolo", true, [decl("example.tremolo", "Tremolo")]);
  register("acme.fx", "Acme FX", true, [decl("acme.fx.crush", "Crush", 200), decl("acme.fx.age", "Age", 300, 1)]);
  register("example.wobble", "Wobble", false, [decl("example.wobble", "Wobble")]);
});
afterEach(() => {
  for (const p of ["example.tremolo", "acme.fx", "example.wobble"]) unregisterPluginEffects(p);
});

describe("the Add effect menu with plugins", () => {
  it("lists the built-ins, then each on plugin's effects under its title, plugins by title and effects alphabetical", () => {
    const groups = effectMenuGroups("bus");
    expect(groups.builtins.some((i) => i.type === "reverb")).toBe(true);
    expect(groups.builtins.some((i) => i.type.includes("."))).toBe(false);
    expect(groups.plugins.map((g) => [g.title, g.items.map((i) => i.label)])).toEqual([["Acme FX", ["Age", "Crush"]], ["Tremolo", ["Tremolo"]]]);
    expect(effectMenuGroups("sample").plugins).toEqual([]); // none of them runs on a sample
  });
});

describe("a plugin effect's card", () => {
  it("is null for a built-in, and carries its plugin's chip", () => {
    expect(pluginCardView(fx("reverb"))).toBeNull();
    expect(pluginCardView(fx("example.tremolo"))).toEqual({ chip: "Tremolo 1.2.0", greyed: false, status: null, health: null, canReset: false });
  });

  it("is greyed with the catalogue's reason while its plugin is off or missing", () => {
    expect(pluginCardView(fx("example.wobble"))).toMatchObject({ chip: "Wobble 1.2.0", greyed: true, status: "Passes audio through: its plugin, Wobble, is off in Project Settings > Plugins", canReset: false });
    expect(pluginCardView(fx("acme.gone"))).toMatchObject({ chip: "acme.gone", greyed: true, status: "Passes audio through: no installed plugin declares that effect type" });
  });

  it("reads its health row: healthy, faulted, off after faults, no free instance, starved, loading, failed", () => {
    const view = (r: Partial<AudioPluginDebug>) => pluginCardView(fx("example.tremolo"), row(r))!;
    expect(view({})).toMatchObject({ status: null, canReset: false });
    expect(view({}).health?.text).toBe("Live · 41 of 300 instructions per frame · 64 KB · no faults");
    expect(view({ faults: { trap: 1, budget: 2, grow: 0, nonFinite: 0, range: 0 } })).toMatchObject({ status: "Faulted: over budget ×2, trapped ×1; those blocks passed through dry", canReset: true });
    expect(view({ state: "disabled", faults: { trap: 3, budget: 0, grow: 0, nonFinite: 0, range: 0 } })).toMatchObject({
      status: "Off after three faults within a second (trapped ×3): passes audio through until reset",
      canReset: true,
    });
    expect(view({ noInstance: 1 }).status).toBe("No free instance once: those uses pass audio through");
    expect(view({ starved: 5 }).status).toBe("Over the shared instruction budget 5 times: those blocks passed through dry");
    expect(view({ state: "loading" })).toMatchObject({ status: "Loading: passes audio through until its module is ready", canReset: false });
    expect(view({ state: "failed", error: "compiling failed" })).toMatchObject({ status: "Didn't load (compiling failed): passes audio through", canReset: false });
  });
});

describe("a health row", () => {
  it("is instructions per frame per instance in use against the declared budget, memory and faults", () => {
    const v = pluginHealthView(row({ type: "acme.fx.crush", instructionsPerQuantum: 3 * 250 * 128, inUse: 3, memoryBytes: 3 * 1024 * 1024 }));
    expect(v).toMatchObject({ perFrame: 250, budget: 200, load: 1.25, memory: "3.0 MB", state: "Live" });
    expect(pluginHealthView(row({ inUse: 0, instructionsPerQuantum: 0 }), null).text).toBe("Live · 0 instructions per frame · 64 KB · no faults");
    expect(memoryText(1536)).toBe("2 KB");
    expect(faultsText({ trap: 0, budget: 0, grow: 1, nonFinite: 4, range: 0 })).toBe("non-finite output ×4, grew its memory ×1");
  });
});
