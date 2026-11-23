// The Generator editor's model (ADR 0360 §9) through its interface: rows generated from the catalogue (a parameter
// the catalogue gains later included), presets, Randomise and Mutate with locks (deterministic per seed), the kind
// switch's loss detection, and the plain edits.
import { describe, expect, it } from "vitest";
import { blipPreset } from "../../../../engine/audio/generators/blipPresets";
import { GENERATOR_CATALOGUE, generatorSpec, type GeneratorParamSpec, type GeneratorSpec } from "../../../../engine/audio/generators/catalogue";
import { emptyGeneratorBody } from "../../../../engine/audio/generators/format";
import { synthPreset } from "../../../../engine/audio/generators/synthPresets";
import { GENERATOR_KINDS, type GeneratorBody } from "../../../../engine/audio/generators/types";
import {
  applyPreset, blipReadout, generatorRows, kindSwitch, kindSwitchQuestion, MORE, mutate, parseSeed, presetsOf, randomise, setGeneratorParam, setNote, setSeed, setVary, switchKind, toggleLock,
} from "./generatorModel";

const next = (r: { next: GeneratorBody } | { refused: string }): GeneratorBody => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};
const coin = (seed = 1734): GeneratorBody => next(applyPreset({ ...emptyGeneratorBody("blip"), seed }, "coin"));

describe("parameter rows", () => {
  it("lists every catalogue parameter of every kind exactly once, with its spec and value", () => {
    for (const kind of GENERATOR_KINDS) {
      const spec = generatorSpec(kind);
      const rows = generatorRows(spec, emptyGeneratorBody(kind)).flatMap((g) => g.rows);
      expect(rows.map((r) => r.name).sort()).toEqual(spec.params.map((q) => q.name).sort());
      for (const r of rows) {
        expect(r.value).toBe(r.spec.default);
        expect(r.choice).toBe(!!r.spec.choices);
        expect(r.isDefault).toBe(true);
      }
    }
  });

  it("groups blips as sfxr does, choices as menus, with real-unit readouts", () => {
    const groups = generatorRows(generatorSpec("blip"), coin());
    expect(groups.map((g) => g.title).slice(0, 3)).toEqual(["Waveform", "Envelope", "Frequency"]);
    const waveform = groups[0]!.rows[0]!;
    expect(waveform.choice).toBe(true);
    expect(waveform.spec.choices).toEqual(["Square", "Saw", "Sine", "Noise", "Triangle"]);
    const freq = groups.find((g) => g.title === "Frequency")!.rows.find((r) => r.name === "baseFrequency")!;
    expect(freq.readout).toMatch(/Hz$/);
    expect(blipReadout("baseFrequency", 0.3)).toBe("321 Hz");
    expect(blipReadout("attack", 0.3)).toBe("204 ms");
    expect(blipReadout("repeatSpeed", 0)).toBe("off");
  });

  it("shows a parameter the catalogue gains later, with no code for it (a choice as a menu, in More)", () => {
    // `quality` (D67) arrived this way; a further, made-up parameter shows the same path still works.
    const extra: GeneratorParamSpec = { name: "character", label: "Character", min: 0, max: 1, step: 1, unit: "", default: 0, scale: "linear", smooth: false, choices: ["Clean", "Warm"], choiceIds: ["clean", "warm"] };
    const grown: GeneratorSpec = { ...GENERATOR_CATALOGUE.synth, params: [...GENERATOR_CATALOGUE.synth.params, extra] };
    const groups = generatorRows(grown, { ...emptyGeneratorBody("synth"), params: { ...emptyGeneratorBody("synth").params, character: 1 } });
    const last = groups[groups.length - 1]!;
    expect(last.title).toBe(MORE);
    expect(last.rows.map((r) => r.name)).toContain("quality");
    const row = last.rows.find((r) => r.name === "character")!;
    expect([row.choice, row.value, row.spec.choices]).toEqual([true, 1, ["Clean", "Warm"]]);
    // A kind with presets can lock it too.
    expect(row.lockable).toBe(true);
  });

  it("marks locks on kinds with presets; level is never lockable (presets keep it)", () => {
    const rows = generatorRows(generatorSpec("blip"), coin(), ["slide"]).flatMap((g) => g.rows);
    expect(rows.find((r) => r.name === "slide")!.locked).toBe(true);
    expect(rows.find((r) => r.name === "level")!.lockable).toBe(false);
    expect(generatorRows(generatorSpec("oscillator"), emptyGeneratorBody("oscillator"), ["frequency"]).flatMap((g) => g.rows).every((r) => !r.lockable && !r.locked)).toBe(true);
    expect(toggleLock(toggleLock([], "slide"), "slide")).toEqual([]);
  });
});

describe("presets", () => {
  it("lists blip and synth presets only", () => {
    expect(presetsOf("blip").map((p) => p.id)).toContain("coin");
    expect(presetsOf("synth").map((p) => p.id)).toContain("pad");
    expect(presetsOf("oscillator")).toEqual([]);
  });

  it("draws a blip preset from the generator's seed and keeps its level and locks", () => {
    const start: GeneratorBody = { ...emptyGeneratorBody("blip"), seed: 42, params: { ...emptyGeneratorBody("blip").params, level: -6, slide: 0.5 } };
    const made = next(applyPreset(start, "laser", ["slide"]));
    const expected = blipPreset("laser", 42);
    expect(made.preset).toBe("laser");
    expect(made.seed).toBe(42);
    expect(made.params.level).toBe(-6);
    expect(made.params.slide).toBe(0.5);
    for (const name of Object.keys(expected)) if (name !== "level" && name !== "slide") expect(made.params[name]).toBe(expected[name]);
    // The same preset and seed: the same blip.
    expect(next(applyPreset(start, "laser", ["slide"]))).toEqual(made);
  });

  it("applies a synth preset with its locks, and refuses another kind's preset", () => {
    const start: GeneratorBody = { ...emptyGeneratorBody("synth"), params: { ...emptyGeneratorBody("synth").params, cutoff: 9000 } };
    const pad = next(applyPreset(start, "pad", ["cutoff"]));
    expect(pad.params.cutoff).toBe(9000);
    expect(pad.params.attack).toBe(synthPreset("pad").attack);
    expect(applyPreset(start, "coin")).toEqual({ refused: 'Synth has no preset "coin"' });
    expect("refused" in applyPreset(emptyGeneratorBody("oscillator"), "beep")).toBe(true);
  });
});

describe("Randomise and Mutate", () => {
  it("Randomise is deterministic per seed and moves to a new seed", () => {
    const a = next(randomise(coin(7)));
    const b = next(randomise(coin(7)));
    expect(a).toEqual(b);
    expect(a.seed).not.toBe(7);
    expect(a.preset).toBe("coin");
    expect(next(randomise(coin(8))).params).not.toEqual(a.params);
  });

  it("Randomise keeps locked parameters and changes no other parameter because of a lock", () => {
    const start = coin(7);
    const free = next(randomise(start));
    const locked = next(randomise(start, ["baseFrequency", "decay"]));
    expect(locked.params.baseFrequency).toBe(start.params.baseFrequency);
    expect(locked.params.decay).toBe(start.params.decay);
    expect(free.params.baseFrequency).not.toBe(start.params.baseFrequency);
    for (const name of Object.keys(free.params)) if (name !== "baseFrequency" && name !== "decay") expect(locked.params[name]).toBe(free.params[name]);
  });

  it("Mutate nudges only unlocked numbers, deterministically, and moves on to the next seed", () => {
    const start = coin(99);
    const a = next(mutate(start, ["punch"]));
    expect(next(mutate(start, ["punch"]))).toEqual(a);
    expect(a.params.punch).toBe(start.params.punch);
    expect(a.params.waveform).toBe(start.params.waveform); // choices never mutate
    expect(a.seed).not.toBe(start.seed);
    const moved = Object.keys(start.params).filter((n) => a.params[n] !== start.params[n]);
    expect(moved.length).toBeGreaterThan(0);
    for (const n of moved) expect(Math.abs(a.params[n]! - start.params[n]!)).toBeLessThanOrEqual(0.05 + 1e-9);
    // Mutating again from the result moves again.
    expect(next(mutate(a, ["punch"])).params).not.toEqual(a.params);
  });

  it("Mutate with every number but one locked moves at most that one", () => {
    const start = coin(99);
    const all = generatorSpec("blip").params.filter((q) => !q.choices).map((q) => q.name);
    const free = next(mutate(start));
    expect(all.filter((n) => free.params[n] !== start.params[n]).length).toBeGreaterThan(1);
    const kept = next(mutate(start, all.filter((n) => n !== "slide")));
    expect(Object.keys(start.params).filter((n) => kept.params[n] !== start.params[n] && n !== "slide")).toEqual([]);
  });

  it("refuses on kinds that don't randomise", () => {
    expect("refused" in randomise(emptyGeneratorBody("synth"))).toBe(true);
    expect("refused" in mutate(emptyGeneratorBody("oscillator"))).toBe(true);
  });
});

describe("the kind switch", () => {
  it("loses nothing from defaults, and carries parameters both kinds hold the same way", () => {
    expect(kindSwitch(emptyGeneratorBody("oscillator"), "synth").lost).toEqual([]);
    const osc: GeneratorBody = { ...emptyGeneratorBody("oscillator"), seed: 5, vary: 0.2, note: "hum", params: { ...emptyGeneratorBody("oscillator").params, frequency: 1000, attack: 50, level: -3 } };
    const s = kindSwitch(osc, "synth");
    expect(s.lost).toEqual([]);
    expect(s.next.kind).toBe("synth");
    expect([s.next.params.frequency, s.next.params.attack, s.next.params.level]).toEqual([1000, 50, -3]);
    expect([s.next.seed, s.next.vary, s.next.note]).toEqual([5, 0.2, "hum"]);
    expect(kindSwitchQuestion(osc, "synth")).toBeNull();
  });

  it("lists set parameters the new kind can't hold (a blip's 0..1 attack isn't ms)", () => {
    const blip = coin();
    const s = kindSwitch(blip, "oscillator");
    expect(s.lost).toContain("Frequency"); // baseFrequency, sfxr units
    expect(s.lost).toContain("Decay");
    expect(s.lost).not.toContain("Level"); // dB in both: carried
    expect(s.presetDropped).toBe(true);
    expect(s.next.preset).toBeUndefined();
    expect(s.next.params.attack).toBe(generatorSpec("oscillator").params.find((q) => q.name === "attack")!.default);
    expect(kindSwitchQuestion(blip, "oscillator")).toMatch(/^Oscillator has no .* lost/);
    const square = next(setGeneratorParam(emptyGeneratorBody("oscillator"), "waveform", 1));
    expect(kindSwitch(square, "synth").lost).toEqual(["Waveform"]);
    expect(next(switchKind(square, "synth")).kind).toBe("synth");
  });
});

describe("plain edits", () => {
  it("clamps parameters, refuses unknown ones, and keeps the body for no change", () => {
    const g = emptyGeneratorBody("oscillator");
    expect(next(setGeneratorParam(g, "frequency", 99999)).params.frequency).toBe(20000);
    expect(next(setGeneratorParam(g, "waveform", 2.6)).params.waveform).toBe(3);
    expect(setGeneratorParam(g, "frequency", 440)).toEqual({ next: g });
    expect(setGeneratorParam(g, "slide", 0.2)).toEqual({ refused: 'Oscillator has no parameter "slide"' });
  });

  it("reads and sets the seed, vary and note", () => {
    expect([parseSeed(""), parseSeed(" 17 "), parseSeed("-1"), parseSeed("1.5"), parseSeed("4294967296")]).toEqual([null, 17, undefined, undefined, undefined]);
    const g = emptyGeneratorBody("blip");
    expect(next(setSeed(g, 17)).seed).toBe(17);
    expect("refused" in setSeed(g, 1.5)).toBe(true);
    expect(next(setVary(g, 3)).vary).toBe(1);
    expect(next(setNote(g, "  Shop  ")).note).toBe("Shop");
    expect(next(setNote({ ...g, note: "x" }, "")).note).toBeUndefined();
  });
});
