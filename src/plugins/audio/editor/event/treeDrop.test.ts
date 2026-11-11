import { describe, expect, it } from "vitest";
import type { EventNode, RandomNode, SustainNode } from "../../../../engine/audio/eventFormat";
import { getNode, newNode } from "./EventTree";
import { applyClipDrop, canDropNode, describeDrop, dropAt } from "./treeDrop";

/** layer [ clip a, random [ clip b ], sustain { loop: clip c } ] */
function tree(): EventNode {
  const random = { ...(newNode("random") as RandomNode), children: [newNode("clip", "b.ogg")] };
  const sustain = { ...(newNode("sustain") as SustainNode), loop: newNode("clip", "c.ogg") };
  return { ...newNode("layer"), children: [newNode("clip", "a.ogg"), random, sustain] } as EventNode;
}

describe("dropAt", () => {
  it("edges of a list child go before and after it", () => {
    const root = tree();
    expect(dropAt(root, { path: [1] }, 0.1, "node")).toEqual({ parent: [], index: 1 });
    expect(dropAt(root, { path: [1] }, 0.9, "node")).toEqual({ parent: [], index: 2 });
  });
  it("the middle of a list container drops at its end", () => {
    expect(dropAt(tree(), { path: [1] }, 0.5, "clips")).toEqual({ parent: [1], index: 1 });
  });
  it("the middle of a clip replaces it for clips, splits for nodes", () => {
    const root = tree();
    expect(dropAt(root, { path: [0] }, 0.5, "clips")).toEqual({ replace: [0] });
    expect(dropAt(root, { path: [0] }, 0.4, "node")).toEqual({ parent: [], index: 0 });
    expect(dropAt(root, { path: [0] }, 0.6, "node")).toEqual({ parent: [], index: 1 });
  });
  it("the root's edges drop into it; an empty slot row into the slot; a sustain's middle nowhere", () => {
    const root = tree();
    expect(dropAt(root, { path: [] }, 0.1, "node")).toEqual({ parent: [], index: 0 });
    expect(dropAt(root, { path: [] }, 0.9, "node")).toEqual({ parent: [], index: 3 });
    expect(dropAt(root, { sustain: [2], slot: "start" }, 0.5, "clips")).toEqual({ parent: [2], slot: "start" });
    expect(dropAt(root, { path: [2] }, 0.5, "clips")).toBeNull();
    expect(dropAt(root, { path: [9] }, 0.5, "clips")).toBeNull();
  });
  it("a slot's clip has no list to sit beside", () => {
    expect(dropAt(tree(), { path: [2, "loop"] }, 0.1, "node")).toBeNull();
  });
});

describe("canDropNode", () => {
  it("refuses replace drops and moves into the node itself", () => {
    const root = tree();
    expect(canDropNode(root, [0], { replace: [0] })).toBe(false);
    expect(canDropNode(root, [1], { parent: [1], index: 0 })).toBe(false);
    expect(canDropNode(root, [0], { parent: [1], index: 0 })).toBe(true);
    expect(canDropNode(root, [0], null)).toBe(false);
  });
});

describe("applyClipDrop", () => {
  it("adds clips in order into a list and returns the first one's path", () => {
    const edit = applyClipDrop(tree(), { parent: [1], index: 0 }, ["x.ogg", "y.ogg"]);
    if (typeof edit === "string") throw new Error(edit);
    expect(edit.path).toEqual([1, 0]);
    expect((getNode(edit.root, [1]) as RandomNode).children.map((c) => (c.type === "clip" ? c.clip : ""))).toEqual(["x.ogg", "y.ogg", "b.ogg"]);
  });
  it("fills an empty slot with one clip, refuses several", () => {
    const root = tree();
    const edit = applyClipDrop(root, { parent: [2], slot: "end" }, ["e.ogg"]);
    if (typeof edit === "string") throw new Error(edit);
    expect(getNode(edit.root, [2, "end"])).toMatchObject({ type: "clip", clip: "e.ogg" });
    expect(typeof applyClipDrop(root, { parent: [2], slot: "end" }, ["e.ogg", "f.ogg"])).toBe("string");
    expect(typeof applyClipDrop(root, { parent: [2], slot: "loop" }, ["e.ogg"])).toBe("string");
  });
  it("replaces a clip row's path, keeping its other fields", () => {
    const root = tree();
    const edit = applyClipDrop(root, { replace: [0] }, ["z.ogg"]);
    if (typeof edit === "string") throw new Error(edit);
    expect(getNode(edit.root, [0])).toEqual({ ...getNode(root, [0]), clip: "z.ogg" });
    expect(getNode(root, [0])).toMatchObject({ clip: "a.ogg" }); // input untouched
  });
  it("refuses no clips", () => {
    expect(typeof applyClipDrop(tree(), { parent: [], index: 0 }, [])).toBe("string");
  });
});

describe("describeDrop", () => {
  it("says what releasing does", () => {
    const root = tree();
    expect(describeDrop(root, { parent: [1], index: 1 }, 2, "clips")).toBe("Add 2 clips in random at 2");
    expect(describeDrop(root, { replace: [0] }, 1, "clips")).toBe("Replace this clip");
    expect(describeDrop(root, { parent: [2], slot: "start" }, 1, "node")).toBe("Move here as the start");
    expect(describeDrop(root, null, 1, "node")).toBe("Can't move it here");
  });
});
