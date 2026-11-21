// ADR 0263: the grid of a segment node now, with one length rule and a refresh once the file's length is known.
import { afterEach, describe, expect, it } from "vitest";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, endAudioSession } from "../testing";
import { parseSegmentNode, type SegmentNode } from "../../../../engine/audio/musicFormat";
import { ticksToSeconds } from "../../../../engine/audio/musicGrid";
import type { MusicClipFacts } from "../../../../engine/audio/musicValidate";
import { serveMusicClips } from "./testing/clips";
import { segmentGrid, segmentLength, segmentLoops } from "./segmentGrids";

let facts: Record<string, MusicClipFacts | undefined> = {};

function rig(): ReturnType<typeof makeFakeBackend> {
  facts = {};
  const b = makeFakeBackend();
  setAudioBackend(b);
  serveMusicClips(b, (p) => facts[p], { stream: true });
  return b;
}

/** 120 bpm 4/4 (2 s a bar); its first track has no clip, so the length comes from `b.ogg`. */
function segment(): SegmentNode {
  const node = parseSegmentNode({
    type: "segment", id: "A",
    tracks: [{ name: "silent" }, { name: "t1", clip: "b.ogg" }, { name: "t2", clip: "c.ogg" }],
    cues: [{ name: "bar2", at: "2:1:0" }, { name: "tail", at: "end" }],
    regions: [{ id: "whole", from: "1:1:0", to: "end", count: 0 }],
  }, "test", { problems: [], ids: new Set() });
  if (!node) throw new Error("fixture segment did not parse");
  return node;
}

afterEach(() => {
  endAudioSession();
  setAudioBackend(null);
});

describe("segment grids (ADR 0263)", () => {
  it("a grid read before the clip is probed has no end; the first read after the facts arrive has it", () => {
    rig();
    const node = segment();
    const early = segmentGrid(node)!;
    expect(Number.isNaN(early.exitTicks)).toBe(true);
    expect(Number.isNaN(early.cueTicks[early.cueNames.indexOf("tail")]!)).toBe(true); // the "end" cue has no time yet
    expect(segmentLoops(node)!.regions).toHaveLength(0); // a region to the end needs the end
    expect(segmentLength(node)).toBeUndefined();

    facts["b.ogg"] = { frames: 8 * 44_100, rate: 44_100, channels: 2, gapless: true };
    const late = segmentGrid(node)!;
    expect(late).not.toBe(early);
    expect(ticksToSeconds(late, late.exitTicks)).toBeCloseTo(8, 9);
    expect(ticksToSeconds(late, late.cueTicks[late.cueNames.indexOf("tail")]!)).toBeCloseTo(8, 9);
    expect(segmentLength(node)).toEqual({ seconds: 8, frames: 8 * 44_100, rate: 44_100 });
    const loops = segmentLoops(node)!;
    expect(loops.rate).toBe(44_100);
    expect(loops.regions).toEqual([{ index: 0, from: 0, to: 8, count: 0 }]);
    expect(segmentGrid(node)).toBe(late); // kept while the length stays
  });

  it("without facts, the backend's decoded length is the file's length", () => {
    const b = rig();
    const node = segment();
    b.durations.set("c.ogg", 3); // not the length clip: ignored
    expect(segmentLength(node)).toBeUndefined();
    b.durations.set("b.ogg", 6);
    expect(segmentLength(node)).toEqual({ seconds: 6, frames: undefined, rate: undefined });
    const g = segmentGrid(node)!;
    expect(ticksToSeconds(g, g.exitTicks)).toBeCloseTo(6, 9);
    expect(segmentLoops(node, 48_000)!.regions).toEqual([{ index: 0, from: 0, to: 6, count: 0 }]);
  });

  it("an open-ended read keeps a region to the end before the length is known, without keeping the answer", () => {
    rig();
    const node = segment();
    expect(segmentLoops(node, 48_000, true)!.regions).toHaveLength(1);
    expect(segmentLoops(node, 48_000)!.regions).toHaveLength(0);
  });

  it("a node that isn't a segment has no grid", () => {
    rig();
    const playlist = { type: "playlist", id: "P" } as unknown as Parameters<typeof segmentGrid>[0];
    expect(segmentGrid(playlist)).toBeNull();
    expect(segmentLoops(playlist)).toBeNull();
    expect(segmentLength(playlist)).toBeUndefined();
  });
});
