// ADR 0299: the one list of the places an audio event names a parameter or a bus, and the one rewrite.
import { describe, expect, it } from "vitest";
import { formatAudioEvent, parseAudioEvent } from "./eventFormat";
import { eventNameReferences, renameEventName, rewriteEventReference, type EventNameReference } from "./eventReferences";

const curve = [[0, 0], [1, 1]];
/** A 0158 event: a local "Speed", a global "Wind", a bus, an aux send beside the reverb send. */
const EVENT = {
  format: "myco.audioevent@1",
  bus: "SFX",
  sends: { reverb: 0.5, Hall: 0.3 },
  parameters: [{ name: "Speed", min: 0, max: 1, default: 0, seekSpeed: 0 }],
  automation: [{ parameter: "Speed", target: "volume", curve }],
  root: {
    type: "layer",
    children: [
      { type: "switch", parameter: "Wind", children: [{ type: "clip", clip: "a.ogg", value: "On", automation: [{ parameter: "Wind", target: "pitch", curve }] }] },
      { type: "blend", parameter: "Speed", children: [] },
      { type: "sustain", start: { type: "clip", clip: "s.ogg", automation: [{ parameter: "Speed", target: "lowpass", curve }] }, loop: { type: "clip", clip: "l.ogg" } },
      { type: "clip", clip: "x.ogg", bus: "UI" }, // a clip names no bus: the key means nothing
    ],
  },
};
/** A music event as written (its tree under `root`): a music switch over a segment, a stinger, a library segment. */
const MUSIC = {
  format: "myco.audioevent@1",
  bus: "Music",
  parameters: [{ name: "State", labels: ["Calm", "Fight"], default: "Calm" }],
  root: {
    type: "musicSwitch", id: "sw", parameter: "State",
    stingers: [{ trigger: "hit", segment: "riser", bus: "Stingers" }],
    children: [{
      type: "segment", id: "calm", value: "Calm",
      automation: [{ parameter: "Ignored", target: "volume", curve }], // a music node's own automation is not read: it names nothing
      tracks: [{ clip: "m.ogg", bus: "Drums", automation: [{ parameter: "Intensity", target: "volume", curve }] }, { clip: "n.ogg", bus: "" }],
      regions: [{ id: "r", from: "1:1:0", to: "2:1:0", while: { parameter: "Boss", is: "alive" } }],
    }],
    library: [{ type: "segment", id: "riser", tracks: [{ clip: "r.ogg", bus: "FX" }] }],
  },
};

const rows = (refs: EventNameReference[]) => refs.map((r) => [r.kind, r.name, r.where.join("/") + (r.key ? " (key)" : ""), r.scope]);

describe("event name references (ADR 0299)", () => {
  it("lists every parameter and bus an event names, in file order, local or global", () => {
    expect(rows(eventNameReferences(EVENT))).toEqual([
      ["bus", "SFX", "bus", "global"],
      ["bus", "Hall", "sends/Hall (key)", "global"], // never `reverb`: the event's own send
      ["parameter", "Speed", "automation/0/parameter", "local"],
      ["parameter", "Wind", "root/children/0/parameter", "global"],
      ["parameter", "Wind", "root/children/0/children/0/automation/0/parameter", "global"],
      ["parameter", "Speed", "root/children/1/parameter", "local"],
      ["parameter", "Speed", "root/children/2/start/automation/0/parameter", "local"],
    ]);
    expect(rows(eventNameReferences(MUSIC))).toEqual([
      ["bus", "Music", "bus", "global"],
      ["parameter", "State", "root/parameter", "local"],
      ["bus", "Stingers", "root/stingers/0/bus", "global"],
      ["bus", "Drums", "root/children/0/tracks/0/bus", "global"],
      ["parameter", "Intensity", "root/children/0/tracks/0/automation/0/parameter", "global"],
      ["parameter", "Boss", "root/children/0/regions/0/while/parameter", "global"],
      ["bus", "FX", "root/library/0/tracks/0/bus", "global"],
    ]);
  });

  it("reads the parsed asset the same way, its music tree under musicRoot", () => {
    const parsed = parseAudioEvent(MUSIC).value;
    expect(rows(eventNameReferences(parsed)).filter(([, , where]) => where !== "bus")).toEqual(
      rows(eventNameReferences(MUSIC)).filter(([, , where]) => where !== "bus").map(([k, n, w, s]) => [k, n, (w as string).replace(/^root/, "musicRoot"), s]),
    );
    expect(eventNameReferences(parseAudioEvent(EVENT).value).filter((r) => r.kind === "parameter")).toHaveLength(5);
    expect(eventNameReferences(null)).toEqual([]);
  });

  it("rewrites one reference, copying only the path to it", () => {
    const [, , , wind] = eventNameReferences(EVENT);
    const out = rewriteEventReference(EVENT, wind!, "Gust");
    expect(out.root.children[0]!.parameter).toBe("Gust");
    expect(out.root.children[0]!.children).toBe(EVENT.root.children[0]!.children); // the clip's automation still says Wind
    expect(out.root.children[1]).toBe(EVENT.root.children[1]);
    expect(out.sends).toBe(EVENT.sends);
    expect(EVENT.root.children[0]!.parameter).toBe("Wind");
  });

  it("renames an aux send in place, never to the reverb send or a key already there", () => {
    const send = eventNameReferences(EVENT).find((r) => r.key)!;
    expect(Object.entries(rewriteEventReference(EVENT, send, "Cave").sends)).toEqual([["reverb", 0.5], ["Cave", 0.3]]);
    expect(rewriteEventReference(EVENT, send, "reverb")).toBe(EVENT);
    expect(rewriteEventReference({ ...EVENT, sends: { Hall: 0.3, Cave: 0.1 } }, send, "Cave").sends).toEqual({ Hall: 0.3, Cave: 0.1 });
  });

  it("renames a bus everywhere, the reverb send never being one", () => {
    const out = renameEventName(MUSIC, "bus", "global", "Drums", "Kit");
    expect(out.root.children[0]!.tracks[0]!.bus).toBe("Kit");
    expect(out.root.library).toBe(MUSIC.root.library);
    expect(renameEventName(EVENT, "bus", "global", "Voice", "Speech")).toBe(EVENT);
    const reverbBus = { ...EVENT, bus: "reverb" };
    const renamed = renameEventName(reverbBus, "bus", "global", "reverb", "Hall2");
    expect([renamed.bus, renamed.sends]).toEqual(["Hall2", EVENT.sends]);
  });

  it("renames a local parameter and its definition; a global rename passes over a name the event's own parameter hides", () => {
    const local = renameEventName(EVENT, "parameter", "local", "Speed", "Pace");
    expect(local.parameters[0]!.name).toBe("Pace");
    expect(eventNameReferences(local).filter((r) => r.name === "Pace").map((r) => r.scope)).toEqual(["local", "local", "local"]);
    expect(eventNameReferences(local).some((r) => r.name === "Speed")).toBe(false);
    expect(renameEventName(EVENT, "parameter", "global", "Speed", "Pace")).toBe(EVENT); // Speed is the event's own here
    const gust = renameEventName(EVENT, "parameter", "global", "Wind", "Gust");
    expect(eventNameReferences(gust).filter((r) => r.name === "Gust")).toHaveLength(2);
    expect(gust.parameters).toBe(EVENT.parameters);
    // Renaming the global Wind to Speed would move its reads onto the local Speed: the event is left alone.
    expect(renameEventName(EVENT, "parameter", "global", "Wind", "Speed")).toBe(EVENT);
    expect(renameEventName(EVENT, "parameter", "global", "Wind", "Wind")).toBe(EVENT);
  });

  it("does not rename a member called parameter where the format reads none", () => {
    const out = renameEventName(MUSIC, "parameter", "global", "Ignored", "Other");
    expect(out).toBe(MUSIC);
    const bus = renameEventName(EVENT, "bus", "global", "UI", "Menu");
    expect(bus).toBe(EVENT);
  });

  it("keeps a renamed music event valid", () => {
    const parsed = parseAudioEvent(MUSIC).value;
    const out = renameEventName(parsed, "parameter", "local", "State", "World");
    expect(out.parameters[0]!.name).toBe("World");
    expect((out.musicRoot as { parameter: string }).parameter).toBe("World");
    expect(parseAudioEvent(JSON.parse(formatAudioEvent(out))).problems).toEqual([]);
  });
});
