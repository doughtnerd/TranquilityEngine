// Editor panel layout (docking). Pure data and geometry, no DOM, so the rules are unit-tested.
//
// Every panel, the scene view included, lives in a dock. Docks are listed outermost first: each
// claims a strip on one side (left, right or bottom) of whatever space the docks outside it left,
// so an outer dock spans the full height (left/right) or width (bottom) of that space. The
// innermost dock fills whatever is left (its side only sets how it splits). A dock holds one or
// more tab groups split evenly along it (stacked in side docks, side by side in bottom docks); a
// group shows one panel at a time, with tabs when it has more than one.
//
// A dock other than the filling one can be collapsed to its edge: it keeps its size (to come back
// to) but draws as a strip one header thick, its tabs along it. Tabs that don't fit a header go
// behind an overflow button (`fitTabs`).

import { panels as panelRegistry } from "../sdk/contributions";

export type BuiltinPanelId = "scene" | "hierarchy" | "inspector" | "assets" | "history" | "code" | "worlds" | "network" | "project" | "shadergraph" | "particlegraph" | "tilepalette";
/** A built-in panel's id, or the id of a panel a plugin registered (ADR 0133). */
export type PanelId = BuiltinPanelId | (string & {});
export type Side = "left" | "right" | "bottom";

/** The built-in panels (registered ones: `allPanels()`). */
export const PANELS: readonly BuiltinPanelId[] = ["scene", "hierarchy", "inspector", "assets", "history", "code", "worlds", "network", "project", "shadergraph", "particlegraph", "tilepalette"];
export const PANEL_TITLES: Record<BuiltinPanelId, string> = { scene: "Scene", hierarchy: "Hierarchy", inspector: "Inspector", assets: "Assets", history: "History", code: "Code", worlds: "Worlds", network: "Network", project: "Project", shadergraph: "Shader Graph", particlegraph: "Particle Graph", tilepalette: "Tile Palette" };

/** Every panel: the built-in ones, then those plugins registered. Reads the registry's version, so a component calling it re-renders on changes. */
export function allPanels(): PanelId[] {
  void panelRegistry.version.value;
  return [...PANELS, ...panelRegistry.list().map((p) => p.id).filter((id) => !(PANELS as readonly string[]).includes(id))];
}

/** True for a built-in or currently registered panel. */
export function isKnownPanel(id: PanelId): boolean {
  void panelRegistry.version.value;
  return (PANELS as readonly string[]).includes(id) || panelRegistry.get(id) !== undefined;
}

/** A panel's title (the id itself if it's unknown). */
export function panelTitle(id: PanelId): string {
  void panelRegistry.version.value;
  return (PANEL_TITLES as Record<string, string>)[id] ?? panelRegistry.get(id)?.title ?? id;
}

/** The panel whose group `id` joins when first shown, if it names one. */
export function panelBeside(id: PanelId): PanelId | undefined {
  void panelRegistry.version.value;
  return (BESIDE as Record<string, PanelId | undefined>)[id] ?? panelRegistry.get(id)?.beside;
}

/** True for a panel kept out of the default layout (built-in or registered with `onDemand`). */
export function isOnDemand(id: PanelId): boolean {
  void panelRegistry.version.value;
  return (ON_DEMAND_PANELS as readonly string[]).includes(id) || !!panelRegistry.get(id)?.onDemand;
}

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
  /** Collapsed to a strip at its edge (`size` is kept for when it expands). Never set on the filling dock. */
  collapsed?: boolean;
}

export interface Layout {
  version: 1;
  /** Outermost first. The last fills the space the others leave (its `size` is unused). */
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
/** Distance from the layout's outer edge, or the filling dock's edge, that targets a new dock. */
export const EDGE_BAND = 28;
export const DEFAULT_SIZE: Record<Side, number> = { left: 240, right: 300, bottom: 190 };
export const MIN_DOCK = 120;
/** The smallest the filling (innermost) dock gets: other docks shrink to leave it this much. */
export const MIN_FILL = { w: 200, h: 140 };
/** Smallest share of a dock a group can be resized to. */
export const MIN_FRACTION = 0.1;

let nextId = 1;
const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}-${nextId++}`;

/**
 * Panels left out of the default layout and opened on demand (the Window menu, or an action such as
 * double-clicking a sky asset), so the editor starts without them; once opened they stay in the
 * layout like any other. Saved layouts without them don't get them added back.
 */
export const ON_DEMAND_PANELS: readonly BuiltinPanelId[] = [];

/** Where a panel missing from a layout goes: beside its usual neighbour, else with the Inspector, else the first group. */
const BESIDE: Partial<Record<BuiltinPanelId, BuiltinPanelId>> = { code: "assets", worlds: "history", network: "worlds", project: "worlds", shadergraph: "scene", particlegraph: "shadergraph", tilepalette: "assets" };
function groupFor(layout: Layout, panel: PanelId): TabGroup {
  const groups = layout.docks.flatMap((d) => d.groups);
  const holding = (p: PanelId) => groups.find((g) => g.panels.includes(p));
  const near = panelBeside(panel);
  return ((near && (holding(near) ?? (near === "particlegraph" ? holding("scene") : undefined))) || holding("inspector")) ?? groups[0]!;
}

export function defaultLayout(): Layout {
  return {
    version: 1,
    docks: [
      { id: "bottom", side: "bottom", size: DEFAULT_SIZE.bottom, groups: [{ id: "assets", panels: ["assets", "code", "tilepalette"], active: "assets" }], fractions: [1] },
      { id: "left", side: "left", size: DEFAULT_SIZE.left, groups: [{ id: "hierarchy", panels: ["hierarchy"], active: "hierarchy" }], fractions: [1] },
      { id: "right", side: "right", size: DEFAULT_SIZE.right, groups: [{ id: "inspector", panels: ["inspector", "history", "worlds", "network", "project"], active: "inspector" }], fractions: [1] },
      // Innermost: fills the middle.
      { id: "main", side: "left", size: 0, groups: [{ id: "scene", panels: ["scene", "shadergraph", "particlegraph"], active: "scene" }], fractions: [1] },
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
  // The filling dock (whichever is last now) has no edge to collapse to.
  const last = docks.at(-1);
  if (last?.collapsed) docks[docks.length - 1] = withoutCollapsed(last);
  return { version: 1, docks };
}

function withoutCollapsed(d: Dock): Dock {
  const { collapsed: _collapsed, ...rest } = d;
  return rest;
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
    delete dock!.collapsed; // dropped onto a collapsed dock: open it to show the panel
  } else if (target.kind === "split") {
    const dock = next.docks.find((d) => d.id === target.dock);
    if (!dock) return layout;
    delete dock.collapsed;
    const index = Math.max(0, Math.min(target.index, dock.groups.length));
    dock.groups.splice(index, 0, { id: newId("g"), panels: [panel], active: panel });
    // Uniform with the other panels in the zone: every group that will remain gets an equal share.
    const remaining = dock.groups.filter((g) => g.panels.length > 0).length;
    dock.fractions = dock.groups.map((g) => (g.panels.length > 0 ? 1 / remaining : 0));
  } else {
    const dock: Dock = { id: newId("d"), side: target.side, size: DEFAULT_SIZE[target.side], groups: [{ id: newId("g"), panels: [panel], active: panel }], fractions: [1] };
    if (target.placement === "outer") next.docks.unshift(dock);
    else next.docks.splice(Math.max(0, next.docks.length - 1), 0, dock); // just outside the filling dock
  }

  const result = normalize(next);
  return shape(result) === shape(layout) ? layout : result;
}

/** Make `panel` the visible tab of its group, expanding its dock if it's collapsed. */
export function activatePanel(layout: Layout, panel: PanelId): Layout {
  const from = locate(layout, panel);
  if (!from && isOnDemand(panel)) {
    // First asked for: it joins the group its neighbour is in (the Sky panel beside the graph editors).
    const next = structuredClone(layout);
    const group = groupFor(next, panel);
    group.panels.push(panel);
    group.active = panel;
    for (const d of next.docks) if (d.groups.includes(group)) delete d.collapsed;
    return next;
  }
  if (!from || (from.group.active === panel && !from.dock.collapsed)) return layout;
  const next = structuredClone(layout);
  const to = locate(next, panel)!;
  to.group.active = panel;
  delete to.dock.collapsed;
  return next;
}

/** Set a dock's thickness (clamped later to fit, by `computeRects`). Resizing a collapsed dock expands it. */
export function resizeDock(layout: Layout, dockId: string, size: number): Layout {
  return { ...layout, docks: layout.docks.map((d) => (d.id === dockId ? { ...withoutCollapsed(d), size: Math.max(MIN_DOCK, Math.round(size)) } : d)) };
}

/** True if a dock can collapse: any but the filling (innermost) one. */
export function canCollapse(layout: Layout, dockId: string): boolean {
  const index = layout.docks.findIndex((d) => d.id === dockId);
  return index >= 0 && index < layout.docks.length - 1;
}

/** Collapse or expand a dock (the filling dock never collapses). Returns `layout` itself when nothing changes. */
export function setDockCollapsed(layout: Layout, dockId: string, collapsed: boolean): Layout {
  const dock = layout.docks.find((d) => d.id === dockId);
  if (!dock || !!dock.collapsed === collapsed || (collapsed && !canCollapse(layout, dockId))) return layout;
  return { ...layout, docks: layout.docks.map((d) => (d.id === dockId ? (collapsed ? { ...d, collapsed: true } : withoutCollapsed(d)) : d)) };
}

/** Collapse an expanded dock, or expand a collapsed one. */
export function toggleDock(layout: Layout, dockId: string): Layout {
  const dock = layout.docks.find((d) => d.id === dockId);
  return dock ? setDockCollapsed(layout, dockId, !dock.collapsed) : layout;
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
 * to the group holding the Inspector (the Code panel: the Assets panel, where there's width; the
 * Worlds panel: the History panel, beside it by default; the Network panel: the Worlds panel; the
 * Shader Graph panel: the scene view, where there's room), or
 * the first group, so the user's arrangement survives. A missing scene view (layouts from when it
 * was fixed in the middle) gets a new innermost dock, filling the middle again.
 */
export function parseLayout(value: unknown): Layout | null {
  try {
    const l = structuredClone(value) as Layout;
    if (!l || l.version !== 1 || !Array.isArray(l.docks)) return null;
    const seen: PanelId[] = [];
    // Panels neither built in nor registered (a plugin since removed) are dropped, with their emptied groups and docks.
    if (l.docks.every((d) => d && Array.isArray(d.groups) && Array.isArray(d.fractions) && d.groups.length === d.fractions.length)) {
      l.docks = l.docks
        .map((d) => {
          const keep = d.groups.map((g) => (g && Array.isArray(g.panels) ? { ...g, panels: g.panels.filter((p) => isKnownPanel(p)) } : g));
          const idx = keep.map((g, i) => (g && Array.isArray(g.panels) && g.panels.length === 0 ? -1 : i)).filter((i) => i >= 0);
          return { ...d, groups: idx.map((i) => keep[i]!), fractions: idx.map((i) => d.fractions[i]!) };
        })
        .filter((d) => d.groups.length > 0);
    }
    for (const d of l.docks) {
      if (!["left", "right", "bottom"].includes(d.side) || typeof d.size !== "number" || !Array.isArray(d.groups) || !Array.isArray(d.fractions)) return null;
      if (d.groups.length !== d.fractions.length || d.groups.length === 0) return null;
      if (d.collapsed !== undefined && typeof d.collapsed !== "boolean") delete (d as { collapsed?: unknown }).collapsed;
      for (const g of d.groups) {
        if (typeof g.id !== "string" || !Array.isArray(g.panels) || g.panels.length === 0) return null;
        for (const p of g.panels) if (typeof p !== "string" || seen.includes(p)) return null;
        seen.push(...g.panels);
      }
    }
    const result = normalize(structuredClone(l));
    if (!seen.includes("scene")) result.docks.push({ id: newId("d"), side: "left", size: 0, groups: [{ id: newId("g"), panels: ["scene"], active: "scene" }], fractions: [1] });
    const missing = allPanels().filter((p) => !seen.includes(p) && p !== "scene" && !isOnDemand(p));
    for (const p of missing) groupFor(result, p).panels.push(p);
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
  /** Drawn as a strip one header thick (its groups' rects are all header). */
  collapsed: boolean;
  groups: GroupRect[];
  /** The dock's resize handle, on its inner edge; null for the filling dock, which has no size of its own. */
  handle: Rect | null;
  /** Handles between consecutive groups (index i sits between group i and i + 1). */
  splits: Rect[];
}

export interface Geometry {
  bounds: Rect;
  docks: DockRect[];
  /** The filling (innermost) dock's area. */
  fill: Rect;
}

const HANDLE = 6;

/**
 * Lay the docks out in `bounds`, outermost first; the last fills what's left. Other docks' sizes
 * are clamped so it keeps at least `MIN_FILL` (the stored size is kept; only the drawn size
 * shrinks).
 */
export function computeGeometry(layout: Layout, bounds: Rect, headerHeight = HEADER_HEIGHT): Geometry {
  let free: Rect = { ...bounds };
  const docks: DockRect[] = [];
  layout.docks.forEach((dock, index) => {
    const horizontal = dock.side === "bottom";
    const filling = index === layout.docks.length - 1;
    const collapsed = !filling && !!dock.collapsed;
    const room = horizontal ? free.h - MIN_FILL.h : free.w - MIN_FILL.w;
    const size = Math.max(0, Math.min(collapsed ? headerHeight : dock.size, room));
    let rect: Rect;
    let handle: Rect | null;
    if (filling) {
      rect = { ...free };
      handle = null;
    } else if (dock.side === "left") {
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
      groups.push({ group, rect: g, header: collapsed ? { ...g } : { x: g.x, y: g.y, w: g.w, h: Math.min(headerHeight, g.h) } });
      offset += share;
      if (i < dock.groups.length - 1) {
        splits.push(horizontal ? { x: g.x + g.w - HANDLE / 2, y: g.y, w: HANDLE, h: g.h } : { x: g.x, y: g.y + g.h - HANDLE / 2, w: g.w, h: HANDLE });
      }
    });
    docks.push({ dock, rect, collapsed, groups, handle, splits: collapsed ? [] : splits });
  });
  return { bounds, docks, fill: docks.at(-1)?.rect ?? free };
}

const inside = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

export interface DropHit {
  target: DropTarget;
  /** Where the panel would appear: the area to highlight while dragging. */
  preview: Rect;
}

/**
 * The drop target under a pointer while dragging `panel`, or null for an invalid spot (the top
 * edge, outside the layout, where it already is). In order of priority: another group's header
 * (join as a tab), the layout's outer edge (new outermost dock, full height or width), the filling
 * dock's edge (a new dock just outside it), inside a dock (split it evenly at that position).
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
    const area = outer ? b : geo.fill;
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

  const c = geo.fill;
  if (inside(c, x, y)) {
    if (x < c.x + EDGE_BAND) return band("left", false);
    if (x >= c.x + c.w - EDGE_BAND) return band("right", false);
    if (y >= c.y + c.h - EDGE_BAND) return band("bottom", false);
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

// --- tab overflow -------------------------------------------------------------------------------

/** How far tabs may shrink (a share of their natural size) before some go behind the overflow button. */
export const TAB_MIN_SHRINK = 0.88;
/** Room the overflow button ("» N") takes at the end of a header. */
export const OVERFLOW_BUTTON = 40;

export interface TabFit {
  /** Indices of the tabs shown, in their order. */
  visible: number[];
  /** Indices of the tabs behind the overflow button, in their order. */
  hidden: number[];
  /** How much the shown tabs are scaled to fit (1 = natural size, never above 1). */
  scale: number;
}

/**
 * Which tabs fit a header `available` long, given their natural lengths. They shrink at most to
 * `minShrink` of their size; past that, tabs go behind an overflow button (`moreSize` long). The
 * active tab always shows; the others fill the room left in order, so picking a hidden tab swaps it
 * in for the last one shown.
 */
export function fitTabs(sizes: readonly number[], available: number, activeIndex: number, minShrink = TAB_MIN_SHRINK, moreSize = OVERFLOW_BUTTON): TabFit {
  const all = sizes.map((_, i) => i);
  const total = sizes.reduce((s, w) => s + w, 0);
  if (total <= available) return { visible: all, hidden: [], scale: 1 };
  // Never below `minShrink`: a tab with no room at all stays its (slightly shrunk) size and is clipped, rather than vanishing.
  if (sizes.length <= 1 || total * minShrink <= available) return { visible: all, hidden: [], scale: total > 0 ? Math.max(minShrink, available / total) : 1 };
  const room = Math.max(0, available - moreSize);
  const active = activeIndex >= 0 && activeIndex < sizes.length ? activeIndex : 0;
  const chosen = new Set([active]);
  let used = sizes[active];
  for (const i of all) {
    if (i === active) continue;
    if ((used + sizes[i]) * minShrink > room) break;
    chosen.add(i);
    used += sizes[i];
  }
  const visible = all.filter((i) => chosen.has(i));
  return { visible, hidden: all.filter((i) => !chosen.has(i)), scale: used > 0 ? Math.max(minShrink, Math.min(1, room / used)) : 1 };
}
