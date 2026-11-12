// F-15: `startAtSegment` sets a playlist's cursors so the first plan starts the chosen segment and the list goes on from it.
import { afterEach, describe, expect, it } from "vitest";
import type { EventInstance } from "../events/eventRuntime";
import { newMusicContext, parseSegmentNode, type SegmentNode } from "../../../../engine/audio/musicFormat";
import { startAtSegment } from "./editorHooks";
import { _resetMusicPlayers, createMusicPlayer, type MusicNodeRef } from "./musicSystem";
import { peekNext } from "./playlist";

function segment(id: string): SegmentNode {
  const node = parseSegmentNode({ type: "segment", id, tracks: [{ name: "t0", clip: `music/${id}.ogg` }] }, "test", newMusicContext());
  if (!node) throw new Error("fixture segment did not parse");
  return node;
}

function playlist(id: string, children: unknown[], over: Record<string, unknown> = {}): MusicNodeRef {
  return {
    type: "playlist", id, mode: "sequence", rounds: 1, avoidRepeat: 0, weight: 1, plays: 1, transitions: [], stingers: [], library: [],
    children, ...over,
  } as unknown as MusicNodeRef;
}

let groups = 300;
const player = (root: MusicNodeRef) => createMusicPlayer({ group: groups++, world: 1, path: "m.audioevent", asset: { bus: "Music" } } as unknown as EventInstance, root);

afterEach(() => _resetMusicPlayers());

describe("startAtSegment", () => {
  it("makes the second item of a sequence the first to play", () => {
    const p = player(playlist("p", [segment("a"), segment("b"), segment("c")]));
    expect(startAtSegment(p.handle, "b")).toBe(true);
    expect(peekNext(p.playlist!)?.id).toBe("b");
  });

  it("finds a segment inside a nested playlist", () => {
    const p = player(playlist("p", [segment("a"), playlist("n", [segment("b"), segment("c")]), segment("d")]));
    expect(startAtSegment(p.handle, "c")).toBe(true);
    expect(peekNext(p.playlist!)?.id).toBe("c");
  });

  it("finds an item in a shuffled order", () => {
    const p = player(playlist("p", [segment("a"), segment("b"), segment("c"), segment("d")], { mode: "shuffle", rounds: 0 }));
    expect(startAtSegment(p.handle, "d")).toBe(true);
    expect(peekNext(p.playlist!)?.id).toBe("d");
  });

  it("is true for the root segment itself and false for an unknown id, a handle with no player, or music already started", () => {
    expect(startAtSegment(player(segment("solo")).handle, "solo")).toBe(true);
    const p = player(playlist("p", [segment("a"), segment("b")]));
    expect(startAtSegment(p.handle, "zzz")).toBe(false);
    expect(startAtSegment({} as never, "a")).toBe(false);
    p.planned = {} as never;
    expect(startAtSegment(p.handle, "b")).toBe(false);
  });
});
