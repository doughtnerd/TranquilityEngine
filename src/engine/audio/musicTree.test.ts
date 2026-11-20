// ADR 0269: the music tree's addressing, by id and by path, over children and library.
import { describe, expect, it } from "vitest";
import { parseAudioEvent } from "./eventFormat";
import type { MusicContainerNode, MusicNode, SegmentNode } from "./musicFormat";
import {
  findMusicContainer, findMusicNode, findMusicSegment, isLibraryPath, isLibraryStep, libraryIndexOf, mapMusicTree, musicChildAt, musicChildById,
  musicChildrenOf, musicEntries, musicLeaves, musicNodeAt, musicNodeCount, musicPathOf, musicStepsOf, replaceMusicNode, replaceMusicNodeAt,
} from "./musicTree";

const seg = (id: string, extra: Record<string, unknown> = {}) => ({ type: "segment", id, tracks: [{ name: "t", clip: `music/${id}.ogg` }], ...extra });

/** world (switch): explore, combat (playlist: c1, c2; library sting), library riser. */
const tree = (): MusicContainerNode => parseAudioEvent({
  format: "myco.audioevent@1",
  parameters: [{ name: "State", labels: ["explore", "combat"] }],
  root: {
    type: "musicSwitch", id: "world", parameter: "State",
    children: [
      seg("explore", { value: "explore" }),
      { type: "playlist", id: "combat", value: "combat", children: [seg("c1"), seg("c2")], library: [seg("sting")], stingers: [{ trigger: "hit", segment: "sting" }] },
    ],
    stingers: [{ trigger: "rise", segment: "riser" }],
    library: [seg("riser")],
  },
}).value.musicRoot as MusicContainerNode;

const ids = (nodes: readonly MusicNode[]) => nodes.map((n) => n.id);

describe("steps", () => {
  it("name library segments as lib<n>, children by index", () => {
    expect(isLibraryStep("lib0")).toBe(true);
    expect(isLibraryStep("lib12")).toBe(true);
    expect(isLibraryStep("lib01")).toBe(false);
    expect(isLibraryStep(0)).toBe(false);
    expect(libraryIndexOf("lib3")).toBe(3);
    expect(libraryIndexOf("loop")).toBeNull();
    expect(isLibraryPath([1, "lib0"])).toBe(true);
    expect(isLibraryPath([1, 0])).toBe(false);
    expect(isLibraryPath([])).toBe(false);
    const root = tree();
    expect(musicStepsOf(root)).toEqual([0, 1, "lib0"]);
    expect(musicStepsOf(root.children[0]!)).toEqual([]);
    expect(musicChildAt(root, "lib0")?.id).toBe("riser");
    expect(musicChildAt(root, "loop")).toBeUndefined();
    expect(ids(musicChildrenOf(root))).toEqual(["explore", "combat"]);
    expect(musicChildById(root, "combat")?.id).toBe("combat");
    expect(musicChildById(root, "riser")).toBeUndefined(); // a library segment is not a child
  });
});

describe("walking", () => {
  it("visits children, then the library, depth first, with each node's path", () => {
    const root = tree();
    const entries = musicEntries(root);
    expect(entries.map((e) => e.path.join("/"))).toEqual(["", "0", "1", "1/0", "1/1", "1/lib0", "lib0"]);
    expect(ids(entries.map((e) => e.node))).toEqual(["world", "explore", "combat", "c1", "c2", "sting", "riser"]);
    for (const e of entries) expect(musicNodeAt(root, e.path)).toBe(e.node);
    expect(ids(musicEntries(root, { library: false }).map((e) => e.node))).toEqual(["world", "explore", "combat", "c1", "c2"]);
    expect(musicNodeCount(root)).toBe(7);
  });

  it("lists the leaf segments a container plays, or every segment with the library", () => {
    const root = tree();
    expect(ids(musicLeaves(root))).toEqual(["explore", "c1", "c2"]);
    expect(ids(musicLeaves(root, { library: true }))).toEqual(["explore", "c1", "c2", "sting", "riser"]);
    expect(ids(musicLeaves(root.children[0]!))).toEqual(["explore"]);
  });
});

describe("finding", () => {
  it("finds a node by id anywhere (library included) and maps an id to its path and back", () => {
    const root = tree();
    expect(findMusicNode(root, "sting")?.id).toBe("sting");
    expect(findMusicNode(undefined, "sting")).toBeUndefined();
    expect(findMusicSegment(root, "riser")?.id).toBe("riser");
    expect(findMusicSegment(root, "combat")).toBeNull(); // a container, not a segment
    expect(findMusicContainer(root, "combat")?.id).toBe("combat");
    expect(findMusicContainer(root, "c1")).toBeNull();
    expect(findMusicNode(root, "nope")).toBeUndefined();
    for (const e of musicEntries(root)) expect(musicPathOf(root, e.node.id)).toEqual(e.path);
    expect(musicPathOf(root, "nope")).toBeNull();
    expect(musicNodeAt(root, [1, 5])).toBeUndefined();
    expect(musicNodeAt(root, [0, 0])).toBeUndefined(); // below a segment
    expect(musicNodeAt(root, [0, "loop"])).toBeUndefined(); // an event path's sustain slot leads nowhere here
  });
});

describe("replacing", () => {
  it("replaces by id with structural sharing, the root itself when the id isn't there", () => {
    const root = tree();
    const next: SegmentNode = { ...findMusicSegment(root, "c2")!, volume: 0.5 };
    const out = replaceMusicNode(root, "c2", next) as MusicContainerNode;
    expect(findMusicSegment(out, "c2")).toBe(next);
    expect(out.children[0]).toBe(root.children[0]); // untouched siblings are shared
    expect(out.library).toBe(root.library);
    expect((out.children[1] as MusicContainerNode).children[0]).toBe((root.children[1] as MusicContainerNode).children[0]);
    expect(root.children[1]).not.toBe(out.children[1]); // the input is not mutated
    expect(replaceMusicNode(root, "nope", next)).toBe(root);
    const whole = { ...root, parameter: "Other" };
    expect(replaceMusicNode(root, "world", whole)).toBe(whole);
  });

  it("replaces a library segment and a nested container", () => {
    const root = tree();
    const sting: SegmentNode = { ...findMusicSegment(root, "sting")!, volume: 0.25 };
    expect(findMusicSegment(replaceMusicNode(root, "sting", sting), "sting")).toBe(sting);
    const combat = { ...findMusicContainer(root, "combat")!, stingers: [] };
    expect(findMusicContainer(replaceMusicNode(root, "combat", combat), "combat")).toBe(combat);
  });

  it("replaces by path, and refuses a path that leads nowhere or a container in a library slot", () => {
    const root = tree();
    const next: SegmentNode = { ...findMusicSegment(root, "riser")!, volume: 0.1 };
    expect(musicNodeAt(replaceMusicNodeAt(root, ["lib0"], next), ["lib0"])).toBe(next);
    expect(() => replaceMusicNodeAt(root, [7], next)).toThrow(RangeError);
    expect(() => replaceMusicNodeAt(root, ["lib0"], root.children[1]!)).toThrow(RangeError);
  });

  it("maps every node bottom up, sharing what the function leaves alone", () => {
    const root = tree();
    expect(mapMusicTree(root, (n) => n)).toBe(root);
    const quiet = mapMusicTree(root, (n) => (n.id === "sting" ? { ...n, volume: 0 } : n)) as MusicContainerNode;
    expect(findMusicSegment(quiet, "sting")?.volume).toBe(0);
    expect(quiet.children[0]).toBe(root.children[0]);
    expect(quiet.library).toEqual(root.library);
  });
});
