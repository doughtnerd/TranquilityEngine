// The Playlists screen's live and row models (UI pass wave 3): what the next trigger plays (previews), each entry's live
// level and the path down to a voice, the "this voice" cards and the parameters a playlist uses; the entry row's share
// of the picks, Voice summary and meta; a playlist effect's automation through the curve editor's result; "Move to
// playlist"; and turning 3D on (occlusion on, ADR 0162).
import { describe, expect, it } from "vitest";
import { defaultEntryUse, emptyPlaylistBody } from "../../../engine/audio/playlist/format";
import type { ParameterDef } from "../../../engine/audio/parameters";
import type { Entry, PlaylistBody } from "../../../engine/audio/playlist/types";
import { createDraft, draftResult } from "../../../editor/ui/curves/curveEditorModel";
import { setBy, setByMode, writeLayer } from "../../../editor/ui/curves/andByModel";
import { applyEffectAutomationResult, automatedNow, bypassLanes, clearLanes, effectAutomationDialog, pasteLanes } from "./effectAutomation";
import { entryMeta, shares, voiceSummary } from "./entryRowModel";
import { hoistEffect, sharedClipEffects } from "./hoistModel";
import { entryLevels, pathTo, previewCards, typeSummary, usedParameters, voiceCards } from "./liveModel";
import { setSpatial } from "./playlistEdits";

const params: ParameterDef[] = [
  { name: "Speed", min: 0, max: 1, default: 0.5, seekSpeed: 0 },
  { name: "Surface", labels: ["Dirt", "Metal"], default: "Dirt" },
];
const sample = (s: string, use: Partial<Entry> = {}): Entry => ({ kind: "sample", sample: s, trim: null, loop: "inherit", ...defaultEntryUse(), ...use }) as Entry;
const embed = (b: PlaylistBody, use: Partial<Entry> = {}): Entry => ({ kind: "embedded", embedded: b, ...defaultEntryUse(), ...use }) as Entry;
const clip = (s: string, effects: PlaylistBody["effects"] = []): Entry => embed({ ...emptyPlaylistBody("clip"), effects, entries: [sample(s)] });
const queue = (...entries: Entry[]): PlaylistBody => ({ ...emptyPlaylistBody("queue"), entries });
const none = () => null;
const ok = <T,>(r: { next: T } | { refused: string }): T => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};

/** A Switch on Surface: Dirt plays a Queue of two clips, Metal a sample. */
const surface = (): PlaylistBody => ({
  ...emptyPlaylistBody("switch"),
  entries: [embed(queue(clip("a/dirt_1.wav"), clip("a/dirt_2.wav"))), sample("a/metal.wav")],
  switch: { ...emptyPlaylistBody("switch").switch!, parameter: "Surface", map: { Dirt: 0, Metal: 1 }, labelGain: { Metal: -3 } },
});

describe("the next trigger's preview", () => {
  it("shows a Queue's pick of N, through a Switch label to what it plays", () => {
    expect(previewCards("Steps", surface(), params, {}, none)).toEqual([{ name: "Random pick · 1 of 2", kind: "queue", weight: 1, gainDb: 0, path: ["Steps", "Queue 1"] }]);
    const metal = previewCards("Steps", surface(), params, { Surface: 1 }, none);
    expect(metal).toMatchObject([{ name: "metal", kind: "sample", gainDb: -3, path: ["Steps", "metal"] }]);
  });

  it("is empty when nothing would play (a random Queue whose weights are all 0)", () => {
    expect(previewCards("q", queue(sample("x.wav", { weight: 0 })), params, {}, none)).toEqual([]);
  });

  it("lists a Blend's entries by weight at the test values", () => {
    const blend: PlaylistBody = { ...emptyPlaylistBody("blend"), entries: [sample("lo.wav", { x: 0 }), sample("hi.wav", { x: 1 })] };
    blend.blend = { ...blend.blend!, axes: [{ parameter: "Speed" }] };
    const cards = previewCards("b", blend, params, { Speed: 1 }, none);
    expect(cards.map((c) => [c.name, Math.round(c.weight * 100)])).toEqual([["hi", 100]]);
  });
});

describe("live levels and paths", () => {
  it("gives each entry the loudest voice playing one of its samples", () => {
    expect(entryLevels(surface(), [{ clip: "a/dirt_2.wav", gain: 0.6 }, { clip: "x.wav", gain: 1 }], none)).toEqual([0.6, 0]);
  });

  it("names the path from the open playlist down to a voice's sample", () => {
    expect(pathTo("Steps", surface(), "a/dirt_2.wav", none)).toEqual(["Steps", "Queue 1", "dirt_2"]);
    expect(pathTo("Steps", surface(), "a/metal.wav", none)).toEqual(["Steps", "metal"]);
  });
});

describe("the Inspector's header and \"this voice\" cards", () => {
  it("summarises the type and resolves a Switch's label to what it plays", () => {
    expect(typeSummary(surface())).toBe("Switch · Surface");
    const cards = voiceCards("Steps", surface(), params, { Surface: 1 }, null);
    expect(cards[0]).toMatchObject({ badge: "D", label: "Surface", value: "Metal", sub: "plays metal" });
    expect(cards[1]).toMatchObject({ badge: "T", value: "—", sub: "Trigger to run it" });
    expect(voiceCards("Steps", surface(), params, {}, 0.5)[1]).toMatchObject({ value: "0.50 s" });
  });

  it("knows the parameters a playlist uses, through what it plays", () => {
    const inner = queue(sample("x.wav", { curves: { gain: { input: { parameter: "Speed" }, curve: [[0, 0]], bypass: false } } }));
    expect([...usedParameters({ ...surface(), entries: [embed(inner)] }, none)].sort()).toEqual(["Speed", "Surface"]);
  });
});

describe("entry rows", () => {
  it("shares a random Queue's picks by weight", () => {
    expect(shares([{ weight: 1 }, { weight: 3 }, { weight: 0 }])).toEqual([0.25, 0.75, 0]);
    expect(shares([{ weight: 0 }])).toEqual([0]);
  });

  it("summarises the Voice button: the gain, set when it changes anything, shaped with running curves", () => {
    expect(voiceSummary({ volume: 0, pitch: 0, curves: {} })).toMatchObject({ text: "0 dB", set: false, shaped: false });
    const v = voiceSummary({ volume: -4, pitch: 0, curves: { gain: { input: "voiceTime", curve: [[0, 0]], bypass: true } } });
    expect(v).toMatchObject({ text: "−4 dB", set: true, shaped: false });
    expect(v.title).toMatch(/1 curve \(1 off\)/);
  });

  it("writes what an entry is after its name", () => {
    expect(entryMeta(clip("a/dirt_1.wav", [{ id: "fx1", type: "gain", on: true, params: {} }]), (clip("a/dirt_1.wav", [{ id: "fx1", type: "gain", on: true, params: {} }]) as { embedded: PlaylistBody }).embedded, () => 0.7)).toBe("Clip · 0.70 s · 1 effect");
    expect(entryMeta(embed(queue(sample("a.wav"), sample("b.wav"))), queue(sample("a.wav"), sample("b.wav")), none)).toBe("Queue · 2 entries");
  });
});

describe("a playlist effect's automation", () => {
  const fx = { id: "fx1", type: "lowpass" as const, on: true, params: { cutoff: 800 } };
  it("adds a lane for each changed parameter and removes one left flat at the effect's value", () => {
    const dialog = effectAutomationDialog(fx, [], params, {});
    expect(dialog.spec.lanes.map((l) => l.id)).toContain("fx:fx1:cutoff");
    const added = applyEffectAutomationResult(dialog, [], { kind: "time", lanes: [{ id: "fx:fx1:cutoff", curve: [[0, 800], [1, 200]], input: "param:Speed", bypass: false }] });
    expect(added?.label).toBe("Automate Cutoff · Low-pass");
    expect(added?.automation).toEqual([{ id: "a1", target: "fx:fx1:cutoff", input: { parameter: "Speed" }, curve: [[0, 800], [1, 200]], bypass: false }]);
    expect(automatedNow([fx], added!.automation, { Speed: 1 })).toEqual({ fx1: { cutoff: "200 Hz" } });
    const again = effectAutomationDialog(fx, added!.automation, params, {});
    const flat = applyEffectAutomationResult(again, added!.automation, { kind: "time", lanes: [{ id: "fx:fx1:cutoff", curve: [[0, 800]], input: "param:Speed", bypass: false }] });
    expect(flat?.automation).toEqual([]);
  });

  it("offers And by: Apply writes the lane's second input, reopens with it, and an untouched Apply changes nothing", () => {
    const dialog = effectAutomationDialog(fx, [], params, { Speed: 0.2 });
    expect(dialog.spec.secondInputs!.map((s) => [s.id, s.labels ?? null])).toEqual([["param:Speed", null], ["param:Surface", ["Dirt", "Metal"]]]);
    // A lane flat at the effect's value is kept while it follows a second input (here: Metal closes the filter).
    let draft = setBy(dialog.spec, createDraft(dialog.spec), "fx:fx1:cutoff", "param:Surface");
    draft = writeLayer(draft, "fx:fx1:cutoff", "label:Metal", [[0, 300], [2, 300]]);
    const r = applyEffectAutomationResult(dialog, [], draftResult(dialog.spec, draft))!;
    expect(r.label).toBe("Automate Cutoff · Low-pass");
    expect(r.automation).toHaveLength(1);
    expect(r.automation[0]).toMatchObject({ target: "fx:fx1:cutoff", input: "voiceTime", by: { input: "Surface", mode: "labels", labels: { Metal: [[0, 300], [2, 300]] } } });
    const again = effectAutomationDialog(fx, r.automation, params);
    expect(again.spec.lanes.find((l) => l.id === "fx:fx1:cutoff")!.by).toEqual({ input: "param:Surface", mode: "labels", labels: { Metal: [[0, 300], [2, 300]] } });
    expect(applyEffectAutomationResult(again, r.automation, draftResult(again.spec, createDraft(again.spec)))).toBeNull();
    // The card's "automated now" follows the second input's test value.
    expect(automatedNow([fx], r.automation, { Surface: 1 }, params)).toEqual({ fx1: { cutoff: "300 Hz" } });
    expect(automatedNow([fx], r.automation, { Surface: 0 }, params)).toEqual({ fx1: { cutoff: "800 Hz" } });
    // Changing only the second input is a change; Nothing leaves a flat lane, which goes.
    const scaled = writeLayer(setByMode(again.spec, setBy(again.spec, createDraft(again.spec), "fx:fx1:cutoff", "param:Speed"), "fx:fx1:cutoff", "scale"), "fx:fx1:cutoff", "scale", [[0, 1], [1, 0.5]]);
    expect(applyEffectAutomationResult(again, r.automation, draftResult(again.spec, scaled))!.automation[0]!.by).toEqual({ input: "Speed", mode: "scale", curve: [[0, 1], [1, 0.5]] });
    const nothing = setBy(again.spec, createDraft(again.spec), "fx:fx1:cutoff", null);
    expect(applyEffectAutomationResult(again, r.automation, draftResult(again.spec, nothing))!.automation).toEqual([]); // flat at the effect's value again
  });

  it("turns lanes off and on, clears them, and pastes another effect's onto the parameters it has", () => {
    const lanes = [{ id: "a1", target: "fx:fx1:cutoff" as const, input: "voiceTime" as const, curve: [[0, 800]] as [number, number][], bypass: false }];
    expect(bypassLanes(lanes, "fx1", true)[0]!.bypass).toBe(true);
    expect(clearLanes(lanes, "fx1")).toEqual([]);
    const other = { id: "fx2", type: "highpass" as const, on: true, params: {} };
    expect(pasteLanes([], lanes, other)?.map((a) => a.target)).toEqual(["fx:fx2:cutoff"]);
    expect(pasteLanes([], lanes, { id: "fx3", type: "reverb", on: true, params: {} })).toBeNull();
  });
});

describe("Move to playlist", () => {
  const dist = (id: string) => ({ id, type: "distortion" as const, on: true, params: { drive: 0.3, mix: 100 } });
  it("offers an effect every clip has, and moves it to the playlist's chain in one step", () => {
    const b = queue(clip("a.wav", [dist("fx1")]), clip("b.wav", [dist("fx4")]));
    expect(sharedClipEffects(b).map((e) => e.type)).toEqual(["distortion"]);
    const next = ok(hoistEffect(b, sharedClipEffects(b)[0]!));
    expect(next.effects.map((e) => e.type)).toEqual(["distortion"]);
    expect(next.entries.every((e) => e.kind === "embedded" && e.embedded.effects.length === 0)).toBe(true);
    expect(sharedClipEffects(queue(clip("a.wav", [dist("fx1")]), sample("b.wav")))).toEqual([]);
  });
});

describe("3D", () => {
  it("turns occlusion on when a flat playlist becomes spatial (ADR 0162)", () => {
    expect(ok(setSpatial(emptyPlaylistBody("queue"), {})).spatial?.occlusion).toBe(true);
    // An explicit choice stays.
    expect(ok(setSpatial(emptyPlaylistBody("queue"), { occlusion: false })).spatial?.occlusion).toBe(false);
  });
});
