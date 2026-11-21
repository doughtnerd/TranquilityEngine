// ADR 0313: the open music node handle the segment view, segment panel and rules table share, driven without Preact: the
// node it reads, edits applied as one undo step of the event's document (a drag's steps merged, a refusal in the status
// bar), and clip facts that start a decode when read and bump the version when it arrives.
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAssetDocument } from "../../../../editor/assetDocuments";
import { joinPath, openFolderProject } from "../../../../editor/projects";
import { currentProject, status } from "../../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../../editor/testing";
import { formatAudioEvent, type AudioEventAsset } from "../../../../engine/audio/eventFormat";
import type { MusicContainerNode, SegmentNode } from "../../../../engine/audio/musicFormat";
import { findMusicSegment } from "../../../../engine/audio/musicTree";
import { useEditorPlugins } from "../../../testEditorPlugins";
import { audioEditorPlugin } from "..";
import { accept, refuse } from "../editResult";
import { musicNodeHandle } from "./musicNodeHandle";
import type { PeakMips } from "./peaksMip";
import { addRule } from "./ruleEdits";
import { switchEvent } from "./ruleFixtures";
import { setTempo } from "./segmentEdits";

useEditorPlugins([audioEditorPlugin], "each");
afterEach(() => {
  vi.useRealTimers();
  status.value = null;
});

const PATH = "music.audioevent.json";

async function openEvent(event: AudioEventAsset = switchEvent([])) {
  const fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  fs.files.set(joinPath(ROOT, PATH), formatAudioEvent(event));
  const project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
  const doc = openAssetDocument<AudioEventAsset>(project, PATH, "audioEvent");
  const file = () => JSON.parse(fs.files.get(joinPath(ROOT, PATH)) as string) as { root: { children: { id: string; tempo?: { bpm: number }[] }[]; transitions?: unknown[] } };
  return { doc, file };
}

/** A peaks service whose decodes the test finishes or fails by hand, counting the requests. */
function handPeaks() {
  const done = new Map<string, PeakMips>();
  const waiting = new Map<string, { resolve: (m: PeakMips) => void; reject: (e: Error) => void }>();
  let requests = 0;
  return {
    peaks: {
      get: (path: string) => {
        requests++;
        return new Promise<PeakMips>((resolve, reject) => waiting.set(path, { resolve: (m) => { done.set(path, m); resolve(m); }, reject }));
      },
      peek: (path: string) => done.get(path),
    },
    finish(path: string, frames: number, rate = 48000, channels = 2) {
      waiting.get(path)!.resolve({ rate, channels, frames, levels: [] });
    },
    fail(path: string) {
      waiting.get(path)!.reject(new Error("not audio"));
    },
    requests: () => requests,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the music node handle (ADR 0313)", () => {
  it("reads the segment or the container by id, and null for an id the event doesn't have", async () => {
    const { doc } = await openEvent();
    const { peaks } = handPeaks();
    expect(musicNodeHandle(doc, peaks, "segment", "b").node?.id).toBe("b");
    expect(musicNodeHandle(doc, peaks, "container", "s").node?.type).toBe("musicSwitch");
    expect(musicNodeHandle(doc, peaks, "segment", "s").node).toBeNull(); // a container is not a segment
    expect(musicNodeHandle(doc, peaks, "container", "zz").node).toBeNull();
    const h = musicNodeHandle(doc, peaks, "segment", "a");
    expect([h.path, h.id, h.readOnly, h.asset]).toEqual([PATH, "a", false, doc.value.value]);
  });

  it("applies an edit of the node as one labelled undo step of the event, written to the file", async () => {
    const { doc, file } = await openEvent();
    const h = musicNodeHandle(doc, handPeaks().peaks, "segment", "b");
    expect(h.apply(setTempo(h.node!, { bpm: 90 }), "Set tempo")).toBe(true);
    expect(h.node!.tempo[0].bpm).toBe(90);
    await h.flush();
    expect(file().root.children[1].tempo?.[0].bpm).toBe(90);
    expect(doc.undoLabel.value).toBe("Set tempo");
    doc.undo();
    expect(h.node!.tempo[0].bpm).not.toBe(90);
  });

  it("applies a container edit (a rule) the same way", async () => {
    const { doc } = await openEvent();
    const h = musicNodeHandle(doc, handPeaks().peaks, "container", "s");
    expect(h.apply(addRule(h.node!, { from: "a", to: "b" }), "Add transition rule")).toBe(true);
    expect((h.node as MusicContainerNode).transitions.map((r) => `${r.from}>${r.to}`)).toEqual(["a>b"]);
  });

  it("a refusal goes to the status bar and changes nothing; an unchanged node is no undo step", async () => {
    const { doc } = await openEvent();
    const h = musicNodeHandle(doc, handPeaks().peaks, "segment", "a");
    const before = doc.value.value;
    expect(h.apply(setTempo(h.node!, { bpm: 0 }), "Set tempo")).toBe(false);
    expect(status.value).toMatchObject({ kind: "error" });
    expect(status.value?.text).toMatch(/^Can't set tempo: .*bpm/);
    expect(doc.value.value).toBe(before);
    expect(h.apply(accept(h.node!), "Nothing")).toBe(true);
    expect(doc.canUndo.value).toBe(false);
  });

  it("a node the event no longer has refuses the edit with why", async () => {
    const { doc } = await openEvent();
    const h = musicNodeHandle(doc, handPeaks().peaks, "segment", "gone");
    expect(h.apply(accept(findMusicSegment(doc.value.value.musicRoot, "a")!), "Set tempo")).toBe(false);
    expect(status.value?.text).toBe(`Can't set tempo: ${PATH} has no segment "gone"`);
    expect(h.apply(refuse("no"), "Set tempo")).toBe(false);
  });

  it("coalesce merges a drag's steps into one undo step", async () => {
    vi.useFakeTimers();
    const { doc } = await openEvent();
    const h = musicNodeHandle(doc, handPeaks().peaks, "segment", "c");
    const start = h.node!;
    for (const bpm of [100, 110, 120]) h.apply(accept<SegmentNode>({ ...h.node!, tempo: [{ ...h.node!.tempo[0], bpm }] }), "Move tempo", { coalesce: true });
    vi.advanceTimersByTime(500);
    await h.flush();
    expect(h.node!.tempo[0].bpm).toBe(120);
    doc.undo();
    await h.flush();
    expect(h.node!.tempo[0].bpm).toBe(start.tempo[0].bpm);
    expect(doc.canUndo.value).toBe(false);
  });

  it("clip facts start a decode when read, once per clip, and bump the version when it arrives", async () => {
    const { doc } = await openEvent();
    const hand = handPeaks();
    const h = musicNodeHandle(doc, hand.peaks, "segment", "a");
    expect(h.clip("music/a.ogg")).toBeUndefined();
    expect(h.seconds("music/a.ogg")).toBeUndefined();
    expect(h.waveform("music/a.ogg")).toBeUndefined();
    expect(hand.requests()).toBe(1);
    expect(h.clip("")).toBeUndefined();
    expect(hand.requests()).toBe(1);
    const v = h.version.value;
    hand.finish("music/a.ogg", 96000, 48000, 6);
    await settle();
    expect(h.version.value).toBe(v + 1);
    expect(h.clip("music/a.ogg")).toEqual({ frames: 96000, rate: 48000, channels: 2, gapless: true });
    expect(h.seconds("music/a.ogg")).toBe(2);
    expect(h.waveform("music/a.ogg")?.frames).toBe(96000);
    expect(hand.requests()).toBe(1);
  });

  it("a failed decode bumps nothing and is asked again on the next read", async () => {
    const { doc } = await openEvent();
    const hand = handPeaks();
    const h = musicNodeHandle(doc, hand.peaks, "segment", "a");
    h.clip("notes.txt");
    const v = h.version.value;
    hand.fail("notes.txt");
    await settle();
    expect(h.version.value).toBe(v);
    h.clip("notes.txt");
    expect(hand.requests()).toBe(2);
  });

  it("decoded waits for each clip, failed ones included, then the facts are there", async () => {
    const { doc } = await openEvent();
    const hand = handPeaks();
    const h = musicNodeHandle(doc, hand.peaks, "segment", "a");
    const wait = h.decoded(["music/a.ogg", "bad.txt"]);
    hand.finish("music/a.ogg", 4800);
    hand.fail("bad.txt");
    await wait;
    expect(h.seconds("music/a.ogg")).toBe(0.1);
  });
});
