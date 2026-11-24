import { describe, expect, it } from "vitest";
import { clipboardText } from "../clipboard";
import { DUPLICATE_OFFSET, freeId, graphDocument, pasteProperties, type GraphGroupData, type GraphNoteData } from "./document";

// The graph document's edits, driven through a small graph kind of the test's own: nodes that may
// read a property (`settings.reads`), wires between them, optional groups (stored as `boxes`, so the
// kind's group access is exercised) and notes.

interface Node {
  id: string;
  type: string;
  position: [number, number];
  reads?: string;
}
interface Property {
  name: string;
  type: "number" | "color";
  value: unknown;
}
interface Graph {
  nodes: Node[];
  properties: Property[];
  wires: { from: string; to: string }[];
  boxes?: { id: string; label: string; ids: string[] }[];
  notes?: GraphNoteData[];
}
interface Clip {
  format: "test.graph.clipboard@1";
  nodes: Node[];
  wires: { from: string; to: string }[];
}

const remove = (g: Graph, ids: Iterable<string>): Graph => {
  const gone = new Set([...ids].filter((id) => g.nodes.some((n) => n.id === id)));
  if (gone.size === 0) return g;
  const boxes = (g.boxes ?? []).map((b) => ({ ...b, ids: b.ids.filter((id) => !gone.has(id)) })).filter((b) => b.ids.length);
  return { ...g, nodes: g.nodes.filter((n) => !gone.has(n.id)), wires: g.wires.filter((w) => !gone.has(w.from) && !gone.has(w.to)), boxes: boxes.length ? boxes : undefined };
};

const edits = graphDocument<Graph, Node, Property, Clip>({
  items: (g) => g.nodes.map((n) => n.id),
  remove,
  newId: (g, of) => freeId(of, (id) => [...(g.boxes ?? []), ...(g.notes ?? [])].some((x) => x.id === id)),
  groups: {
    get: (g): GraphGroupData[] => (g.boxes ?? []).map((b) => ({ id: b.id, title: b.label, members: b.ids })),
    set(g, list) {
      if (list.length) g.boxes = list.map((gr) => ({ id: gr.id, label: gr.title, ids: gr.members }));
      else delete g.boxes;
    },
  },
  notes: {
    get: (g) => g.notes ?? [],
    set(g, list) {
      if (list.length) g.notes = list;
      else delete g.notes;
    },
  },
  property: {
    label: (type) => (type === "number" ? "Number" : "Colour"),
    create: (name, type) => ({ name, type, value: type === "number" ? 0 : "#ffffff" }),
    reads: (n, name) => n.reads === name,
    retarget: (n, name) => void (n.reads = name),
  },
  clipboard: {
    format: "test.graph.clipboard@1",
    copy(g, ids) {
      const nodes = g.nodes.filter((n) => ids.has(n.id) && n.type !== "fixed");
      if (nodes.length === 0) return null;
      const inside = (id: string) => nodes.some((n) => n.id === id);
      return { nodes: structuredClone(nodes), wires: g.wires.filter((w) => inside(w.from) && inside(w.to)) };
    },
    read(raw) {
      if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) return null;
      if (raw.nodes.some((n) => typeof n.type !== "string")) throw new Error("malformed");
      return { format: raw.format, nodes: raw.nodes, wires: raw.wires ?? [] };
    },
    positions: (clip) => clip.nodes.map((n) => n.position),
    paste(g, clip, [dx, dy]) {
      const map = new Map<string, string>();
      for (const n of clip.nodes) {
        const id = freeId(n.type, (x) => g.nodes.some((m) => m.id === x));
        map.set(n.id, id);
        g.nodes.push({ ...n, id, position: [Math.round(n.position[0] + dx), Math.round(n.position[1] + dy)] });
      }
      for (const w of clip.wires) if (map.has(w.from) && map.has(w.to)) g.wires.push({ from: map.get(w.from)!, to: map.get(w.to)! });
      return [...map.values()];
    },
  },
});

/** A fixed node, an add and a time node wired into it, and a node reading the property "Speed". */
function sample(): Graph {
  return {
    nodes: [
      { id: "out", type: "fixed", position: [400, 0] },
      { id: "add1", type: "add", position: [100, 0] },
      { id: "time1", type: "time", position: [0, 50] },
      { id: "prop1", type: "prop", position: [0, 150], reads: "Speed" },
    ],
    properties: [{ name: "Speed", type: "number", value: 1 }],
    wires: [
      { from: "time1", to: "add1" },
      { from: "add1", to: "out" },
    ],
  };
}

describe("free ids", () => {
  it("count from 1 and never use the bare prefix", () => {
    const taken = (names: string[]) => (n: string) => names.includes(n);
    expect(freeId("note", taken([]))).toBe("note1");
    expect(freeId("note", taken(["note1"]))).toBe("note2");
  });
});

describe("graph document: properties", () => {
  it("adds properties named after their type, never changing the graph it was given", () => {
    const g0 = sample();
    const before = JSON.stringify(g0);
    let made = edits.addProperty(g0, "number");
    expect(made.name).toBe("Number");
    made = edits.addProperty(made.graph, "number");
    expect(made.name).toBe("Number 2");
    expect(made.graph.properties.at(-1)).toEqual({ name: "Number 2", type: "number", value: 0 });
    expect(JSON.stringify(g0)).toBe(before);
  });

  it("says why a name can't be used, the same words for every graph", () => {
    const g = edits.addProperty(sample(), "color").graph;
    expect(edits.whyNotPropertyName(g, "Speed", "Colour")).toBe(`there's already a property named "Colour"`);
    expect(edits.whyNotPropertyName(g, "Speed", " Tint")).toMatch(/space/);
    expect(edits.whyNotPropertyName(g, "Speed", "  ")).toMatch(/needs a name/);
    expect(edits.whyNotPropertyName(g, "Speed", "Speed")).toBeNull();
    expect(edits.whyNotPropertyName(g, null, "Speed")).toMatch(/already/);
  });

  it("renames a property and the nodes reading it, refusing a taken name", () => {
    let g = edits.addProperty(sample(), "color").graph;
    expect(edits.renameProperty(g, "Speed", "Colour")).toBe(g);
    g = edits.renameProperty(g, "Speed", "Rate");
    expect(g.properties[0].name).toBe("Rate");
    expect(g.nodes.find((n) => n.id === "prop1")!.reads).toBe("Rate");
  });

  it("sets a value, reorders, and removes a property with the nodes reading it and their wires", () => {
    let g = edits.addProperty(sample(), "color").graph;
    g = edits.setPropertyValue(g, "Speed", [1, 2]);
    expect(g.properties[0].value).toEqual([1, 2]);
    expect(edits.setPropertyValue(g, "nope", 3)).toBe(g);
    g = edits.moveProperty(g, "Speed", 1);
    expect(g.properties.map((p) => p.name)).toEqual(["Colour", "Speed"]);
    expect(edits.moveProperty(g, "Speed", 1)).toBe(g);
    g = { ...g, wires: [...g.wires, { from: "prop1", to: "add1" }] };
    g = edits.removeProperty(g, "Speed");
    expect(g.properties.map((p) => p.name)).toEqual(["Colour"]);
    expect(g.nodes.map((n) => n.id)).toEqual(["out", "add1", "time1"]);
    expect(g.wires.some((w) => w.from === "prop1")).toBe(false);
    expect(edits.removeProperty(g, "Speed")).toBe(g);
  });
});

describe("graph document: groups and notes", () => {
  it("groups items, moving them out of other groups, through the kind's own storage", () => {
    let made = edits.group(sample(), ["add1", "time1", "missing", "add1"], "Math");
    expect(made.id).toBe("group1");
    let g = made.graph;
    made = edits.group(g, ["time1"]);
    g = made.graph;
    expect(g.boxes).toEqual([
      { id: "group1", label: "Math", ids: ["add1"] },
      { id: "group2", label: "Group", ids: ["time1"] },
    ]);
    expect(edits.group(g, ["missing"])).toEqual({ graph: g, id: null });
    g = edits.setGroupTitle(g, "group2", "Clock");
    expect(g.boxes![1].label).toBe("Clock");
    expect(edits.setGroupTitle(g, "group2", "Clock")).toBe(g);
    // Regrouping every member of a group empties it, and an empty group goes.
    g = edits.group(g, ["add1"]).graph;
    expect(g.boxes!.map((b) => b.id)).toEqual(["group2", "group3"]);
    g = edits.ungroup(edits.ungroup(g, "group3"), "group2");
    expect(g.boxes).toBeUndefined();
    expect(edits.ungroup(g, "group1")).toBe(g);
  });

  it("adds, edits and removes notes, rounding and keeping a smallest size; an edit that changes nothing is no edit", () => {
    const made = edits.addNote(sample(), [10.4, 20.6], "Hi");
    let g = made.graph;
    expect(g.notes).toEqual([{ id: "note1", position: [10, 21], size: [200, 100], text: "Hi" }]);
    g = edits.updateNote(g, made.id, { text: "Bye", size: [10, 10], position: [5.5, 6.5] });
    expect(g.notes![0]).toEqual({ id: "note1", position: [6, 7], size: [80, 40], text: "Bye" });
    expect(edits.updateNote(g, made.id, { text: "Bye", position: [6, 7] })).toBe(g);
    expect(edits.updateNote(g, "nope", { text: "x" })).toBe(g);
    expect(edits.removeNote(g, made.id).notes).toBeUndefined();
    expect(edits.removeNote(g, "nope")).toBe(g);
  });
});

describe("graph document: copy, paste, duplicate", () => {
  it("copies what the kind copies, stamped with its clipboard format", () => {
    const clip = edits.copy(sample(), ["add1", "time1", "out"])!;
    expect(clip.format).toBe("test.graph.clipboard@1");
    expect(edits.clipboardFormat).toBe("test.graph.clipboard@1");
    expect(clip.nodes.map((n) => n.id)).toEqual(["add1", "time1"]);
    expect(clip.wires).toEqual([{ from: "time1", to: "add1" }]);
    expect(edits.copy(sample(), ["out"])).toBeNull();
  });

  it("pastes with new ids, the copy's top-left at the point, keeping the wires among the copied items", () => {
    const g = sample();
    const clip = edits.copy(g, ["add1", "time1"])!;
    const made = edits.paste(g, clip, [500.4, 500.6]);
    expect(made.ids).toEqual(["add2", "time2"]);
    expect(made.graph.nodes.find((n) => n.id === "add2")!.position).toEqual([600, 501]);
    expect(made.graph.nodes.find((n) => n.id === "time2")!.position).toEqual([500, 551]);
    expect(made.graph.wires).toContainEqual({ from: "time2", to: "add2" });
    expect(g.nodes).toHaveLength(4); // the input is unchanged
  });

  it("reads its own clipboard text back, and nothing from other text (ADR 0226)", () => {
    const clip = edits.copy(sample(), ["add1", "time1"])!;
    expect(edits.clipboardFromText(clipboardText(clip))).toEqual(clip);
    const text = (v: object) => JSON.stringify({ ...clip, ...v });
    expect(edits.clipboardFromText("add1")).toBeNull(); // plain text
    expect(edits.clipboardFromText(text({ format: "myco.shadergraph.clipboard@1" }))).toBeNull(); // another kind's
    expect(edits.clipboardFromText(text({ nodes: [] }))).toBeNull(); // the kind says it's empty
    expect(edits.clipboardFromText(text({ nodes: [{ id: "x", position: [0, 0] }] }))).toBeNull(); // the kind's reader throws
  });

  it("duplicates the items offset from where they were", () => {
    const g = sample();
    const d = edits.duplicate(g, ["add1", "time1", "out"]);
    expect(d.ids).toEqual(["add2", "time2"]);
    expect(d.graph.nodes.find((n) => n.id === "time2")!.position).toEqual([DUPLICATE_OFFSET[0], 50 + DUPLICATE_OFFSET[1]]);
    expect(d.graph.wires).toContainEqual({ from: "time2", to: "add2" });
    expect(d.graph.wires.filter((w) => w.to === "out")).toHaveLength(1); // a wire from outside the copy isn't duplicated
    expect(edits.duplicate(g, [], [10, 10])).toEqual({ graph: g, ids: [] });
    expect(edits.duplicate(g, ["time1"], [10, 10]).graph.nodes.at(-1)!.position).toEqual([10, 60]);
  });

  it("removes items and lists them by the kind's rules", () => {
    const g = sample();
    expect(edits.items(g)).toEqual(["out", "add1", "time1", "prop1"]);
    expect(edits.remove(g, ["nothing"])).toBe(g);
    expect(edits.remove(g, ["add1"]).wires).toEqual([]);
  });
});

describe("graph document: pasteProperties", () => {
  it("adds what's missing, keeps same-named properties of the same type, and renames a clash of types to a name the paste doesn't carry", () => {
    const board: Property[] = [{ name: "Speed", type: "color", value: "#000000" }, { name: "Size", type: "number", value: 1 }];
    const renames = pasteProperties(board, [
      { name: "Speed", type: "number", value: 2 },
      { name: "Speed 2", type: "number", value: 5 },
      { name: "Size", type: "number", value: 7 },
    ]);
    expect(renames).toEqual(new Map([["Speed", "Speed 3"]]));
    expect(board).toEqual([
      { name: "Speed", type: "color", value: "#000000" },
      { name: "Size", type: "number", value: 1 },
      { name: "Speed 3", type: "number", value: 2 },
      { name: "Speed 2", type: "number", value: 5 },
    ]);
    expect(pasteProperties(board, undefined)).toEqual(new Map());
  });
});
