// The game's global parameters in the Studio (D19), through their model: the ADR 0304 list over `audio.json` with what
// a rename and a remove carry along in the mix, the rename across playlists and events, and the panel's hosts.
import { signal } from "@preact/signals";
import { describe, expect, it } from "vitest";
import { parsePlaylist, playlistBodyToJson } from "../../../engine/audio/playlist/format";
import { audioProjectToJson, parseAudioProject } from "../../../engine/audio/project/format";
import type { AudioProject } from "../../../engine/audio/project/types";
import { globalParameterList, parameterRenameEdit, parameterUsesInMix, renamedParameter, renameParameterInPlaylist } from "./globalParameters";
import { renameTestValue, sessionParametersHost } from "./globalParametersHost";
import { createMixerSession, type MixDocument } from "./mixerScreen";
import { mixerFixture } from "./mixerFixture";

const ok = <T>(r: { next: T } | { refused: string }): T => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};
const refused = <T>(r: { next: T } | { refused: string }): string => ("refused" in r ? r.refused : "accepted");
const valid = (p: AudioProject) => {
  const back = parseAudioProject(audioProjectToJson(p));
  expect(back.problems).toEqual([]);
  expect(back.project).toEqual(p);
};

describe("global parameters over audio.json", () => {
  it("adds, edits and refuses as the ADR 0304 list does, at most 64", () => {
    const p = mixerFixture();
    const added = ok(globalParameterList.add(p, "labelled"));
    expect(added.parameters.at(-1)).toEqual({ name: "Parameter", labels: ["State 1", "State 2"], default: "State 1" });
    expect(globalParameterList.limit).toBe(64);
    expect(refused(globalParameterList.rename(p, "threat", "health"))).toBe('another parameter is named "health"');
    expect(ok(globalParameterList.setRange(p, "depth", { min: 50 })).parameters.find((q) => q.name === "depth")).toMatchObject({ min: 30, max: 50, default: 30 });
    valid(added);
  });

  it("a rename carries the automation and snapshot conditions reading it, in the same edit", () => {
    const p = mixerFixture();
    const next = ok(globalParameterList.rename(p, "depth", " waterDepth "));
    expect(next.parameters.map((q) => q.name)).toContain("waterDepth");
    expect(next.automation.find((a) => a.target === "fx:fx1:cutoff")!.parameter).toBe("waterDepth");
    const under = next.snapshots.find((s) => s.name === "Underwater")!.start;
    expect(under.kind === "conditions" && under.conditions[0]!.parameter).toBe("waterDepth");
    expect(next.automation.filter((a) => a.parameter === "threat").length).toBe(2);
    expect(renamedParameter(p.parameters, next.parameters)).toEqual({ from: "depth", to: "waterDepth" });
    valid(next);
  });

  it("a remove drops the automation it drives and the conditions on it", () => {
    const p = mixerFixture();
    expect(parameterUsesInMix(p, "threat")).toEqual({ automation: 2, conditions: 0 });
    expect(parameterUsesInMix(p, "gameState")).toEqual({ automation: 0, conditions: 2 });
    const next = ok(globalParameterList.remove(p, "gameState"));
    expect(next.parameters.some((q) => q.name === "gameState")).toBe(false);
    const pause = next.snapshots.find((s) => s.name === "Pause menu")!.start;
    expect(pause).toEqual({ kind: "conditions", match: "all", conditions: [] });
    const gone = ok(globalParameterList.remove(p, "threat"));
    expect(gone.automation.map((a) => a.target)).toEqual(["fx:fx1:cutoff"]);
    valid(next);
    valid(gone);
    expect(renamedParameter(p.parameters, next.parameters)).toBeNull();
  });
});

const playlistJson = {
  format: "myco.playlist@1",
  type: "switch",
  switch: { parameter: "surface", map: { dirt: 0 }, onChange: { when: "now", how: "transition", length: { ms: 100 }, transition: { embedded: { type: "blend", entries: [], blend: { axes: ["surface"] } } } }, rules: [] },
  entries: [
    { sample: "a.wav", curves: { gain: { input: { parameter: "surface" }, curve: [[0, 0], [1, -6]] }, pitch: { input: "voiceTime", curve: [[0, 0], [1, 1]] }, lowpass: { input: "surface", curve: [[0, 20000], [1, 800]] } } },
    { embedded: { type: "blend", entries: [], blend: { axes: [{ parameter: "surface" }, { parameter: "speed" }] } } },
    // A local parameter of another name, and what reads it: left alone.
    { embedded: { type: "switch", parameters: [{ name: "gear", labels: ["a", "b"], default: "a" }], switch: { parameter: "gear", map: {} }, entries: [] } },
    {
      embedded: {
        type: "sequence",
        entries: [],
        sequence: {
          tracks: [{ id: "t1", automation: [{ id: "a1", target: "volume", input: { parameter: "surface" }, curve: [[0, 0]] }], clips: [{ id: "c1", sample: "b.wav", loops: { l1: { active: "parameter", binding: { parameter: "surface", op: ">", value: 0.5 } } }, automation: [{ id: "a2", target: "pan", input: "sequenceTime", curve: [[0, 0]] }] }] }],
          loops: [{ id: "L", start: 0, end: 1, active: "parameter", binding: { parameter: "surface", op: "<", value: 1 } }],
        },
      },
    },
  ],
  stingers: [{ trigger: "hit", playlist: { embedded: { type: "clip", entries: [{ sample: "c.wav", curves: { gain: { input: { parameter: "surface" }, curve: [[0, 0]] } } }] } } }],
};

describe("renaming a global parameter in playlists", () => {
  it("renames every reference in file JSON: Switch, Blend axes, curve and automation inputs, loop bindings", () => {
    const next = renameParameterInPlaylist(playlistJson, "surface", "ground");
    const back = parsePlaylist(next, "p.playlist.json").playlist;
    expect(back.switch!.parameter).toBe("ground");
    const transition = back.switch!.onChange.transition!;
    expect(transition.kind === "embedded" && transition.embedded.blend!.axes).toEqual([{ parameter: "ground" }]);
    expect(back.entries[0]!.curves.gain!.input).toEqual({ parameter: "ground" });
    expect(back.entries[0]!.curves.pitch!.input).toBe("voiceTime");
    expect(back.entries[0]!.curves.lowpass!.input).toEqual({ parameter: "ground" });
    const blend = back.entries[1]!;
    expect(blend.kind === "embedded" && blend.embedded.blend!.axes).toEqual([{ parameter: "ground" }, { parameter: "speed" }]);
    const local = back.entries[2]!;
    expect(local.kind === "embedded" && local.embedded.switch!.parameter).toBe("gear");
    const seq = back.entries[3]!;
    if (seq.kind !== "embedded") throw new Error("embedded");
    const track = seq.embedded.sequence!.tracks[0]!;
    expect(track.automation[0]!.input).toEqual({ parameter: "ground" });
    expect(track.clips[0]!.loops.l1!.binding!.parameter).toBe("ground");
    expect(track.clips[0]!.automation[0]!.input).toBe("sequenceTime");
    expect(seq.embedded.sequence!.loops[0]!.binding!.parameter).toBe("ground");
    const stinger = back.stingers[0]!.playlist;
    expect(stinger.kind === "embedded" && stinger.embedded.entries[0]!.curves.gain!.input).toEqual({ parameter: "ground" });
  });

  it("renames a playlist instance's own automation inputs, at the root and in embedded playlists", () => {
    const json = {
      format: "myco.playlist@1",
      type: "layer",
      automation: [{ id: "a", target: "volume", input: { parameter: "surface" }, curve: [[0, 0]] }, { id: "b", target: "pitch", input: "voiceTime", curve: [[0, 0]] }],
      entries: [{ embedded: { type: "clip", automation: [{ id: "c", target: "pan", input: "surface", curve: [[0, 0]] }], entries: [{ sample: "a.wav" }] } }],
    };
    const back = parsePlaylist(renameParameterInPlaylist(json, "surface", "ground")).playlist;
    expect(back.automation.map((a) => a.input)).toEqual([{ parameter: "ground" }, "voiceTime"]);
    const e = back.entries[0]!;
    expect(e.kind === "embedded" && e.embedded.automation[0]!.input).toEqual({ parameter: "ground" });
  });

  it("leaves the whole playlist alone when any playlist in its instance defines a local one (the runtime's rule)", () => {
    const json = { format: "myco.playlist@1", type: "switch", switch: { parameter: "surface", map: {} }, entries: [{ embedded: { type: "clip", parameters: [{ name: "surface", min: 0, max: 1, default: 0 }], entries: [] } }] };
    expect(renameParameterInPlaylist(json, "surface", "ground")).toBe(json);
  });

  it("returns the playlist itself when nothing names the parameter, or when it defines a local one of either name", () => {
    expect(renameParameterInPlaylist(playlistJson, "rpm", "revs")).toBe(playlistJson);
    const local = { ...playlistJson, parameters: [{ name: "ground", min: 0, max: 1, default: 0 }] };
    expect(renameParameterInPlaylist(local, "surface", "ground")).toBe(local);
  });

  it("works on a parsed playlist's JSON as written", () => {
    const parsed = parsePlaylist(playlistJson, "p.playlist.json").playlist;
    const json = { format: "myco.playlist@1", ...playlistBodyToJson(parsed) };
    const next = renameParameterInPlaylist(json, "surface", "ground");
    expect(parsePlaylist(next).playlist.switch!.parameter).toBe("ground");
  });

  it("as a project file edit: playlists and events, never audio.json or scenes", () => {
    const edit = parameterRenameEdit("surface", "ground");
    expect(edit.mentioned('{"parameter":"surface"}')).toBe(true);
    expect(edit.mentioned('{"parameter":"ground"}')).toBe(false);
    expect(edit.json({ parameters: [{ name: "surface" }] }, "audio.json")).toBeNull();
    expect((edit.json(playlistJson, "a/b.playlist.json") as typeof playlistJson).switch.parameter).toBe("ground");
    expect(edit.json(playlistJson, "a/b.json")).toBeNull();
    expect(edit.settings({})).toBeNull();
  });
});

describe("the panel's hosts", () => {
  it("moves a test value to the new name", () => {
    const values = { depth: 4, threat: 1 };
    expect(renameTestValue(values, "depth", "waterDepth")).toEqual({ threat: 1, waterDepth: 4 });
    expect(renameTestValue(values, "speed", "pace")).toBe(values);
  });

  it("over the Mixer's session: one undo step on audio.json, then the test value moves and the rename goes outside", () => {
    const value = signal(mixerFixture());
    const edits: string[] = [];
    const doc: MixDocument = { value, readOnly: false, edit: (next, o) => { value.value = next; edits.push(o?.label ?? ""); } };
    const session = createMixerSession({ doc, confirm: async () => true, toast: () => {}, report: () => {} });
    session.setTestValue("depth", 12);
    const outside: string[] = [];
    const host = sessionParametersHost(session, (from, to) => outside.push(`${from}>${to}`));
    const before = host.project.peek();
    const result = globalParameterList.rename(before, "depth", "waterDepth");
    expect(host.commit(result, "Rename parameter depth to waterDepth")).toBe(true);
    host.renamed?.("depth", "waterDepth");
    expect(edits).toEqual(["Rename parameter depth to waterDepth"]);
    expect(value.value.automation.find((a) => a.target === "fx:fx1:cutoff")!.parameter).toBe("waterDepth");
    expect(session.testValues.value).toEqual({ waterDepth: 12 });
    expect(outside).toEqual(["depth>waterDepth"]);
    session.dispose();
  });
});
