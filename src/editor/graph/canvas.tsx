// The canvas pieces both graph editors share (ADR 0046, 0060): the pan and zoom pane, box
// selection, pointer drags, the sticky note, the minimap and the node search popup. Class names
// (`sg-*`) are the Shader Graph's; the styles are in graph.css.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { NO_DRAG, NO_PAN, NO_WHEEL, createPane, toGraph, type CanvasNode, type Pane, type Point, type View } from "./xyflow";

/** A CSS length (Preact 11 doesn't add `px` to numbers). */
export const px = (n: number) => `${n}px`;

/** Whether an event came from a form control, which keeps its own keys and drags. */
export const isFieldTarget = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input, select, textarea, button");

// --- pan and zoom ------------------------------------------------------------------------------------

/** Each graph's view (pan and zoom) this session, so switching tabs keeps it. */
const views = new Map<string, View>();

export interface GraphCanvasOptions {
  /** Which view to keep (an asset path): the same key gets its pan and zoom back. */
  viewKey: string;
  /** The nodes now, for framing; read when `frameAll` runs. */
  nodes: readonly CanvasNode[];
  /** A right-click on the pane, with its position in the pane's CSS pixels. */
  onContextMenu(e: MouseEvent, at: Point): void;
}

/**
 * The pan and zoom pane: attach `pane` to the element that holds the viewport, draw the viewport
 * with `view`, and read the latest view without re-rendering through `viewRef`.
 */
export function useGraphCanvas(o: GraphCanvasOptions) {
  const [view, setViewState] = useState<View>(() => views.get(o.viewKey) ?? { x: 80, y: 80, zoom: 1 });
  const [paneSize, setPaneSize] = useState({ w: 600, h: 400 });
  const pane = useRef<HTMLDivElement>(null);
  const paneApi = useRef<Pane | null>(null);
  const viewRef = useRef(view);
  /** The last pointer position over the canvas (CSS pixels in the pane), where pastes land. */
  const pointer = useRef<Point | null>(null);
  const latest = useRef(o);
  latest.current = o;

  const setView = (v: View) => {
    views.set(o.viewKey, v);
    viewRef.current = v;
    setViewState(v);
  };

  const frameAll = (nodes: readonly CanvasNode[] = latest.current.nodes) => {
    const el = pane.current;
    if (!el || nodes.length === 0) return;
    const x0 = Math.min(...nodes.map((n) => n.x)), y0 = Math.min(...nodes.map((n) => n.y));
    const x1 = Math.max(...nodes.map((n) => n.x + n.width)), y1 = Math.max(...nodes.map((n) => n.y + n.height));
    const w = el.clientWidth, h = el.clientHeight;
    const zoom = Math.min(1, (w - 80) / Math.max(1, x1 - x0), (h - 80) / Math.max(1, y1 - y0));
    const v = { zoom: Math.max(0.2, zoom), x: 0, y: 0 };
    v.x = w / 2 - ((x0 + x1) / 2) * v.zoom;
    v.y = h / 2 - ((y0 + y1) / 2) * v.zoom;
    paneApi.current?.setView(v);
    setView(v);
  };

  useLayoutEffect(() => {
    const el = pane.current!;
    paneApi.current = createPane(el, {
      view: viewRef.current,
      onView: setView,
      onContextMenu: (e) => {
        const r = el.getBoundingClientRect();
        latest.current.onContextMenu(e, { x: e.clientX - r.left, y: e.clientY - r.top });
      },
    });
    if (!views.has(o.viewKey)) frameAll();
    const resize = new ResizeObserver(() => setPaneSize({ w: el.clientWidth, h: el.clientHeight }));
    resize.observe(el);
    return () => {
      resize.disconnect();
      paneApi.current?.destroy();
    };
  }, []);

  return {
    pane,
    paneApi,
    view,
    viewRef,
    paneSize,
    pointer,
    setView,
    frameAll,
    panBy: (dx: number, dy: number) => paneApi.current?.panBy(dx, dy) ?? Promise.resolve(false),
    /** The middle of the pane, in its CSS pixels. */
    paneCenter: (): Point => ({ x: (pane.current?.clientWidth ?? 400) / 2, y: (pane.current?.clientHeight ?? 300) / 2 }),
    /** Track the pointer over the pane (pass to its `onPointerMove`). */
    onPointerMove: (e: PointerEvent) => {
      const r = pane.current!.getBoundingClientRect();
      pointer.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    },
  };
}

// --- selection and drags -----------------------------------------------------------------------------

export interface BoxSelectOptions {
  pane: HTMLElement;
  view(): View;
  nodes(): readonly CanvasNode[];
  /** The selection before the drag: kept when the drag is additive (Shift, Ctrl or Cmd). */
  selection: ReadonlySet<string>;
  onSelection(ids: Set<string>): void;
  /** The rectangle being dragged in pane pixels, or null when it ends. */
  onBox(box: { a: Point; b: Point } | null): void;
}

/** Start dragging a selection rectangle from a pointer-down on the empty pane. */
export function startBoxSelect(e: PointerEvent, o: BoxSelectOptions): void {
  const rect = o.pane.getBoundingClientRect();
  const a = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  const base = additive ? new Set(o.selection) : new Set<string>();
  if (!additive) o.onSelection(base);
  const el = o.pane;
  el.setPointerCapture(e.pointerId);
  const move = (m: PointerEvent) => {
    const b = { x: m.clientX - rect.left, y: m.clientY - rect.top };
    o.onBox({ a, b });
    const g0 = toGraph({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, o.view());
    const g1 = toGraph({ x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) }, o.view());
    const next = new Set(base);
    for (const n of o.nodes()) if (n.x < g1.x && n.x + n.width > g0.x && n.y < g1.y && n.y + n.height > g0.y) next.add(n.id);
    o.onSelection(next);
  };
  const up = () => {
    o.onBox(null);
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
}

/** The selection rectangle, in pane pixels. */
export function SelectionBox(props: { box: { a: Point; b: Point } }) {
  const { a, b } = props.box;
  return <div class="sg-box" style={{ left: px(Math.min(a.x, b.x)), top: px(Math.min(a.y, b.y)), width: px(Math.abs(b.x - a.x)), height: px(Math.abs(b.y - a.y)) }} />;
}

/**
 * Drag something by an element that took the pointer-down (a group title, a note bar): reports
 * the offset in graph units (screen pixels over the zoom) as it moves and where it ended.
 */
export function startPointerDrag(e: PointerEvent, o: { zoom(): number; onMove(dx: number, dy: number): void; onEnd(dx: number, dy: number): void }): void {
  e.stopPropagation();
  const start = { x: e.clientX, y: e.clientY };
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);
  let last = { dx: 0, dy: 0 };
  const move = (m: PointerEvent) => {
    const z = o.zoom();
    last = { dx: (m.clientX - start.x) / z, dy: (m.clientY - start.y) / z };
    o.onMove(last.dx, last.dy);
  };
  const up = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", up);
    o.onEnd(last.dx, last.dy);
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", up);
}

// --- notes and the minimap ---------------------------------------------------------------------------

/** A sticky note's data: where it is, how big, what it says. */
export interface NoteData {
  position: [number, number];
  size: [number, number];
  text: string;
}

/** A sticky note: drag its top bar, resize from the corner, type in it. */
export function NoteView(props: { note: NoteData; zoom: number; readOnly: boolean; onChange(patch: Partial<NoteData>): void; onRemove(): void }) {
  const { note } = props;
  const [live, setLive] = useState<{ position: [number, number]; size: [number, number] } | null>(null);
  const pos = live?.position ?? note.position, size = live?.size ?? note.size;
  const drag = (e: PointerEvent, resize: boolean) => {
    if (e.button !== 0 || props.readOnly || isFieldTarget(e.target)) return;
    const at = (dx: number, dy: number): { position: [number, number]; size: [number, number] } =>
      resize ? { position: note.position, size: [note.size[0] + dx, note.size[1] + dy] } : { position: [note.position[0] + dx, note.position[1] + dy], size: note.size };
    startPointerDrag(e, {
      zoom: () => props.zoom,
      onMove: (dx, dy) => setLive(at(dx, dy)),
      onEnd: (dx, dy) => {
        setLive(null);
        props.onChange(at(dx, dy));
      },
    });
  };
  return (
    <div class={`sg-note ${NO_PAN}`} style={{ left: px(pos[0]), top: px(pos[1]), width: px(size[0]), height: px(size[1]) }} aria-label="Sticky note">
      <div class="sg-note-head" onPointerDown={(e) => drag(e, false)}>
        <button aria-label="Remove note" title="Remove the note" disabled={props.readOnly} onClick={props.onRemove}>
          ✕
        </button>
      </div>
      <textarea class={`${NO_DRAG} ${NO_WHEEL}`} aria-label="Note text" disabled={props.readOnly} value={note.text} placeholder="Note" onChange={(e) => props.onChange({ text: (e.currentTarget as HTMLTextAreaElement).value })} />
      <div class="sg-note-resize" onPointerDown={(e) => drag(e, true)} />
    </div>
  );
}

const MINIMAP = { w: 180, h: 120 };

/** Every node and the visible area, small: drag to pan, wheel to zoom (xyflow's minimap). */
export function Minimap(props: { nodes: readonly Pick<CanvasNode, "id" | "x" | "y" | "width" | "height" | "selected">[]; view: View; size: { w: number; h: number }; pane: { current: Pane | null } }) {
  const { nodes, view, size } = props;
  const svg = useRef<SVGSVGElement>(null);
  const scale = useRef(1);
  const v0 = toGraph({ x: 0, y: 0 }, view), v1 = toGraph({ x: size.w, y: size.h }, view);
  const xs = [v0.x, v1.x, ...nodes.flatMap((n) => [n.x, n.x + n.width])], ys = [v0.y, v1.y, ...nodes.flatMap((n) => [n.y, n.y + n.height])];
  const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
  scale.current = Math.max((x1 - x0) / MINIMAP.w, (y1 - y0) / MINIMAP.h, 0.01);
  const s = scale.current;
  const ox = (MINIMAP.w - (x1 - x0) / s) / 2, oy = (MINIMAP.h - (y1 - y0) / s) / 2;
  const mx = (x: number) => ox + (x - x0) / s, my = (y: number) => oy + (y - y0) / s;
  useEffect(() => props.pane.current?.attachMinimap(svg.current!, () => scale.current), [props.pane.current]);
  return (
    <svg ref={svg} class={`sg-minimap ${NO_PAN} ${NO_WHEEL}`} width={MINIMAP.w} height={MINIMAP.h} aria-label="Minimap">
      {nodes.map((n) => (
        <rect key={n.id} class={n.selected ? "selected" : ""} x={mx(n.x)} y={my(n.y)} width={n.width / s} height={n.height / s} rx={2} />
      ))}
      <rect class="sg-minimap-view" x={mx(v0.x)} y={my(v0.y)} width={(v1.x - v0.x) / s} height={(v1.y - v0.y) / s} />
    </svg>
  );
}

// --- node search -------------------------------------------------------------------------------------

/** One entry of the node search; callers extend it with what they need on a pick. */
export interface SearchItem {
  key: string;
  label: string;
  /** Entries are grouped by category, in the order given. */
  category: string;
  /** The text the query matches against (case doesn't matter): label, category, synonyms… */
  keywords: string;
}

/** The search popup: a query box over the items (already limited to those that fit), arrow keys and Enter to pick. */
export function NodeSearchPopup<T extends SearchItem>(props: {
  items: readonly T[];
  at: Point;
  onPick(item: T): void;
  onClose(): void;
  /** The dialog's aria-label, default "Add node". */
  title?: string;
  /** The query box's placeholder and aria-label, default "Search nodes". */
  placeholder?: string;
  /** Shown when nothing matches, default "No nodes match". */
  none?: string;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const lowered = useMemo(() => props.items.map((i) => i.keywords.toLowerCase()), [props.items]);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = props.items.filter((_, n) => words.every((w) => lowered[n].includes(w)));
  const pick = (i: T | undefined) => i && props.onPick(i);
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") setActive((a) => Math.min(shown.length - 1, a + 1));
    else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
    else if (e.key === "Enter") pick(shown[active]);
    else if (e.key === "Escape") props.onClose();
    else return;
    e.preventDefault();
  };
  const placeholder = props.placeholder ?? "Search nodes";
  let lastCategory = "";
  return (
    <div class={`sg-search ${NO_PAN} ${NO_WHEEL}`} style={{ left: px(props.at.x), top: px(props.at.y) }} role="dialog" aria-label={props.title ?? "Add node"} onPointerDown={(e) => e.stopPropagation()}>
      <input ref={input} type="search" placeholder={placeholder} aria-label={placeholder} value={query} onInput={(e) => (setQuery((e.currentTarget as HTMLInputElement).value), setActive(0))} onKeyDown={onKey} />
      <ul role="listbox">
        {shown.map((item, i) => {
          const head = item.category !== lastCategory;
          lastCategory = item.category;
          return (
            <>
              {head && <li class="sg-search-cat" role="presentation">{item.category}</li>}
              <li key={item.key} role="option" aria-selected={i === active} class={i === active ? "active" : ""} onMouseEnter={() => setActive(i)} onClick={() => pick(item)}>
                {item.label}
              </li>
            </>
          );
        })}
        {shown.length === 0 && <li class="sg-search-none">{props.none ?? "No nodes match"}</li>}
      </ul>
    </div>
  );
}
