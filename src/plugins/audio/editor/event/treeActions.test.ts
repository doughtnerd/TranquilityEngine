import { describe, expect, it } from "vitest";
import type { EventNode, LayerNode, RandomNode, SustainNode } from "../../../../engine/audio/eventFormat";
import { getNode, newNode } from "./eventTree";
import { addNode, addTarget, changeListType } from "./treeActions";

/** layer [ clip a, sustain { loop: clip c } ] */
function tree(): EventNode {
  const sustain = { ...(newNode("sustain") as SustainNode), loop: newNode("clip", "c.ogg") };
  return { ...newNode("layer"), children: [newNode("clip", "a.ogg"), sustain] } as EventNode;
}

describe("addTarget", () => {
  it("into a list container, after a list child, the root for the event row, nowhere in a slot", () => {
    const root = tree();
    expect(addTarget(root, null)).toEqual({ parent: [], index: 2 });
    expect(addTarget(root, [0])).toEqual({ parent: [], index: 1 });
    expect(addTarget(root, [1])).toEqual({ parent: [], index: 2 });
    expect(addTarget(root, [1, "loop"])).toBeNull();
    expect(addTarget(newNode("clip"), null)).toBeNull();
    expect(addTarget(root, [7])).toBeNull();
  });
});

describe("addNode", () => {
  it("adds a fresh node and returns its path, or a reason", () => {
    const edit = addNode(tree(), [0], "random");
    if (typeof edit === "string") throw new Error(edit);
    expect(edit.path).toEqual([1]);
    expect(getNode(edit.root, [1])?.type).toBe("random");
    const clip = addNode(tree(), null, "clip", "x.ogg");
    if (typeof clip === "string") throw new Error(clip);
    expect(getNode(clip.root, clip.path)).toMatchObject({ type: "clip", clip: "x.ogg" });
    expect(typeof addNode(tree(), [1, "loop"], "clip")).toBe("string");
  });
});

describe("changeListType", () => {
  it("keeps children and common fields, takes the new type's defaults", () => {
    const root = { ...(tree() as LayerNode), volume: 0.5, weight: 3 } as EventNode;
    const next = changeListType(root, [], "random") as RandomNode;
    expect(next.type).toBe("random");
    expect(next.children).toBe((root as LayerNode).children);
    expect(next.volume).toBe(0.5);
    expect(next.weight).toBe(3);
    expect(next.mode).toBe("step");
    expect(changeListType(root, [0], "random")).toBe(root); // a clip
    expect(changeListType(root, [], "layer")).toBe(root);
  });
});
