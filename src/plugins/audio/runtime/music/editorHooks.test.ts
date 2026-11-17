// F-15: `startAtSegment` sets a playlist's cursors so the first plan starts the chosen segment and the list goes on from it.
import { afterEach, describe, expect, it } from "vitest";
import type { EventInstance } from "../events/eventRuntime";
import {
  finishMusicContainer,
  parseMusicContainerHead,
  parseSegmentNode,
  type MusicNode,
  type PlaylistNode,
  type SegmentNode,
} from "../../../../engine/audio/musicFormat";
import { startAtPosition, startAtSegment } from "./editorHooks";
import { planTick, type PlanRequest } from "./planner";
import { withStartPosition } from "./startPosition";
import { createMusicPlayer, type MusicFrame, type MusicPlayer } from "./musicSystem";
import { tickPlaylist } from "./playlist";
import { setSegmentClipSource } from "./segmentRun";
import { setAudioBackend } from "../backend";
import { endAudioSession, makeFakeBackend } from "../testing";

/** The segment the playlist's first plan asks for: one playlist tick on a fake backend, as the planner's frame runs it. */
function firstPlanned(p: MusicPlayer): string | undefined {
  return firstFrame(p, false);
}

/** One frame of the first start on a fake backend: the playlist's tick, then (`plan`) the planner's, which starts a segment root. */
function firstFrame(p: MusicPlayer, plan: boolean): string | undefined {
  const b = makeFakeBackend();
  setAudioBackend(b);
  setSegmentClipSource({
    url: (c) => `/assets/${c}`, settings: () => ({ volume: 1, stream: true }), bus: (o) => o ?? "Master",
    facts: () => ({ frames: 120 * 48_000, rate: 48_000, channels: 2, gapless: true }),
  });
  const f = { backend: b, music: b.music ?? null, now: 0, dt: 1 / 60, hidden: false } as unknown as MusicFrame;
  tickPlaylist(p, f);
  if (plan) planTick(p, f);
  return p.planned?.request.to.id;
}

function segment(id: string): SegmentNode {
  const node = parseSegmentNode({ type: "segment", id, tracks: [{ name: "t0", clip: `music/${id}.ogg` }] }, "test", { problems: [], ids: new Set() });
  if (!node) throw new Error("fixture segment did not parse");
  return node;
}

/** A playlist as the event reader builds one: its head parsed, then its children, then the checks that need them. */
function playlist(id: string, children: MusicNode[], over: Partial<Pick<PlaylistNode, "mode" | "rounds" | "avoidRepeat" | "plays">> = {}): PlaylistNode {
  const problems: string[] = [];
  const node = parseMusicContainerHead({ type: "playlist", id, ...over }, "test", { problems, ids: new Set() });
  if (node?.type !== "playlist") throw new Error("fixture playlist did not parse");
  node.children = children;
  finishMusicContainer(node, "test", problems);
  return node;
}

let groups = 300;
const player = (root: MusicNode) => createMusicPlayer({ group: groups++, world: 1, path: "m.audioevent", asset: { bus: "Music" } } as unknown as EventInstance, root);

afterEach(() => {
  endAudioSession();
  setSegmentClipSource(null);
  setAudioBackend(null);
});

describe("startAtSegment", () => {
  it("makes the second item of a sequence the first to play", () => {
    const p = player(playlist("p", [segment("a"), segment("b"), segment("c")]));
    expect(startAtSegment(p.handle, "b")).toBe(true);
    expect(firstPlanned(p)).toBe("b");
  });

  it("finds a segment inside a nested playlist", () => {
    const p = player(playlist("p", [segment("a"), playlist("n", [segment("b"), segment("c")]), segment("d")]));
    expect(startAtSegment(p.handle, "c")).toBe(true);
    expect(firstPlanned(p)).toBe("c");
  });

  it("finds an item in a shuffled order", () => {
    const p = player(playlist("p", [segment("a"), segment("b"), segment("c"), segment("d")], { mode: "shuffle", rounds: 0 }));
    expect(startAtSegment(p.handle, "d")).toBe(true);
    expect(firstPlanned(p)).toBe("d");
  });

  it("is true for the root segment itself and false for an unknown id, a handle with no player, or music already started", () => {
    expect(startAtSegment(player(segment("solo")).handle, "solo")).toBe(true);
    const p = player(playlist("p", [segment("a"), segment("b")]));
    expect(startAtSegment(p.handle, "zzz")).toBe(false);
    expect(startAtSegment({} as never, "a")).toBe(false);
    firstPlanned(p); // the music started: its first segment is planned
    expect(startAtSegment(p.handle, "b")).toBe(false);
  });
});

// F-41: the editor's "play from" starts the first segment at the position, once.
describe("startAtPosition", () => {
  const timed = (cue: string) => {
    const node = parseSegmentNode({
      type: "segment", id: "s", tempo: [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }],
      cues: [{ name: "entry", at: cue }], entry: "entry", tracks: [{ name: "t0", clip: "music/s.ogg" }],
    }, "test", { problems: [], ids: new Set() });
    if (!node) throw new Error("fixture segment did not parse");
    return node;
  };
  const request = (to: SegmentNode, preEntry: number): PlanRequest => ({ to, reason: "start", grid: "immediate", notBefore: Number.NaN, startFrame: 0, preEntry });

  it("moves the first start to the position, and a start at 1:1:0 is the plain start", () => {
    const node = timed("1:1:0");
    const p = player(node);
    expect(withStartPosition(p, request(node, 0))).toEqual(request(node, 0)); // nothing recorded
    expect(startAtPosition(p.handle, "2:1:0")).toBe(true);
    const moved = withStartPosition(p, request(node, 0));
    expect(moved.startFrame).toBe(2 * 48_000); // 2 s at 120 bpm, the fallback rate until the clip's facts are known
    expect(moved.preEntry).toBe(0);
    const q = player(node);
    startAtPosition(q.handle, "1:1:0");
    const same = withStartPosition(q, request(node, 0));
    expect(same.startFrame).toBe(0);
    expect(same.preEntry).toBe(0);
  });

  it("keeps the lead-in before a later entry cue only for the part the start doesn't skip", () => {
    const node = timed("2:1:0");
    const p = player(node);
    startAtPosition(p.handle, "1:3:0"); // 1 s in, the entry at 2 s: 1 s of lead-in left
    expect(withStartPosition(p, request(node, 2)).preEntry).toBeCloseTo(1, 6);
    const q = player(node);
    startAtPosition(q.handle, "2:1:0"); // from the entry itself: no lead-in
    expect(withStartPosition(q, request(node, 2)).preEntry).toBe(0);
  });

  it("leaves the request alone for a position the segment doesn't have, and is false once the music started or for no player", () => {
    const node = timed("1:1:0");
    const p = player(node);
    startAtPosition(p.handle, "1:9:0");
    expect(withStartPosition(p, request(node, 0))).toEqual(request(node, 0));
    expect(startAtPosition({} as never, "1:1:0")).toBe(false);
    expect(firstFrame(p, true)).toBe("s"); // the music started: its first segment is planned
    expect(startAtPosition(p.handle, "2:1:0")).toBe(false);
  });
});
