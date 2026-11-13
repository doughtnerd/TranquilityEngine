import { describe, expect, it } from "vitest";
import { EMPTY_BUS_LOUDNESS, LoudnessView, type BusLoudness } from "../../../../engine/audio/loudnessTypes";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import { LOUD_OUTPUT_TAP, type StatusBlock } from "../wire.generated";
import { LoudnessHub } from "./loudnessHub";

// api-and-models §1.1, "Empty and flag semantics": every row of the empty-state text.
//   "`momentary` is `-Infinity` for 0.4 s after a reset, `shortTerm` for 3 s, `integrated` until a 400 ms block passes
//    the -70 LUFS gate; digital silence keeps `integrated` where it was. An unmetered bus has `metered === false`,
//    every reading `-Infinity` and every control a no-op, never a throw (`Audio.bus("nope").loudness` is the inert
//    object a missing bus already returns). ... `target.state` is `waiting` while `integrated` is `-Infinity`."
// plus the field comments: `lra` -Infinity until two short-term blocks pass the gates; readings "never NaN";
// `metered` false for "not chosen in the project (or the Babylon fallback)"; `target` null when no targets.

const NEG = Number.NEGATIVE_INFINITY;
const energyFor = (lufs: number): number => 10 ** ((lufs + 0.691) / 10);

function block(slot: number, firstSeq: number, energies: number[], extra: { truePeak?: number; flags?: number } = {}): StatusBlock {
  return {
    loudShed: 0,
    loudBuses: [{ slot, flags: energies.length | (extra.flags ?? 0), firstSeq, truePeak: extra.truePeak ?? 0, gatedQuanta: 0 }],
    loudEnergies: energies,
  } as unknown as StatusBlock;
}

function makeHub(): LoudnessHub {
  const hub = new LoudnessHub();
  hub.configure({
    available: true,
    root: "Master",
    buses: [
      { name: "Master", parent: null, slot: 0, metered: false },
      { name: "Voice", parent: "Master", slot: 1, metered: true },
      { name: "Music", parent: "Master", slot: 2, metered: false },
    ],
  });
  return hub;
}

function expectInert(l: BusLoudness): void {
  expect(l.metered).toBe(false);
  for (const k of ["momentary", "shortTerm", "integrated", "lra", "maxTruePeak", "maxMomentary"] as const) expect(l[k], k).toBe(NEG);
  expect(l.elapsed).toBe(0);
  expect(l.truePeakBound).toBe("exact");
  expect(l.paused).toBe(false);
  expect(l.pausedBy).toBeNull();
  expect(l.incomplete).toBe(false);
  expect(l.tainted).toBe(false);
  expect(l.target).toBeNull();
  expect(() => {
    l.reset();
    l.reset("integrated");
    l.reset("maxPeak");
    l.pause();
    l.resume();
  }).not.toThrow();
  expect(l.paused).toBe(false);
}

describe("LoudnessHub empty state (api §1.1)", () => {
  it("an unmetered bus is inert: metered false, every reading -Infinity, controls no-ops that never throw", () => {
    const hub = makeHub();
    expect(hub.busLoudness("Music")).toBeNull();
    expectInert(new LoudnessView(() => hub.busLoudness("Music")));
  });

  it("a missing bus (Audio.bus('nope').loudness) is the inert object a missing bus already returns", () => {
    const hub = makeHub();
    const mixer = new Mixer(defaultAudioSettings());
    hub.attach(mixer);
    expectInert(mixer.bus("nope").loudness);
    expect(hub.busLoudness("nope")).toBeNull();
    expect(mixer.bus("nope").loudness).toBe(mixer.bus("nope").loudness);
    expectInert(EMPTY_BUS_LOUDNESS);
  });

  it("an unmetered bus stays inert after STATUS blocks arrive for the metered ones", () => {
    const hub = makeHub();
    hub.feed(block(1, 0, [energyFor(-20), energyFor(-20), energyFor(-20), energyFor(-20)]));
    expectInert(new LoudnessView(() => hub.busLoudness("Music")));
  });

  it("the Babylon shape (available false): every bus, the root included, is unmetered and inert; feeding is a no-op", () => {
    const hub = new LoudnessHub();
    hub.configure({ available: false, root: "Master", buses: [{ name: "Master", parent: null, slot: 0, metered: false }, { name: "Voice", parent: "Master", slot: 1, metered: true }] });
    expect(hub.busLoudness("Master")).toBeNull();
    expect(hub.busLoudness("Voice")).toBeNull();
    expectInert(new LoudnessView(() => hub.busLoudness("Voice")));
    expect(() => hub.feed(block(1, 0, [1, 1, 1, 1]))).not.toThrow();
  });

  it("a metered bus that has heard nothing: metered true, readings -Infinity, elapsed 0, no flags, a waiting target", () => {
    const hub = makeHub();
    const v = hub.busLoudness("Voice")!;
    expect(v.metered).toBe(true);
    for (const k of ["momentary", "shortTerm", "integrated", "lra", "maxTruePeak", "maxMomentary"] as const) expect(v[k], k).toBe(NEG);
    expect(v.elapsed).toBe(0);
    expect(v.paused).toBe(false);
    expect(v.pausedBy).toBeNull();
    expect(v.incomplete).toBe(false);
    expect(v.tainted).toBe(false);
    expect(v.target).not.toBeNull();
    expect(v.target!.state).toBe("waiting");
    expect(v.target!.deviation).toBe(NEG);
    expect(v.target!.peakOver).toBe(false);
  });

  it("the root bus reads the final output (the output tap): always metered, even though the project does not mark it", () => {
    const hub = makeHub();
    const m = hub.busLoudness("Master")!;
    expect(m.metered).toBe(true);
    hub.feed(block(LOUD_OUTPUT_TAP, 0, [energyFor(-23), energyFor(-23), energyFor(-23), energyFor(-23)]));
    expect(m.momentary).toBeCloseTo(-23, 6);
    expect(hub.busLoudness("Voice")!.momentary).toBe(NEG);
  });

  it("momentary is -Infinity for 0.4 s (4 sub-blocks) after a reset", () => {
    const hub = makeHub();
    const v = hub.busLoudness("Voice")!;
    const e = energyFor(-20);
    hub.feed(block(1, 0, [e, e, e]));
    expect(v.momentary).toBe(NEG);
    hub.feed(block(1, 3, [e]));
    expect(v.momentary).toBeCloseTo(-20, 6);
    v.reset("all");
    expect(v.momentary).toBe(NEG);
    hub.feed(block(1, 4, [e, e, e]));
    expect(v.momentary).toBe(NEG);
    hub.feed(block(1, 7, [e]));
    expect(v.momentary).toBeCloseTo(-20, 6);
  });

  it("shortTerm is -Infinity for 3 s (30 sub-blocks) after a reset", () => {
    const hub = makeHub();
    const v = hub.busLoudness("Voice")!;
    const e = energyFor(-20);
    hub.feed(block(1, 0, new Array(29).fill(e)));
    expect(v.shortTerm).toBe(NEG);
    expect(v.momentary).toBeCloseTo(-20, 6);
    hub.feed(block(1, 29, [e]));
    expect(v.shortTerm).toBeCloseTo(-20, 6);
    v.reset("all");
    expect(v.shortTerm).toBe(NEG);
  });

  it("integrated stays -Infinity until a 400 ms block passes the -70 LUFS gate", () => {
    const hub = makeHub();
    const v = hub.busLoudness("Voice")!;
    const quiet = energyFor(-80);
    hub.feed(block(1, 0, new Array(10).fill(quiet)));
    expect(v.integrated).toBe(NEG);
    expect(v.target!.state).toBe("waiting");
    const loud = energyFor(-30);
    hub.feed(block(1, 10, [loud, loud, loud, loud]));
    expect(v.integrated).toBeGreaterThan(NEG);
    expect(Number.isFinite(v.integrated)).toBe(true);
  });

  it("digital silence keeps integrated where it was", () => {
    const hub = makeHub();
    const v = hub.busLoudness("Voice")!;
    const loud = energyFor(-23);
    hub.feed(block(1, 0, new Array(20).fill(loud)));
    expect(v.integrated).toBeCloseTo(-23, 1);
    // The last 400 ms blocks still overlap the sound (BS.1770's 75 % overlap), so let those 4 sub-blocks pass.
    hub.feed(block(1, 20, new Array(4).fill(0)));
    const before = v.integrated;
    expect(before).toBeGreaterThan(NEG);
    hub.feed(block(1, 24, new Array(30).fill(0)));
    expect(v.integrated).toBe(before);
    expect(v.momentary).toBe(NEG);
  });

  it("lra is -Infinity until two short-term blocks pass the gates", () => {
    const hub = makeHub();
    const v = hub.busLoudness("Voice")!;
    const e = energyFor(-23);
    hub.feed(block(1, 0, new Array(30).fill(e))); // first 3 s block
    expect(v.lra).toBe(NEG);
    hub.feed(block(1, 30, new Array(10).fill(e))); // second, 1 s hop later
    expect(Number.isFinite(v.lra)).toBe(true);
  });

  it("reset clears everything back to the empty state, and no reading is ever NaN", () => {
    const hub = makeHub();
    const v = hub.busLoudness("Voice")!;
    const e = energyFor(-23);
    hub.feed(block(1, 0, new Array(40).fill(e), { truePeak: 0.5 }));
    expect(v.maxTruePeak).toBeGreaterThan(NEG);
    expect(v.elapsed).toBeCloseTo(4, 6);
    v.reset("all");
    for (const k of ["momentary", "shortTerm", "integrated", "lra", "maxTruePeak", "maxMomentary"] as const) expect(v[k], k).toBe(NEG);
    expect(v.elapsed).toBe(0);
    expect(v.target!.state).toBe("waiting");
    expect(v.target!.deviation).toBe(NEG);
    // Hostile input never reaches a reading as NaN.
    hub.feed(block(1, 40, [NaN, Infinity, -1, 0], { truePeak: NaN }));
    for (const k of ["momentary", "shortTerm", "integrated", "lra", "maxTruePeak", "maxMomentary", "elapsed"] as const) expect(Number.isNaN(v[k]), k).toBe(false);
    expect(Number.isNaN(v.target!.deviation)).toBe(false);
  });
});
