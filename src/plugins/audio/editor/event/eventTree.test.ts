import { describe, expect, it } from "vitest";
import {
  AUDIO_EVENT_FORMAT,
  NODE_TYPES,
  emptyAudioEvent,
  eventNodes,
  formatAudioEvent,
  parseAudioEvent,
  type AudioEventAsset,
  type EventNode,
} from "../../../../engine/audio/eventFormat";
import {
  addChild,
  canAddChild,
  canDuplicate,
  canMove,
  canRemove,
  childSteps,
  cloneNode,
  countNodes,
  duplicateNode,
  getNode,
  isAncestor,
  moveNode,
  newNode,
  nodeLabel,
  nodePaths,
  parameterUses,
  parentPath,
  parsePathKey,
  pathKey,
  removeNode,
  renameParameter,
  reorderChild,
  samePath,
  setNode,
  setSustainSlot,
  subtreeHeight,
  wrapNode,
  type ListNodeType,
  type NodePath,
} from "./eventTree";

// --- helpers --------------------------------------------------------------------------------------------------------

/** Freezes a value and everything under it, so any mutation throws (modules are strict). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as object).forEach((v) => deepFreeze(v));
  }
  return value;
}

const clipNode = (name: string): EventNode => newNode("clip", name);
const list = (type: ListNodeType, children: EventNode[]): EventNode => ({ ...newNode(type), children }) as EventNode;

function sustain(loop: EventNode, slots: { start?: EventNode; end?: EventNode } = {}): EventNode {
  return { ...newNode("sustain"), loop, ...slots } as EventNode;
}

/** A layer [random(a, b), sustain(loop, start), c]: paths [0], [0,0], [0,1], [1], [1,"start"], [1,"loop"], [2]. */
function sampleTree(): EventNode {
  return list("layer", [
    list("random", [clipNode("sfx/a.ogg"), clipNode("sfx/b.ogg")]),
    sustain(clipNode("loop.ogg"), { start: clipNode("start.ogg") }),
    clipNode("c.ogg"),
  ]);
}

/** A layer nested `depth` levels deep around `leaf`: the leaf sits at path `[0]` repeated `depth` times. */
function nest(depth: number, leaf: EventNode): EventNode {
  return depth === 0 ? leaf : list("layer", [nest(depth - 1, leaf)]);
}

const zeros = (n: number): NodePath => Array.from({ length: n }, () => 0);

/** A layer whose children are `count` clips. */
function wideLayer(count: number): EventNode {
  return list("layer", Array.from({ length: count }, (_, i) => clipNode(`c${i}.ogg`)));
}

const eventWith = (root: EventNode, extra: Partial<AudioEventAsset> = {}): AudioEventAsset => ({
  ...emptyAudioEvent(),
  root,
  ...extra,
});

// --- tests ----------------------------------------------------------------------------------------------------------

describe("eventTree paths", () => {
  it('pathKey and parsePathKey round-trip, the root is ""', () => {
    expect(pathKey([])).toBe("");
    expect(pathKey([1, "loop", 0])).toBe("1/loop/0");
    const samples: NodePath[] = [[], [0], [1, "loop", 0], ["start"], [2, "end"], [10, 3]];
    for (const path of samples) expect(parsePathKey(pathKey(path))).toEqual(path);
    expect(parsePathKey("")).toEqual([]);
  });

  it("parsePathKey rejects unknown slot names and negative or fractional indices", () => {
    for (const bad of ["middle", "1/middle", "-1", "1.5", "01", "1//2", "1/", "x0"]) {
      expect(parsePathKey(bad)).toBeNull();
    }
  });

  it("samePath, isAncestor (not its own ancestor) and parentPath (null for the root)", () => {
    expect(samePath([1, "loop"], [1, "loop"])).toBe(true);
    expect(samePath([1], [1, 0])).toBe(false);
    expect(isAncestor([1], [1, "loop", 0])).toBe(true);
    expect(isAncestor([], [0])).toBe(true);
    expect(isAncestor([1], [1])).toBe(false);
    expect(isAncestor([0], [1])).toBe(false);
    expect(parentPath([])).toBeNull();
    expect(parentPath([1, "loop"])).toEqual([1]);
  });
});

describe("eventTree reading", () => {
  it("getNode follows indices and sustain slots, undefined for a stale path", () => {
    const root = sampleTree();
    const sus = (root as Extract<EventNode, { type: "layer" }>).children[1] as Extract<EventNode, { type: "sustain" }>;
    expect(getNode(root, [])).toBe(root);
    expect(getNode(root, [1, "loop"])).toBe(sus.loop);
    expect(getNode(root, [1, "start"])).toBe(sus.start);
    const random = (root as Extract<EventNode, { type: "layer" }>).children[0] as Extract<EventNode, { type: "random" }>;
    expect(getNode(root, [0, 1])).toBe(random.children[1]);
    expect(getNode(root, [1, "end"])).toBeUndefined();
    expect(getNode(root, [5])).toBeUndefined();
    expect(getNode(root, [0, 0, 0])).toBeUndefined();
    expect(getNode(root, [0, "loop"])).toBeUndefined();
    expect(getNode(root, [2, 0])).toBeUndefined();
  });

  it("childSteps: indices for list containers, filled sustain slots in order, none for a clip", () => {
    const root = sampleTree();
    expect(childSteps(root)).toEqual([0, 1, 2]);
    expect(childSteps(sustain(clipNode("l"), { end: clipNode("e"), start: clipNode("s") }))).toEqual(["start", "loop", "end"]);
    expect(childSteps(sustain(clipNode("l")))).toEqual(["loop"]);
    expect(childSteps(clipNode("a"))).toEqual([]);
  });

  it("nodePaths walks depth first in eventNodes order", () => {
    const root = sampleTree();
    expect(nodePaths(root)).toEqual([[], [0], [0, 0], [0, 1], [1], [1, "start"], [1, "loop"], [2]]);
    const walked = [...eventNodes(root)];
    const viaPaths = nodePaths(root).map((p) => getNode(root, p));
    expect(viaPaths.length).toBe(walked.length);
    walked.forEach((node, i) => expect(viaPaths[i]).toBe(node));
  });

  it("countNodes and subtreeHeight", () => {
    const root = sampleTree();
    expect(countNodes(root)).toBe(8);
    expect(countNodes(clipNode("a"))).toBe(1);
    expect(subtreeHeight(root)).toBe(3);
    expect(subtreeHeight(clipNode("a"))).toBe(1);
    expect(subtreeHeight(sustain(clipNode("l"), { start: clipNode("s") }))).toBe(2);
  });

  it("nodeLabel: clip stem, (no clip), capitalised container type", () => {
    expect(nodeLabel(clipNode("sfx/step_01.ogg"))).toBe("step_01");
    expect(nodeLabel(clipNode("clip.v2.ogg"))).toBe("clip.v2");
    expect(nodeLabel(clipNode(""))).toBe("(no clip)");
    expect(nodeLabel(newNode("random"))).toBe("Random");
    expect(nodeLabel(newNode("sequence"))).toBe("Sequence");
    expect(nodeLabel(newNode("sustain"))).toBe("Sustain");
  });
});

describe("eventTree making nodes", () => {
  it("newNode gives every type parseAudioEvent's defaults (round-trips through formatAudioEvent/parseAudioEvent unchanged)", () => {
    for (const type of NODE_TYPES) {
      const event = { ...emptyAudioEvent(), root: newNode(type) };
      const parsed = parseAudioEvent(JSON.parse(formatAudioEvent(event)));
      expect(parsed.value.root).toEqual(newNode(type));
      expect(parseAudioEvent({ format: AUDIO_EVENT_FORMAT, root: newNode(type) }).value.root).toEqual(newNode(type));
    }
  });

  it("newNode shares no arrays between nodes; a sustain gets an empty clip in loop", () => {
    const a = newNode("random") as Extract<EventNode, { type: "random" }>;
    const b = newNode("random") as Extract<EventNode, { type: "random" }>;
    expect(a.children).not.toBe(b.children);
    expect(a.volumeRandom).not.toBe(b.volumeRandom);
    expect(a.pitchRandom).not.toBe(b.pitchRandom);
    expect(a.automation).not.toBe(b.automation);
    const s1 = newNode("sustain");
    const s2 = newNode("sustain");
    expect(s1.type === "sustain" && s1.loop).toEqual({ ...newNode("clip"), clip: "" });
    expect(s1.type === "sustain" && s1.loop).not.toBe(s2.type === "sustain" && s2.loop);
    expect("start" in s1).toBe(false);
    expect("end" in s1).toBe(false);
  });

  it("cloneNode is deep: equal by value, no shared objects", () => {
    const root = sampleTree();
    const copy = cloneNode(root);
    expect(copy).toEqual(root);
    const original = nodePaths(root);
    original.forEach((path) => {
      const a = getNode(root, path) as EventNode;
      const b = getNode(copy, path) as EventNode;
      expect(b).not.toBe(a);
      expect(b.volumeRandom).not.toBe(a.volumeRandom);
      expect(b.automation).not.toBe(a.automation);
    });
  });
});

describe("eventTree edits", () => {
  it("setNode replaces along the path, shares untouched siblings, never mutates the input", () => {
    const root = deepFreeze(sampleTree());
    const replacement = clipNode("x.ogg");
    const next = setNode(root, [0, 1], replacement);
    expect(getNode(next, [0, 1])).toBe(replacement);
    expect(getNode(root, [0, 1])).toEqual(clipNode("sfx/b.ogg"));
    expect((next as Extract<EventNode, { type: "layer" }>).children[1]).toBe((root as Extract<EventNode, { type: "layer" }>).children[1]);
    expect((next as Extract<EventNode, { type: "layer" }>).children[2]).toBe((root as Extract<EventNode, { type: "layer" }>).children[2]);
    expect((next as Extract<EventNode, { type: "layer" }>).children[0]).not.toBe((root as Extract<EventNode, { type: "layer" }>).children[0]);
    expect(setNode(root, [], replacement)).toBe(replacement);
    const sus = setNode(root, [1, "loop"], replacement);
    expect(getNode(sus, [1, "loop"])).toBe(replacement);
    expect(getNode(sus, [1, "start"])).toBe(getNode(root, [1, "start"]));
  });

  it("setNode throws RangeError for a path that leads nowhere", () => {
    const root = sampleTree();
    expect(() => setNode(root, [5], clipNode("x"))).toThrow(RangeError);
    expect(() => setNode(root, [0, "loop"], clipNode("x"))).toThrow(RangeError);
  });

  it("addChild appends by default, inserts at a clamped index, returns the new path", () => {
    const root = deepFreeze(sampleTree());
    const d = clipNode("d.ogg");
    const appended = addChild(root, [0], d);
    expect(appended.path).toEqual([0, 2]);
    expect(getNode(appended.root, [0, 2])).toBe(d);
    expect(getNode(root, [0, 2])).toBeUndefined();
    expect(addChild(root, [0], d, 0).path).toEqual([0, 0]);
    expect(addChild(root, [0], d, 99).path).toEqual([0, 2]);
    expect(addChild(root, [0], d, -5).path).toEqual([0, 0]);
    const inserted = addChild(root, [0], d, 1);
    expect(getNode(inserted.root, [0, 1])).toBe(d);
    expect(getNode(inserted.root, [0, 2])).toEqual(clipNode("sfx/b.ogg"));
  });

  it("addChild refuses a clip or sustain parent, and the depth and node limits (canAddChild)", () => {
    const root = sampleTree();
    expect(() => addChild(root, [2], clipNode("x"))).toThrow(RangeError);
    expect(() => addChild(root, [1], clipNode("x"))).toThrow(RangeError);
    expect(canAddChild(root, [1], clipNode("x"))).toBe(false);
    expect(canAddChild(root, [0], clipNode("x"))).toBe(true);

    // The parent sits at depth 14: a clip (height 1) fits, a two-level container (height 2) would reach depth 16.
    const deep = nest(14, list("layer", []));
    expect(canAddChild(deep, zeros(14), clipNode("x"))).toBe(true);
    expect(canAddChild(deep, zeros(14), list("layer", [clipNode("x")]))).toBe(false);
    expect(() => addChild(deep, zeros(14), list("layer", [clipNode("x")]))).toThrow(RangeError);

    // Node limit: 1023 nodes in total leave room for one more clip, not for a two-node subtree.
    const big = wideLayer(1022);
    expect(countNodes(big)).toBe(1023);
    expect(canAddChild(big, [], clipNode("x"))).toBe(true);
    expect(canAddChild(big, [], list("layer", [clipNode("x")]))).toBe(false);
  });

  it("setSustainSlot fills and clears start/end, replaces loop, refuses clearing loop", () => {
    const root = sampleTree();
    const end = clipNode("end.ogg");
    const filled = setSustainSlot(root, [1], "end", end);
    expect(filled.path).toEqual([1, "end"]);
    expect(getNode(filled.root, [1, "end"])).toBe(end);
    expect(getNode(filled.root, [1, "start"])).toEqual(clipNode("start.ogg"));

    const replaced = setSustainSlot(root, [1], "start", end);
    expect(getNode(replaced.root, [1, "start"])).toBe(end);

    const cleared = setSustainSlot(root, [1], "start", undefined);
    expect(cleared.path).toEqual([1]);
    expect("start" in (getNode(cleared.root, [1]) as object)).toBe(false);
    expect(childSteps(getNode(cleared.root, [1]) as EventNode)).toEqual(["loop"]);

    const loop = clipNode("new-loop.ogg");
    expect(getNode(setSustainSlot(root, [1], "loop", loop).root, [1, "loop"])).toBe(loop);
    expect(() => setSustainSlot(root, [1], "loop", undefined)).toThrow(RangeError);
    expect(() => setSustainSlot(root, [0], "start", end)).toThrow(RangeError);
  });

  it("removeNode splices a child, removes a sustain start/end key; refuses the root and a loop slot", () => {
    const root = sampleTree();
    expect(canRemove(root, [0])).toBe(true);
    const spliced = removeNode(root, [0]);
    expect((spliced as Extract<EventNode, { type: "layer" }>).children.length).toBe(2);
    expect((spliced as Extract<EventNode, { type: "layer" }>).children[0]).toBe((root as Extract<EventNode, { type: "layer" }>).children[1]);

    const noStart = removeNode(root, [1, "start"]);
    expect("start" in (getNode(noStart, [1]) as object)).toBe(false);
    expect(getNode(noStart, [1, "loop"])).toBe(getNode(root, [1, "loop"]));

    expect(canRemove(root, [])).toBe(false);
    expect(canRemove(root, [1, "loop"])).toBe(false);
    expect(() => removeNode(root, [])).toThrow(RangeError);
    expect(() => removeNode(root, [1, "loop"])).toThrow(RangeError);
  });

  it("reorderChild moves a child to index to; from === to returns the same root", () => {
    const root = sampleTree();
    const r = (root as Extract<EventNode, { type: "layer" }>);
    const toEnd = reorderChild(root, [], 0, 2);
    expect(toEnd.path).toEqual([2]);
    const moved = toEnd.root as Extract<EventNode, { type: "layer" }>;
    expect(moved.children[0]).toBe(r.children[1]);
    expect(moved.children[1]).toBe(r.children[2]);
    expect(moved.children[2]).toBe(r.children[0]);

    expect(reorderChild(root, [], 2, 0).path).toEqual([0]);
    expect(reorderChild(root, [], 0, 99).path).toEqual([2]);
    expect(reorderChild(root, [], 1, 1).root).toBe(root);
    expect(() => reorderChild(root, [0, 0], 0, 1)).toThrow(RangeError);
    expect(() => reorderChild(root, [], 3, 0)).toThrow(RangeError);
  });

  it("moveNode within one list lands where the drop indicator was (before-move indices)", () => {
    const root = deepFreeze(sampleTree());
    const r = root as Extract<EventNode, { type: "layer" }>;
    // Drop before the clip (index 2): the random lands between the sustain and the clip.
    const before = moveNode(root, [0], { parent: [], index: 2 });
    expect(before.path).toEqual([1]);
    const b = before.root as Extract<EventNode, { type: "layer" }>;
    expect(b.children.map((c) => c.type)).toEqual(["sustain", "random", "clip"]);
    expect(b.children[1]).toBe(r.children[0]);

    // Drop after the last child (index 3): the random goes to the end.
    expect(moveNode(root, [0], { parent: [], index: 3 }).path).toEqual([2]);
    // Drop before itself or after itself: no move.
    expect(moveNode(root, [0], { parent: [], index: 0 }).path).toEqual([0]);
    expect(moveNode(root, [0], { parent: [], index: 1 }).path).toEqual([0]);
    // Upwards: the clip to the front.
    const up = moveNode(root, [2], { parent: [], index: 0 });
    expect(up.path).toEqual([0]);
    expect((up.root as Extract<EventNode, { type: "layer" }>).children[0]).toBe(r.children[2]);
  });

  it("moveNode to another parent and into an empty sustain slot, adjusting the target path for the removal", () => {
    // Empty start slot on the sustain at [1]: move the random (root child 0) into it.
    const tree = deepFreeze(list("layer", [
      list("random", [clipNode("a.ogg")]),
      sustain(clipNode("loop.ogg")),
    ]));
    const toSlot = moveNode(tree, [0], { parent: [1], slot: "start" });
    expect(toSlot.path).toEqual([0, "start"]);
    expect(getNode(toSlot.root, [0, "start"])).toEqual(list("random", [clipNode("a.ogg")]));
    expect(getNode(toSlot.root, [0, "loop"])).toEqual(clipNode("loop.ogg"));

    // A layer target after the removed node: its path [2] becomes [1] once the node at [0] is gone.
    const root = deepFreeze(list("layer", [
      list("random", [clipNode("a.ogg")]),
      clipNode("b.ogg"),
      list("layer", [clipNode("z.ogg")]),
    ]));
    const a = (root as Extract<EventNode, { type: "layer" }>).children[0];
    const into = moveNode(root, [0], { parent: [2], index: 0 });
    expect(into.path).toEqual([1, 0]);
    expect(getNode(into.root, [1, 0])).toBe(a);
    expect(getNode(into.root, [1, 1])).toEqual(clipNode("z.ogg"));
    expect(getNode(into.root, [0])).toEqual(clipNode("b.ogg"));
  });

  it("canMove refuses moving into itself or a descendant, a filled slot, the root, and past the depth limit", () => {
    const root = sampleTree();
    expect(canMove(root, [0], { parent: [0], index: 0 })).toBe(false);
    expect(canMove(root, [1], { parent: [1], slot: "end" })).toBe(false);
    expect(canMove(root, [1], { parent: [1, "loop"], index: 0 })).toBe(false);
    expect(canMove(root, [2], { parent: [1], slot: "start" })).toBe(false); // start is filled
    expect(canMove(root, [2], { parent: [1], slot: "end" })).toBe(true);
    expect(canMove(root, [], { parent: [0], index: 0 })).toBe(false);
    expect(canMove(root, [1, "loop"], { parent: [], index: 0 })).toBe(false);
    expect(canMove(root, [0], { parent: [0, 0], index: 0 })).toBe(false); // a clip is not a list
    expect(canMove(root, [0], { parent: [9], index: 0 })).toBe(false);

    // A clip (height 1) under a parent at depth 15 would sit at depth 16; at depth 14 it fits.
    const deep = list("layer", [clipNode("x.ogg"), nest(14, list("layer", []))]);
    expect(canMove(deep, [0], { parent: [1, ...zeros(13)], index: 0 })).toBe(true);
    expect(canMove(deep, [0], { parent: [1, ...zeros(14)], index: 0 })).toBe(false);
  });

  it("duplicateNode inserts a deep copy right after; refuses the root and sustain slot children", () => {
    const root = sampleTree();
    const dup = duplicateNode(root, [0, 1]);
    expect(dup.path).toEqual([0, 2]);
    const copy = getNode(dup.root, [0, 2]) as EventNode;
    expect(copy).toEqual(clipNode("sfx/b.ogg"));
    expect(copy).not.toBe(getNode(root, [0, 1]));
    expect(getNode(dup.root, [0, 1])).toBe(getNode(root, [0, 1]));

    expect(canDuplicate(root, [])).toBe(false);
    expect(canDuplicate(root, [1, "start"])).toBe(false);
    expect(() => duplicateNode(root, [])).toThrow(RangeError);
    expect(() => duplicateNode(root, [1, "loop"])).toThrow(RangeError);

    // The node limit: 1023 nodes leave room for a copy of one clip, but not of a 1023-node subtree.
    const big = wideLayer(1022);
    expect(canDuplicate(big, [0])).toBe(true);
    const full = list("layer", [wideLayer(1021), clipNode("x")]);
    expect(countNodes(full)).toBe(1024);
    expect(canDuplicate(full, [1])).toBe(false);
  });

  it("wrapNode puts the node in a fresh list container or a sustain's loop slot", () => {
    const root = sampleTree();
    const c = (root as Extract<EventNode, { type: "layer" }>).children[2];
    const wrapped = wrapNode(root, [2], "random");
    expect(wrapped.path).toEqual([2]);
    const wrapper = getNode(wrapped.root, [2]) as Extract<EventNode, { type: "random" }>;
    expect(wrapper.type).toBe("random");
    expect(wrapper.children).toEqual([c]);
    expect(wrapper.children[0]).toBe(c);
    expect(wrapper.avoidRepeat).toBe(0);

    const inLoop = wrapNode(root, [2], "sustain");
    const sus = getNode(inLoop.root, [2]) as Extract<EventNode, { type: "sustain" }>;
    expect(sus.type).toBe("sustain");
    expect(sus.loop).toBe(c);
    expect(sus.start).toBeUndefined();

    // The wrapper sits at depth 14 with the leaf at depth 15 (kept by the parser); one level more is dropped.
    const leaf = clipNode("leaf.ogg");
    const deep = nest(14, leaf);
    const ok = wrapNode(deep, zeros(14), "random");
    expect(getNode(ok.root, [...zeros(14), 0])).toBe(leaf);
    const parsed = parseAudioEvent({ format: AUDIO_EVENT_FORMAT, root: ok.root }).value.root;
    expect(getNode(parsed, [...zeros(14), 0])).toEqual(leaf);
    expect(() => wrapNode(nest(14, list("layer", [clipNode("x")])), zeros(14), "random")).toThrow(RangeError);
    expect(() => wrapNode(root, [9], "random")).toThrow(RangeError);
  });

  it("no edit mutates its input (deep-frozen trees)", () => {
    const root = deepFreeze(sampleTree());
    const snapshot = JSON.stringify(root);
    setNode(root, [0, 1], clipNode("x"));
    addChild(root, [0], clipNode("x"), 0);
    setSustainSlot(root, [1], "end", clipNode("e"));
    setSustainSlot(root, [1], "start", undefined);
    removeNode(root, [0]);
    reorderChild(root, [], 0, 2);
    moveNode(root, [0, 1], { parent: [1], slot: "end" });
    moveNode(root, [2], { parent: [0], index: 0 });
    duplicateNode(root, [0, 0]);
    wrapNode(root, [2], "sustain");
    cloneNode(root);
    expect(JSON.stringify(root)).toBe(snapshot);
  });
});

describe("eventTree parameters", () => {
  /** An event with a local parameter "Speed" used by the event, a switch, a blend and a sustain's loop and start. */
  function speedEvent(): AudioEventAsset {
    const automation = [{ parameter: "Speed", target: "pitch" as const, curve: [[0, 1], [10, 2]] as [number, number][] }];
    const root = list("layer", [
      { ...newNode("switch"), parameter: "Speed", children: [] } as EventNode,
      { ...newNode("blend"), parameter: "Speed", children: [] } as EventNode,
      sustain({ ...clipNode("loop.ogg"), automation }, { start: { ...clipNode("start.ogg"), automation } }),
      clipNode("x.ogg"),
    ]);
    return eventWith(root, {
      parameters: [{ name: "Speed", min: 0, max: 10, default: 0, seekSpeed: 20 }],
      automation: [{ parameter: "Speed", target: "volume", curve: [[0, 0.5], [10, 1]] }],
    });
  }

  it("parameterUses counts switch/blend parameters and event and node automation", () => {
    const event = speedEvent();
    // The event's automation, the switch, the blend, the loop's and the start's automation.
    expect(parameterUses(event, "Speed")).toBe(5);
    expect(parameterUses(event, "Missing")).toBe(0);
  });

  it("renameParameter renames the definition and every use, sharing unaffected subtrees", () => {
    const event = deepFreeze(speedEvent());
    const renamed = renameParameter(event, "Speed", "Velocity");
    expect(renamed.parameters[0].name).toBe("Velocity");
    expect(renamed.automation[0].parameter).toBe("Velocity");
    expect(parameterUses(renamed, "Speed")).toBe(0);
    expect(parameterUses(renamed, "Velocity")).toBe(5);
    const root = renamed.root as Extract<EventNode, { type: "layer" }>;
    expect(root.children[0]).toMatchObject({ type: "switch", parameter: "Velocity" });
    expect(root.children[1]).toMatchObject({ type: "blend", parameter: "Velocity" });
    expect(root.children[3]).toBe((event.root as Extract<EventNode, { type: "layer" }>).children[3]);
    expect(event.parameters[0].name).toBe("Speed");
    expect(renameParameter(event, "Speed", "Speed")).toBe(event);
  });
});

