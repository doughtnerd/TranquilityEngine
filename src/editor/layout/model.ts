// Editor panel layout (docking). Pure data and geometry, no DOM, so the rules are unit-tested.
//
// The viewport sits in the centre. Around it are docks, listed outermost first: each dock claims
// a strip on one side (left, right or bottom) of whatever space the docks outside it left, so an
// outer dock spans the full height (left/right) or width (bottom) of that space. A dock holds one
// or more tab groups split evenly along it (stacked in side docks, side by side in the bottom
// dock); a group shows one panel at a time, with tabs when it has more than one.

export type PanelId = "hierarchy" | "inspector" | "assets" | "history" | "code";
export type Side = "left" | "right" | "bottom";

export const PANELS: readonly PanelId[] = ["hierarchy", "inspector", "assets", "history", "code"];
export const PANEL_TITLES: Record<PanelId, string> = { hierarchy: "Hierarchy", inspector: "Inspector", assets: "Assets", history: "History", code: "Code" };

export interface TabGroup {
  id: string;
  panels: PanelId[];
  active: PanelId;
}

export interface Dock {
  id: string;
  side: Side;
  /** Thickness in CSS pixels: width for left/right docks, height for bottom docks. */
  size: number;
  groups: TabGroup[];
  /** Share of the dock's length for each group; sums to 1. */
  fractions: number[];
}

export interface Layout {
  version: 1;
  /** Outermost first. */
  docks: Dock[];
}

/** Where a dragged panel would go. */
export type DropTarget =
  | { kind: "tab"; group: string }
  | { kind: "split"; dock: string; index: number }
  | { kind: "edge"; side: Side; placement: "outer" | "inner" };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Height of a group's header (title or tabs); keep in sync with the CSS. */
export const HEADER_HEIGHT = 28;
/** Distance from the layout's outer edge, or the viewport's edge, that targets a new dock. */
export const EDGE_BAND = 28;
export const DEFAULT_SIZE: Record<Side, number> = { left: 240, right: 300, bottom: 190 };
export const MIN_DOCK = 120;
export const MIN_CENTER = { w: 200, h: 140 };
/** Smallest share of a dock a group can be resized to. */
export const MIN_FRACTION = 0.1;

let nextId = 1;
const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}-${nextId++}`;

export function defaultLayout(): Layout {
  return {
    version: 1,
    docks: [
      { id: "bottom", side: "bottom", size: DEFAULT_SIZE.bottom, groups: [{ id: "assets", panels: ["assets", "code"], active: "assets" }], fractions: [1] },
      { id: "left", side: "left", size: DEFAULT_SIZE.left, groups: [{ id: "hierarchy", panels: ["hierarchy"], active: "hierarchy" }], fractions: [1] },
      { id: "right", side: "right", size: DEFAULT_SIZE.right, groups: [{ id: "inspector", panels: ["inspector", "history"], active: "inspector" }], fractions: [1] },
    ],
  };
}

const even = (n: number) => Array.from({ length: n }, () => 1 / n);

/** Drop empty groups and docks, keep every group's active panel valid and fractions summing to 1. */
function normalize(layout: Layout): Layout {
  const docks: Dock[] = [];
  for (const d of layout.docks) {
    const kept = d.groups.map((g, i) => ({ g, f: d.fractions[i] ?? 0 })).filter(({ g }) => g.panels.length > 0);
    if (kept.length === 0) continue;
    const total = kept.reduce((s, k) => s + k.f, 0);
    const fractions = total > 0 ? kept.map((k) => k.f / total) : even(kept.length);
    const groups = kept.map(({ g }) => ({ ...g, active: g.panels.includes(g.active) ? g.active : g.panels[0] }));
    docks.push({ ...d, groups, fractions });
  }
  return { version: 1, docks };
}

function locate(layout: Layout, panel: PanelId): { dock: Dock; group: TabGroup } | null {
  for (const dock of layout.docks) for (const group of dock.groups) if (group.panels.includes(panel)) return { dock, group };
  return null;
}

/** A structural fingerprint (ignores sizes and ids), to detect moves that change nothing. */
function shape(layout: Layout): string {
  return JSON.stringify(layout.docks.map((d) => [d.side, d.groups.map((g) => [...g.panels])]));
}

/**
 * Move `panel` to `target`. Returns `layout` itself (unchanged, same object) when the target
 * doesn't exist or the move wouldn't change anything; otherwise a new layout. A group that gains
 * a split gets even shares in its dock, so panels in a zone stay uniform.
 */
export function movePanel(layout: Layout, panel: PanelId, target: DropTarget): Layout {
  const from = locate(layout, panel);
  if (!from) return layout;
  // Work on a copy with the panel taken out (leaving an empty group in place, so indices hold).
  const next: Layout = structuredClone(layout);
  for (const d of next.docks) for (const g of d.groups) g.panels = g.panels.filter((p) => p !== panel);

  if (target.kind === "tab") {
    const dock = next.docks.find((d) => d.groups.some((g) => g.id === target.group));
    const group = dock?.groups.find((g) => g.id === target.group);
    if (!group) return layout;
    group.panels.push(panel);
    group.active = panel;
  } else if (target.kind === "split") {
    const dock = next.docks.find((d) => d.id === target.dock);
    if (!dock) return layout;
    const index = Math.max(0, Math.min(target.index, dock.groups.length));
    dock.groups.splice(index, 0, { id: newId("g"), panels: [panel], active: panel });
    // Uniform with the other panels in the zone: every group that will remain gets an equal share.
    const remaining = dock.groups.filter((g) => g.panels.length > 0).length;
    dock.fractions = dock.groups.map((g) => (g.panels.length > 0 ? 1 / remaining : 0));
  } else {
    const dock: Dock = { id: newId("d"), side: target.side, size: DEFAULT_SIZE[target.side], groups: [{ id: newId("g"), panels: [panel], active: panel }], fractions: [1] };
    if (target.placement === "outer") next.docks.unshift(dock);
    else next.docks.push(dock);
  }

  const result = normalize(next);
  return shape(result) === shape(layout) ? layout : result;
}

/** Make `panel` the visible tab of its group. */
export function activatePanel(layout: Layout, panel: PanelId): Layout {
  const from = locate(layout, panel);
  if (!from || from.group.active === panel) return layout;
  const next = structuredClone(layout);
  locate(next, panel)!.group.active = panel;
  return next;
}

/** Set a dock's thickness (clamped later to fit, by `computeRects`). */
export function resizeDock(layout: Layout, dockId: string, size: number): Layout {
  return { ...layout, docks: layout.docks.map((d) => (d.id === dockId ? { ...d, size: Math.max(MIN_DOCK, Math.round(size)) } : d)) };
}

/**
 * Move the boundary between groups `index` and `index + 1` of a dock by `delta` (a share of the
 * dock's length), keeping both groups at least `MIN_FRACTION`.
 */
export function resizeSplit(layout: Layout, dockId: string, index: number, delta: number): Layout {
  return {
    ...layout,
    docks: layout.docks.map((d) => {
      if (d.id !== dockId || index < 0 || index >= d.groups.length - 1) return d;
      const f = [...d.fractions];
      const pair = f[index] + f[index + 1];
      const a = Math.max(MIN_FRACTION, Math.min(pair - MIN_FRACTION, f[index] + delta));
      f[index] = a;
      f[index + 1] = pair - a;
      return { ...d, fractions: f };
    }),
  };
}

/**
 * Accept a saved layout only if it's well formed and holds each panel at most once; otherwise
 * null (the caller falls back to the default). Guards against stale or hand-edited storage.
 * Panels missing from it (e.g. added to the editor after the layout was saved) are added as tabs
 * to the group holding the Inspector (the Code panel: the Assets panel, where there's width), or
 * the first group, so the user's arrangement survives.
 */
export function parseLayout(value: unknown): Layout | null {
  try {
    const l = value as Layout;
    if (!l || l.version !== 1 || !Array.isArray(l.docks)) return null;
    const seen: PanelId[] = [];
    for (const d of l.docks) {
      if (!["left", "right", "bottom"].includes(d.side) || typeof d.size !== "number" || !Array.isArray(d.groups) || !Array.isArray(d.fractions)) return null;
      if (d.groups.length !== d.fractions.length || d.groups.length === 0) return null;
      for (const g of d.groups) {
        if (typeof g.id !== "string" || !Array.isArray(g.panels) || g.panels.length === 0) return null;
        for (const p of g.panels) if (!PANELS.includes(p) || seen.includes(p)) return null;
        seen.push(...g.panels);
      }
    }
    const result = normalize(structuredClone(l));
    const missing = PANELS.filter((p) => !seen.includes(p));
    if (missing.length) {
      if (result.docks.length === 0) return null;
      const groups = result.docks.flatMap((d) => d.groups);
      const holding = (p: PanelId) => groups.find((g) => g.panels.includes(p));
      for (const p of missing) (((p === "code" && holding("assets")) || holding("inspector")) ?? groups[0]).panels.push(p);
    }
    return result;
  } catch {
    return null;
  }
}

// --- geometry -----------------------------------------------------------------------------------

export interface GroupRect {
  group: TabGroup;
  rect: Rect;
  header: Rect;
}

export interface DockRect {
  dock: Dock;
  rect: Rect;
  groups: GroupRect[];
  /** The dock's resize handle, on its edge facing the viewport. */
  handle: Rect;
  /** Handles between consecutive groups (index i sits between group i and i + 1). */
  splits: Rect[];
}

export interface Geometry {
  bounds: Rect;
  docks: DockRect[];
  center: Rect;
}

const HANDLE = 6;

/**
 * Lay the docks out in `bounds`, outermost first. Dock sizes are clamped so the viewport keeps
 * at least `MIN_CENTER` (the stored size is kept; only the drawn size shrinks).
 */
export function computeGeometry(layout: Layout, bounds: Rect): Geometry {
  let free: Rect = { ...bounds };
  const docks: DockRect[] = [];
  for (const dock of layout.docks) {
    const horizontal = dock.side === "bottom";
    const room = horizontal ? free.h - MIN_CENTER.h : free.w - MIN_CENTER.w;
    const size = Math.max(0, Math.min(dock.size, room));
    let rect: Rect;
    let handle: Rect;
    if (dock.side === "left") {
      rect = { x: free.x, y: free.y, w: size, h: free.h };
      handle = { x: rect.x + size - HANDLE / 2, y: rect.y, w: HANDLE, h: rect.h };
      free = { x: free.x + size, y: free.y, w: free.w - size, h: free.h };
    } else if (dock.side === "right") {
      rect = { x: free.x + free.w - size, y: free.y, w: size, h: free.h };
      handle = { x: rect.x - HANDLE / 2, y: rect.y, w: HANDLE, h: rect.h };
      free = { x: free.x, y: free.y, w: free.w - size, h: free.h };
    } else {
      rect = { x: free.x, y: free.y + free.h - size, w: free.w, h: size };
      handle = { x: rect.x, y: rect.y - HANDLE / 2, w: rect.w, h: HANDLE };
      free = { x: free.x, y: free.y, w: free.w, h: free.h - size };
    }
    const groups: GroupRect[] = [];
    const splits: Rect[] = [];
    let offset = 0;
    dock.groups.forEach((group, i) => {
      const share = dock.fractions[i];
      const g: Rect = horizontal
        ? { x: rect.x + offset * rect.w, y: rect.y, w: share * rect.w, h: rect.h }
        : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: share * rect.h };
      groups.push({ group, rect: g, header: { x: g.x, y: g.y, w: g.w, h: Math.min(HEADER_HEIGHT, g.h) } });
      offset += share;
      if (i < dock.groups.length - 1) {
        splits.push(horizontal ? { x: g.x + g.w - HANDLE / 2, y: g.y, w: HANDLE, h: g.h } : { x: g.x, y: g.y + g.h - HANDLE / 2, w: g.w, h: HANDLE });
      }
    });
    docks.push({ dock, rect, groups, handle, splits });
  }
  return { bounds, docks, center: free };
}

const inside = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

export interface DropHit {
  target: DropTarget;
  /** Where the panel would appear: the area to highlight while dragging. */
  preview: Rect;
}

/**
 * The drop target under a pointer while dragging `panel`, or null for an invalid spot (the
 * viewport's middle, the top edge, outside the layout). In order of priority: another group's
 * header (join as a tab), the layout's outer edge (new outermost dock, full height or width),
 * the viewport's edge (new innermost dock), inside a dock (split it evenly at that position).
 */
export function hitTest(layout: Layout, geo: Geometry, panel: PanelId, x: number, y: number): DropHit | null {
  const b = geo.bounds;
  if (!inside(b, x, y)) return null;

  for (const d of geo.docks) {
    for (const g of d.groups) {
      if (inside(g.header, x, y)) {
        if (g.group.panels.length === 1 && g.group.panels[0] === panel) return null; // onto itself
        return { target: { kind: "tab", group: g.group.id }, preview: g.rect };
      }
    }
  }

  const band = (side: Side, outer: boolean): DropHit => {
    const area = outer ? b : geo.center;
    const size = Math.min(DEFAULT_SIZE[side], side === "bottom" ? area.h / 2 : area.w / 2);
    const preview: Rect =
      side === "left" ? { x: area.x, y: area.y, w: size, h: area.h }
      : side === "right" ? { x: area.x + area.w - size, y: area.y, w: size, h: area.h }
      : { x: area.x, y: area.y + area.h - size, w: area.w, h: size };
    return { target: { kind: "edge", side, placement: outer ? "outer" : "inner" }, preview };
  };
  if (x < b.x + EDGE_BAND) return band("left", true);
  if (x >= b.x + b.w - EDGE_BAND) return band("right", true);
  if (y >= b.y + b.h - EDGE_BAND) return band("bottom", true);

  const c = geo.center;
  if (inside(c, x, y)) {
    if (x < c.x + EDGE_BAND) return band("left", false);
    if (x >= c.x + c.w - EDGE_BAND) return band("right", false);
    if (y >= c.y + c.h - EDGE_BAND) return band("bottom", false);
    return null; // the middle of the viewport
  }

  for (const d of geo.docks) {
    if (!inside(d.rect, x, y)) continue;
    const horizontal = d.dock.side === "bottom";
    const along = horizontal ? (x - d.rect.x) / d.rect.w : (y - d.rect.y) / d.rect.h;
    // Insert before the group under the pointer if in its first half, else after it.
    let index = d.groups.length;
    let acc = 0;
    for (let i = 0; i < d.groups.length; i++) {
      const f = d.dock.fractions[i];
      if (along < acc + f / 2) { index = i; break; }
      if (along < acc + f) { index = i + 1; break; }
      acc += f;
    }
    // Moving within its own group/dock to where it already is: no change.
    const target: DropTarget = { kind: "split", dock: d.dock.id, index };
    if (movePanel(layout, panel, target) === layout) return null;
    // If the panel's own group (holding only it) is in this dock, it vacates its slot.
    const own = d.groups.findIndex((g) => g.group.panels.length === 1 && g.group.panels[0] === panel);
    const slots = d.groups.length + 1 - (own >= 0 ? 1 : 0);
    const slot = Math.min(own >= 0 && own < index ? index - 1 : index, slots - 1);
    const preview: Rect = horizontal
      ? { x: d.rect.x + (slot * d.rect.w) / slots, y: d.rect.y, w: d.rect.w / slots, h: d.rect.h }
      : { x: d.rect.x, y: d.rect.y + (slot * d.rect.h) / slots, w: d.rect.w, h: d.rect.h / slots };
    return { target, preview };
  }
  return null;
}
