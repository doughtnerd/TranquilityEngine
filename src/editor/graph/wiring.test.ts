// The wiring gesture's decisions (ADR 0259), through `wireGesture` with a small graph's wire edits:
// which port a press draws from, which input it picks a wire up from, which edit a landing or a drop
// in empty space makes, and why a wire is refused.
import { describe, expect, it } from "vitest";
import { wireGesture, type GraphPort, type GraphWiringEdits } from "./wiring";

/** A graph of wires into inputs; an input takes one wire, and a node can't feed itself. */
interface Wires {
  edges: { from: string; to: string }[];
}

const node = (ref: string) => ref.slice(0, ref.indexOf("."));
const edits: GraphWiringEdits<Wires> = {
  sourceOf: (g, input) => g.edges.find((e) => e.to === input)?.from,
  whyNot: (g, from, to) => {
    if (node(from) === node(to)) return "a node can't feed itself";
    if (g.edges.some((e) => e.to === to)) return "that input is wired already";
    return null;
  },
  connect: (g, from, to) => (edits.whyNot(g, from, to) ? g : { edges: [...g.edges, { from, to }] }),
  disconnect: (g, input) => ({ edges: g.edges.filter((e) => e.to !== input) }),
  split: (ref) => ({ node: node(ref), port: ref.slice(ref.indexOf(".") + 1) }),
};

const port = (ref: string, side: GraphPort["side"]): GraphPort => ({ ...edits.split(ref), side, ref });
const graph: Wires = { edges: [{ from: "a.out", to: "b.in" }] };

describe("wireGesture", () => {
  it("draws a new wire from a pressed output; landing connects, a drop in space is the panel's", () => {
    const g = wireGesture(edits, graph, port("c.out", "output"));
    expect(g.anchor).toEqual(port("c.out", "output"));
    expect(g.detached).toBeNull();
    expect(g.connect(graph, "c.out", "d.in").edges).toContainEqual({ from: "c.out", to: "d.in" });
    expect(g.drop(graph)).toBeNull();
  });

  it("draws from an unwired input itself", () => {
    const g = wireGesture(edits, graph, port("d.in", "input"));
    expect(g.anchor).toEqual(port("d.in", "input"));
    expect(g.detached).toBeNull();
  });

  it("picks a wired input's wire up from the input end: drawn from its source output, the input detached", () => {
    const g = wireGesture(edits, graph, port("b.in", "input"));
    expect(g.anchor).toEqual(port("a.out", "output"));
    expect(g.detached).toBe("b.in");
  });

  it("moves a picked-up wire to the input it lands on, as one edit", () => {
    const g = wireGesture(edits, graph, port("b.in", "input"));
    expect(g.connect(graph, "a.out", "d.in").edges).toEqual([{ from: "a.out", to: "d.in" }]);
  });

  it("removes a picked-up wire dropped in empty space", () => {
    const g = wireGesture(edits, graph, port("b.in", "input"));
    expect(g.drop(graph)).toEqual({ edges: [] });
  });

  it("judges a picked-up wire without itself: it may go back where it was", () => {
    const g = wireGesture(edits, graph, port("b.in", "input"));
    expect(edits.whyNot(graph, "a.out", "b.in")).toBe("that input is wired already");
    expect(g.whyNot(graph, "a.out", "b.in")).toBeNull();
    expect(g.connect(graph, "a.out", "b.in").edges).toEqual([{ from: "a.out", to: "b.in" }]);
  });

  it("says why a wire is refused, and a refused landing changes nothing", () => {
    const g = wireGesture(edits, graph, port("c.out", "output"));
    expect(g.whyNot(graph, "c.out", "c.in")).toBe("a node can't feed itself");
    expect(g.connect(graph, "c.out", "c.in")).toBe(graph);
  });
});
