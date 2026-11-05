import { describe, expect, it } from "vitest";
import { layoutGraph, type GraphLayout, type LayoutLinkIn, type LayoutNodeIn, type Rect } from "./worldsLayout";

const node = (name: string, spawnable = false): LayoutNodeIn => ({ key: `${spawnable ? "t" : "w"}:${name}`, name, spawnable });
const link = (from: string, to: string, label = "loopback"): LayoutLinkIn => ({ from, to, label });

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Whether the axis-aligned segment p→q passes through the inside of `box`. */
function crosses(p: [number, number], q: [number, number], box: Rect): boolean {
  const [x1, x2] = [Math.min(p[0], q[0]), Math.max(p[0], q[0])];
  const [y1, y2] = [Math.min(p[1], q[1]), Math.max(p[1], q[1])];
  return x1 < box.x + box.w && x2 > box.x && y1 < box.y + box.h && y2 > box.y;
}

/** Every rule the panel relies on: no arrow over a node, no label over a node or another label, arrows orthogonal, everything inside the graph. */
function expectClean(g: GraphLayout): void {
  const labels = g.links.flatMap((r) => (r ? [r.label] : []));
  g.links.forEach((r, li) => {
    if (!r) return;
    for (let i = 1; i < r.points.length; i++) {
      const p = r.points[i - 1], q = r.points[i];
      expect(p[0] === q[0] || p[1] === q[1], `link ${li} segment ${i} is orthogonal`).toBe(true);
      for (const n of g.nodes) expect(crosses(p, q, n), `link ${li} segment ${i} crosses ${n.key}`).toBe(false);
    }
    for (const [x, y] of r.points) expect(x >= 0 && x <= g.width && y >= 0 && y <= g.height).toBe(true);
  });
  labels.forEach((a, i) => {
    for (const n of g.nodes) expect(overlaps(a, n), `label ${i} overlaps ${n.key}`).toBe(false);
    labels.forEach((b, j) => j > i && expect(overlaps(a, b), `labels ${i} and ${j} overlap`).toBe(false));
    expect(a.x >= 0 && a.x + a.w <= g.width && a.y >= 0 && a.y + a.h <= g.height).toBe(true);
  });
  g.nodes.forEach((a, i) => g.nodes.forEach((b, j) => j > i && expect(overlaps(a, b), `${a.key} overlaps ${b.key}`).toBe(false)));
}

const colOf = (g: GraphLayout, key: string) => g.nodes.find((n) => n.key === key)!.col;

describe("Worlds graph layout", () => {
  it("lays out the Arena sample: Client and Client 2 left of the Spawnable Server, no arrow or label over anything", () => {
    const g = layoutGraph([node("Client"), node("Server", true), node("Client 2", true)], [link("Client", "Server"), link("Client 2", "Server")]);
    expect(colOf(g, "w:Client")).toBe(0);
    expect(colOf(g, "t:Client 2")).toBe(0);
    expect(colOf(g, "t:Server")).toBe(1);
    expect(g.links.every(Boolean)).toBe(true);
    expectClean(g);
  });

  it("puts a chain in successive columns", () => {
    const g = layoutGraph([node("A"), node("B"), node("C"), node("D", true)], [link("A", "B"), link("B", "C"), link("C", "D", "websocket")]);
    expect(g.nodes.map((n) => n.col)).toEqual([0, 1, 2, 3]);
    expectClean(g);
  });

  it("fans out from one client to several servers, and in from several clients to one", () => {
    const out = layoutGraph([node("C"), node("S1"), node("S2"), node("S3", true)], [link("C", "S1"), link("C", "S2"), link("C", "S3", "websocket")]);
    expect(out.nodes.map((n) => n.col)).toEqual([0, 1, 1, 1]);
    expectClean(out);
    const fanIn = layoutGraph([node("A"), node("B"), node("C"), node("S")], [link("A", "S"), link("B", "S"), link("C", "S")]);
    expectClean(fanIn);
  });

  it("lays out a client, a server and two Spawnable Worlds, the unlinked one in a last column", () => {
    const g = layoutGraph([node("Client"), node("Server"), node("Match", true), node("Lobby", true)], [link("Client", "Server"), link("Server", "Match")]);
    expect(g.nodes.map((n) => n.col)).toEqual([0, 1, 2, 3]);
    expectClean(g);
  });

  it("routes a link that skips a column around the nodes in it", () => {
    const g = layoutGraph([node("A"), node("B"), node("C"), node("M1"), node("M2")], [link("A", "B"), link("B", "C"), link("A", "C"), link("M1", "B"), link("M2", "B")]);
    expect(g.nodes.map((n) => n.col)).toEqual([0, 1, 2, 0, 0]);
    expectClean(g);
  });

  it("survives a cycle, routing the link back below the nodes", () => {
    const g = layoutGraph([node("Client"), node("Server")], [link("Client", "Server"), link("Server", "Client", "websocket")]);
    expect(g.nodes.every((n) => n.col <= 1)).toBe(true);
    expect(g.links.every(Boolean)).toBe(true);
    expectClean(g);
  });

  it("keeps long and many labels apart", () => {
    const g = layoutGraph(
      [node("A"), node("B"), node("C"), node("S")],
      [link("A", "S", "a-very-long-transport-name"), link("B", "S", "websocket"), link("C", "S"), link("A", "S", "connected ×2"), link("B", "S", "connecting…")],
    );
    expectClean(g);
  });

  it("skips links naming a missing World or the same World twice, and draws a lone World", () => {
    const g = layoutGraph([node("Default")], [link("Default", "Nowhere"), link("Default", "Default")]);
    expect(g.links).toEqual([null, null]);
    expect(g.nodes).toHaveLength(1);
    expect(g.width).toBeGreaterThan(g.nodes[0].w);
    expectClean(g);
  });

  it("draws Worlds sharing a name (an invalid draft) without overlapping them; links go to the first", () => {
    const g = layoutGraph([node("A"), { key: "w:A2", name: "A", spawnable: false }, node("S")], [link("A", "S")]);
    expect(g.nodes).toHaveLength(3);
    expectClean(g);
  });
});
