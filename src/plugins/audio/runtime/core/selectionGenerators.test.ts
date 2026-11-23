// ADR 0360 (G3): selection with generator voices on a voice table: a silence is forced virtual whatever the room, and a
// generator weighs its kind's measured cost against the mixed cap (G2's ratios, one table), at admission and per frame.
import { describe, expect, it } from "vitest";
import { generatorWireValues } from "../../../../engine/audio/generators/catalogue";
import { GENERATOR_VOICE_COST, generatorVoiceCost, Selection, type SelectionSink } from "./selection";
import { VoiceFlag, VoiceReason, VoiceState, VoiceTable } from "./voiceTable";
import { recordingSink } from "../mix/recordingSink";

const sink: SelectionSink = { setMixed: () => {}, steal: () => {} };

/** A voice at `gain`, a generator of kind number `kind` weighing `weight` (0: a sample voice), admitted under `cap`. */
function admit(table: VoiceTable, sel: Selection, gain: number, cap: number, kind = 0, weight = 1, flags = 0): number {
  const id = table.allocate(0, 0, 0, VoiceState.WAITING_FOR_DATA);
  const i = id & 0xffff;
  table.gain[i] = gain;
  table.flags[i] = flags;
  if (kind > 0) table.setGenerator(i, kind, [], 1, "g", weight);
  const mixed = sel.admit(i, cap);
  table.state[i] = mixed ? VoiceState.PLAYING : VoiceState.VIRTUAL;
  table.reason[i] = mixed ? VoiceReason.NONE : VoiceReason.VIRTUAL;
  return i;
}

const mixed = (t: VoiceTable): number[] => [...Array(t.capacity).keys()].filter((i) => t.state[i] === VoiceState.PLAYING);

describe("selection with generator voices (ADR 0360)", () => {
  it("reads the kinds' costs from one table: G2's measured ratios, the oscillator's noise apart", () => {
    // The measured ratios after D67's blip optimisation (metered gen-* scenes against their sample twins).
    expect(GENERATOR_VOICE_COST).toEqual({ oscillator: 0.68, noise: 0.78, synth: 1.44, blip: 1.47, silence: 0.64 });
    expect(generatorVoiceCost("oscillator", generatorWireValues("oscillator", {}))).toBe(GENERATOR_VOICE_COST.oscillator);
    expect(generatorVoiceCost("oscillator", generatorWireValues("oscillator", { waveform: 4 }))).toBe(GENERATOR_VOICE_COST.noise);
    expect(generatorVoiceCost("blip", generatorWireValues("blip", {}))).toBe(GENERATOR_VOICE_COST.blip);
    expect(generatorVoiceCost("synth", generatorWireValues("synth", {}))).toBe(GENERATOR_VOICE_COST.synth);
  });

  it("a silence is never mixed: admitted virtual with room to spare, and kept virtual frame after frame", () => {
    const table = new VoiceTable(16);
    const sel = new Selection(table);
    const s = admit(table, sel, 1, 8, 4, GENERATOR_VOICE_COST.silence, VoiceFlag.VIRTUAL_ONLY);
    const tone = admit(table, sel, 0.5, 8, 1, GENERATOR_VOICE_COST.oscillator);
    expect(mixed(table)).toEqual([tone]);
    for (let f = 0; f < 6; f++) sel.run(8, sink);
    expect(table.state[s]).toBe(VoiceState.VIRTUAL);
    expect(mixed(table)).toEqual([tone]);
  });

  it("weighs blips at their cost against the cap at admission, and keeps the loudest that fit when ranking", () => {
    const table = new VoiceTable(16);
    const sel = new Selection(table);
    // Cap 3: two blips (2 × 1.47 = 2.94) fit, a third (4.41) doesn't; a sample voice (1) would not after two (3.94).
    const w = GENERATOR_VOICE_COST.blip;
    const fit = Math.floor(3 / w);
    expect(fit).toBe(2);
    const blips = [0.4, 0.5, 0.6].map((g) => admit(table, sel, g, 3, 3, w));
    expect(mixed(table)).toEqual(blips.slice(0, fit));
    const sample = admit(table, sel, 0.1, 3);
    expect(table.state[sample]).toBe(VoiceState.VIRTUAL);
    // Past the dwell the loudest two blips are mixed; the sample voice and the quietest blip wait.
    for (let f = 0; f < 6; f++) sel.run(3, sink);
    expect(mixed(table).sort()).toEqual(blips.slice(1).sort());
    expect(sel.mixedCount).toBeCloseTo(fit * w, 4);
    // Oscillators weigh less than a sample voice, but never more than `cap` voices mix (the core's mixed pool).
    const t2 = new VoiceTable(32);
    const s2 = new Selection(t2);
    for (let k = 0; k < 14; k++) admit(t2, s2, 1 - k * 0.01, 8, 1, GENERATOR_VOICE_COST.oscillator);
    for (let f = 0; f < 6; f++) s2.run(8, sink);
    expect(mixed(t2)).toHaveLength(8);
  });

  it("the capture's voiceStart names a generator voice by its generator, not its reserved clip id", () => {
    const table = new VoiceTable(8);
    const stub = recordingSink();
    table.setProfile(stub.sink, { clip: (id) => `clip${id}`, busRef: (b) => b });
    const sel = new Selection(table);
    const id = table.allocate(0, 128, 0, VoiceState.WAITING_FOR_DATA);
    const i = id & 0xffff;
    table.clip[i] = 0xffff0303;
    table.gain[i] = 1;
    table.setGenerator(i, 3, generatorWireValues("blip", {}), 5, "ui/coin.generator.json", GENERATOR_VOICE_COST.blip);
    sel.admit(i, 8);
    expect(stub.of("voiceStart")[0]![1]).toBe("ui/coin.generator.json");
    // Freed, the slot forgets it: the next voice there is a clip voice again.
    table.free(id, VoiceReason.NONE);
    expect(table.genKind[i]).toBe(0);
    expect(table.capWeight[i]).toBe(1);
    expect(table.genLive).toBe(0);
  });

  it("without generator voices, selection counts voices as before", () => {
    const table = new VoiceTable(16);
    const sel = new Selection(table);
    for (let k = 0; k < 6; k++) admit(table, sel, 1 - k * 0.1, 4);
    for (let f = 0; f < 6; f++) sel.run(4, sink);
    expect(mixed(table)).toEqual([0, 1, 2, 3]);
    expect(sel.mixedCount).toBe(4);
  });
});
