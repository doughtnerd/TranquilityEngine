// Ed8: the Event editor's music tree (ADR 0166 §2.3, §2.5; decision D6: the tree is `musicRoot`): the pure edits of
// EventTree.tsx, the music field descriptors and stinger helpers of nodeFields.ts, and the writer round trip through
// the asset document. Every edit result must read back through `parseAudioEvent` without a problem and with unique ids.
import { afterEach, describe, expect, it, vi } from "vitest";
import { _reset, openAssetDocument } from "../../../../editor/assetDocuments";
import { joinPath, openFolderProject } from "../../../../editor/projects";
import { currentProject } from "../../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../../editor/testing";
import { formatAudioEvent, parseAudioEvent, type AudioEventAsset } from "../../../../engine/audio/eventFormat";
import type { MusicNode, MusicSwitchNode, PlaylistNode, SegmentNode } from "../../../../engine/audio/musicFormat";
import { useEditorPlugins } from "../../../testEditorPlugins";
import { audioEditorPlugin } from "..";
import {
  addMusicNode, canDuplicateMusic, canRemoveMusic, duplicateMusicNode, freshMusicId, getMusicNode, isLibraryPath, musicIdProblem, musicIds,
  musicNodePaths, parameterUses, parsePathKey, pathKey, removeMusicNode, renameMusicId, renameParameter, reorderMusicNode, setMusicNode,
} from "./EventTree";
import {
  coerceField, findField, musicNodeFields, newStinger, patchStinger, readField, stingerAtFrom, stingerAtKind, writeField, type FieldDescriptor,
} from "./nodeFields";

useEditorPlugins([audioEditorPlugin], "each");
afterEach(() => {
  _reset();
  vi.useRealTimers();
});

const track = (name: string, extra: Record<string, unknown> = {}) => ({ name, clip: `music/${name}.ogg`, ...extra });
const raw = (): Record<string, unknown> => ({
  format: "myco.audioevent@1",
  bus: "Music",
  parameters: [{ name: "State", labels: ["explore", "combat"] }, { name: "Intensity", min: 0, max: 1 }],
  root: {
    type: "musicSwitch", id: "world", parameter: "State", default: "explore",
    children: [
      { type: "segment", id: "explore", value: "explore", cues: [{ name: "exit", at: "5:1:0" }], tracks: [track("e", { automation: [{ parameter: "Intensity", target: "volume", curve: [[0, 0], [1, 1]] }] })], regions: [{ id: "loop", from: "1:1:0", to: "5:1:0", count: 0, while: { parameter: "Intensity", atLeast: 0.5 } }] },
      { type: "playlist", id: "combat", value: "combat", children: [{ type: "segment", id: "c1", tracks: [track("c1")] }, { type: "segment", id: "c2", tracks: [track("c2")] }], library: [{ type: "segment", id: "sting", tracks: [track("sting")] }], stingers: [{ trigger: "hit", segment: "sting" }] },
    ],
    transitions: [{ from: "explore", to: "combat", bridge: { segment: "riser" } }, { from: "combat", to: "explore" }],
    stingers: [{ trigger: "secret", segment: "riser", at: "bar", dontRepeat: 2 }],
    library: [{ type: "segment", id: "riser", tracks: [track("riser")] }],
  },
});

const load = (): AudioEventAsset => parseAudioEvent(raw()).value;
const music = (): MusicSwitchNode => load().musicRoot as MusicSwitchNode;
const reread = (root: MusicNode) => {
  const event = { ...load(), musicRoot: root };
  const read = parseAudioEvent(JSON.parse(formatAudioEvent(event)));
  return read;
};
/** The edit's result reads back as the same tree, with no problem (so no id was duplicated or left dangling). */
const expectRoundTrip = (root: MusicNode) => {
  const read = reread(root);
  // A fresh segment has no stems and a switch child no value yet: those are the author's to fill in. Anything else (a
  // duplicate id, a dangling rule) would be the editor's fault.
  expect(read.problems.filter((p) => !/plays nothing|needs a value|parameter is empty/.test(p))).toEqual([]);
  expect(read.value.musicRoot).toEqual(root);
  const ids = musicIds(root);
  expect(new Set(ids).size).toBe(ids.length);
};
const ok = <T,>(r: T | string): T => {
  if (typeof r === "string") throw new Error(r);
  return r;
};

describe("the fixture", () => {
  it("is a clean music event", () => {
    const read = parseAudioEvent(raw());
    expect(read.problems).toEqual([]);
    expect(read.value.musicRoot?.type).toBe("musicSwitch");
    expectRoundTrip(music());
  });
});

describe("paths", () => {
  it("name library segments beside children and round trip through a key", () => {
    const root = music();
    const entries = musicNodePaths(root);
    expect(entries.map((e) => pathKey(e.path))).toEqual(["", "0", "1", "1/0", "1/1", "1/lib0", "lib0"]);
    for (const e of entries) {
      expect(parsePathKey(pathKey(e.path))).toEqual(e.path);
      expect(getMusicNode(root, e.path)).toBe(e.node);
    }
    expect(isLibraryPath(["1", "lib0"].map((s) => (s === "1" ? 1 : s)) as never)).toBe(true);
    expect(isLibraryPath([1, 0])).toBe(false);
    expect(parsePathKey("lib01")).toBeNull();
  });
});

describe("ids", () => {
  it("are refused when they are malformed or another node has them, and not when they are the node's own", () => {
    const root = music();
    expect(musicIdProblem(root, [0], "explore")).toBeNull();
    expect(musicIdProblem(root, [0], "combat")).toMatch(/already used/);
    expect(musicIdProblem(root, [0], "riser")).toMatch(/already used/); // library ids share the namespace
    expect(musicIdProblem(root, [0], "")).toMatch(/1 to 48/);
    expect(musicIdProblem(root, [0], "has space")).toMatch(/1 to 48/);
    expect(musicIdProblem(root, [0], "x".repeat(49))).toMatch(/1 to 48/);
    expect(musicIdProblem(root, [0], "fresh-1_A")).toBeNull();
  });

  it("freshMusicId cleans and suffixes", () => {
    expect(freshMusicId(new Set(), "a b")).toBe("a-b");
    expect(freshMusicId(new Set(["segment", "segment-2"]), "segment")).toBe("segment-3");
    expect(freshMusicId(new Set(), "")).toBe("node");
  });

  it("renaming a child follows the rules; renaming a library segment follows bridges and stingers", () => {
    const root = music();
    const a = renameMusicId(root, [0], "wander") as MusicSwitchNode;
    expect(a.children[0].id).toBe("wander");
    expect(a.transitions.map((r) => `${r.from}>${r.to}`)).toEqual(["wander>combat", "combat>wander"]);
    expectRoundTrip(a);
    const b = renameMusicId(root, ["lib0"] as never, "swell") as MusicSwitchNode;
    expect(b.library[0].id).toBe("swell");
    expect(b.transitions[0].bridge?.segment).toBe("swell");
    expect(b.stingers[0].segment).toBe("swell");
    expectRoundTrip(b);
    const c = renameMusicId(root, [1, "lib0"] as never, "boom") as MusicSwitchNode;
    expect((c.children[1] as PlaylistNode).stingers[0].segment).toBe("boom");
    expectRoundTrip(c);
    expect(renameMusicId(root, [0], "explore")).toBe(root);
  });
});

describe("adding", () => {
  it("puts a node at the end of the selected container, or after a selected child, with a fresh id", () => {
    const root = music();
    const into = ok(addMusicNode(root, [], "segment"));
    expect(into.path).toEqual([2]);
    expect(getMusicNode(into.root, into.path)?.id).toBe("segment");
    expectRoundTrip(into.root);
    const after = ok(addMusicNode(into.root, [0], "playlist"));
    expect(after.path).toEqual([1]);
    expect(getMusicNode(after.root, [1])?.type).toBe("playlist");
    const ev = ok(addMusicNode(root, null, "musicSwitch")); // the event row means the root
    expect(getMusicNode(ev.root, ev.path)?.type).toBe("musicSwitch");
    expectRoundTrip(ev.root);
    const twice = ok(addMusicNode(into.root, [], "segment"));
    expect(getMusicNode(twice.root, twice.path)?.id).toBe("segment-2");
  });

  it("puts a library segment into the container of the selection", () => {
    const root = music();
    const a = ok(addMusicNode(root, [1, 0], "library")); // beside a child of the playlist: that playlist's library
    expect(a.path).toEqual([1, "lib1"]);
    expect(((a.root as MusicSwitchNode).children[1] as PlaylistNode).library).toHaveLength(2);
    const b = ok(addMusicNode(root, [0], "library")); // under the switch
    expect(b.path).toEqual(["lib1"]);
    expectRoundTrip(b.root);
  });

  it("says why it can't", () => {
    const seg = parseAudioEvent({ format: "myco.audioevent@1", root: { type: "segment", id: "only", tracks: [track("t")] } }).value.musicRoot!;
    expect(typeof addMusicNode(seg, [], "segment")).toBe("string");
    expect(typeof addMusicNode(seg, null, "library")).toBe("string");
  });
});

describe("removing", () => {
  it("the root stays", () => {
    expect(canRemoveMusic(music(), [])).toBe(false);
    expect(canRemoveMusic(music(), [0])).toBe(true);
    expect(canRemoveMusic(music(), [9])).toBe(false);
  });

  it("a child takes the rules naming it", () => {
    const next = removeMusicNode(music(), [0]) as MusicSwitchNode;
    expect(next.children.map((c) => c.id)).toEqual(["combat"]);
    expect(next.transitions).toEqual([]);
    expectRoundTrip(next);
  });

  it("a library segment takes the stingers and bridges naming it", () => {
    const next = removeMusicNode(music(), ["lib0"] as never) as MusicSwitchNode;
    expect(next.library).toEqual([]);
    expect(next.stingers).toEqual([]);
    expect(next.transitions.map((r) => r.bridge)).toEqual([undefined, undefined]);
    expect("bridge" in next.transitions[0]).toBe(false);
    expectRoundTrip(next);
    const inner = removeMusicNode(music(), [1, 0]) as MusicSwitchNode; // a playlist child that nothing names
    expect(((inner.children[1] as PlaylistNode).children).map((c) => c.id)).toEqual(["c2"]);
    expectRoundTrip(inner);
  });
});

describe("reordering and duplicating", () => {
  it("moves children and library segments", () => {
    const root = music();
    const down = reorderMusicNode(root, [0], 1);
    expect(down.path).toEqual([1]);
    expect((down.root as MusicSwitchNode).children.map((c) => c.id)).toEqual(["combat", "explore"]);
    expectRoundTrip(down.root);
    expect(reorderMusicNode(root, [0], -1).root).toBe(root);
    const withTwo = ok(addMusicNode(root, ["lib0"] as never, "library"));
    const moved = reorderMusicNode(withTwo.root, ["lib1"] as never, -1);
    expect(moved.path).toEqual(["lib0"]);
    expect((moved.root as MusicSwitchNode).library.map((s) => s.id)).toEqual(["library", "riser"]);
  });

  it("copies a subtree with fresh ids and its own rules following them", () => {
    const withRules = setMusicNode(music(), [1], {
      ...(music().children[1] as PlaylistNode),
      transitions: [{ from: "c1", to: "c2", exit: "bar", enter: "entryCue", fadeOut: { unit: "beats", amount: 1, offset: 0, curve: "equalPower" }, fadeIn: { unit: "beats", amount: 1, offset: 0, curve: "equalPower" } }],
    } as PlaylistNode);
    expect(canDuplicateMusic(withRules, [1])).toBe(true);
    const dup = duplicateMusicNode(withRules, [1]);
    expect(dup.path).toEqual([2]);
    const copy = getMusicNode(dup.root, dup.path) as PlaylistNode;
    expect(copy.id).toBe("combat-2");
    expect(copy.children.map((c) => c.id)).toEqual(["c1-2", "c2-2"]);
    expect(copy.library.map((c) => c.id)).toEqual(["sting-2"]);
    expect(copy.transitions.map((r) => `${r.from}>${r.to}`)).toEqual(["c1-2>c2-2"]);
    expect(copy.stingers[0].segment).toBe("sting-2");
    expect(getMusicNode(dup.root, [1])).toBe(getMusicNode(withRules, [1])); // the original is untouched
    expectRoundTrip(dup.root);
  });

  it("copies a library segment beside it", () => {
    const dup = duplicateMusicNode(music(), ["lib0"] as never);
    expect(dup.path).toEqual(["lib1"]);
    expect(musicIds(dup.root)).toContain("riser-2");
    expectRoundTrip(dup.root);
    expect(canDuplicateMusic(music(), [])).toBe(false);
  });
});

describe("parameters", () => {
  it("uses and renames reach the music tree", () => {
    const event = load();
    expect(parameterUses(event, "State")).toBe(1);
    expect(parameterUses(event, "Intensity")).toBe(2); // a stem automation and a region condition
    const renamed = renameParameter(event, "Intensity", "Danger");
    expect(renamed.parameters.map((p) => p.name)).toEqual(["State", "Danger"]);
    const seg = renamed.musicRoot && (renamed.musicRoot as MusicSwitchNode).children[0] as SegmentNode;
    expect(seg?.tracks[0].automation[0].parameter).toBe("Danger");
    expect(seg?.regions[0].while?.parameter).toBe("Danger");
    const sw = renameParameter(event, "State", "World");
    expect((sw.musicRoot as MusicSwitchNode).parameter).toBe("World");
    expect(parseAudioEvent(JSON.parse(formatAudioEvent(sw))).problems).toEqual([]);
  });
});

describe("musicNodeFields", () => {
  const names = (fields: readonly FieldDescriptor[]) => fields.map((f) => f.name);
  it("lists the id first and leaves out what music ignores", () => {
    const root = music();
    const seg = root.children[0];
    const fields = musicNodeFields(seg, root);
    expect(names(fields)).toEqual(["id", "gridOffset", "entry", "exit", "volume", "volumeRandom", "value"]);
    expect(names(musicNodeFields(root, null))).toEqual(["id", "parameter", "default", "volume", "volumeRandom"]);
    for (const hidden of ["pitch", "pitchRandom", "delay", "fade", "range", "automation"]) expect(names(fields)).not.toContain(hidden);
  });

  it("gives plays under a playlist, weight only under a random one, and nothing from a library", () => {
    const pl = root0("sequence");
    expect(names(musicNodeFields(pl.children[0], pl))).toEqual(["id", "gridOffset", "entry", "exit", "volume", "volumeRandom", "plays"]);
    const rnd = root0("random");
    expect(names(musicNodeFields(rnd, null))).toEqual(["id", "mode", "rounds", "avoidRepeat", "volume", "volumeRandom"]);
    expect(names(musicNodeFields(rnd.children[0], rnd))).toContain("weight");
    expect(names(musicNodeFields(root0("sequence").library[0], root0("sequence"), true))).toEqual(["id", "gridOffset", "entry", "exit", "volume", "volumeRandom"]);
    expect(findField(musicNodeFields(rnd, null), "avoidRepeat")).toMatchObject({ max: 1 });
  });

  it("an optional select writes the cue name and removes the key when cleared", () => {
    const seg = music().children[0] as SegmentNode;
    const exit = findField(musicNodeFields(seg, null), "exit")!;
    expect(exit).toMatchObject({ kind: "select", options: ["exit"], optional: true });
    const set = writeField(seg, exit, coerceField(exit, "exit"));
    expect(set.exit).toBe("exit");
    expect(readField(set, exit)).toBe("exit");
    const cleared = writeField(set, exit, coerceField(exit, ""));
    expect("exit" in cleared).toBe(false);
    expect(coerceField(exit, "nope")).toBeUndefined();
    expectRoundTrip(setMusicNode(music(), [0], set));
  });

  it("field writes read back", () => {
    const root = music();
    const volume = findField(musicNodeFields(root, null), "volume")!;
    const next = setMusicNode(root, [], writeField(root, volume, 0.5));
    expect((next as MusicSwitchNode).volume).toBe(0.5);
    expectRoundTrip(next);
  });
});

function root0(mode: "sequence" | "random"): PlaylistNode {
  return parseAudioEvent({
    format: "myco.audioevent@1",
    root: { type: "playlist", id: "p", mode, children: [{ type: "segment", id: "a", tracks: [track("a")] }, { type: "segment", id: "b", tracks: [track("b")] }], library: [{ type: "segment", id: "lib", tracks: [track("l")] }] },
  }).value.musicRoot as PlaylistNode;
}

describe("stinger helpers", () => {
  it("make a new stinger with a fresh trigger on the first library segment", () => {
    expect(newStinger([], "riser")).toEqual({ trigger: "stinger", segment: "riser", at: "beat", dontRepeat: 0, ifTooLate: "nextGrid" });
    expect(newStinger(["stinger", "stinger-2"], "riser").trigger).toBe("stinger-3");
  });

  it("read and write the `at` choice", () => {
    expect(stingerAtKind("bar")).toBe("bar");
    expect(stingerAtKind({ cue: "hit" })).toBe("cue");
    expect(stingerAtKind({ every: "bar", n: 2 })).toBe("every");
    expect(stingerAtFrom("cue", "bar")).toEqual({ cue: "" });
    expect(stingerAtFrom("cue", { cue: "hit" })).toEqual({ cue: "hit" });
    expect(stingerAtFrom("immediate", { cue: "hit" })).toBe("immediate");
    expect(stingerAtFrom("every", { every: "bar", n: 2 })).toEqual({ every: "bar", n: 2 });
  });

  it("patching drops an unset volume and bus, and the list round trips", () => {
    const s = patchStinger({ trigger: "a", segment: "riser", at: "beat", dontRepeat: 0, ifTooLate: "nextGrid", volume: 2, bus: "Fx" }, { volume: undefined, bus: "" });
    expect("volume" in s).toBe(false);
    expect("bus" in s).toBe(false);
    const root = music();
    const edited = patchStinger(root.stingers[0], { at: { cue: "hit" }, dontRepeat: 5, ifTooLate: "skip", volume: 1.5, bus: "Music" });
    const next = { ...root, stingers: [edited, newStinger(["secret"], "riser")] };
    const read = reread(next);
    expect(read.problems).toEqual([]);
    expect((read.value.musicRoot as MusicSwitchNode).stingers).toEqual(next.stingers);
  });
});

describe("the asset document", () => {
  const PATH = "m.audioevent.json";
  async function open() {
    const fs = new MemoryFileSystem();
    fs.files.set(joinPath(ROOT, "project.json"), "{}");
    fs.files.set(joinPath(ROOT, PATH), JSON.stringify(raw()));
    const project = await openFolderProject(fs, ROOT);
    currentProject.value = project;
    const doc = openAssetDocument<AudioEventAsset>(project, PATH, "audioEvent");
    const file = () => JSON.parse(fs.files.get(joinPath(ROOT, PATH)) as string) as { root: { id: string; children: { id: string }[]; library: { id: string }[]; transitions: { from: string }[] } };
    return { doc, file };
  }

  it("an edit to the music root is written to the file's root, and undone", async () => {
    const { doc, file } = await open();
    const event = () => doc.value.value;
    expect(event().musicRoot?.type).toBe("musicSwitch");
    const added = ok(addMusicNode(event().musicRoot!, [], "segment"));
    doc.edit({ ...event(), musicRoot: added.root }, { label: "Add segment" });
    doc.edit({ ...event(), musicRoot: renameMusicId(event().musicRoot!, [0], "wander") }, { label: "Rename node" });
    await doc.flush();
    expect(file().root.children.map((c) => c.id)).toEqual(["wander", "combat", "segment"]);
    expect(file().root.transitions[0].from).toBe("wander");
    expect(file().root.library.map((c) => c.id)).toEqual(["riser"]);
    expect(doc.undoLabel.value).toBe("Rename node");
    doc.undo();
    doc.undo();
    await doc.flush();
    expect(file().root.children.map((c) => c.id)).toEqual(["explore", "combat"]);
  });
});
