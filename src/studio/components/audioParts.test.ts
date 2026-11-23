// The Studio's shared audio parts (ADR 0349), through their models: faders and meters, parameter rows and the game
// parameters panel, effect chain edits, send and ducking rows, the sound picker and type badges, time axes and lanes,
// the gain breakdown, and the "Why it played" view.
import { describe, expect, it } from "vitest";
import { defaultEffect } from "../../engine/audio/effects/catalogue";
import type { Effect } from "../../engine/audio/effects/types";
import type { DuckingRule } from "../../engine/audio/project/types";
import { START_VIEW, chainKey, chainText, chainWheel, fitView, shouldStack, worstSeverity, zoomAt, type CausalStep } from "./causalChainModel";
import { addEffect, effectMenu, effectSummary, keyBusOptions, levelWarning, moveEffect, nextEffectId, removeEffect, setEffectKey, setEffectOn, setEffectParam, SUMMARY_MIN_PX, summaryFits, type EditResult } from "./effectChainModel";
import { FADER_MAX_DB, FADER_MIN_DB, dbToPosition, faderGhosts, faderKey, formatDb, parseDb, pointerToDb, positionToDb, snapFaderDb } from "./faderModel";
import { audibleUnderSolo, dbText, gainBreakdown, gainText, laneBar, laneText, parentsText, totalText, type GainInputs } from "./gainLanesModel";
import { EMPTY_HOLD, clearClip, meterFill, meterText, meterZone, nextHold } from "./meterModel";
import { duckSummary, duckTriggerOptions, editDuck, editSendLevel, sendSummary, sendTargets, triggerEntries } from "./mixRowsModel";
import { numericSpec, parameterRows, withTestValue } from "./parameterPanelModel";
import { formatParam, paramKey, paramToFraction, paramToSlider, parseParam, scrubParam, sliderToParam, snapParam, stepDecimals, type ParamSpec } from "./parameterRowModel";
import { flatItems, soundFolder, soundName, soundSections, stepActive, type SoundItem } from "./soundPickerModel";
import { isDimmed, packSpans, spanAt, spanBoxes, stepSpan, type Span } from "./spanLaneModel";
import { formatTime, linearTimeAxis, spanBox, zoomTimeAxis } from "./timeAxis";
import { placeholderBadge, playlistBadge, sampleBadge } from "./typeBadgeModel";
import { formatValue, lanePolyline, valueAt, valueRange, valueToY } from "./valueLaneModel";

const next = <T>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};
const refused = <T>(r: EditResult<T>): string => ("refused" in r ? r.refused : "");

describe("fader", () => {
  it("maps −60..+6 dB linearly along the travel, 0 dB at 60/66", () => {
    expect(dbToPosition(FADER_MIN_DB)).toBe(0);
    expect(dbToPosition(FADER_MAX_DB)).toBe(1);
    expect(dbToPosition(0)).toBeCloseTo(60 / 66);
    expect(dbToPosition(20)).toBe(1);
    expect(dbToPosition(-Infinity)).toBe(0);
    expect(positionToDb(60 / 66)).toBe(0);
    expect(positionToDb(-1)).toBe(FADER_MIN_DB);
    expect(positionToDb(0.5)).toBe(-27);
  });

  it("snaps to 0.5 dB within range and reads pointers on either orientation", () => {
    expect(snapFaderDb(-3.26)).toBe(-3.5);
    expect(snapFaderDb(-3.24)).toBe(-3);
    expect(snapFaderDb(6.02)).toBe(6);
    expect(Object.is(snapFaderDb(-0.1), 0)).toBe(true);
    const rect = { left: 100, top: 10, width: 66, height: 132 };
    expect(pointerToDb(rect, 160, 0, "horizontal")).toBe(0);
    expect(pointerToDb(rect, 0, 10, "vertical")).toBe(FADER_MAX_DB);
    expect(pointerToDb(rect, 0, 142, "vertical")).toBe(FADER_MIN_DB);
    expect(pointerToDb(rect, 0, 22, "vertical")).toBe(0);
  });

  it("steps by key: 0.5 dB, Shift and Page 3 dB, Home/End the ends, 0 unity", () => {
    expect(faderKey(-6, "ArrowUp")).toBe(-5.5);
    expect(faderKey(-6, "ArrowLeft")).toBe(-6.5);
    expect(faderKey(-6, "ArrowRight", true)).toBe(-3);
    expect(faderKey(5, "PageUp")).toBe(6);
    expect(faderKey(-59, "PageDown")).toBe(-60);
    expect(faderKey(-6, "Home")).toBe(6);
    expect(faderKey(-6, "End")).toBe(-60);
    expect(faderKey(-6, "0")).toBe(0);
    expect(faderKey(-6, "a")).toBeNull();
  });

  it("writes and reads levels", () => {
    expect([formatDb(-60), formatDb(-70), formatDb(0), formatDb(3), formatDb(-6.5), formatDb(-0.04)]).toEqual(["−∞", "−∞", "0.0", "+3.0", "−6.5", "0.0"]);
    expect(parseDb("−6.3 dB")).toBe(-6.5);
    expect(parseDb("+2")).toBe(2);
    expect(parseDb("-inf")).toBe(FADER_MIN_DB);
    expect(parseDb("12")).toBe(6);
    expect(parseDb("loud")).toBeNull();
    expect(parseDb(" ")).toBeNull();
  });

  it("draws the single ghost tick and both ticks of snapshot mode, one per kind", () => {
    expect(faderGhosts(null, undefined, undefined)).toEqual([]);
    expect(faderGhosts(-6, "With VCAs", undefined)).toEqual([{ db: -6, title: "With VCAs", kind: "vca" }]);
    const both = faderGhosts(undefined, undefined, [{ kind: "vca", db: -10 }, { kind: "base", db: -3, title: "Base" }]);
    expect(both.map((g) => g.kind)).toEqual(["vca", "base"]);
    // A second tick of a kind already drawn, and a tick that isn't a number, are left out.
    expect(faderGhosts(-6, undefined, [{ kind: "vca", db: -9 }, { kind: "base", db: Number.NaN }]).map((g) => g.db)).toEqual([-6]);
    expect(faderGhosts(-6, undefined, [{ kind: "base", db: -Infinity }]).map((g) => g.kind)).toEqual(["vca", "base"]);
  });
});

describe("meter", () => {
  it("fills on the fader's scale and colours by zone", () => {
    expect(meterFill(null)).toBe(0);
    expect(meterFill(-80)).toBe(0);
    expect(meterFill(0)).toBeCloseTo(60 / 66);
    expect(meterFill(12)).toBe(1);
    expect([meterZone(undefined), meterZone(-20), meterZone(-3), meterZone(0.5)]).toEqual(["quiet", "ok", "hot", "clip"]);
    expect(meterText(-12, -18.25)).toBe("Peak −12.0 dBFS, RMS −18.3 dBFS");
    expect(meterText(null)).toBe("Peak silent");
  });

  it("holds the peak 1.5 s, then lets it fall 20 dB/s, and latches clips until cleared", () => {
    let h = nextHold(EMPTY_HOLD, -10, 0);
    expect(h).toEqual({ holdDb: -10, heldAt: 0, clipped: false });
    h = nextHold(h, -30, 1000);
    expect(h.holdDb).toBe(-10);
    h = nextHold(h, -30, 2000);
    expect(h.holdDb).toBeCloseTo(-20);
    h = nextHold(h, -5, 2100);
    expect(h).toEqual({ holdDb: -5, heldAt: 2100, clipped: false });
    h = nextHold(h, 0.2, 2200);
    expect(h.clipped).toBe(true);
    h = nextHold(h, -40, 5000);
    expect(h.clipped).toBe(true);
    expect(clearClip(h).clipped).toBe(false);
    expect(clearClip(EMPTY_HOLD)).toBe(EMPTY_HOLD);
  });
});

describe("parameter row", () => {
  const cutoff: ParamSpec = { label: "Cutoff", min: 20, max: 20000, step: 1, unit: "Hz", scale: "log", default: 20000 };
  const gain: ParamSpec = { label: "Gain", min: -24, max: 24, step: 0.1, unit: "dB" };

  it("places log parameters by ratio and linear ones by difference", () => {
    expect(paramToFraction(cutoff, 632.456)).toBeCloseTo(0.5, 3);
    expect(paramToFraction(gain, 0)).toBe(0.5);
    expect(paramToSlider(cutoff, 20000)).toBe(1000);
    expect(sliderToParam(cutoff, 500)).toBe(632);
    expect(sliderToParam(gain, 250)).toBe(-12);
  });

  it("slides a log range that starts at 0 by ratio, shifted to start at 1", () => {
    const ms: ParamSpec = { label: "Attack", min: 0, max: 10000, step: 1, unit: "ms", scale: "log" };
    expect(paramToFraction(ms, 0)).toBe(0);
    expect(paramToFraction(ms, 10000)).toBeCloseTo(1);
    expect(paramToFraction(ms, 100)).toBeCloseTo(Math.log(101) / Math.log(10001));
    expect(sliderToParam(ms, 500)).toBe(99);
    expect(sliderToParam(ms, 0)).toBe(0);
  });

  it("snaps to the step without float noise", () => {
    expect(stepDecimals(0.1)).toBe(1);
    expect(stepDecimals(0.01)).toBe(2);
    expect(stepDecimals(1)).toBe(0);
    expect(snapParam(gain, 0.30000000004)).toBe(0.3);
    expect(snapParam(gain, 99)).toBe(24);
    expect(snapParam({ label: "R", min: 0.1, max: 200, step: 0.1, unit: "ms" }, 10.04)).toBe(10);
  });

  it("scrubs a share of the range per pixel, ×10 with Shift, finely with Alt", () => {
    expect(scrubParam(gain, 0, 30)).toBeCloseTo(4.8);
    expect(scrubParam(gain, 0, 30, { shift: true })).toBe(24);
    expect(scrubParam(gain, 0, 3, { alt: true })).toBeCloseTo(0.05);
    // log: equal pixels are equal ratios
    const up = scrubParam(cutoff, 200, 50);
    const up2 = scrubParam(cutoff, 2000, 50);
    expect(up2 / 2000).toBeCloseTo(up / 200, 1);
  });

  it("steps by key and writes and reads values", () => {
    expect(paramKey(gain, 0, "ArrowUp")).toBe(0.1);
    expect(paramKey(gain, 0, "ArrowDown", { shift: true })).toBe(-1);
    expect(paramKey(gain, 0, "ArrowUp", { alt: true })).toBe(0.01);
    expect(paramKey(cutoff, 1000, "ArrowUp")).toBe(1010);
    expect(paramKey(gain, 3, "Home")).toBe(-24);
    expect(paramKey(gain, 3, "x")).toBeNull();
    expect(formatParam(cutoff, 2400)).toBe("2.40 kHz");
    expect(formatParam(cutoff, 800)).toBe("800 Hz");
    expect(formatParam(gain, -3)).toBe("−3.0 dB");
    expect(parseParam(cutoff, "2.4 kHz")).toBe(2400);
    expect(parseParam(cutoff, "2.4k")).toBe(2400);
    expect(parseParam(gain, "−3.04 dB")).toBe(-3);
    expect(parseParam(gain, "abc")).toBeNull();
  });
});

describe("game parameters panel", () => {
  const defs = [
    { name: "speed", min: 0, max: 300, default: 0, seekSpeed: 0 },
    { name: "threat", min: 0, max: 1, default: 0, seekSpeed: 0 },
    { name: "rpm", min: 0, max: 8000, default: 3200, seekSpeed: 0 },
    { name: "surface", labels: ["Dirt", "Metal", "Wood"], default: "Metal" },
  ];
  it("gives numeric parameters a slider over 1000 steps and labelled ones a select", () => {
    const rows = parameterRows(defs, { threat: 0.4567, surface: 7 }, { speed: "km/h" });
    expect(rows.map((r) => r.kind)).toEqual(["number", "number", "number", "labels"]);
    const [speed, threat, rpm, surface] = rows as [Extract<(typeof rows)[0], { kind: "number" }>, Extract<(typeof rows)[0], { kind: "number" }>, Extract<(typeof rows)[0], { kind: "number" }>, Extract<(typeof rows)[0], { kind: "labels" }>];
    expect(speed.spec).toMatchObject({ step: 0.1, unit: "km/h" });
    expect(threat).toMatchObject({ value: 0.457, isDefault: false });
    expect(threat.spec.step).toBe(0.001);
    expect(rpm).toMatchObject({ value: 3200, isDefault: true });
    expect(rpm.spec.step).toBe(1);
    expect(surface).toMatchObject({ value: 2, labels: ["Dirt", "Metal", "Wood"] });
    expect(parameterRows(defs, {})[3]).toMatchObject({ value: 1, isDefault: true });
    expect(numericSpec({ name: "x", min: 5, max: 5, default: 5 }).step).toBe(1);
  });
  it("sets and clears test values", () => {
    expect(withTestValue({ a: 1 }, "b", 2)).toEqual({ a: 1, b: 2 });
    expect(withTestValue({ a: 1 }, "a", null)).toEqual({});
  });
});

describe("effect chain", () => {
  const chain: Effect[] = [defaultEffect("lowpass", "fx1"), defaultEffect("compressor", "fx2")];

  it("offers the level's types alphabetically", () => {
    const bus = effectMenu("bus").map((i) => i.label);
    expect(bus).toEqual([...bus].sort((a, b) => a.localeCompare(b)));
    expect(bus).toContain("Limiter");
    expect(bus).toContain("Sidechain compressor");
    expect(bus).not.toContain("Gain");
    const voice = effectMenu("voice").map((i) => i.type);
    expect(voice).toContain("envelope");
    expect(voice).not.toContain("reverb");
  });

  it("adds at the end with defaults and a fresh id, refusing the wrong level and a full chain", () => {
    expect(nextEffectId([defaultEffect("eq", "fx2")])).toBe("fx1");
    const added = next(addEffect(chain, "reverb", "bus"));
    expect(added).toHaveLength(3);
    expect(added[2]).toMatchObject({ id: "fx3", type: "reverb", on: true, params: { size: 0.5, decay: 1.8, mix: 20 } });
    expect(next(addEffect(chain, "eq", "bus", { index: 0 }))[0]!.type).toBe("eq");
    expect(refused(addEffect(chain, "limiter", "voice"))).toMatch(/can't run on a clip/);
    expect(refused(addEffect(chain, "eq", "bus", { limit: 2 }))).toBe("at most 2 effects here");
    expect(next(addEffect([], "sidechainCompressor", "bus"))[0]!.key).toBe("");
  });

  it("removes, reorders and bypasses, refusing moves past the ends", () => {
    expect(next(removeEffect(chain, "fx1")).map((e) => e.id)).toEqual(["fx2"]);
    expect(refused(removeEffect(chain, "nope"))).toMatch(/no effect/);
    expect(next(moveEffect(chain, "fx2", -1)).map((e) => e.id)).toEqual(["fx2", "fx1"]);
    expect(refused(moveEffect(chain, "fx1", -1))).toBe("it is already first");
    expect(refused(moveEffect(chain, "fx2", 1))).toBe("it is already last");
    const off = next(setEffectOn(chain, "fx1", false));
    expect(off[0]!.on).toBe(false);
    expect(off[1]).toBe(chain[1]);
    expect(next(setEffectOn(chain, "fx1", true))).toBe(chain);
  });

  it("sets parameters within range and sidechain keys, refusing what doesn't apply", () => {
    expect(next(setEffectParam(chain, "fx1", "cutoff", 50000))[0]!.params.cutoff).toBe(20000);
    expect(next(setEffectParam(chain, "fx1", "cutoff", 20000))).toBe(chain);
    expect(refused(setEffectParam(chain, "fx1", "ratio", 2))).toMatch(/no parameter "ratio"/);
    expect(refused(setEffectParam(chain, "fx1", "cutoff", NaN))).toMatch(/number/);
    const sc = [defaultEffect("sidechainCompressor", "fx1")];
    expect(next(setEffectKey(sc, "fx1", "Dialogue", "Music"))[0]!.key).toBe("Dialogue");
    expect(refused(setEffectKey(sc, "fx1", "Music", "Music"))).toMatch(/own sidechain/);
    expect(refused(setEffectKey(chain, "fx1", "Dialogue"))).toMatch(/no key bus/);
    expect(keyBusOptions(["Master", "SFX", "Music", "Dialogue"], "Music")).toEqual(["SFX", "Dialogue"]);
  });

  it("summarises a card and warns when it can't run at the level", () => {
    expect(effectSummary(chain[0]!)).toBe("20.00 kHz · 0.10");
    expect(effectSummary({ ...chain[0]!, on: false })).toBe("Bypassed");
    expect(effectSummary(defaultEffect("sidechainCompressor", "fx9"))).toBe("−24.0 dB · 3.0 :1 · no key");
    expect(levelWarning(defaultEffect("gain", "fx1"), "bus")).toMatch(/doesn't run on a bus/);
    expect(levelWarning(chain[0]!, "bus")).toBeNull();
    // ADR 0362: a chain whose owner runs a type the level doesn't list (a sequence clip's Amp envelope) doesn't warn.
    expect(levelWarning(defaultEffect("envelope", "fx2"), "instance")).toMatch(/doesn't run/);
    expect(levelWarning(defaultEffect("envelope", "fx2"), "instance", ["envelope", "gain"])).toBeNull();
  });
});

describe("send and ducking rows", () => {
  const rule: DuckingRule = { target: "Music", trigger: "Dialogue", mode: "presence", detector: "rms", thresholdDb: -20, amountDb: -6, attackMs: 80, releaseMs: 400, enabled: true };
  it("edits a send's level on the fader's grid and lists where a bus may send", () => {
    const send = { to: "Reverb", levelDb: -12 };
    expect(next(editSendLevel(send, -7.3))).toEqual({ to: "Reverb", levelDb: -7.5 });
    expect(next(editSendLevel(send, -12))).toBe(send);
    expect(next(editSendLevel(send, 40)).levelDb).toBe(6);
    expect(refused(editSendLevel(send, NaN))).toMatch(/number/);
    expect(sendSummary(send)).toBe("→ Reverb · −12.0 dB");
    expect(sendTargets(["Reverb", "Delay"], "SFX", [send])).toEqual([{ name: "Reverb", disabled: "already" }, { name: "Delay", disabled: null }]);
    expect(sendTargets(["Reverb"], "Master", [])[0]!.disabled).toBe("Master can't send");
  });

  it("summarises and edits ducking rules within the parse's limits", () => {
    expect(duckSummary(rule)).toBe("−6.0 dB · while playing");
    expect(duckSummary({ ...rule, mode: "level", amountDb: -8 })).toBe("−8.0 dB · above −20.0 dBFS");
    expect(duckSummary({ ...rule, enabled: false })).toBe("Off");
    expect(next(editDuck(rule, { amountDb: 3, attackMs: 99999, thresholdDb: -200 }))).toMatchObject({ amountDb: 0, attackMs: 10000, thresholdDb: -80 });
    expect(next(editDuck(rule, { releaseMs: 400 }))).toBe(rule);
    expect(refused(editDuck(rule, { trigger: "Music" }))).toMatch(/can't duck itself/);
    expect(refused(editDuck(rule, { attackMs: NaN }))).toMatch(/number/);
  });

  it("lists the buses that may trigger a duck, with why not", () => {
    const parents: Record<string, string | null> = { Master: null, SFX: "Master", Vehicles: "SFX", Music: "Master", Dialogue: "Master" };
    const opts = duckTriggerOptions(["Master", "SFX", "Vehicles", "Music", "Dialogue"], "Vehicles", [{ ...rule, target: "Vehicles", trigger: "Dialogue" }], (n) => parents[n] ?? null);
    expect(opts.map((o) => o.disabled)).toEqual(["Master can't trigger", "contains Vehicles", "the ducked bus", null, "already"]);
    expect(duckTriggerOptions(["Dialogue"], "Vehicles", [{ ...rule, target: "Vehicles" }], (n) => parents[n] ?? null, "Dialogue")[0]!.disabled).toBeNull();
  });
});

describe("sound picker and badges", () => {
  const items: SoundItem[] = [
    { path: "audio/sfx/footsteps.playlist.json", kind: "playlist", badge: "QUE" },
    { path: "audio/music/explore.playlist.json", kind: "playlist", badge: "SEQ" },
    { path: "audio/sfx/dirt_01.wav", kind: "sample", badge: "SMP" },
    { path: "audio/sfx/metal_01.wav", kind: "sample", badge: "SMP", disabled: "it would contain itself" },
    { path: "boost.ogg", kind: "sample", badge: "SMP", name: "Boost whoosh" },
  ];
  it("names sounds and finds their folders", () => {
    expect(soundName(items[0]!)).toBe("footsteps");
    expect(soundName(items[2]!)).toBe("dirt_01");
    expect(soundName(items[4]!)).toBe("Boost whoosh");
    expect(soundFolder(items[0]!)).toBe("audio/sfx");
    expect(soundFolder(items[4]!)).toBe("");
  });
  it("searches every word in name and path, in two sorted sections", () => {
    const all = soundSections(items, "");
    expect(all.map((s) => s.title)).toEqual(["Playlists", "Samples"]);
    expect(all[0]!.items.map(soundName)).toEqual(["explore", "footsteps"]);
    expect(soundSections(items, "sfx DIRT").flatMap((s) => s.items.map(soundName))).toEqual(["dirt_01"]);
    expect(soundSections(items, "whoosh")[0]!.title).toBe("Samples");
    expect(soundSections(items, "", "sample").map((s) => s.title)).toEqual(["Samples"]);
    expect(soundSections(items, "zzz")).toEqual([]);
  });
  it("walks the shown items by key, skipping disabled ones", () => {
    const shown = flatItems(soundSections(items, ""));
    expect(stepActive(shown, null, "ArrowDown")).toBe("audio/music/explore.playlist.json");
    expect(stepActive(shown, "audio/sfx/dirt_01.wav", "ArrowDown")).toBe("boost.ogg");
    expect(stepActive(shown, "boost.ogg", "ArrowUp")).toBe("audio/sfx/dirt_01.wav");
    expect(stepActive(shown, "boost.ogg", "ArrowDown")).toBe("boost.ogg");
    expect(stepActive(shown, null, "End")).toBe("boost.ogg");
    expect(stepActive(shown, null, "x")).toBeNull();
    expect(stepActive([], null, "ArrowDown")).toBeNull();
  });
  it("badges each playlist type, a Blend by its axes, and samples", () => {
    expect((["queue", "switch", "layer", "clip", "sequence"] as const).map((t) => playlistBadge(t).code)).toEqual(["QUE", "SW", "LAY", "CLP", "SEQ"]);
    expect(playlistBadge("blend").code).toBe("1D");
    expect(playlistBadge("blend", 2)).toMatchObject({ code: "2D", name: "Blend playlist, two axes" });
    expect(sampleBadge().code).toBe("SMP");
    expect(new Set([...["queue", "switch", "layer", "clip", "sequence"].map((t) => playlistBadge(t as "queue").tone), playlistBadge("blend").tone, playlistBadge("blend", 2).tone, sampleBadge().tone]).size).toBe(8);
  });
  it("colours the badges as the ui-pass decisions say, and has a placeholder for an empty chip", () => {
    const tone = (t: Parameters<typeof playlistBadge>[0], axes?: 1 | 2) => playlistBadge(t, axes).tone;
    expect([tone("clip"), tone("queue"), tone("switch"), tone("blend"), tone("blend", 2), tone("sequence"), tone("layer")]).toEqual(["clip", "queue", "switch", "blend1", "blend2", "sequence", "layer"]);
    expect(placeholderBadge()).toMatchObject({ code: "—", name: "No sound", tone: "none" });
  });
});

describe("time axis and lanes", () => {
  it("maps time to x and back, zooms about a time within limits", () => {
    const axis = linearTimeAxis(10, 20, 500);
    expect(axis.toX(15)).toBe(250);
    expect(axis.toTime(100)).toBe(12);
    expect(linearTimeAxis(5, 5, 100).end).toBe(6);
    const z = zoomTimeAxis(axis, 2, 15, { min: 0, max: 30 });
    expect([z.start, z.end]).toEqual([12.5, 17.5]);
    const edge = zoomTimeAxis(axis, 0.1, 15, { min: 0, max: 30 });
    expect([edge.start, edge.end]).toEqual([0, 30]);
    expect(spanBox(axis.toX, 15, 15)).toEqual({ x: 250, width: 2 });
    expect(formatTime(4.2)).toBe("4.200 s");
    expect(formatTime(65.25)).toBe("1:05.250");
  });

  it("reads a value lane at a time, linear or held", () => {
    const pts = [{ t: 0, v: 0 }, { t: 2, v: 10 }, { t: 4, v: 4 }];
    expect(valueAt(pts, 1)).toBe(5);
    expect(valueAt(pts, 1, "step")).toBe(0);
    expect(valueAt(pts, -1)).toBe(0);
    expect(valueAt(pts, 9)).toBe(4);
    expect(valueAt([], 1)).toBeNull();
    expect(valueRange(pts)).toEqual([0, 10]);
    expect(valueRange(pts, null, 32)).toEqual([0, 32]);
    expect(valueRange([{ t: 0, v: 3 }])).toEqual([2.5, 3.5]);
    expect(valueRange(pts, [-60, 6])).toEqual([-60, 6]);
    expect(valueToY(10, [0, 10], 40)).toBe(2);
    expect(valueToY(0, [0, 10], 40)).toBe(38);
    expect(formatValue(-3.456, "dB", 1)).toBe("−3.5 dB");
    expect(formatValue(null)).toBe("—");
  });

  it("draws the polyline over the lane, stairs for held values, thinning dense series", () => {
    const axis = linearTimeAxis(0, 4, 400);
    const pts = [{ t: 0, v: 0 }, { t: 2, v: 10 }, { t: 4, v: 4 }];
    expect(lanePolyline(pts, axis.toX, [0, 10], 400, 40)).toBe("0,38 200,2 400,23.6");
    expect(lanePolyline(pts, axis.toX, [0, 10], 400, 40, "step")).toBe("0,38 200,38 200,2 400,2 400,23.6");
    const dense = Array.from({ length: 1000 }, (_, i) => ({ t: i / 1000, v: i % 2 }));
    const thin = lanePolyline(dense, linearTimeAxis(0, 1, 10).toX, [0, 1], 10, 40).split(" ");
    expect(thin.length).toBeLessThanOrEqual(40);
    // points past the lane are dropped, keeping one each side to carry the line
    const wide = lanePolyline([{ t: -10, v: 0 }, { t: -5, v: 0 }, { t: 1, v: 0 }, { t: 9, v: 0 }, { t: 20, v: 0 }], axis.toX, [0, 1], 400, 40);
    expect(wide.split(" ")).toHaveLength(3);
  });

  it("packs overlapping spans into rows and finds, steps and dims them", () => {
    const spans: Span[] = [
      { id: "a", start: 0, end: 2, status: "ok", label: "Boost" },
      { id: "b", start: 1, end: 3, status: "stolen", label: "Boost" },
      { id: "c", start: 2, end: null, held: { start: 2.5, end: null }, status: "blocked", label: "Boost" },
    ];
    const { rows, count } = packSpans(spans, 4);
    expect([rows.get("a"), rows.get("b"), rows.get("c"), count]).toEqual([0, 1, 0, 2]);
    const axis = linearTimeAxis(0, 4, 400);
    expect(spanBoxes(spans[2]!, axis.toX, 4)).toEqual({ x: 200, width: 200, held: { x: 250, width: 150 } });
    expect(spanBoxes({ ...spans[0]!, end: 0 }, axis.toX, 4).width).toBe(3);
    expect(spanAt(spans, 1.5, 4)?.id).toBe("b");
    expect(spanAt(spans, 9, 4)).toBeNull();
    expect(stepSpan(spans, "a", "ArrowRight")).toBe("b");
    expect(stepSpan(spans, "c", "ArrowRight")).toBe("c");
    expect(stepSpan(spans, null, "ArrowLeft")).toBe("c");
    expect(stepSpan(spans, "b", "Home")).toBe("a");
    expect(stepSpan(spans, "b", "q")).toBeNull();
    expect([isDimmed(spans[0]!, "problems"), isDimmed(spans[1]!, "problems"), isDimmed(spans[0]!, "all")]).toEqual([true, false, false]);
  });
});

describe("gain lanes", () => {
  const mix: GainInputs = {
    buses: [
      { name: "Master", parent: null, volumeDb: 0, mute: false },
      { name: "SFX", parent: "Master", volumeDb: -2, mute: false },
      { name: "Vehicles", parent: "SFX", volumeDb: -4, mute: false },
      { name: "Engine", parent: "Vehicles", volumeDb: -3, mute: false },
      { name: "Music", parent: "Master", volumeDb: -10, mute: false },
      { name: "Dialogue", parent: "Master", volumeDb: 0, mute: false },
    ],
    returns: [{ name: "Reverb", output: "Master", volumeDb: -3, mute: false }],
    vcas: [
      { name: "Gameplay SFX", volumeDb: -2, members: ["Vehicles", "SFX"] },
      { name: "Engines", volumeDb: -1, members: ["Engine"] },
    ],
  };

  it("sums the bus's lanes and the levels above it, each VCA once", () => {
    const b = gainBreakdown(mix, "Engine")!;
    expect(b.lanes.map((l) => l.key)).toEqual(["authored", "runtime", "snapshot", "vca", "monitor", "dip", "duck", "automation"]);
    const vca = b.lanes.find((l) => l.key === "vca")!;
    expect(vca).toMatchObject({ db: -3, note: "Gameplay SFX, Engines" });
    expect(b.ownDb).toBe(-6);
    expect(b.parents).toEqual([{ name: "Vehicles", db: -4 }, { name: "SFX", db: -2 }, { name: "Master", db: 0 }]);
    expect(b.totalDb).toBe(-12);
    expect(b.gain).toBeCloseTo(Math.pow(10, -12 / 20));
    expect(gainBreakdown(mix, "Nope")).toBeNull();
  });

  it("adds the shown snapshot's offset and the runtime's lanes", () => {
    const b = gainBreakdown({ ...mix, snapshot: { name: "Underwater", buses: { Music: -6, Master: -1 } }, live: { Music: { duck: -6, automation: -1.5 } } }, "Music")!;
    expect(b.lanes.find((l) => l.key === "snapshot")).toMatchObject({ db: -6, note: "Underwater" });
    expect(b.lanes.find((l) => l.key === "duck")!.db).toBe(-6);
    expect(b.totalDb).toBe(-10 - 6 - 6 - 1.5 - 1);
    expect(gainBreakdown({ ...mix, snapshot: { name: "U", buses: { Music: -6 } }, live: { Music: { snapshot: -3 } } }, "Music")!.lanes[2]!.db).toBe(-3);
  });

  it("silences for mute, the floor and solo, keeping the soloed line, Master and returns", () => {
    const muted = gainBreakdown({ ...mix, buses: mix.buses.map((b) => (b.name === "SFX" ? { ...b, mute: true } : b)) }, "Engine")!;
    expect(muted.totalDb).toBe(-Infinity);
    expect(muted.gain).toBe(0);
    const floor = gainBreakdown({ ...mix, buses: mix.buses.map((b) => (b.name === "Music" ? { ...b, volumeDb: -60 } : b)) }, "Music")!;
    expect(floor.lanes[0]).toMatchObject({ db: -Infinity, note: "at the floor" });
    const solo = { ...mix, solo: "Vehicles" };
    expect(gainBreakdown(solo, "Music")!.lanes.find((l) => l.key === "monitor")).toMatchObject({ db: -Infinity, note: "solo on Vehicles" });
    expect(["Master", "SFX", "Vehicles", "Engine", "Reverb"].map((n) => audibleUnderSolo(solo, n, "Vehicles"))).toEqual([true, true, true, true, true]);
    expect(audibleUnderSolo(solo, "Dialogue", "Vehicles")).toBe(false);
    expect(gainBreakdown(solo, "Reverb")!.totalDb).toBe(-3);
    // The spec's words (§4.3.5): stage names, who sets a lane, the chain above, the total with its linear gain.
    expect(gainBreakdown(mix, "Music")!.lanes.map((l) => l.label)).toEqual(["authored", "runtime", "snapshot", "vca", "monitor", "dip", "duck", "automation"]);
    expect(totalText(gainBreakdown(solo, "Music")!)).toBe("−∞ (monitor)");
    expect(totalText({ totalDb: -10, gain: Math.pow(10, -0.5), lanes: [] })).toBe("−10.0 dB · 0.32×");
    expect(parentsText({ parents: [{ name: "SFX", db: -2 }, { name: "Master", db: 0 }] })).toBe("SFX −2.0 · Master 0.0");
  });

  it("writes lanes and bars", () => {
    expect(laneBar(-20)).toEqual({ fill: 0.5, cut: true });
    expect(laneBar(-Infinity)).toEqual({ fill: 1, cut: true });
    expect(laneBar(80)).toEqual({ fill: 1, cut: false });
    expect(laneText({ db: 0, neutral: true })).toBe("neutral");
    expect(laneText({ db: -Infinity, neutral: false })).toBe("−∞");
    expect([dbText(2), dbText(-16), dbText(0)]).toEqual(["+2.0 dB", "−16.0 dB", "0.0 dB"]);
    expect([gainText(0), gainText(0.5)]).toEqual(["× 0", "× 0.500"]);
  });
});

describe("why it played", () => {
  const steps: CausalStep[] = [
    { kind: "game", name: "Land", why: "Velocity 118", severity: "ok" },
    { kind: "playlist", tag: "SW", name: "Bike impacts", why: "Surface → Metal", severity: "ok" },
    { kind: "sample", name: "land_hard_04.wav", why: "missing file", severity: "error" },
  ];
  it("zooms about a point within 25–250 % and pans", () => {
    const v = zoomAt(START_VIEW, 2, 100, 100);
    expect(v).toEqual({ x: -76, y: -76, s: 2 });
    expect(zoomAt(v, 10, 0, 0).s).toBe(2.5);
    expect(zoomAt(START_VIEW, 0.01, 0, 0).s).toBe(0.25);
  });
  it("answers keys and wheel turns", () => {
    const c = { x: 100, y: 50 };
    expect(chainKey(START_VIEW, "ArrowLeft", c)).toEqual({ x: 60, y: 12, s: 1 });
    expect(chainKey(START_VIEW, "ArrowDown", c)).toEqual({ x: 12, y: -36, s: 1 });
    expect((chainKey(START_VIEW, "+", c) as { s: number }).s).toBe(1.25);
    expect((chainKey({ x: 0, y: 0, s: 2 }, "1", c) as { s: number }).s).toBe(1);
    expect(chainKey(START_VIEW, "0", c)).toBe("fit");
    expect(chainKey(START_VIEW, "q", c)).toBeNull();
    expect(chainWheel(START_VIEW, { deltaX: 0, deltaY: 10, ctrl: false, shift: false, x: 0, y: 0 })).toEqual({ x: 12, y: 2, s: 1 });
    expect(chainWheel(START_VIEW, { deltaX: 0, deltaY: 10, ctrl: false, shift: true, x: 0, y: 0 })).toEqual({ x: 2, y: 12, s: 1 });
    expect(chainWheel(START_VIEW, { deltaX: 0, deltaY: -100, ctrl: true, shift: false, x: 0, y: 0 }).s).toBe(2.5);
  });
  it("fits the chain, stacks it in a narrow panel and summarises it", () => {
    expect(fitView({ width: 600, height: 200 }, { width: 300, height: 100 }, false)).toEqual({ x: 150, y: 50, s: 1 });
    expect(fitView({ width: 300, height: 200 }, { width: 1200, height: 100 }, false)).toMatchObject({ x: 0, s: 0.6 });
    expect(fitView({ width: 300, height: 200 }, { width: 1200, height: 100 }, true).s).toBe(0.25);
    expect(fitView({ width: 0, height: 0 }, { width: 10, height: 10 }, true)).toBe(START_VIEW);
    expect(shouldStack(7, 600)).toBe(true);
    expect(shouldStack(3, 600)).toBe(false);
    expect(shouldStack(1, 50)).toBe(false);
    expect(worstSeverity(steps)).toBe("error");
    expect(worstSeverity(steps.slice(0, 2))).toBe("ok");
    expect(chainText(steps.slice(0, 2))).toBe("game Land (Velocity 118), then playlist Bike impacts (Surface → Metal)");
  });
});

describe("Mixer rows (UI pass MX-30, MX-33)", () => {
  it("a collapsed card's summary is drawn only with room for it (otherwise it's on the tooltip, not cut to a letter)", () => {
    expect(SUMMARY_MIN_PX).toBe(60);
    expect(summaryFits(59)).toBe(false);
    expect(summaryFits(60)).toBe(true);
  });

  it("Ducked by is a menu: captioned, the current trigger checked, the ones that can't trigger disabled with why", () => {
    const chosen: string[] = [];
    const entries = triggerEntries([{ name: "Dialogue", disabled: null }, { name: "Weapons", disabled: "already" }, { name: "Music", disabled: null }], "Dialogue", (n) => chosen.push(n));
    expect(entries[0]).toEqual({ kind: "group", label: "Duck when this plays" });
    expect(entries.slice(1).map((e) => ("id" in e ? [e.id, e.checked, !!e.disabled, e.note ?? null] : null))).toEqual([
      ["Dialogue", true, false, null],
      ["Weapons", false, true, "already"],
      ["Music", false, false, null],
    ]);
    for (const e of entries) if ("run" in e && !e.disabled) e.run();
    expect(chosen).toEqual(["Music"]); // choosing the current one changes nothing
  });
});
