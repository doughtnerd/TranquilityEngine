import { describe, expect, it } from "vitest";
import type { EventNode, LayerNode, RandomNode, SustainNode } from "../../../../engine/audio/eventFormat";
import { getNode, newNode } from "./eventTreeModel";
import { addNode, addTarget, changeListType } from "./treeActions";
import type { EditResult } from "../editResult";

/** The accepted value of an edit (ADR 0307), or the test fails with its refusal. */
const nextOf = <T,>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};

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
    const edit = nextOf(addNode(tree(), [0], "random"));
    expect(edit.path).toEqual([1]);
    expect(getNode(edit.root, [1])?.type).toBe("random");
    const clip = nextOf(addNode(tree(), null, "clip", "x.ogg"));
    expect(getNode(clip.root, clip.path)).toMatchObject({ type: "clip", clip: "x.ogg" });
    expect(addNode(tree(), [1, "loop"], "clip")).toHaveProperty("refused");
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
