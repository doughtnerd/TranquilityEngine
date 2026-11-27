// The Samples screen's models: source/timeline time, every edit's rule and undo label, the file diff, revert, Detach,
// the write summary and the merge review, the timeline's derived structure, snapping, tap tempo, the loop seam, the
// import plan and the library tree.
import { describe, expect, it } from "vitest";
import { defaultSampleEdits } from "../../../engine/audio/sample/format";
import type { SampleEdits, SampleLoop, SampleMarker } from "../../../engine/audio/sample/types";
import type { WavMetadata } from "../../../engine/audio/sample/wavChunks";
import { destinationFolder, destinationPath, guessKind, importedMessage, kindOn, kindsFound, sampleBlockFor } from "./importPlan";
import {
  addLoop, addMarker, clipAfterGain, closeGap, convertMarker, deleteMarker, loopGaps, moveLoop, moveMarker, normalizeGain, normalizeGainText, normalizeTargetText, refusalOf, removeLoop, setNormalize,
  setRoot, setTempo, setTrim, slideLoop, snip, snippets, tapeSnippet, toggleSnippet, updateLoop, updateMarker, type SampleEdit,
} from "./sampleEditing";
import { applyMerge, changedCount, detachAll, loopDiff, markerDiff, mergeRows, revertLoop, revertMarker, summarizeMerge, writeSummary, wroteText } from "./sampleFile";
import { allSamples, audioFolders, cleanPath, fileChip, folderChoices, libraryTree, metaLine, sampleName, searchSamples, shortLength, usesOf } from "./sampleLibrary";
import { editedLength, inClosedGap, toSource, toView } from "./sampleTime";
import {
  colourCss, colourValue, fitToSource, landmarks, liveSelection, loopLabel, loopRegions, MARKER_PRESETS, markerColour, nextMarker, shortSeconds, musicalSpans, outlineGroups, packMarkerRows, parseSelection, parseSnapStep, regionAt, sampleWarnings, selectionKey, selectionSpan,
  snapTime, snippetMenu, snippetUnder, trimHoldingMarkers,
} from "./sampleView";
import { nearestZeroCrossing, seamJump, seamStrip, seamWindow } from "./seam";
import { addTap, tapDots, tapResult } from "./tapTempo";
import { effectCategories, effectEdits, effectSummary, freezeEdit, searchEffects } from "./sampleEffects";
import { planPlay, planSeam, PLAY_MODES, playModeInfo, playModeRefusal, showsMusicModes } from "./sampleTransport";

const LEN = 2.6;
const next = (r: SampleEdit): SampleEdits => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};
const label = (r: SampleEdit) => ("label" in r ? r.label : `refused: ${r.refused}`);

function loop(id: string, start: number, end: number, extra: Partial<SampleLoop> = {}): SampleLoop {
  return { id, start, end, direction: "forward", crossfadeMs: 20, count: 0, active: "held", exit: "finish", exitFadeMs: 40, reentry: "ignore", file: null, ...extra };
}
function marker(id: string, at: number, extra: Partial<SampleMarker> = {}): SampleMarker {
  return { id, type: "note", name: id, at, file: null, ...extra };
}
const skid = (): SampleEdits => ({
  ...defaultSampleEdits("sustain"),
  loops: [loop("l1", 0.45, 1.55, { crossfadeMs: 35, file: { chunk: "smpl", index: 0, start: 0.45, end: 1.55, direction: "forward", count: 0 } })],
  markers: [
    marker("m1", 0.3, { type: "cue", name: "brake_lockup" }),
    marker("m2", 0.32, { name: "Lock-up", file: { chunk: "cue", id: 1, at: 0.32, name: "Lock-up" } }),
    marker("m3", 1.7, { name: "Release", file: { chunk: "cue", id: 2, at: 1.7, name: "Release" } }),
  ],
});

describe("source and timeline time", () => {
  const gaps: [number, number][] = [[1, 0.5]];
  it("maps through closed gaps both ways", () => {
    expect(toView(0.5, gaps)).toBe(0.5);
    expect(toView(2, gaps)).toBe(1.5);
    expect(toView(1.2, gaps)).toBe(1); // inside the gap: at the join
    expect(toSource(1.5, gaps)).toBe(2);
    expect(toSource(0.9, gaps)).toBe(0.9);
    expect(editedLength(LEN, gaps)).toBeCloseTo(2.1, 9);
    expect(inClosedGap(1.2, gaps)).toBe(true);
    expect(inClosedGap(1, gaps)).toBe(false);
  });
});

describe("markers", () => {
  it("adds a note named Marker N and labels the step", () => {
    const r = addMarker(skid(), 1, LEN);
    expect(label(r)).toBe("Add Marker 4");
    expect(next(r).markers.map((m) => m.at)).toEqual([0.3, 0.32, 1, 1.7]);
    expect(refusalOf(addMarker(skid(), 3, LEN))).toBe("that's outside the sample");
  });

  it("moves a marker, a range with its end, and refuses a range under 10 ms", () => {
    expect(label(moveMarker(skid(), "m1", 0.5, LEN))).toBe("Move brake_lockup");
    const ranged = next(convertMarker(skid(), "m3", LEN));
    expect(ranged.markers.find((m) => m.id === "m3")).toMatchObject({ at: 1.7, end: 1.96 });
    const moved = next(moveMarker(ranged, "m3", 2.5, LEN));
    expect(moved.markers.find((m) => m.id === "m3")).toMatchObject({ at: 2.34, end: 2.6 });
    expect(refusalOf(moveMarker(ranged, "m3", 1.7, LEN, 1.705))).toMatch(/at least 10 ms/);
  });

  it("gives Exit and Hit point fixed names and drops a range and colour off a note", () => {
    const e = next(updateMarker(next(convertMarker(skid(), "m3", LEN)), "m3", { color: 2 }));
    const r = updateMarker(e, "m3", { type: "exit" });
    expect(label(r)).toBe("Make Release an exit");
    const m = next(r).markers.find((x) => x.id === "m3")!;
    expect(m).toMatchObject({ type: "exit", name: "Exit" });
    expect(m.end).toBeUndefined();
    expect(m.color).toBeUndefined();
    expect(refusalOf(updateMarker(next(r), "m3", { name: "Out" }))).toBe("Exit has a fixed name");
    expect(label(updateMarker(skid(), "m1", { name: "skid_start" }))).toBe("Rename brake_lockup to skid_start");
    expect(label(updateMarker(skid(), "m1", { note: "Smoke" }))).toBe("Note on brake_lockup");
    expect(refusalOf(updateMarker(skid(), "m1", { color: 3 }))).toBe("only a note has its own colour");
    expect(refusalOf(convertMarker(skid(), "m1", LEN))).toBe("only a note can be a range");
    expect(label(deleteMarker(skid(), "m2"))).toBe("Delete Lock-up");
  });
});

describe("loops", () => {
  it("adds a loop in the largest gap, 60 % of it, centred", () => {
    const e = defaultSampleEdits();
    const r = addLoop(e, 2);
    expect(label(r)).toBe("Add loop");
    expect(next(r).loops[0]).toMatchObject({ start: 0.4, end: 1.6, active: "held", direction: "forward", crossfadeMs: 20 });
    const two = next(addLoop(skid(), LEN, 2));
    expect(two.loops).toHaveLength(2);
    expect(two.loops[1].start).toBeGreaterThan(1.55);
    expect(refusalOf(addLoop({ ...skid(), loops: [loop("l1", 0.02, 2.58)] }, LEN))).toBe("Not enough room for a loop there");
    expect(loopGaps(skid(), LEN)).toEqual([[0, 0.44], [1.56, LEN]]);
  });

  it("clamps a moved loop between its neighbours and the trim, and allows a hold point", () => {
    const e = { ...skid(), loops: [loop("a", 0.2, 0.6), loop("b", 1, 1.4)] };
    expect(next(moveLoop(e, "b", 0.4, 1.4, LEN)).loops[1].start).toBe(0.61);
    expect(next(moveLoop(e, "b", 1.2, 1.2, LEN)).loops[1]).toMatchObject({ start: 1.2, end: 1.2 });
    expect(label(moveLoop(e, "b", 1.1, 1.3, LEN))).toBe("Move loop 2");
    const trimmed = { ...e, trim: [0.1, 2] as [number, number] };
    expect(next(moveLoop(trimmed, "b", 1, 2.5, LEN)).loops[1].end).toBe(1.99);
    expect(next(slideLoop(e, "a", -1, LEN)).loops[0]).toMatchObject({ start: 0, end: 0.4 });
  });

  it("edits settings within their limits and removes", () => {
    const r = updateLoop(skid(), "l1", { crossfadeMs: 900, count: 3, exit: "jump" });
    expect(label(r)).toBe("Edit loop 1");
    expect(next(r).loops[0]).toMatchObject({ crossfadeMs: 500, count: 3, exit: "jump" });
    expect(label(removeLoop(skid(), "l1"))).toBe("Remove loop");
  });
});

describe("trim", () => {
  it("must hold every loop with 10 ms to spare; the whole file is no trim", () => {
    expect(next(setTrim(skid(), 0.02, 2.58, LEN)).trim).toEqual([0.02, 2.58]);
    expect(refusalOf(setTrim(skid(), 0.45, 2.5, LEN))).toBe("The trim start has to be before the first loop");
    expect(refusalOf(setTrim(skid(), 0, 1.55, LEN))).toBe("The trim end has to be after the last loop");
    expect(refusalOf(setTrim(defaultSampleEdits(), 1, 1.005, LEN))).toBe("The trim needs some length");
    expect(next(setTrim(skid(), -1, 9, LEN)).trim).toBeNull();
  });
});

describe("tempo, root, normalize", () => {
  it("validates tempo and root", () => {
    expect(next(setTempo(skid(), { bpm: 120.04, meter: "6/8" })).tempo).toMatchObject({ bpm: 120, meter: "6/8", source: "set" });
    expect(refusalOf(setTempo(skid(), { bpm: 500, meter: "4/4" }))).toMatch(/20–400/);
    expect(next(setRoot(skid(), { note: "F#3", cents: -12.4 })).root).toEqual({ note: "F#3", cents: -12, source: "set" });
    expect(refusalOf(setRoot(skid(), { note: "H2", cents: 0 }))).toMatch(/C4/);
    expect(refusalOf(setRoot(skid(), { note: "C4", cents: 60 }))).toMatch(/50 cents/);
  });

  it("stores gain = target − measured and warns about clipping", () => {
    const measured = { integrated: -19.5, peak: -2 };
    expect(normalizeGain("loudness", -16, measured)).toBe(3.5);
    expect(normalizeGain("peak", -1, measured)).toBe(1);
    // Written with a true minus, as every other number (journeys walk 2, J2.6).
    expect(normalizeTargetText({ mode: "loudness", target: -16 })).toBe("−16 LUFS");
    expect(normalizeTargetText({ mode: "peak", target: -1 })).toBe("−1 dBFS");
    expect([normalizeGainText(7), normalizeGainText(-3.5)]).toEqual(["+7.0 dB", "−3.5 dB"]);
    expect(next(setNormalize(skid(), "loudness", -16, measured)).normalize).toEqual({ mode: "loudness", target: -16, gainDb: 3.5 });
    expect(refusalOf(setNormalize(skid(), "loudness", -16, null))).toMatch(/measured/);
    expect(refusalOf(setNormalize(skid(), "peak", 3, measured))).toMatch(/-12 to 0/);
    expect(next(setNormalize(skid(), "off", undefined, null)).normalize.gainDb).toBe(0);
    expect(clipAfterGain(-2, 3.5)).toBe(1.5);
    expect(clipAfterGain(-2, 1)).toBeNull();
  });
});

describe("razor and closed gaps", () => {
  it("snips, refusing near the ends and next to a cut, and lists snippets", () => {
    let e = next(snip(defaultSampleEdits(), 1, 2));
    expect(label(snip(defaultSampleEdits(), 1, 2))).toBe("Snipped at 1.000 s");
    e = next(snip(e, 1.5, 2));
    expect(snippets(e, 2).map((s) => [s.start, s.end])).toEqual([[0, 1], [1, 1.5], [1.5, 2]]);
    expect(refusalOf(snip(e, 1.001, 2))).toBe("Already snipped at 1.000 s");
    expect(refusalOf(snip(e, 0.002, 2))).toMatch(/too close/);
  });

  it("finds the snippet under a click and builds its menu", () => {
    const e = next(snip(next(snip(defaultSampleEdits(), 1, 2)), 1.5, 2));
    expect(snippetUnder(defaultSampleEdits(), 2, 0.5)).toBeNull(); // no cuts: no snippets
    expect(snippetUnder(e, 2, 0.5)?.index).toBe(1);
    expect(snippetUnder(e, 2, 1.2)?.index).toBe(2);
    expect(snippetUnder(e, 2, 2)?.index).toBe(3); // the very end belongs to the last
    const menu = (x: SampleEdits, i: number) => snippetMenu(x, 2, i).map((m) => [m.label, m.refused]);
    expect(menu(e, 1)).toEqual([
      ["Save as sample…", null],
      ["Tape to the left", "there's no snippet on that side"],
      ["Tape to the right", null],
      ["Delete", null],
      ["Delete and close gap", null],
    ]);
    const deleted = next(toggleSnippet(e, 2, 2));
    expect(menu(deleted, 2)).toEqual([
      ["Save as sample…", null],
      ["Tape to the left", "Restore the deleted snippet before taping it"],
      ["Tape to the right", "Restore the deleted snippet before taping it"],
      ["Restore", null],
      ["Close gap", null],
    ]);
    expect(snippetMenu(e, 2, 9)).toEqual([]);
  });

  it("deletes, restores and tapes snippets; a cut in a deleted one keeps both halves deleted", () => {
    let e = next(snip(next(snip(defaultSampleEdits(), 1, 2)), 1.5, 2));
    const del = toggleSnippet(e, 2, 2);
    expect(label(del)).toBe("Delete Snippet 2");
    e = next(del);
    expect(refusalOf(tapeSnippet(e, 2, "left", 2))).toBe("Restore the deleted snippet before taping it");
    const cut = next(snip(e, 1.25, 2));
    expect(snippets(cut, 2).filter((s) => s.deleted).map((s) => s.start)).toEqual([1, 1.25]);
    expect(label(tapeSnippet(next(toggleSnippet(e, 2, 2)), 2, "left", 2))).toBe("Tape Snippet 1 + Snippet 2");
  });

  it("closes a gap: drops what's inside, records it in source time, and labels the step", () => {
    let e: SampleEdits = { ...defaultSampleEdits(), markers: [marker("a", 1.2), marker("b", 1.8)], loops: [loop("x", 1.1, 1.3)] };
    e = next(snip(next(snip(e, 1, 2)), 1.4, 2));
    const r = closeGap(e, 2, 2);
    expect(label(r)).toBe("Close gap · 0.40 s");
    expect("removed" in r && r.removed).toBe(2);
    const n = next(r);
    expect(n.closedGaps).toEqual([[1, 0.4]]);
    expect(n.markers.map((m) => m.id)).toEqual(["b"]);
    expect(n.loops).toEqual([]);
    expect(snippets(n, 2).map((s) => s.name)).toEqual(["Snippet 1", "Snippet 2"]);
    expect(toView(1.8, n.closedGaps)).toBeCloseTo(1.4, 9);
  });
});

describe("file diff, revert, detach, write and merge", () => {
  it("lists what differs from the file and reverts per field", () => {
    const e = next(moveMarker(skid(), "m2", 0.4, LEN));
    const m2 = e.markers.find((m) => m.id === "m2")!;
    expect(markerDiff(m2)).toEqual([{ field: "at", file: 0.32, project: 0.4 }]);
    expect(changedCount(e)).toBe(1);
    expect(next(revertMarker(e, "m2", "at")).markers.find((m) => m.id === "m2")!.at).toBe(0.32);
    const exit = next(updateMarker(skid(), "m2", { type: "exit" }));
    const back = next(revertMarker(exit, "m2", "type")).markers.find((m) => m.id === "m2")!;
    expect(back).toMatchObject({ type: "note", name: "Lock-up" });
    const moved = next(moveLoop(skid(), "l1", 0.5, 1.5, LEN));
    expect(loopDiff(moved.loops[0]).map((r) => r.field)).toEqual(["start", "end"]);
    expect(next(revertLoop(moved, "l1")).loops[0]).toMatchObject({ start: 0.45, end: 1.55 });
    expect(refusalOf(revertMarker(skid(), "m1"))).toBe("that marker isn't from the file");
  });

  it("detaches everything, file tempo and root becoming set values", () => {
    const e = { ...skid(), tempo: { bpm: 120, meter: "4/4", map: [], source: "file" as const } };
    const d = next(detachAll(e));
    expect(d.markers.every((m) => m.file === null) && d.loops.every((l) => l.file === null)).toBe(true);
    expect(d.tempo?.source).toBe("set");
    expect(refusalOf(detachAll(d))).toBe("nothing here tracks the file");
  });

  it("summarises the write; types the WAV can't carry stay in the sidecar", () => {
    const s = writeSummary(skid());
    expect(s.rows[0]).toEqual({ what: "2 cue points", chunks: "cue + labl + note" });
    expect(s.rows[2].what).toBe("1 loop");
    expect(s.keptInSidecar).toBe(1);
  });

  it("says it removes loops or a tempo only when the file has them, and counts in the singular (journeys walk 2, J2.7)", () => {
    const none = { ...skid(), loops: [], tempo: null };
    expect(writeSummary(none, { loops: 0, tempo: false }).rows.slice(2, 4).map((r) => r.what)).toEqual(["No loops", "No tempo"]);
    expect(writeSummary(none, { loops: 2, tempo: true }).rows.slice(2, 4).map((r) => r.what)).toEqual(["No loops (removes the file's 2 loops)", "No tempo (removes the file's tempo)"]);
    expect(wroteText("brake_skid.wav", { cues: 1, regions: 0, loops: 1 })).toBe("Wrote brake_skid.wav · 1 cue, 0 regions and 1 loop (backup kept)");
  });

  it("builds the merge review and applies choices", () => {
    const now: WavMetadata = {
      sampleRate: 1000, frames: 2600, channels: 1, root: null, tempo: null, bext: null, regions: [],
      cues: [{ id: 1, frame: 350, label: "Lock-up", note: "" }, { id: 2, frame: 1700, label: "Release", note: "" }, { id: 3, frame: 2000, label: "Stop", note: "" }],
      loops: [{ cueId: 0, type: 0, start: 450, end: 1500, fraction: 0, playCount: 0 }],
    };
    const edited = next(moveMarker(skid(), "m2", 0.4, LEN)); // the project moved Lock-up too
    const rows = mergeRows(edited, now);
    expect(rows.map((r) => [r.title, r.conflict, r.choice])).toEqual([
      ["Moved cue", true, "project"],
      ["New cue", false, "add"],
      ["Loop end moved", false, "file"],
    ]);
    expect(summarizeMerge(rows)).toBe("2 cue changes and the loop end moved.");
    const merged = next(applyMerge(edited, rows, "brake_skid.wav"));
    expect(merged.markers.find((m) => m.id === "m2")).toMatchObject({ at: 0.4, file: { at: 0.35 } });
    expect(merged.markers.some((m) => m.name === "Stop")).toBe(true);
    expect(merged.loops[0]).toMatchObject({ end: 1.5, file: { end: 1.5 } });
  });

  it("matches a moved file loop to a project loop that has no file snapshot", () => {
    const untracked: SampleEdits = { ...defaultSampleEdits("sustain"), loops: [loop("l1", 0.45, 1.55)] };
    const meta = (end: number): WavMetadata => ({
      sampleRate: 1000, frames: 2600, channels: 1, root: null, tempo: null, bext: null, regions: [], cues: [],
      loops: [{ cueId: 0, type: 0, start: 450, end, fraction: 0, playCount: 0 }],
    });
    expect(mergeRows(untracked, meta(1550))).toEqual([]); // the file says what the project has: nothing to review
    const rows = mergeRows(untracked, meta(1600));
    expect(rows.map((r) => [r.title, r.detail, r.conflict, r.choice, r.id])).toEqual([["Loop end moved", "0.450 s – 1.550 s → 0.450 s – 1.600 s", false, "file", "l1"]]);
    const merged = next(applyMerge(untracked, rows, "engine-idle.wav"));
    expect(merged.loops).toHaveLength(1);
    expect(merged.loops[0]).toMatchObject({ id: "l1", end: 1.6, file: { index: 0, end: 1.6 } });
  });
});

describe("timeline structure", () => {
  it("derives Pickup, loops, links and Tail", () => {
    const e = { ...skid(), loops: [loop("a", 0.2, 0.6), loop("b", 1, 1.4, { active: "always", count: 2 })] };
    expect(loopRegions(e, 2).map((r) => r.label)).toEqual(["Pickup", "Loop 1 · while held", "Link", "Loop 2", "Tail"]);
    expect(regionAt(e, 2, 0.3)).toBe("loop 1 (while held)");
    expect(regionAt(e, 2, 0.8)).toBe("link");
    // The next marker is by time, whatever order the markers were added in (journeys walk 2, V4).
    const late = { ...e, markers: [{ ...e.markers[0]!, id: "late", at: 1.5 }, { ...e.markers[0]!, id: "soon", at: 0.9 }] };
    expect(nextMarker(late, 0.5)?.id).toBe("soon");
    expect(nextMarker(late, 1.6)).toBeNull();
    expect(selectionSpan({ kind: "tail" }, e, 2)).toEqual({ start: 1.4, end: 2 });
    expect(selectionSpan({ kind: "marker", id: "m1" }, e, 2)).toEqual({ start: 0.3, end: 2 });
    expect(landmarks(e, 2)).toContain(1.4);
  });

  it("round-trips selections through the route and drops gone ones", () => {
    for (const s of [{ kind: "marker", id: "m1" }, { kind: "loop", id: "l1" }, { kind: "snippet", index: 2 }, { kind: "trim" }] as const) expect(parseSelection(selectionKey(s))).toEqual(s);
    expect(parseSelection("nonsense")).toEqual({ kind: "sample" });
    expect(liveSelection({ kind: "marker", id: "zz" }, skid(), LEN)).toEqual({ kind: "sample" });
  });

  it("packs marker labels into rows", () => {
    const rows = packMarkerRows(skid().markers, (t) => t * 100, (n) => n.length * 6);
    expect(rows.get("m1")).toBe(0);
    expect(rows.get("m2")).toBe(1); // 2 px later: overlaps brake_lockup
    expect(rows.get("m3")).toBe(0);
  });

  it("warns about markers outside the trim, seams that may click and edits past the source", () => {
    const e = { ...skid(), trim: [0.31, 2.5] as [number, number] };
    const w = sampleWarnings(e, LEN, new Map([["l1", 4.2]]));
    expect(w.map((x) => x.text)).toEqual(["1 marker outside the trim won't play"]); // a 35 ms crossfade hides the seam
    const thin = { ...e, loops: [{ ...e.loops[0], crossfadeMs: 10 }] };
    expect(sampleWarnings(thin, LEN, new Map([["l1", 4.2]])).map((x) => x.id)).toEqual(["outside", "seam:l1"]);
    expect(trimHoldingMarkers(e, LEN)).toEqual([0.3, 2.5]);
    expect(sampleWarnings(skid(), 1.6).map((x) => x.id)).toEqual(["past"]);
    expect(fitToSource(skid(), 1.6).markers.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("groups the outline and filters it", () => {
    const g = outlineGroups(skid(), LEN);
    // Spec §4.1.4: markers by type, Loops with the pickup, links and tail, Snippets, and the Trim.
    expect(g.map((x) => x.title)).toEqual(["Cues", "Entries", "Exits", "Hit points", "Loops", "Notes", "Snippets", "Trim"]);
    expect(g.find((x) => x.id === "notes")!.items.map((i) => i.name)).toEqual(["Lock-up", "Release"]);
    expect(g.find((x) => x.id === "loops")!.items.map((i) => [i.name, i.at, i.end])).toEqual([["Pickup", 0, 0.45], ["Loop 1", 0.45, 1.55], ["Tail", 1.55, LEN]]);
    expect(g.find((x) => x.id === "loops")!.items[1]).toMatchObject({ fromFile: true, active: "held", color: "var(--range-loop)" });
    expect(g.find((x) => x.id === "cues")!.items[0]).toMatchObject({ name: "brake_lockup", at: 0.3, color: "var(--marker-cue)", outside: false });
    expect(g.find((x) => x.id === "trim")!.items[0]).toMatchObject({ at: 0, end: LEN });
    const filtered = outlineGroups(skid(), LEN, "rel").find((x) => x.id === "notes")!;
    expect(filtered.items.map((i) => i.name)).toEqual(["Release"]);
    expect(filtered.total).toBe(2);
    // Outside the trim is flagged.
    const trimmed = outlineGroups({ ...skid(), trim: [0.3, 2] }, LEN).find((x) => x.id === "notes")!;
    expect(trimmed.items.map((i) => i.outside)).toEqual([false, false]);
    expect(outlineGroups({ ...skid(), trim: [0.4, 1.6] }, LEN).find((x) => x.id === "notes")!.items.map((i) => [i.name, i.outside])).toEqual([["Lock-up", true], ["Release", true]]);
  });

  it("makes a marker an Entry (fixed name), and shades the post-exit tail and the pre-entry inside the trim", () => {
    const e = next(addMarker(defaultSampleEdits(), 0.4, LEN, "entry"));
    expect(e.markers[0]).toMatchObject({ type: "entry", name: "Entry" });
    expect(refusalOf(updateMarker(e, e.markers[0].id, { name: "x" }))).toBe("Entry has a fixed name");
    const note = next(updateMarker(e, e.markers[0].id, { type: "note" }));
    expect(label(updateMarker(note, note.markers[0].id, { type: "entry" }))).toBe(`Make ${note.markers[0].name} an entry`);
    const withExit = { ...e, trim: [0.2, 2.4] as [number, number], markers: [...e.markers, marker("x", 2, { type: "exit" })] };
    expect(musicalSpans(withExit, LEN)).toEqual({ tail: [2, 2.4], preEntry: [0.2, 0.4] });
    expect(musicalSpans({ ...withExit, trim: [0.5, 1.9] }, LEN)).toEqual({ tail: null, preEntry: null }); // both outside the trim
    expect(musicalSpans(defaultSampleEdits(), LEN)).toEqual({ tail: null, preEntry: null });
  });

  it("snaps in ms, samples and beats", () => {
    const ctx = { rate: 48000, bpm: 120 };
    expect(snapTime(0.1234, { on: true, unit: "ms", step: 10 }, ctx)).toBeCloseTo(0.12, 9);
    expect(snapTime(0.1234, { on: true, unit: "samples", step: 1000 }, ctx)).toBeCloseTo(6000 / 48000, 9);
    expect(snapTime(0.3, { on: true, unit: "beats", step: 1 }, ctx)).toBe(0.5);
    expect(snapTime(0.3, { on: true, unit: "beats", step: 1 }, { rate: 48000 })).toBe(0.3);
    expect(snapTime(0.3, { on: false, unit: "ms", step: 100 }, ctx)).toBe(0.3);
    expect(parseSnapStep("1/3", "beats")).toBeCloseTo(1 / 3, 9);
    expect(parseSnapStep("-2", "ms")).toBeNull();
  });
});

describe("marker colours, ruler labels and loop labels", () => {
  it("stores presets as theme series and custom colours as hex, and draws a note in its own colour", () => {
    expect(colourValue("var(--series-3)")).toBe(3);
    expect(colourValue("#6AA8FF")).toBe("#6aa8ff");
    expect(colourValue("var(--accent)")).toBeNull();
    expect(colourCss(6)).toBe("var(--series-6)");
    expect(markerColour({ type: "note", color: 2 })).toBe("var(--series-2)");
    expect(markerColour({ type: "note" })).toBe("var(--marker-note)");
    expect(markerColour({ type: "exit", color: 2 })).toBe("var(--marker-exit)");
    expect(MARKER_PRESETS.map((p) => p.name)).toEqual(["Amber", "Cyan", "Green", "Violet"]);
  });

  it("labels ruler ticks in short seconds and loops with their direction, count and file mark", () => {
    expect([0, 0.3, 2.6, 12, 75, 90.5].map(shortSeconds)).toEqual(["0", "0.3 s", "2.6 s", "12 s", "1:15", "1:30.5"]);
    const e = skid();
    expect(loopLabel(e, e.loops[0])).toBe("▪ ↻ Loop 1");
    expect(loopLabel(e, { ...e.loops[0], file: null, direction: "pingPong", count: 2 })).toBe("↔ Loop 1 ×2");
    expect(loopLabel(e, { ...e.loops[0], end: e.loops[0].start })).toBe("Hold 1");
  });
});

describe("tap tempo", () => {
  it("averages the last 8 intervals and resets after a pause over 2.5 s (spec §4.1.5)", () => {
    let taps: number[] = [];
    for (let i = 0; i < 12; i++) taps = addTap(taps, i * 500);
    expect(taps).toHaveLength(9);
    expect(tapResult(taps)).toEqual({ bpm: 120, steadiness: "steady", taps: 9, usable: true });
    expect(addTap(taps, 5500 + 2400)).toHaveLength(9);
    expect(addTap(taps, 5500 + 2600)).toEqual([8100]);
    expect(tapResult([0])).toBeNull();
    expect(tapResult([0, 500, 1100, 1500])!.steadiness).toBe("uneven");
    // The dot strip: each gap against the average, ±15 % at the ends.
    expect(tapDots([0, 500])).toEqual([]);
    expect(tapDots([0, 500, 1000, 1500])).toEqual([0.5, 0.5, 0.5]);
    const dots = tapDots([0, 460, 1000, 1500]); // gaps 460, 540, 500 around a 500 ms mean
    expect(dots[0]).toBeCloseTo(0.5 - 0.08 / 0.3, 6);
    expect(dots[1]).toBeCloseTo(0.5 + 0.08 / 0.3, 6);
    expect(tapDots([0, 100, 1000])).toEqual([0, 1]);
  });
});

describe("loop seam", () => {
  const rate = 1000;
  // 1 s: a ramp 0 → 1 so the end is louder than the start.
  const pcm = Float32Array.from({ length: 1000 }, (_, i) => (i / 1000) * (i % 2 ? 1 : -1));
  const p = { pcm, channels: 1, rate };
  it("sizes the window and measures the jump across the seam", () => {
    expect(seamWindow(0, 0.12)).toBe(0.04);
    expect(seamWindow(0, 6)).toBe(0.12);
    expect(seamJump(p, 0.2, 0.8)).toBeLessThan(-10);
    const strip = seamStrip(p, 0.2, 0.8, 0, 100);
    expect(strip.seam).toBe(50);
    expect(Math.abs(strip.values[49])).toBeGreaterThan(Math.abs(strip.values[51]));
  });
  it("finds the nearest zero crossing", () => {
    const sine = { pcm: Float32Array.from({ length: 1000 }, (_, i) => Math.sin((2 * Math.PI * 10 * i) / 1000)), channels: 1, rate };
    expect(nearestZeroCrossing(sine, 0.052)).toBeCloseTo(0.05, 3);
  });
});

describe("import plan", () => {
  const meta: WavMetadata = {
    sampleRate: 1000, frames: 3000, channels: 1, bext: null, tempo: null, root: { midiNote: 48, cents: 0 },
    cues: [{ id: 1, frame: 100, label: "Creak start", note: "" }], regions: [{ id: 2, frame: 500, length: 500, label: "Creak", note: "", purpose: "rgn ", text: "" }],
    loops: [{ cueId: 0, type: 0, start: 1000, end: 2000, fraction: 0, playCount: 0 }],
  };
  it("lists the kinds found and builds the sidecar block less what's off", () => {
    expect(kindsFound([{ rel: "door.wav", meta }, { rel: "x.mp3", meta: null }]).map((k) => [k.kind.id, k.items])).toEqual([["cues", 1], ["regions", 1], ["loops", 1], ["root", 1], ["detect", 2]]);
    const all = sampleBlockFor(meta, {})!;
    expect(all.markers.map((m) => m.name)).toEqual(["Creak start", "Creak"]);
    expect(all.kind).toBe("sustain");
    expect(all.root?.note).toBe("C3");
    const some = sampleBlockFor(meta, { regions: false, loops: false })!;
    expect(some.markers.map((m) => [m.id, m.name])).toEqual([["m1", "Creak start"]]);
    expect(some.loops).toEqual([]);
    expect(sampleBlockFor(meta, { cues: false, regions: false, loops: false, root: false })).toBeNull();
    expect(kindOn({}, "detect")).toBe(true);
    expect(guessKind({ loops: [], tempo: { bpm: 1, meter: "4/4", map: [], source: "file" } })).toBe("music");
  });
  it("places files keeping their folders or flat", () => {
    expect(destinationFolder("audio", "Footsteps/Dirt/a.wav", true)).toBe("audio/Footsteps/Dirt");
    expect(destinationPath("audio", "Footsteps/Dirt/a.wav", false)).toBe("audio/a.wav");
    expect(destinationPath("", "a.wav", true)).toBe("a.wav");
    expect(importedMessage(3, "audio/sfx")).toBe("Imported 3 samples into audio › sfx");
  });
});

describe("library", () => {
  const files = ["audio/sfx/door.wav", "audio/sfx/door.wav.meta.json", "audio/music/hook.ogg", "audio/sfx/door_fork.sample.json", "scenes/main.scene.json", "a.wav"];
  const folders = ["audio", "audio/sfx", "audio/music", "scenes", "empty"];
  it("builds the tree of folders holding samples, and empty folders", () => {
    const t = libraryTree(files, folders);
    expect(t.samples).toEqual(["a.wav"]);
    expect(t.folders.map((f) => f.name)).toEqual(["audio", "empty"]);
    expect(t.folders[0].folders.map((f) => f.name)).toEqual(["music", "sfx"]);
    // By name without the extension: a fork after what it came from (journeys walk 2, J11.3), named without `.sample.json`.
    expect(t.folders[0].folders[1].samples).toEqual(["audio/sfx/door.wav", "audio/sfx/door_fork.sample.json"]);
    expect(t.folders[0].folders[1].samples.map(sampleName)).toEqual(["door.wav", "door_fork"]);
    expect(allSamples(t)).toHaveLength(4);
    expect(searchSamples(files, "DOOR")).toEqual(["audio/sfx/door.wav", "audio/sfx/door_fork.sample.json"]);
  });

  it("leaves flattened renders out (they are source versions) and the game's own folders out of the pickers", () => {
    const withRender = [...files, "audio/sfx/door.flat1.wav"];
    expect(allSamples(libraryTree(withRender, folders))).not.toContain("audio/sfx/door.flat1.wav");
    expect(searchSamples(withRender, "door")).not.toContain("audio/sfx/door.flat1.wav");
    expect(audioFolders(["audio", "audio/sfx", "scenes", "scripts", ".myco", "mine"], ["audio/sfx/door.wav", "scenes/a.scene.json"])).toEqual(["audio", "audio/sfx", "mine"]);
    expect(audioFolders(["scripts", "scripts/vo"], ["scripts/vo/line.wav"])).toEqual(["scripts", "scripts/vo"]);
  });

  it("lists folders for the folder combo, filtered by path, with a new folder to make", () => {
    const fs = ["Vehicles", "Vehicles/HoverBike", "Props"];
    expect(folderChoices(fs, "")).toEqual({ folders: ["", "Props", "Vehicles", "Vehicles/HoverBike"], create: null });
    expect(folderChoices(fs, "hover")).toEqual({ folders: ["Vehicles/HoverBike"], create: "hover" });
    expect(folderChoices(fs, "Vehicles › Hover")).toEqual({ folders: ["Vehicles/HoverBike"], create: "Vehicles/Hover" });
    expect(folderChoices(fs, "props")).toEqual({ folders: ["Props"], create: null });
    expect(cleanPath(" Props / Doors /")).toBe("Props/Doors");
  });

  it("writes meta lines and the file chip", () => {
    expect(metaLine("a.wav", null, 0.34, null)).toBe("One-shot · 340 ms");
    expect(metaLine("a.wav", skid(), 2.6, null)).toBe("Loop · while held · 2.6 s");
    const music = { ...defaultSampleEdits("music"), tempo: { bpm: 120, meter: "4/4", map: [], source: "file" as const } };
    expect(metaLine("h.wav", music, 24, null)).toBe("Music · 12 bars");
    expect(shortLength(72)).toBe("1:12");
    expect(fileChip(skid())).toBe("2 cues · 1 loop");
    expect(fileChip(defaultSampleEdits())).toBeNull();
  });

  it("finds the playlists and derived samples that use a sample", () => {
    const data: Record<string, unknown> = {
      "a.playlist.json": { format: "myco.playlist@1", type: "queue", entries: [{ sample: "audio/sfx/door.wav" }, { sample: "audio/sfx/door.wav" }] },
      "b.playlist.json": { format: "myco.playlist@1", type: "queue", entries: [{ sample: "other.wav" }] },
      "f.sample.json": { format: "myco.sample@1", source: "audio/sfx/door.wav", lineage: { kind: "fork", parent: "audio/sfx/door.wav", mode: "pin" } },
    };
    expect(usesOf("audio/sfx/door.wav", Object.keys(data), (p) => data[p])).toEqual([{ path: "a.playlist.json", count: 1 }, { path: "f.sample.json", count: 1 }]);
  });
});

describe("baked effects chain", () => {
  it("adds, bypasses, reorders, sets parameters and removes, one labelled step each", () => {
    let e = effectEdits.add(defaultSampleEdits(), "eq").next;
    const fades = effectEdits.add(e, "fades");
    expect(fades.label).toBe("Add Fades");
    e = fades.next;
    expect(e.effects.map((f) => f.id)).toEqual(["fx1", "fx2"]);
    expect(effectEdits.bypass(e, "fx1").label).toBe("Bypass EQ");
    const moved = effectEdits.move(e, "fx2", -1);
    expect("next" in moved ? moved.next?.effects.map((f) => f.type) : moved).toEqual(["fades", "eq"]);
    expect("refused" in effectEdits.move(e, "fx1", -1)).toBe(true);
    expect(effectEdits.param(e, "fx1", "low", 3).label).toBe("EQ · Low 3 dB");
    expect(effectEdits.remove(e, "fx1").next.effects).toHaveLength(1);
  });
});

describe("effects menu, summaries and Freeze", () => {
  it("groups the sample-level effects by category, searches them, and summarises a row", () => {
    const cats = effectCategories(["eq", "compressor", "fades", "noiseReduction", "reverse", "gain"]);
    expect(cats.map((c) => [c.name, c.types])).toEqual([["Dynamics", ["compressor", "gain"]], ["EQ & filter", ["eq"]], ["Envelope", ["fades"]], ["Pitch & time", ["reverse"]], ["Restoration", ["noiseReduction"]]]);
    expect(effectCategories(["eq", "chorus"]).map((c) => c.name)).toEqual(["EQ & filter", "Other"]);
    expect(searchEffects(["eq", "compressor", "noiseReduction"], "re")).toEqual([{ type: "compressor", category: "Dynamics" }, { type: "noiseReduction", category: "Restoration" }]);
    expect(effectSummary({ type: "compressor", params: { threshold: -18, ratio: 3, attack: 10 } })).toBe("Threshold −18 dB · Ratio 3:1 · Attack 10 ms");
    expect(effectSummary({ type: "reverse", params: {} })).toBe("whole sample");
  });

  it("freezes and unfreezes the chain, one step each", () => {
    const f = freezeEdit(defaultSampleEdits());
    expect(f).toMatchObject({ label: "Freeze", next: { frozen: true } });
    expect(freezeEdit(f.next)).toMatchObject({ label: "Unfreeze", next: { frozen: false } });
  });
});

describe("play plans", () => {
  it("plays the selection by its kind and the whole-sample modes", () => {
    const e = skid();
    expect(planPlay(e, LEN, { kind: "loop", id: "l1" }, "selection", 0)).toMatchObject({ from: 0.45, to: 1.55, loop: { count: 0, crossfadeMs: 35 }, scope: "Loop 1" });
    expect(planPlay(e, LEN, { kind: "marker", id: "m1" }, "selection", 0)).toMatchObject({ from: 0.3, to: LEN, loop: null, scope: "brake_lockup → end" });
    expect(planPlay({ ...e, loops: [] }, LEN, { kind: "sample" }, "whole", 1)).toMatchObject({ from: 0, to: LEN, scope: "Whole" });
    expect(planPlay(e, LEN, { kind: "sample" }, "whole", 0)).toMatchObject({ from: 0, to: LEN, held: true, loop: { start: 0.45 }, scope: "Whole" });
    expect(planPlay(e, LEN, { kind: "sample" }, "through", 0)).toMatchObject({ from: 0, to: LEN, held: true, loop: { start: 0.45 } });
    expect(planPlay(e, LEN, { kind: "sample" }, "toNextMarker", 0.31)).toMatchObject({ from: 0.31, to: 0.32, scope: "To Lock-up" });
    expect(planPlay(e, LEN, { kind: "sample" }, "selection", 1)).toMatchObject({ from: 1, scope: "From the playhead" });
    expect(planPlay(e, LEN, { kind: "tail" }, "selection", 0)).toMatchObject({ from: 1.55, to: LEN });
  });

  it("names the modes as the spec does and plays the music modes, to next exit and from the selection", () => {
    const e = { ...skid(), markers: [marker("m1", 0.3), { ...marker("x", 2, { type: "exit" as const }) }] };
    expect(PLAY_MODES.map((m) => m.label)).toEqual(["Selection", "Whole", "Cycle loop", "Pickup → loop", "Loop", "Loop → exit", "To next marker", "To next exit", "To trim end"]);
    expect(playModeInfo("through").label).toBe("Whole");
    expect(planPlay(e, LEN, { kind: "sample" }, "loop", 0)).toMatchObject({ from: 0.45, to: 1.55, held: false, scope: "Cycle loop" });
    expect(planPlay(e, LEN, { kind: "sample" }, "pickupLoop", 0)).toMatchObject({ from: 0, to: 1.55, loop: null, scope: "Pickup → loop" });
    expect(planPlay(e, LEN, { kind: "sample" }, "heldLoop", 0)).toMatchObject({ from: 0.45, to: 1.55, held: true, scope: "Loop" });
    expect(planPlay(e, LEN, { kind: "sample" }, "loopExit", 0)).toMatchObject({ from: 0.45, to: LEN, held: true, scope: "Loop → exit" });
    expect(planPlay(e, LEN, { kind: "marker", id: "m1" }, "toNextExit", 0)).toMatchObject({ from: 0.3, to: 2, scope: "To next exit" });
    expect(planPlay(e, LEN, { kind: "marker", id: "m1" }, "toEnd", 0)).toMatchObject({ from: 0.3, to: LEN, scope: "To trim end" });
    expect(playModeRefusal(skid(), "toNextExit")).toBe("no exits");
    expect(playModeRefusal({ ...skid(), loops: [] }, "loop")).toBe("no loops");
    expect(playModeRefusal(e, "toNextExit")).toBeNull();
    expect(showsMusicModes(skid())).toBe(false);
    expect(showsMusicModes({ ...skid(), kind: "music" })).toBe(true);
  });

  it("plays across a seam: the window before the loop's end, then the window after its start, and no more", () => {
    const e = skid(); // loop l1 0.45–1.55 s: the window is 1.1 / 6 s, clamped to 120 ms
    const p = planSeam(e, "l1")!;
    expect(p.from).toBeCloseTo(1.43, 9);
    expect(p.to).toBeCloseTo(0.57, 9);
    expect(p).toMatchObject({ loop: { start: 0.45, end: 1.55, count: 2, crossfadeMs: 35 }, held: false });
    expect(planSeam(e, "gone")).toBeNull();
    const short = { ...e, loops: [loop("s", 1, 1.06)] }; // 60 ms: the window can't pass the middle
    expect(planSeam(short, "s")).toMatchObject({ from: 1.03, to: 1.03 });
  });
});
