// The Worlds panel's graph layout (ADR 0032, 0062): start-up and Spawnable Worlds as one layered
// graph, with orthogonal link arrows routed through the gaps between columns and a label pill per
// link. Pure (nodes and links in, positions, paths and label boxes out), so it's unit-tested;
// WorldsPanel.tsx draws the result.
//
// Columns follow link depth: a link's `from` (the client) sits left of its `to` (the server), so a
// Spawnable World lands in the column after the deepest World linking to it; Spawnable Worlds with
// no links get a final column. Arrows leave a node's right side and enter the target's left side,
// turning only inside the gaps between columns. A link spanning several columns passes through a
// slot reserved for it in each column it crosses; a link pointing back (a cycle) drops to a lane
// below every node. So no arrow passes over a node, and labels, which sit in the gaps (each gap is
// as wide as its widest label), never overlap one either; a collision pass stacks a gap's labels.

/** A node to place: `key` is unique; links name nodes by `name` (the first node with a name wins). */
export interface LayoutNodeIn {
  key: string;
  name: string;
  spawnable: boolean;
}

export interface LayoutLinkIn {
  from: string;
  to: string;
  label: string;
}

export interface LayoutOptions {
  nodeW: number;
  nodeH: number;
  /** The least space between two columns. */
  gapX: number;
  /** The space between two nodes in a column. */
  gapY: number;
  /** The margin around the graph. */
  pad: number;
  /** The height of a slot a long link passes through. */
  slotH: number;
  /** A label pill's height, its padding each side of the text, and the width of one character of its text. */
  labelH: number;
  labelPadX: number;
  charW: number;
  /** The least space between a label and the next label above or below it. */
  labelMargin: number;
  /** The least space between a label and the columns each side of its gap, so the arrow and its head show. */
  labelSideX: number;
  /** The space between parallel vertical runs in a gap, and between lanes below the nodes. */
  track: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  nodeW: 118,
  nodeH: 62,
  gapX: 44,
  gapY: 14,
  pad: 8,
  slotH: 12,
  labelH: 15,
  labelPadX: 5,
  charW: 5.6,
  labelMargin: 4,
  labelSideX: 10,
  track: 8,
};

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NodePlace extends Rect {
  key: string;
  col: number;
}

export interface LinkRoute {
  /** The orthogonal polyline from the source's right side to just short of the target's left side (the arrowhead's tip). */
  points: [number, number][];
  /** The polyline as an SVG path, with rounded corners. */
  d: string;
  /** The label pill. */
  label: Rect;
}

export interface GraphLayout {
  nodes: NodePlace[];
  /** One per input link, in order: null for a link naming a missing World or the same World at both ends. */
  links: (LinkRoute | null)[];
  width: number;
  height: number;
}

interface Item {
  /** A node's index, or -1 for a slot a long link passes through. */
  node: number;
  link: number;
  col: number;
  order: number;
  y: number;
  h: number;
}

export function layoutGraph(nodes: readonly LayoutNodeIn[], links: readonly LayoutLinkIn[], opts: LayoutOptions = DEFAULT_LAYOUT): GraphLayout {
  const { nodeW, nodeH, gapY, pad } = opts;
  const n = nodes.length;
  const byName = new Map<string, number>();
  nodes.forEach((node, i) => byName.has(node.name) || byName.set(node.name, i));
  const ends = links.map((l) => {
    const a = byName.get(l.from), b = byName.get(l.to);
    return a === undefined || b === undefined || a === b ? null : { a, b };
  });
  const live = ends.filter((e): e is { a: number; b: number } => e !== null);

  // Columns: longest-path layering, capped at n passes so a cycle can't loop forever.
  const col = new Array<number>(n).fill(0);
  for (let pass = 0; pass < n; pass++) {
    let changed = false;
    for (const { a, b } of live) {
      if (col[b] >= col[a] + 1 || col[a] + 1 >= n) continue;
      col[b] = col[a] + 1;
      changed = true;
    }
    if (!changed) break;
  }
  const linked = new Set(live.flatMap((e) => [e.a, e.b]));
  const loose = nodes.map((node, i) => node.spawnable && !linked.has(i));
  const deepest = Math.max(-1, ...col.filter((_, i) => !loose[i]));
  nodes.forEach((_, i) => loose[i] && (col[i] = deepest + 1));
  const cols = Math.max(1, ...col.map((c) => c + 1));

  // Column items: nodes, and a slot in each column a forward link skips over.
  const items: Item[] = nodes.map((_, i) => ({ node: i, link: -1, col: col[i], order: i, y: 0, h: nodeH }));
  const slots = new Map<string, Item>(); // `${link}:${col}`
  ends.forEach((e, li) => {
    if (!e) return;
    for (let c = col[e.a] + 1; c < col[e.b]; c++) {
      const slot: Item = { node: -1, link: li, col: c, order: n + li, y: 0, h: opts.slotH };
      items.push(slot);
      slots.set(`${li}:${c}`, slot);
    }
  });
  // The item a forward link comes from into column c: its source, or its slot in column c-1.
  const feeder = (li: number, c: number): Item => slots.get(`${li}:${c - 1}`) ?? items[ends[li]!.a];
  const columns: Item[][] = Array.from({ length: cols }, () => []);
  for (const it of items) columns[it.col].push(it);
  // Order each column by where its items' feeders sit in the columns before it (fewer crossings).
  const rank = new Map<Item, number>();
  columns.forEach((list, c) => {
    const key = (it: Item, at: number): number => {
      const from = it.node >= 0
        ? ends.flatMap((e, li) => (e && e.b === it.node && col[e.a] < c ? [rank.get(feeder(li, c)) ?? 0] : []))
        : [rank.get(feeder(it.link, c)) ?? 0];
      return from.length ? from.reduce((s, v) => s + v, 0) / from.length : at;
    };
    const keyed = list.map((it, at) => ({ it, k: c === 0 ? at : key(it, at) }));
    keyed.sort((p, q) => p.k - q.k || p.it.order - q.it.order);
    let y = pad;
    keyed.forEach(({ it }, i) => {
      rank.set(it, i);
      it.y = y;
      y += it.h + gapY;
    });
    columns[c] = keyed.map((k) => k.it);
  });
  const contentBottom = Math.max(pad + nodeH, ...items.map((it) => it.y + it.h));

  // Ports: each node's links leave its right side and enter its left side, spread out and ordered
  // by where the other end is, so they don't cross at the node.
  const centre = (it: Item) => it.y + it.h / 2;
  const backward = (li: number) => col[ends[li]!.b] <= col[ends[li]!.a];
  const lanes = new Map<number, number>();
  ends.forEach((e, li) => e && backward(li) && lanes.set(li, contentBottom + opts.track * (lanes.size + 1)));
  const outY = new Map<number, number>(), inY = new Map<number, number>();
  nodes.forEach((_, i) => {
    const it = items[i];
    const spread = (list: { li: number; k: number }[], into: Map<number, number>) =>
      list.sort((p, q) => p.k - q.k || p.li - q.li).forEach(({ li }, k) => into.set(li, it.y + (it.h * (k + 1)) / (list.length + 1)));
    const firstStep = (li: number) => (backward(li) ? lanes.get(li)! : centre(slots.get(`${li}:${col[i] + 1}`) ?? items[ends[li]!.b]));
    spread(ends.flatMap((e, li) => (e && e.a === i ? [{ li, k: firstStep(li) }] : [])), outY);
    const lastStep = (li: number) => (backward(li) ? lanes.get(li)! : centre(slots.get(`${li}:${col[i] - 1}`) ?? items[ends[li]!.a]));
    spread(ends.flatMap((e, li) => (e && e.b === i ? [{ li, k: lastStep(li) }] : [])), inY);
  });

  // Each link's vertical runs, one per gap it turns in. Gap g lies right of column g (gap -1 is left of column 0).
  interface Run { li: number; gap: number; y1: number; y2: number }
  const runs: Run[][] = ends.map((e, li) => {
    if (!e) return [];
    const ca = col[e.a], cb = col[e.b];
    if (backward(li)) return [{ li, gap: ca, y1: outY.get(li)!, y2: lanes.get(li)! }, { li, gap: cb - 1, y1: lanes.get(li)!, y2: inY.get(li)! }];
    const out: Run[] = [];
    let y = outY.get(li)!;
    for (let g = ca; g < cb; g++) {
      const next = g + 1 === cb ? inY.get(li)! : centre(slots.get(`${li}:${g + 1}`)!);
      out.push({ li, gap: g, y1: y, y2: next });
      y = next;
    }
    return out;
  });
  const byGap = new Map<number, Run[]>();
  for (const r of runs.flat()) byGap.set(r.gap, [...(byGap.get(r.gap) ?? []), r]);
  for (const list of byGap.values()) list.sort((p, q) => Math.min(p.y1, p.y2) - Math.min(q.y1, q.y2) || p.y1 - q.y1 || p.li - q.li);

  // Labels: in the gap of each link's first run, as wide as their text.
  const labelW = (li: number) => links[li].label.length * opts.charW + opts.labelPadX * 2;
  const labelGap = (li: number) => runs[li][0]?.gap;
  const gapW = (g: number): number => {
    const inner = g >= 0 && g < cols - 1;
    const tracks = byGap.get(g)?.length ?? 0;
    const widest = Math.max(0, ...ends.flatMap((e, li) => (e && labelGap(li) === g ? [labelW(li)] : [])));
    const need = Math.max(widest ? widest + opts.labelSideX * 2 : 0, tracks ? (tracks + 1) * opts.track : 0);
    return Math.max(inner ? opts.gapX : pad, need);
  };
  const gapLeft = new Map<number, number>();
  const colX: number[] = [];
  let x = 0;
  for (let g = -1; g < cols; g++) {
    if (g >= 0) {
      colX[g] = x;
      x += nodeW;
    }
    gapLeft.set(g, x);
    x += gapW(g);
  }
  const width = x;
  const trackX = (r: Run) => {
    const list = byGap.get(r.gap)!;
    return gapLeft.get(r.gap)! + (gapW(r.gap) * (list.indexOf(r) + 1)) / (list.length + 1);
  };

  const places: NodePlace[] = nodes.map((node, i) => ({ key: node.key, col: col[i], x: colX[col[i]], y: items[i].y, w: nodeW, h: nodeH }));

  // Label boxes, then a collision pass per gap: stack each gap's labels top to bottom.
  const labels = new Map<number, Rect>();
  const wanted = (li: number) => {
    const r = runs[li][0];
    return (r.y1 + r.y2) / 2 - opts.labelH / 2;
  };
  for (const [g] of byGap) {
    const mine = ends.flatMap((e, li) => (e && labelGap(li) === g ? [li] : [])).sort((p, q) => wanted(p) - wanted(q) || p - q);
    let floor = -Infinity;
    for (const li of mine) {
      const w = labelW(li);
      const y = Math.max(wanted(li), floor);
      labels.set(li, { x: gapLeft.get(g)! + (gapW(g) - w) / 2, y, w, h: opts.labelH });
      floor = y + opts.labelH + opts.labelMargin;
    }
  }
  // A label pushed above the graph's top moves everything down.
  const top = Math.min(pad, ...[...labels.values()].map((r) => r.y));
  const dy = pad - top;

  const routes = ends.map((e, li): LinkRoute | null => {
    if (!e) return null;
    const pts: [number, number][] = [[colX[col[e.a]] + nodeW, outY.get(li)!]];
    for (const r of runs[li]) {
      const tx = trackX(r);
      pts.push([tx, r.y1], [tx, r.y2]);
    }
    pts.push([colX[col[e.b]] - 1, inY.get(li)!]);
    const points = simplify(pts).map(([px, py]) => [px, py + dy] as [number, number]);
    const label = labels.get(li)!;
    return { points, d: roundedPath(points, 4), label: { ...label, y: label.y + dy } };
  });
  for (const p of places) p.y += dy;

  const bottoms = [contentBottom, ...lanes.values(), ...[...labels.values()].map((r) => r.y + r.h)];
  return { nodes: places, links: routes, width, height: Math.max(...bottoms) + dy + pad };
}

/** The polyline without repeated points and without middle points on a straight run. */
function simplify(pts: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 0.01 && Math.abs(last[1] - p[1]) < 0.01) continue;
    const prev = out[out.length - 2];
    if (prev && last && ((Math.abs(prev[0] - last[0]) < 0.01 && Math.abs(last[0] - p[0]) < 0.01) || (Math.abs(prev[1] - last[1]) < 0.01 && Math.abs(last[1] - p[1]) < 0.01))) out.pop();
    out.push(p);
  }
  return out;
}

const fmt = (v: number) => String(Math.round(v * 10) / 10);

/** An orthogonal polyline as an SVG path whose corners are rounded by up to `radius`. */
function roundedPath(pts: [number, number][], radius: number): string {
  let d = `M${fmt(pts[0][0])},${fmt(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [cx, cy] = pts[i], [nx, ny] = pts[i + 1];
    const r = Math.min(radius, Math.hypot(cx - px, cy - py) / 2, Math.hypot(nx - cx, ny - cy) / 2);
    const toward = (ax: number, ay: number, len: number): [number, number] => {
      const l = Math.hypot(ax - cx, ay - cy) || 1;
      return [cx + ((ax - cx) / l) * len, cy + ((ay - cy) / l) * len];
    };
    const [ax, ay] = toward(px, py, r), [bx, by] = toward(nx, ny, r);
    d += ` L${fmt(ax)},${fmt(ay)} Q${fmt(cx)},${fmt(cy)} ${fmt(bx)},${fmt(by)}`;
  }
  const end = pts[pts.length - 1];
  return `${d} L${fmt(end[0])},${fmt(end[1])}`;
}
