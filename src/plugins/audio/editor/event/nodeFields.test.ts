// L6.3b: the Event editor's field descriptors (nodeFields.ts). Defaults are checked against what parseAudioEvent reads.
import { describe, it, expect } from "vitest";
import { formatAudioEvent, parseAudioEvent, type AudioEventAsset, type BlendNode, type EventNode, type RandomNode, type SustainNode, type SwitchNode } from "../../../../engine/audio/eventFormat";
import {
  coerceField, eventFields, findField, nodeFields, readField, writeField, type FieldDescriptor, type GroupField, type AuxSend,
} from "./nodeFields";

const clip = (extra: Record<string, unknown> = {}) => ({ type: "clip", clip: "a.ogg", ...extra });
const parseRoot = (root: unknown): EventNode => parseAudioEvent({ format: "myco.audioevent@1", root }).value.root;
const parseEvent = (extra: Record<string, unknown> = {}): AudioEventAsset =>
  parseAudioEvent({ format: "myco.audioevent@1", root: clip(), ...extra }).value;

const names = (fields: readonly FieldDescriptor[]): string[] => fields.map((f) => f.name);
const need = (fields: readonly FieldDescriptor[], name: string): FieldDescriptor => {
  const f = findField(fields, name);
  if (!f) throw new Error(`no field "${name}"`);
  return f;
};

/** Every non-optional, non-group field of the list has a default equal to the parsed node's value for its key. */
function expectDefaultsMatch(node: EventNode, parent: EventNode | null): void {
  for (const f of nodeFields(node, parent)) {
    // The test nodes name a clip and a parameter, so those fields are not at their defaults; the tests below cover them.
    if (f.kind === "curves" || f.kind === "group" || f.kind === "asset" || f.kind === "parameter") continue;
    if ((f.kind === "range" || f.kind === "text") && f.optional) continue;
    expect(readField(node, f), f.name).toEqual(f.default);
  }
}

describe("nodeFields", () => {
  it("clip: clip asset first, then loop, startOffset, loopRegion (optional), sustain, then the common fields, automation last", () => {
    const fields = nodeFields(parseRoot(clip()), null);
    expect(names(fields)).toEqual([
      "clip", "loop", "startOffset", "loopRegion", "sustain",
      "volume", "pitch", "volumeRandom", "pitchRandom", "delay", "automation",
    ]);
    expect(fields[0]).toMatchObject({ kind: "asset", assetKind: "audio", default: "" });
    expect(need(fields, "loopRegion")).toMatchObject({ kind: "range", optional: true, default: [0, 1] });
  });

  it("random: avoidRepeat max is children - 1 (0 with none), mode, gap only when continuous", () => {
    const step = parseRoot({ type: "random", children: [clip(), clip({ clip: "b.ogg" }), clip({ clip: "c.ogg" })] });
    const stepFields = nodeFields(step, null);
    expect(need(stepFields, "avoidRepeat")).toMatchObject({ max: 2, integer: true, default: 0 });
    expect(names(stepFields).slice(0, 2)).toEqual(["avoidRepeat", "mode"]);
    expect(names(stepFields)).not.toContain("gap");

    const cont = parseRoot({ type: "random", mode: "continuous", children: [clip()] });
    const contFields = nodeFields(cont, null);
    expect(names(contFields).slice(0, 3)).toEqual(["avoidRepeat", "mode", "gap"]);
    expect(need(contFields, "gap")).toMatchObject({ min: -10, max: 60, default: 0 });

    const none = parseRoot({ type: "random", children: [] });
    expect(need(nodeFields(none, null), "avoidRepeat")).toMatchObject({ max: 0 });
  });

  it("sequence: mode, loop only when continuous, reset only when step, gap only when continuous", () => {
    const step = nodeFields(parseRoot({ type: "sequence", children: [clip()] }), null);
    expect(names(step).slice(0, 2)).toEqual(["mode", "reset"]);
    expect(need(step, "reset")).toMatchObject({ min: 0, max: 1e6, default: 0 });

    const cont = nodeFields(parseRoot({ type: "sequence", mode: "continuous", loop: true, children: [clip()] }), null);
    expect(names(cont).slice(0, 3)).toEqual(["mode", "loop", "gap"]);
    expect(names(cont)).not.toContain("reset");
    expect(need(cont, "loop")).toMatchObject({ kind: "boolean", default: false });
  });

  it("switch: labelled parameter first, default (optional text), onChange, crossfade only when crossfade", () => {
    const keep = nodeFields(parseRoot({ type: "switch", parameter: "Surface", children: [clip({ value: "Grass" })] }), null);
    expect(names(keep).slice(0, 3)).toEqual(["parameter", "default", "onChange"]);
    expect(keep[0]).toMatchObject({ kind: "parameter", labelled: true, default: "" });
    expect(need(keep, "default")).toMatchObject({ kind: "text", optional: true });
    expect(names(keep)).not.toContain("crossfade");

    const fade = nodeFields(parseRoot({ type: "switch", parameter: "Surface", onChange: "crossfade", children: [clip()] }), null);
    expect(need(fade, "crossfade")).toMatchObject({ min: 0, max: 10, step: 0.01, default: 0.1 });
  });

  it("blend: parameter; layer: no own fields", () => {
    const blend = nodeFields(parseRoot({ type: "blend", parameter: "Speed", children: [clip({ range: [0, 1] })] }), null);
    expect(blend[0]).toMatchObject({ name: "parameter", kind: "parameter", default: "" });
    expect(blend[0].kind === "parameter" && blend[0].labelled).toBeFalsy();

    const layer = nodeFields(parseRoot({ type: "layer", children: [clip()] }), null);
    expect(names(layer)).toEqual(["volume", "pitch", "volumeRandom", "pitchRandom", "delay", "automation"]);
  });

  it("sustain: release; releaseFade only when release is now; fade only under a blend", () => {
    const loopEnd = nodeFields(parseRoot({ type: "sustain", loop: clip() }), null);
    expect(names(loopEnd).slice(0, 1)).toEqual(["release"]);
    expect(names(loopEnd)).not.toContain("releaseFade");
    expect(names(loopEnd)).not.toContain("fade");
    expect(need(loopEnd, "release")).toMatchObject({ options: ["now", "loopEnd"], default: "loopEnd" });

    const now = nodeFields(parseRoot({ type: "sustain", release: "now", loop: clip() }), null);
    expect(names(now).slice(0, 2)).toEqual(["release", "releaseFade"]);
    expect(names(now)).not.toContain("fade");
    expect(need(now, "releaseFade")).toMatchObject({
      kind: "number", label: "Release crossfade", min: 0, max: 1e6, step: 0.01, default: 0,
      help: "seconds of crossfade from the loop into the end on release",
    });
  });

  it("release now lists releaseFade defaulting to the node's current release crossfade", () => {
    const node = parseRoot({ type: "sustain", release: "now", fade: 0.5, loop: clip() }) as SustainNode;
    expect(need(nodeFields(node, null), "releaseFade")).toMatchObject({ default: 0.5 });
    expect(readField(node, need(nodeFields(node, null), "releaseFade"))).toBe(0.5);
  });

  it("reading releaseFade falls back to fade when the key is absent, and reads releaseFade when set", () => {
    const absent = parseRoot({ type: "sustain", release: "now", fade: 0.25, loop: clip() }) as SustainNode;
    expect(absent.releaseFade).toBeUndefined();
    expect(readField(absent, need(nodeFields(absent, null), "releaseFade"))).toBe(0.25);

    const set = parseRoot({ type: "sustain", release: "now", fade: 0.25, releaseFade: 2, loop: clip() }) as SustainNode;
    expect(readField(set, need(nodeFields(set, null), "releaseFade"))).toBe(2);
  });

  it("writing releaseFade sets releaseFade without touching fade", () => {
    const node = parseRoot({ type: "sustain", release: "now", fade: 0.25, loop: clip() }) as SustainNode;
    const field = need(nodeFields(node, null), "releaseFade");
    const written = writeField(node, field, 1.5);
    expect(written.releaseFade).toBe(1.5);
    expect(written.fade).toBe(0.25);
    expect(node.releaseFade).toBeUndefined();
    expect(readField(written, field)).toBe(1.5);
  });

  it("parent-given fields: weight under random, value under switch, range and fade under blend, none at the root", () => {
    const random = parseRoot({ type: "random", children: [clip()] }) as RandomNode;
    expect(names(nodeFields(random.children[0], random))).toContain("weight");
    expect(need(nodeFields(random.children[0], random), "weight")).toMatchObject({ default: 1 });
    expect(names(nodeFields(random.children[0], null))).not.toContain("weight");

    const sw = parseRoot({ type: "switch", parameter: "S", children: [clip({ value: "A" })] }) as SwitchNode;
    expect(need(nodeFields(sw.children[0], sw), "value")).toMatchObject({ kind: "text", optional: true, default: "" });

    const blend = parseRoot({ type: "blend", parameter: "P", children: [clip({ range: [0, 0.5] })] }) as BlendNode;
    const bf = nodeFields(blend.children[0], blend);
    expect(names(bf).slice(-3)).toEqual(["range", "fade", "automation"]);
    expect(need(bf, "range")).toMatchObject({ optional: true, min: -1e6, max: 1e6, default: [0, 1] });
    expect(need(bf, "fade")).toMatchObject({ default: 0 });

    const root = nodeFields(parseRoot(clip()), null);
    for (const n of ["weight", "value", "range", "fade"]) expect(names(root)).not.toContain(n);
  });

  it("a sustain under a blend lists both releaseFade (when release is now) and the blend fade", () => {
    const now = parseRoot({ type: "blend", parameter: "P", children: [{ type: "sustain", release: "now", loop: clip(), range: [0, 1], fade: 0.3 }] }) as BlendNode;
    const nowFields = nodeFields(now.children[0], now);
    expect(names(nowFields).slice(0, 2)).toEqual(["release", "releaseFade"]);
    expect(names(nowFields).filter((n) => n === "fade")).toHaveLength(1);
    expect(need(nowFields, "fade")).toMatchObject({ label: "Fade", default: 0 });
    expect(need(nowFields, "releaseFade").label).toBe("Release crossfade");
    expect(names(nowFields).slice(-3)).toEqual(["range", "fade", "automation"]);

    const loopEnd = parseRoot({ type: "blend", parameter: "P", children: [{ type: "sustain", loop: clip(), range: [0, 1] }] }) as BlendNode;
    const loopEndFields = nodeFields(loopEnd.children[0], loopEnd);
    expect(names(loopEndFields)).not.toContain("releaseFade");
    expect(names(loopEndFields).filter((n) => n === "fade")).toHaveLength(1);
    expect(need(loopEndFields, "fade").label).toBe("Fade");
  });

  it("limits match parseAudioEvent's (volume 0..4, pitch 0.0625..16, volumeRandom -96..24, pitchRandom -48..48, delay 0..60)", () => {
    const fields = nodeFields(parseRoot(clip()), null);
    expect(need(fields, "volume")).toMatchObject({ min: 0, max: 4, step: 0.01, default: 1 });
    expect(need(fields, "pitch")).toMatchObject({ min: 0.0625, max: 16, step: 0.01, default: 1 });
    expect(need(fields, "volumeRandom")).toMatchObject({ min: -96, max: 24, step: 0.5, default: [0, 0] });
    expect(need(fields, "pitchRandom")).toMatchObject({ min: -48, max: 48, step: 0.1, default: [0, 0] });
    expect(need(fields, "delay")).toMatchObject({ min: 0, max: 60, step: 0.01, default: 0 });
  });

  it("every descriptor default equals parseAudioEvent's default for that key", () => {
    expectDefaultsMatch(parseRoot(clip()), null);
    // Each node is left at its defaults, so every field (including the mode-dependent ones) is checked against the parser.
    const random = parseRoot({ type: "random", children: [clip(), clip({ clip: "b.ogg" })] }) as RandomNode;
    expectDefaultsMatch(random, null);
    expectDefaultsMatch(random.children[0], random);
    const sequence = parseRoot({ type: "sequence", children: [clip()] }) as EventNode;
    expectDefaultsMatch(sequence, null);
    const sw = parseRoot({ type: "switch", parameter: "S", children: [clip({ value: "A" })] }) as SwitchNode;
    expectDefaultsMatch(sw, null);
    expectDefaultsMatch(sw.children[0], sw);
    const blend = parseRoot({ type: "blend", parameter: "P", children: [clip({ range: [0, 1] })] }) as BlendNode;
    expectDefaultsMatch(blend.children[0], blend);
    const sustain = parseRoot({ type: "sustain", loop: clip() }) as SustainNode;
    expectDefaultsMatch(sustain, null);
    const bare = parseRoot({ type: "switch", children: [] }) as SwitchNode;
    expect(readField(bare, need(nodeFields(bare, null), "parameter"))).toBe("");
    const continuous = parseRoot({ type: "sequence", mode: "continuous", loop: true, children: [clip()] }) as EventNode;
    expect(readField(continuous, need(nodeFields(continuous, null), "mode"))).toBe("continuous");
  });

  it("names unique within a list and every field has a label and help", () => {
    const check = (fields: readonly FieldDescriptor[]): void => {
      expect(new Set(names(fields)).size, names(fields).join(",")).toBe(fields.length);
      for (const f of fields) {
        expect(f.label.length, f.name).toBeGreaterThan(0);
        expect(f.help.length, f.name).toBeGreaterThan(0);
        if (f.kind === "group") check(f.fields);
      }
    };
    const root = parseRoot({ type: "random", children: [clip()] }) as RandomNode;
    check(nodeFields(root, null));
    check(nodeFields(root.children[0], root));
    check(eventFields());
  });
});

describe("eventFields", () => {
  it("lists bus, volume, pitch, volumeRandom, pitchRandom, priority, spatial, limit, cooldown, automation in order", () => {
    expect(names(eventFields())).toEqual([
      "bus", "volume", "pitch", "volumeRandom", "pitchRandom", "priority", "spatial", "filter", "sends", "limit", "cooldown", "automation",
    ]);
  });

  it("spatial is an optional group with minDistance, maxDistance, rolloff; limit a required group", () => {
    const spatial = need(eventFields(), "spatial") as GroupField;
    expect(spatial).toMatchObject({ kind: "group", optional: true });
    expect(names(spatial.fields)).toEqual(["minDistance", "maxDistance", "rolloff", "occlusion", "dopplerLevel", "reverbSendCurve"]);
    const limit = need(eventFields(), "limit") as GroupField;
    expect(limit.kind).toBe("group");
    expect(limit.optional).toBeFalsy();
    expect(names(limit.fields)).toEqual(["maxInstances", "steal"]);
  });

  it("priority is an integer 0..255, maxInstances an integer 0..4096, cooldown 0..60", () => {
    expect(need(eventFields(), "priority")).toMatchObject({ integer: true, min: 0, max: 255, default: 128 });
    const limit = need(eventFields(), "limit") as GroupField;
    expect(need(limit.fields, "maxInstances")).toMatchObject({ integer: true, min: 0, max: 4096, default: 0 });
    expect(need(eventFields(), "cooldown")).toMatchObject({ min: 0, max: 60, default: 0 });
  });

  it("defaults equal parseAudioEvent's, groups included", () => {
    const event = parseEvent();
    for (const f of eventFields()) {
      if (f.kind === "curves" || f.kind === "group") continue;
      expect(readField(event, f), f.name).toEqual(f.default);
    }
    const limit = need(eventFields(), "limit") as GroupField;
    expect(readField(event, limit)).toEqual(limit.default);
    const spatial = need(eventFields(), "spatial") as GroupField;
    expect(readField(parseEvent({ spatial: {} }), spatial)).toEqual(spatial.default);
    expect(spatial.default).toEqual({ minDistance: 1, maxDistance: 100, rolloff: "inverse" });
  });
});

describe("field values", () => {
  it("findField finds by name at the top level", () => {
    expect(findField(eventFields(), "priority")?.kind).toBe("number");
    expect(findField(eventFields(), "nope")).toBeUndefined();
    expect(findField(eventFields(), "maxInstances")).toBeUndefined();
  });

  it("readField reads a key, undefined when absent", () => {
    const node = parseRoot(clip({ loopRegion: [0, 2] }));
    expect(readField(node, need(nodeFields(node, null), "loopRegion"))).toEqual([0, 2]);
    const bare = parseRoot(clip());
    expect(readField(bare, need(nodeFields(bare, null), "loopRegion"))).toBeUndefined();
  });

  it("writeField copies, sets, removes an optional key on undefined, never mutates", () => {
    const node = parseRoot(clip({ loopRegion: [0, 2], loop: false }));
    const fields = nodeFields(node, null);
    const loop = need(fields, "loop");

    const set = writeField(node, loop, true);
    expect(set).not.toBe(node);
    expect(readField(set, loop)).toBe(true);
    expect(readField(node, loop)).toBe(false);

    const removed = writeField(node, need(fields, "loopRegion"), undefined);
    expect("loopRegion" in removed).toBe(false);
    expect(readField(node, need(fields, "loopRegion"))).toEqual([0, 2]);
  });

  it("writeField gives a required field its default on undefined", () => {
    const node = parseRoot(clip({ loop: true, volumeRandom: [-3, 3] }));
    const fields = nodeFields(node, null);
    expect(readField(writeField(node, need(fields, "loop"), undefined), need(fields, "loop"))).toBe(false);
    expect(readField(writeField(node, need(fields, "volumeRandom"), undefined), need(fields, "volumeRandom"))).toEqual([0, 0]);
  });

  it("coerceField: number clamp, integer rounding, non-finite to default", () => {
    const volume = need(nodeFields(parseRoot(clip()), null), "volume");
    expect(coerceField(volume, 9)).toBe(4);
    expect(coerceField(volume, -1)).toBe(0);
    expect(coerceField(volume, "0.5")).toBe(0.5);
    expect(coerceField(volume, NaN)).toBe(1);
    expect(coerceField(volume, Infinity)).toBe(1);
    expect(coerceField(volume, "abc")).toBe(1);

    const priority = need(eventFields(), "priority");
    expect(coerceField(priority, 12.6)).toBe(13);
    expect(coerceField(priority, 300)).toBe(255);
  });

  it("coerceField: range clamp and swap, optional undefined stays undefined", () => {
    const volumeRandom = need(eventFields(), "volumeRandom");
    expect(coerceField(volumeRandom, [30, -200])).toEqual([-96, 24]);
    expect(coerceField(volumeRandom, [5, -5])).toEqual([-5, 5]);
    expect(coerceField(volumeRandom, undefined)).toEqual([0, 0]);

    const loopRegion = need(nodeFields(parseRoot(clip()), null), "loopRegion");
    expect(coerceField(loopRegion, undefined)).toBeUndefined();
    expect(coerceField(loopRegion, [2, 1])).toEqual([1, 2]);
  });

  it("coerceField: select falls back to default, asset drops asset:, optional text maps empty to undefined, boolean", () => {
    const onChange = need(nodeFields(parseRoot({ type: "switch", parameter: "S", children: [clip({ value: "A" })] }), null), "onChange");
    expect(coerceField(onChange, "bogus")).toBe("keep");
    expect(coerceField(onChange, "crossfade")).toBe("crossfade");

    const asset = need(nodeFields(parseRoot(clip()), null), "clip");
    expect(coerceField(asset, "asset:sfx/a.ogg")).toBe("sfx/a.ogg");

    const value = need(nodeFields(parseRoot({ type: "switch", parameter: "S", children: [clip({ value: "A" })] }), null), "default");
    expect(coerceField(value, "")).toBeUndefined();
    expect(coerceField(value, "Grass")).toBe("Grass");

    const loop = need(nodeFields(parseRoot(clip()), null), "loop");
    expect(coerceField(loop, true)).toBe(true);
    expect(coerceField(loop, "yes")).toBe(false);
  });
});

// ADR 0162 §2.5 (E5): filter, sends and the spatial additions, through edit -> serialise -> parse.
describe("filter, sends and spatial additions (ADR 0162 §2.5)", () => {
  const root = (e: AudioEventAsset, name: string) => need(eventFields(), name) as GroupField;
  const field = (g: GroupField, name: string) => need(g.fields, name);
  /** Serialise and parse again, as a save followed by a load does. */
  const roundTrip = (e: AudioEventAsset): AudioEventAsset => {
    const out = parseAudioEvent(JSON.parse(formatAudioEvent(e)));
    expect(out.problems).toEqual([]);
    return out.value;
  };
  /** One edit as the panel makes it: coerce the widget value, write it into the group, write the group into the event. */
  const edit = (e: AudioEventAsset, group: string, name: string, raw: unknown): AudioEventAsset => {
    const g = root(e, group);
    const f = field(g, name);
    const current = (readField(e, g) as Record<string, unknown> | undefined) ?? {};
    return writeField(e, g, writeField(current, f, coerceField(f, raw)));
  };

  it("filter: the fields have the parser's limits and an off end", () => {
    const g = root(parseEvent(), "filter");
    expect(g).toMatchObject({ kind: "group", implicit: true });
    expect(field(g, "lowpass")).toMatchObject({ kind: "number", min: 10, max: 24000, optional: true, offAtOrAbove: 20000 });
    expect(field(g, "highpass")).toMatchObject({ kind: "number", min: 10, max: 24000, optional: true, offAtOrBelow: 20 });
  });

  it("filter round trips; an off value or an empty input removes the key, and the last key removes the object", () => {
    let e = parseEvent();
    e = edit(e, "filter", "lowpass", 9000);
    e = edit(e, "filter", "highpass", 80);
    expect(roundTrip(e).filter).toEqual({ lowpass: 9000, highpass: 80 });
    e = edit(e, "filter", "lowpass", 20000);
    expect(roundTrip(e).filter).toEqual({ highpass: 80 });
    e = edit(e, "filter", "highpass", 20);
    expect(e.filter).toBeUndefined();
    expect(formatAudioEvent(e)).not.toContain("filter");
    expect(roundTrip(e).filter).toBeUndefined();
    // Out of range clamps as the parser does.
    e = edit(e, "filter", "lowpass", 5);
    expect(roundTrip(e).filter).toEqual({ lowpass: 10 });
  });

  it("sends: reverb 0..2 (1 is the default and removes the key), one aux bus with a 0..2 level", () => {
    const g = root(parseEvent(), "sends");
    expect(names(g.fields)).toEqual(["reverb", "aux"]);
    expect(field(g, "reverb")).toMatchObject({ min: 0, max: 2, default: 1, optional: true });
    let e = parseEvent();
    e = edit(e, "sends", "reverb", 0.5);
    e = edit(e, "sends", "aux", { bus: "Cave", level: 0.3 });
    expect(e.sends).toEqual({ reverb: 0.5, Cave: 0.3 });
    expect(roundTrip(e).sends).toEqual({ reverb: 0.5, Cave: 0.3 });
    expect(readField(e.sends!, field(g, "aux"))).toEqual({ bus: "Cave", level: 0.3 } satisfies AuxSend);
    // Changing the bus replaces the aux send rather than adding a second one.
    e = edit(e, "sends", "aux", { bus: "Radio", level: 5 });
    expect(roundTrip(e).sends).toEqual({ reverb: 0.5, Radio: 2 });
    // Reset: no aux, reverb back to 1, and then no sends at all.
    e = edit(e, "sends", "aux", undefined);
    expect(e.sends).toEqual({ reverb: 0.5 });
    e = edit(e, "sends", "reverb", 1);
    expect(e.sends).toBeUndefined();
    expect(roundTrip(e).sends).toBeUndefined();
    // "reverb" is the reverb key, never a bus.
    expect(coerceField(field(g, "aux"), { bus: "reverb", level: 1 })).toBeUndefined();
  });

  it("spatial additions: occlusion, dopplerLevel and reverbSendCurve round trip and reset to absent", () => {
    const g = root(parseEvent(), "spatial");
    expect(field(g, "dopplerLevel")).toMatchObject({ min: 0, max: 5, default: 0, optional: true });
    expect(field(g, "occlusion")).toMatchObject({ kind: "boolean", default: true, optional: true });
    expect(field(g, "reverbSendCurve")).toMatchObject({ kind: "curve", default: [[0, 1], [1, 0.5]] });

    let e = parseEvent({ spatial: {} });
    e = edit(e, "spatial", "occlusion", false);
    e = edit(e, "spatial", "dopplerLevel", 2.5);
    e = edit(e, "spatial", "reverbSendCurve", [[0, 1], [0.5, 0.2], [1, 0]]);
    expect(roundTrip(e).spatial).toMatchObject({ occlusion: false, dopplerLevel: 2.5, reverbSendCurve: [[0, 1], [0.5, 0.2], [1, 0]] });
    expect(roundTrip(e).spatial!.minDistance).toBe(1);
    // Out of range clamps.
    expect(roundTrip(edit(e, "spatial", "dopplerLevel", 9)).spatial!.dopplerLevel).toBe(5);

    e = edit(e, "spatial", "occlusion", true);
    e = edit(e, "spatial", "dopplerLevel", 0);
    e = edit(e, "spatial", "reverbSendCurve", [[0, 1], [1, 0.5]]);
    expect(Object.keys(e.spatial!).sort()).toEqual(["maxDistance", "minDistance", "rolloff"]);
    const text = formatAudioEvent(e);
    for (const key of ["occlusion", "dopplerLevel", "reverbSendCurve"]) expect(text).not.toContain(key);
    // Writing undefined (the reset button) removes a set key too.
    const withDoppler = edit(e, "spatial", "dopplerLevel", 1);
    const spatial = root(withDoppler, "spatial");
    expect(writeField(withDoppler.spatial!, field(spatial, "dopplerLevel"), undefined)).not.toHaveProperty("dopplerLevel");
  });

  it("a flat event keeps filter and sends; turning spatial off drops the spatial keys with it", () => {
    let e = parseEvent({ spatial: {}, filter: { lowpass: 5000 }, sends: { Cave: 1 } });
    e = edit(e, "spatial", "dopplerLevel", 1);
    const spatial = root(e, "spatial");
    e = writeField(e, spatial, undefined);
    expect(e.spatial).toBeUndefined();
    expect(roundTrip(e)).toMatchObject({ filter: { lowpass: 5000 }, sends: { Cave: 1 } });
  });
});
