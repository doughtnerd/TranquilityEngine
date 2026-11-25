import { describe, expect, it } from "vitest";
import { defaultEntryUse, emptyPlaylistBody } from "../../../engine/audio/playlist/format";
import type { Entry, PlaylistBody } from "../../../engine/audio/playlist/types";
import { addItems, entriesFor, filterCounts, filterItems, pickRange, togglePick, addLabel } from "./addDialogModel";
import { isSamplePath, libraryGroups, sampleDragText, sampleFromDrag } from "./libraryModel";
import { ancestorKeys, entryKey, fileKey, findNode, folderKey, linkedByIndex, nodePath, playlistTree, searchTree } from "./playlistTree";
import { childrenToKeep, countLinks, deleteEntry, moveAcrossFiles, moveWithinFile, planDelete, replaceLinks, shiftAfterRemoval } from "./structureEdits";
import { dropLabel, dropZone, planDrop } from "./treeDrop";
import { aliveAt, eventTimes, markTrigger, stepEvent, triggerRows, triggerSpan, updateLog, voicesNow, type DebugSnapshot } from "./voiceLog";

const ctx = { parameters: [] };
const sample = (s: string): Entry => ({ kind: "sample", sample: s, trim: null, loop: "inherit", ...defaultEntryUse() });
const link = (p: string): Entry => ({ kind: "linked", playlist: p, ...defaultEntryUse() });
const clipOf = (s: string): Entry => ({ kind: "embedded", embedded: { ...emptyPlaylistBody("clip"), entries: [sample(s)] }, ...defaultEntryUse() });
const emb = (b: PlaylistBody): Entry => ({ kind: "embedded", embedded: b, ...defaultEntryUse() });
const of = (type: PlaylistBody["type"], ...entries: Entry[]): PlaylistBody => ({ ...emptyPlaylistBody(type), entries });
const ok = <T,>(r: { next: T } | { refused: string }): T => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};

// A small project: steps (a Queue with an embedded Switch and a link to dirt), dirt (a Queue), engine (a Clip).
const project: Record<string, PlaylistBody> = {
  "audio/steps.playlist.json": of("queue", emb(of("switch", clipOf("audio/a.wav"))), link("audio/dirt.playlist.json")),
  "audio/dirt.playlist.json": of("queue", clipOf("audio/d1.wav"), clipOf("audio/d2.wav")),
  "music/engine.playlist.json": of("clip", sample("audio/e.wav")),
};
const load = (p: string) => project[p] ?? null;
const files = [...Object.keys(project), "audio/a.wav", "audio/d1.wav", "audio/sub/x.sample.json", "images/logo.png", ".myco/h.json"];
const folders = ["audio", "audio/sub", "music", "images", "empty", ".myco"];

describe("playlist tree", () => {
  const tree = playlistTree(files, folders, load);

  it("lists folders holding playlists and empty folders, files A–Z, entries nested", () => {
    expect(tree.map((n) => n.key)).toEqual([folderKey("audio"), folderKey("empty"), folderKey("music")]);
    const audio = tree[0]!;
    expect(audio.kind === "folder" && audio.count).toBe(2);
    expect(audio.children.map((n) => n.key)).toEqual([fileKey("audio/dirt.playlist.json"), fileKey("audio/steps.playlist.json")]);
    const steps = findNode(tree, fileKey("audio/steps.playlist.json"))!;
    expect(steps.children.map((n) => n.kind === "entry" && [n.name, n.link, n.type])).toEqual([["Switch 1", null, "switch"], ["dirt", "audio/dirt.playlist.json", "queue"]]);
    // The embedded Switch's Clip is a row of its own.
    expect(steps.children[0]!.children.map((n) => n.key)).toEqual([entryKey("audio/steps.playlist.json", [0, 0])]);
    // A Clip's sample isn't a row.
    expect(findNode(tree, fileKey("music/engine.playlist.json"))!.children).toEqual([]);
  });

  it("knows who links a file, finds rows and their ancestors, and what a row opens", () => {
    expect(linkedByIndex(files, load).get("audio/dirt.playlist.json")).toEqual(["audio/steps.playlist.json"]);
    const dirt = findNode(tree, fileKey("audio/dirt.playlist.json"))!;
    expect(dirt.kind === "file" && dirt.linkedBy).toEqual(["audio/steps.playlist.json"]);
    expect(ancestorKeys(tree, entryKey("audio/steps.playlist.json", [0, 0]))).toEqual([folderKey("audio"), fileKey("audio/steps.playlist.json"), entryKey("audio/steps.playlist.json", [0])]);
    expect(nodePath(findNode(tree, entryKey("audio/steps.playlist.json", [1]))!)).toEqual({ file: "audio/dirt.playlist.json", indices: [] });
    expect(nodePath(findNode(tree, entryKey("audio/steps.playlist.json", [0]))!)).toEqual({ file: "audio/steps.playlist.json", indices: [0] });
  });

  it("searches files and entries with their paths", () => {
    expect(searchTree(tree, "dirt").map((h) => h.where)).toEqual(["audio/dirt", "audio/steps › dirt"]);
    expect(searchTree(tree, "")).toEqual([]);
  });
});

describe("tree drops", () => {
  const src = { kind: "file", path: "music/engine.playlist.json" } as const;

  it("reads zones from the pointer's place in a row", () => {
    expect(dropZone(0.1, { folder: false })).toBe("before");
    expect(dropZone(0.5, { folder: false })).toBe("into");
    expect(dropZone(0.9, { folder: false })).toBe("after");
    expect(dropZone(0.1, { folder: true })).toBe("into");
  });

  it("moves files between folders and links them into playlists", () => {
    expect(planDrop(src, { kind: "folder", path: "audio" }, "into", load)).toEqual({ kind: "moveFile", path: src.path, to: "audio" });
    expect(planDrop(src, { kind: "file", path: "audio/dirt.playlist.json" }, "after", load)).toEqual({ kind: "moveFile", path: src.path, to: "audio" });
    expect(planDrop(src, { kind: "file", path: "audio/dirt.playlist.json" }, "into", load)).toEqual({ kind: "link", path: src.path, into: { file: "audio/dirt.playlist.json", indices: [] }, at: 2 });
    expect(planDrop(src, { kind: "folder", path: "music" }, "into", load)).toMatchObject({ kind: "refused" });
  });

  it("refuses parents that can't hold entries and drops that make a cycle", () => {
    const dirt = { kind: "file", path: "audio/dirt.playlist.json" } as const;
    expect(planDrop(dirt, { kind: "file", path: "music/engine.playlist.json" }, "into", load)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/Clip/) });
    // dirt is linked by steps, so steps can't go into dirt.
    expect(planDrop({ kind: "file", path: "audio/steps.playlist.json" }, dirt, "into", load)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/contain itself/) });
    expect(planDrop(dirt, dirt, "into", load)).toMatchObject({ kind: "refused" });
  });

  it("reorders entries in a parent, moves them between parents and takes them out to folders", () => {
    const e0 = { kind: "entry", file: "audio/steps.playlist.json", parent: [], index: 0, link: null } as const;
    const e1 = { kind: "entry", file: "audio/steps.playlist.json", parent: [], index: 1, link: "audio/dirt.playlist.json" } as const;
    expect(planDrop(e0, e1, "after", load)).toEqual({ kind: "moveEntry", from: { file: e0.file, indices: [] }, index: 0, into: { file: e0.file, indices: [] }, at: 1 });
    expect(planDrop(e0, e1, "before", load)).toMatchObject({ kind: "refused" });
    expect(planDrop(e0, { kind: "entry", file: e0.file, parent: [0], index: 0, link: null }, "into", load)).toMatchObject({ kind: "refused" });
    expect(planDrop(e0, { kind: "folder", path: "music" }, "into", load)).toEqual({ kind: "extract", from: { file: e0.file, indices: [] }, index: 0, folder: "music", linked: false });
    // Into the linked dirt (another file).
    expect(planDrop(e0, e1, "into", load)).toMatchObject({ kind: "moveEntry", into: { file: "audio/dirt.playlist.json", indices: [] }, at: 2 });
    expect(dropLabel({ kind: "moveEntry", from: { file: "a", indices: [] }, index: 0, into: { file: "a", indices: [] }, at: 1 }, "x", "y")).toBe("Reorder entries");
  });
});

describe("structure edits", () => {
  it("moves an entry within a file, shifting the target path past the removal", () => {
    const root = of("layer", clipOf("a.wav"), emb(of("queue")), clipOf("c.wav"));
    const next = ok(moveWithinFile(root, [], 0, [1], 0, ctx));
    expect(next.entries).toHaveLength(2);
    expect((next.entries[0] as { embedded: PlaylistBody }).embedded.entries).toHaveLength(1);
    expect(shiftAfterRemoval([2, 0], [], 0)).toEqual([1, 0]);
    expect(shiftAfterRemoval([0, 3], [], 0)).toBeNull();
    // Same parent: a reorder.
    expect(ok(moveWithinFile(root, [], 0, [], 2, ctx)).entries[2]).toBe(root.entries[0]);
  });

  it("moves an entry across files", () => {
    const r = ok(moveAcrossFiles(project["audio/dirt.playlist.json"]!, { file: "d", indices: [] }, 0, of("layer"), { file: "l", indices: [] }, 0, ctx));
    expect(r.source.entries).toHaveLength(1);
    expect(r.target.entries).toHaveLength(1);
  });

  it("unlinks or removes every link to a deleted file, at any depth", () => {
    const b = of("layer", link("x.playlist.json"), emb(of("queue", link("x.playlist.json"), clipOf("a.wav"))));
    expect(countLinks(b, "x.playlist.json")).toBe(2);
    const removed = replaceLinks(b, "x.playlist.json", "remove", null);
    expect(countLinks(removed, "x.playlist.json")).toBe(0);
    expect(removed.entries).toHaveLength(1);
    const unlinked = replaceLinks(b, "x.playlist.json", "unlink", of("queue", clipOf("z.wav")));
    expect(unlinked.entries[0]!.kind).toBe("embedded");
    expect(replaceLinks(b, "y.playlist.json", "remove", null)).toBe(b);
  });

  it("plans deletes with children and links, and moves children up", () => {
    const linkedBy = (p: string) => linkedByIndex(Object.keys(project), load).get(p) ?? [];
    expect(planDelete({ kind: "file", path: "audio/dirt.playlist.json" }, "dirt", load, linkedBy)).toMatchObject({ children: 2, embedded: 2, linkedBy: ["audio/steps.playlist.json"] });
    expect(planDelete({ kind: "entry", file: "audio/steps.playlist.json", parent: [], index: 0 }, "Switch 1", load, linkedBy)).toMatchObject({ children: 1, linkedBy: [] });
    const steps = project["audio/steps.playlist.json"]!;
    const up = ok(deleteEntry(steps, [], 0, "up", ctx));
    expect(up.entries.map((e) => e.kind)).toEqual(["linked", "embedded"]);
    expect(ok(deleteEntry(steps, [], 0, "all", ctx)).entries).toHaveLength(1);
    expect(childrenToKeep(steps).map((c) => c.index)).toEqual([0]);
  });
});

describe("add dialog", () => {
  const items = addItems(files, "audio/dirt.playlist.json", "queue", load);

  it("lists samples and playlists, disabling cycles and the playlist itself", () => {
    expect(items.map((i) => i.path)).toEqual(["audio/a.wav", "audio/d1.wav", "audio/dirt.playlist.json", "audio/steps.playlist.json", "audio/sub/x.sample.json", "music/engine.playlist.json"]);
    expect(items.find((i) => i.path === "audio/dirt.playlist.json")!.disabled).toMatch(/contain itself/);
    expect(items.find((i) => i.path === "audio/steps.playlist.json")!.disabled).toBe("steps already contains dirt");
    expect(items.find((i) => i.path === "music/engine.playlist.json")!.disabled).toBeNull();
    expect(addItems(files, "music/engine.playlist.json", "clip", load).filter((i) => i.kind !== "sample").every((i) => i.disabled)).toBe(true);
  });

  it("filters with counts and picks one or several", () => {
    expect(filterCounts(items, "")).toEqual({ all: 6, samples: 3, playlists: 3, sequences: 0, generators: 0 });
    expect(filterItems(items, "sub", "samples").map((i) => i.path)).toEqual(["audio/sub/x.sample.json"]);
    const a = items[0]!, b = items[1]!, self = items[2]!;
    expect(togglePick([], a, false, false)).toEqual([a.path]);
    expect(togglePick([a.path], b, true, false)).toEqual([a.path, b.path]);
    expect(togglePick([a.path], b, true, true)).toEqual([b.path]);
    expect(togglePick([a.path], self, true, false)).toEqual([a.path]);
  });

  it("picks a Shift-click range, either way, skipping what can't be added", () => {
    const [a, b, self] = [items[0]!, items[1]!, items[2]!];
    expect(pickRange([], items, 0, 2)).toEqual(self.disabled ? [a.path, b.path] : [a.path, b.path, self.path]);
    expect(pickRange([b.path], items, 1, 0)).toEqual([b.path, a.path]);
  });

  it("adds samples, links or copies", () => {
    const e = entriesFor(["audio/a.wav", "music/engine.playlist.json"], items, "link", load);
    expect(e.map((x) => x.kind)).toEqual(["sample", "linked"]);
    expect(entriesFor(["music/engine.playlist.json"], items, "copy", load)[0]!.kind).toBe("embedded");
    expect(addLabel(1)).toBe("Add entry");
    expect(addLabel(3)).toBe("Add 3 entries");
  });
});

describe("library", () => {
  it("groups samples by folder and searches by path", () => {
    expect(isSamplePath("a.WAV")).toBe(true);
    expect(isSamplePath("a.playlist.json")).toBe(false);
    const all = libraryGroups(files);
    expect(all.groups.map((g) => g.folder)).toEqual(["audio", "audio/sub"]);
    expect(all.groups[1]!.samples[0]).toEqual({ path: "audio/sub/x.sample.json", name: "x", derived: true });
    expect(libraryGroups(files, "d1").shown).toBe(1);
    expect(libraryGroups(files, "wav", 1)).toMatchObject({ total: 2, shown: 1 });
    expect(sampleFromDrag(sampleDragText("audio/a.wav"))).toBe("audio/a.wav");
    expect(sampleFromDrag("other")).toBeNull();
  });
});

describe("voice log", () => {
  const snap = (time: number, voices: DebugSnapshot["voices"], refusals: { playlist: string; reason: string; time: number }[] = []): DebugSnapshot => ({
    time, events: [{ id: 7, asset: "p.playlist.json", voices: voices.length }, { id: 8, asset: "other.playlist.json", voices: 0 }], voices, playlistTotals: { recentRefusals: refusals },
  });
  const v = (id: number, event = 7, gain = 1) => ({ id, clip: `c${id}.wav`, bus: "Master", state: "playing", gain, playheadSeconds: 0, event });

  it("starts, updates and finishes voices of the asset's instances only", () => {
    let log = updateLog([], snap(1, [v(1), v(2, 8)]), "p.playlist.json");
    expect(log.map((r) => r.key)).toEqual(["v1:7"]);
    expect(voicesNow(snap(1, [v(1), v(2, 8)]), "p.playlist.json")).toHaveLength(1);
    log = updateLog(log, snap(1.5, [v(1, 7, 0.5), v(3)]), "p.playlist.json");
    expect(log[0]!.gainDb).toBeCloseTo(-6.02, 1);
    log = updateLog(log, snap(2, [v(3)], [{ playlist: "p.playlist.json", reason: "cooldown", time: 1.9 }]), "p.playlist.json");
    expect(log.map((r) => [r.key, r.status, r.end])).toEqual([["v1:7", "finished", 2], ["v3:7", "playing", null], ["r1.9", "refused", 1.9]]);
    // A refusal is logged once.
    expect(updateLog(log, snap(2.1, [v(3)], [{ playlist: "p.playlist.json", reason: "cooldown", time: 1.9 }]), "p.playlist.json").filter((r) => r.kind === "refused")).toHaveLength(1);
  });

  it("steps through event times and tells what sounds at a time", () => {
    const log = updateLog(updateLog([], snap(1, [v(1)]), "p.playlist.json"), snap(2, []), "p.playlist.json");
    const times = eventTimes(log);
    expect(times).toEqual([1, 2]);
    expect(stepEvent(times, null, 1)).toBe(1);
    expect(stepEvent(times, 1, 1)).toBe(2);
    expect(stepEvent(times, 2, 1)).toBeNull();
    expect(stepEvent(times, 2, -1)).toBe(1);
    expect(aliveAt(log, 1.5)).toHaveLength(1);
    expect(aliveAt(log, 2)).toHaveLength(0);
  });

  it("keeps the latest trigger's voices for the strip, over its own span", () => {
    const first = updateLog(updateLog([], snap(1, [v(1)]), "p.playlist.json"), snap(2, []), "p.playlist.json");
    const mark = markTrigger(first, 30);
    const log = updateLog(first, snap(30.1, [v(2), v(3)]), "p.playlist.json");
    const rows = triggerRows(log, mark);
    expect(rows.map((r) => r.key)).toEqual(["v2:7", "v3:7"]);
    expect(triggerRows(log, null)).toHaveLength(3);
    // Still playing (no known end): a strip wider than the time so far, so the playhead moves across it.
    expect(triggerSpan(rows, mark, 31)).toEqual([30, 32]);
    expect(triggerSpan(rows, mark, 33.5)).toEqual([30, 34]);
    expect(triggerSpan(rows, mark, 40)).toEqual([30, 45]);
    // Every voice ended: the strip is the trigger's own length.
    const done = triggerRows(updateLog(log, snap(32.5, []), "p.playlist.json"), mark);
    expect(triggerSpan(done, mark, 50)).toEqual([30, 32.5]);
    expect(triggerSpan([], mark, 50)).toBeNull();
  });
});
