// ADR 0352 §3–4: a plugin's `audio` section (parsePluginAudio) and plugin effects in the one catalogue
// (registerPluginEffects, effectSpec, parseEffect, effectToJson, pluginEffectNote), through their module interfaces.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  allowedAt, clampEffectParam, defaultEffect, effectSpec, effectToJson, effectTypesAt, parseEffect, parseEffects, pluginEffectNote,
  registerPluginEffects, registeredPluginEffects, unregisterPluginEffects,
} from "./catalogue";
import { PLUGIN_AUDIO_LIMITS, parsePluginAudio } from "./pluginEffects";
import { parseAudioProject } from "../project/format";
import { coreSectionOf } from "../project/runtimeView";
import type { PluginAudio } from "./types";

const TREMOLO_JSON = JSON.parse(readFileSync(new URL("../../../../samples/fx-tremolo/plugins/tremolo/plugin.json", import.meta.url), "utf8")) as {
  name: string; version: string; title: string; audio: unknown;
};
const ID = { name: TREMOLO_JSON.name, version: TREMOLO_JSON.version, title: TREMOLO_JSON.title };

function parse(audio: unknown, id = ID): { audio: PluginAudio; problems: string[] } {
  const problems: string[] = [];
  return { audio: parsePluginAudio(audio, id, problems), problems };
}

/** A valid section with one effect, `effect` merged over it. */
const section = (effect: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  modules: { dsp: { wasm: "dsp/fx.wasm" } },
  effects: [{ type: "example.tremolo.fx", module: "dsp", kind: 0, label: "Fx", levels: ["bus"], ...effect }],
  ...extra,
});

describe("parsePluginAudio", () => {
  it("reads the tremolo sample's section: modules, effect, levels, cost, budget, instances and params", () => {
    const { audio, problems } = parse(TREMOLO_JSON.audio);
    expect(problems).toEqual([]);
    expect(audio.modules).toEqual([{ id: "dsp", wasm: "dsp/tremolo.wasm", memoryMB: 1 }]);
    const [fx] = audio.effects;
    expect(fx).toMatchObject({ module: "dsp", kind: 0, instructionsPerFrame: 300, maxInstances: 32 });
    expect(fx!.spec).toMatchObject({
      type: "example.tremolo", label: "Tremolo", version: "1.0.0", levels: ["sample", "instance", "bus"], cost: "light",
      plugin: { name: "example.tremolo", title: "Tremolo", version: "1.0.0", state: "on" },
    });
    expect(fx!.spec.params.map((q) => q.name)).toEqual(["rate", "depth", "shape"]);
    expect(fx!.spec.params[2]).toEqual({ name: "shape", label: "Shape", min: 0, max: 2, step: 1, unit: "", default: 0, scale: "linear", choices: ["Sine", "Triangle", "Square"], smooth: false });
  });

  it("fills defaults for what is left out: abi, memory, cost, budget, instances, version, step", () => {
    const { audio, problems } = parse(section({ params: [{ name: "x", label: "X", min: 0, max: 10 }, { name: "on", label: "On", bool: true }] }));
    expect(problems).toEqual([]);
    expect(audio.abi).toBe(1);
    expect(audio.modules[0]!.memoryMB).toBe(PLUGIN_AUDIO_LIMITS.memoryMB.default);
    expect(audio.effects[0]).toMatchObject({ instructionsPerFrame: 1000, maxInstances: 16, spec: { cost: "medium", version: "1.0.0" } });
    expect(audio.effects[0]!.spec.params[0]).toMatchObject({ step: 0.1, default: 0, unit: "", scale: "linear" });
    expect(audio.effects[0]!.spec.params[1]).toMatchObject({ bool: true, smooth: false, min: 0, max: 1 });
  });

  it("caps the budget at 5,000 instructions per frame (0358 §3) and the memory at 64 MB", () => {
    expect(parse(section({ budget: { instructionsPerFrame: 5000 } })).problems).toEqual([]);
    expect(parse(section({ budget: { instructionsPerFrame: 5001 } })).problems).toEqual(["audio.effects[0].budget.instructionsPerFrame: must be a whole number from 1 to 5000"]);
    expect(parse(section({}, { modules: { dsp: { wasm: "dsp/fx.wasm", memoryMB: 65 } } })).problems).toEqual(["audio.modules.dsp.memoryMB: must be a whole number from 1 to 64"]);
  });

  it("reports every problem, with where it is", () => {
    const { audio, problems } = parse({
      abi: 2,
      modules: { dsp: { wasm: "../escape.wasm" } },
      effects: [
        { type: "other.fx", module: "nope", kind: 300, label: "", levels: ["bus", "everywhere"], cost: "huge", maxInstances: 0, params: "x" },
        {
          type: "example.tremolo.b", module: "dsp", label: "B", levels: ["bus"],
          params: [
            { name: "1bad", label: "L", min: 0, max: 1 },
            { name: "f", label: "F", min: 0, max: 100, scale: "log" },
            { name: "d", label: "D", min: 0, max: 1, default: 2 },
            { name: "c", label: "C", choices: ["A", "B"], default: 2, min: 0 },
            { name: "s", label: "S", choices: ["A"], smooth: true },
          ],
        },
      ],
    });
    expect(problems).toEqual([
      "audio.abi: this engine runs DSP ABI 1 (got 2)",
      "audio.modules.dsp.wasm: must be the path of a .wasm file inside the plugin",
      '.effects[0].type: "other.fx" must start with the plugin\'s name, example.tremolo'.replace(/^/, "audio"),
      "audio.effects[0].module: must name one of the modules (none)",
      "audio.effects[0].kind: must be a whole number from 0 to 255",
      "audio.effects[0].label: must be a non-empty string",
      'audio.effects[0].levels: "everywhere" isn\'t a level (sample, voice, instance, bus)',
      "audio.effects[0].cost: must be light, medium, heavy",
      "audio.effects[0].maxInstances: must be a whole number from 1 to 128",
      "audio.effects[0].params: must be a list",
      // effects[1] names "dsp", whose own problem is reported above: no second line for it.
      "audio.effects[1].params[0].name: must be letters, digits and _, starting with a letter",
      "audio.effects[1].params[1].scale: a log parameter needs a min above 0",
      "audio.effects[1].params[2].default: must be a number from min to max",
      "audio.effects[1].params[3].min: a choices parameter takes no min (its value is the choice's index)",
      "audio.effects[1].params[3].default: must be a choice's index, 0 to 1",
      "audio.effects[1].params[4].smooth: a choice steps; it can't glide",
    ]);
    expect(audio.effects).toEqual([]);
  });

  it("refuses duplicates, a non-namespaced type, more than 16 params, and a missing section shape", () => {
    const sixteen = Array.from({ length: 17 }, (_, i) => ({ name: `p${i}`, label: `P${i}`, min: 0, max: 1 }));
    expect(parse(section({ params: sixteen })).problems).toEqual(["audio.effects[0].params: at most 16 parameters"]);
    const twice = { modules: { dsp: { wasm: "a.wasm" } }, effects: [section().effects[0], section().effects[0]] };
    expect(parse(twice).problems).toEqual(['audio.effects[1].type: "example.tremolo.fx" is declared twice', "audio.effects[1].kind: module dsp's kind 0 is already another effect"]);
    expect(parse(section({ type: "nodot" }), { name: "nodot", version: "1.0.0", title: "N" }).problems).toEqual([expect.stringMatching(/must be namespaced by the plugin, such as "nodot.effect"/)]);
    expect(parse([]).problems).toEqual(["audio: must be an object"]);
    expect(parse({}).problems).toEqual([expect.stringMatching(/^audio.modules: must name at least one module/), "audio.effects: must list at least one effect"]);
  });
});

describe("plugin effects in the catalogue", () => {
  afterEach(() => unregisterPluginEffects("example.tremolo"));
  const register = (enabled = true) => registerPluginEffects({ plugin: ID.name, title: ID.title, version: ID.version, enabled, effects: parse(TREMOLO_JSON.audio).audio.effects });
  const RAW = { id: "fx4", type: "example.tremolo", on: true, params: { rate: 6, wobble: 3 } };

  it("answers a registered effect's spec like a built-in's: menu, levels, defaults, clamping, parse and write", () => {
    expect(register()).toEqual([]);
    expect(effectSpec("example.tremolo")).toMatchObject({ label: "Tremolo", plugin: { state: "on" } });
    expect(effectTypesAt("bus")).toContain("example.tremolo");
    expect(effectTypesAt("voice")).not.toContain("example.tremolo");
    expect(allowedAt("example.tremolo", "voice")).toBe(false);
    expect(defaultEffect("example.tremolo", "fx1").params).toEqual({ rate: 5, depth: 50, shape: 0 });
    expect(clampEffectParam(effectSpec("example.tremolo").params[2]!, 1.6)).toBe(2);
    const problems: string[] = [];
    const e = parseEffect({ ...RAW, params: { rate: 99, shape: 1.2, wobble: 3 } }, "bus", "fx", problems);
    expect(e).toEqual({ id: "fx4", type: "example.tremolo", on: true, params: { rate: 20, depth: 50, shape: 1 } });
    expect(problems).toEqual([expect.stringMatching(/rate/), expect.stringMatching(/Tremolo has no parameter "wobble"/)]);
    expect(effectToJson(e!)).toEqual({ id: "fx4", type: "example.tremolo", on: true, params: { rate: 20, shape: 1 } });
    expect(pluginEffectNote("example.tremolo")).toBeNull();
    expect(registeredPluginEffects().map((d) => d.spec.type)).toEqual(["example.tremolo"]);
  });

  it("keeps a missing plugin's effect in files untouched, with no problem, and says it passes through", () => {
    const problems: string[] = [];
    const [e] = parseEffects([RAW], "bus", "buses[1].effects", problems);
    expect(problems).toEqual([]);
    expect(e).toEqual(RAW);
    expect(effectToJson(e!)).toEqual(RAW);
    expect(effectSpec("example.tremolo")).toMatchObject({ label: "example.tremolo", params: [], plugin: { name: null, state: "missing" } });
    expect(effectTypesAt("bus")).not.toContain("example.tremolo");
    expect(pluginEffectNote("example.tremolo")).toBe("(example.tremolo) passes audio through: no installed plugin declares that effect type");
    // An unknown type without a dot is still dropped (ADR 0345).
    expect(parseEffect({ type: "wobble" }, "bus", "fx", problems)).toBeNull();
  });

  it("keeps a disabled plugin's effect as written too, and names the plugin that is off", () => {
    register(false);
    const problems: string[] = [];
    const e = parseEffect(RAW, "bus", "fx", problems);
    expect(problems).toEqual([]);
    expect(effectToJson(e!)).toEqual(RAW);
    expect(effectSpec("example.tremolo")).toMatchObject({ label: "Tremolo", plugin: { state: "off" } });
    expect(effectTypesAt("bus")).not.toContain("example.tremolo");
    expect(pluginEffectNote("example.tremolo")).toMatch(/its plugin, Tremolo, is off/);
  });

  it("a mix with a missing plugin's effect parses clean, round-trips, and the runtime's view leaves it out with one warning", () => {
    const audio = {
      format: "myco.audio@1",
      buses: [
        { name: "Master", parent: null, effects: [] },
        { name: "Wobble", parent: "Master", effects: [RAW] },
      ],
    };
    const { project, problems } = parseAudioProject(audio);
    expect(problems).toEqual([]);
    expect(project.buses[1]!.effects).toEqual([RAW]);
    expect(effectToJson(project.buses[1]!.effects[0]!)).toEqual(RAW);
    const warnings: string[] = [];
    const section = coreSectionOf(project, warnings);
    expect(section.buses.find((b) => b.name === "Wobble")!.effects).toEqual([]);
    expect(warnings.filter((w) => w.includes("fx4"))).toEqual([
      'bus "Wobble": the effect "fx4" (example.tremolo) passes audio through: no installed plugin declares that effect type.',
    ]);
  });

  it("refuses a type another plugin registered first, and a reload replaces a plugin's effects", () => {
    register();
    const other = registerPluginEffects({ plugin: "example", version: "1.0.0", enabled: true, effects: parse(TREMOLO_JSON.audio).audio.effects });
    expect(other).toEqual(["example: the effect type example.tremolo is already example.tremolo's; not registered."]);
    expect(register()).toEqual([]);
    expect(registeredPluginEffects()).toHaveLength(1);
    unregisterPluginEffects("example.tremolo");
    expect(effectSpec("example.tremolo").plugin?.state).toBe("missing");
  });
});
