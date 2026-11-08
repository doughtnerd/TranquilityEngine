import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  HEADER_HEIGHT,
  panelTitle,
  activatePanel,
  canCollapse,
  computeGeometry,
  fitTabs,
  hitTest,
  movePanel,
  resizeDock,
  resizeSplit,
  toggleDock,
  type DockRect,
  type DropHit,
  type PanelId,
  type Rect,
  type Side,
} from "./model";
import { layout } from "./store";

/** Pointer travel (CSS px) before pressing a panel header becomes a drag. */
const DRAG_THRESHOLD = 5;
/** Pointer travel on a dock's border before it resizes, so a double-click never nudges it. */
const RESIZE_THRESHOLD = 3;

/** Size of the layout area, measured from the DOM. */
const size = signal({ w: 0, h: 0 });

/** The panel being dragged and where it would land; null when not dragging. */
const drag = signal<{ panel: PanelId; x: number; y: number; hit: DropHit | null } | null>(null);

/** The open "» N" menu's strip, so opening one closes any other; null when none is open. */
const openMenu = signal<object | null>(null);

/**
 * A header's height at the current UI scale (the CSS draws `.dock-header` at 28px × `--ui-scale`,
 * at least 24px), so collapsed strips and drop targets match what's drawn.
 */
function headerHeight(): number {
  const scale = typeof document === "undefined" ? 1 : parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1;
  return Math.max(24, Math.round(HEADER_HEIGHT * scale));
}

const box = (r: Rect): Record<string, string> => ({ left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });

type Root = { current: HTMLDivElement | null };

/**
 * Dockable, resizable editor panels, the scene view among them (see `model.ts` for the rules).
 * Drag a panel by its header (title or tab) to move it: the highlighted area shows where it will
 * go, and dropping on an invalid spot (or pressing Escape) leaves everything as it was. Drag the
 * handles between panels to resize; double-click a dock's border (or use the chevron in its
 * header) to collapse it to its edge. Tabs that don't fit a header go behind a "» N" button. (The
 * Scene panel keeps the engine's canvas alive across moves: see ScenePanel.tsx.)
 */
export function DockLayout(props: { panels: Record<PanelId, () => ComponentChildren> }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current!;
    const observer = new ResizeObserver(() => (size.value = { w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    size.value = { w: el.clientWidth, h: el.clientHeight };
    return () => observer.disconnect();
  }, []);

  const current = layout.value;
  const geo = computeGeometry(current, { x: 0, y: 0, ...size.value }, headerHeight());
  const dragging = drag.value;
  return (
    <div ref={root} class={`dock-layout${dragging ? (dragging.hit ? " dragging" : " dragging invalid") : ""}`}>
      {geo.docks.map((d) => (
        <DockView key={d.dock.id} dock={d} root={root} panels={props.panels} />
      ))}
      {dragging?.hit && <div class="drop-preview" style={box(dragging.hit.preview)} />}
      {dragging && (
        <div class="drag-ghost" style={{ left: `${dragging.x + 12}px`, top: `${dragging.y + 12}px` }}>
          {panelTitle(dragging.panel)}
        </div>
      )}
    </div>
  );
}

/** The arrow on a dock's collapse button: towards its edge to collapse, away from it to expand. */
const CHEVRON: Record<Side, [collapse: string, expand: string]> = { bottom: ["▾", "▴"], left: ["◂", "▸"], right: ["▸", "◂"] };

/** A dock's name for labels: its first group's visible panel ("Assets dock"). */
const dockName = (d: DockRect) => `${panelTitle(d.dock.groups[0].active)} dock`;

function CollapseButton(props: { dock: DockRect }) {
  const { dock } = props;
  const collapsed = dock.collapsed;
  const label = `${collapsed ? "Expand" : "Collapse"} ${dockName(dock)}`;
  return (
    <button
      class="dock-collapse"
      aria-expanded={!collapsed}
      aria-label={label}
      title={`${label} (or double-click its border)`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => (layout.value = toggleDock(layout.value, dock.dock.id))}
    >
      {CHEVRON[dock.dock.side][collapsed ? 1 : 0]}
    </button>
  );
}

function DockView(props: { dock: DockRect; root: Root; panels: Record<PanelId, () => ComponentChildren> }) {
  const { dock, root, panels } = props;
  const side = dock.dock.side;
  const collapsible = canCollapse(layout.value, dock.dock.id);
  // The chevron sits once per dock: at the top of a side dock, at the right end of a bottom dock.
  const chevronGroup = side === "bottom" ? dock.groups.length - 1 : 0;
  const handle = dock.handle && (
    <ResizeHandle
      rect={dock.handle}
      axis={side === "bottom" ? "y" : "x"}
      label={`Resize ${side} panels`}
      grip
      onDoubleClick={() => (layout.value = toggleDock(layout.value, dock.dock.id))}
      onDrag={(start, delta) => {
        const sign = side === "left" ? 1 : -1;
        const from = start.docks.find((d) => d.id === dock.dock.id);
        const base = from?.collapsed ? headerHeight() : (from?.size ?? dock.dock.size);
        layout.value = resizeDock(start, dock.dock.id, base + sign * delta);
      }}
    />
  );

  if (dock.collapsed) {
    // One strip for the whole dock: its tabs along it (vertical titles at the sides), and the expand chevron.
    const tabs = dock.dock.groups.flatMap((g) => g.panels);
    const active = dock.dock.groups[0].active;
    const selected = dock.dock.groups.map((g) => g.active); // each group's showing panel
    return (
      <>
        <div class={`dock-strip side-${side}`} style={box(dock.rect)}>
          {side !== "bottom" && <CollapseButton dock={dock} />}
          <TabStrip panels={tabs} active={active} selected={selected} vertical={side !== "bottom"} root={root} collapsedStrip />
          {side === "bottom" && <CollapseButton dock={dock} />}
        </div>
        {handle}
      </>
    );
  }

  return (
    <>
      {dock.groups.map((g, i) => (
        <div key={g.group.id} class={`dock-group side-${side}`} style={box(g.rect)}>
          <div class="dock-header">
            <TabStrip panels={g.group.panels} active={g.group.active} vertical={false} root={root} />
            {collapsible && i === chevronGroup && <CollapseButton dock={dock} />}
          </div>
          <section class={`panel ${g.group.active}`}>
            <div class="panel-body">{panels[g.group.active]()}</div>
          </section>
        </div>
      ))}
      {handle}
      {dock.splits.map((r, i) => (
        <ResizeHandle
          key={i}
          rect={r}
          axis={side === "bottom" ? "x" : "y"}
          label="Resize panels"
          onDrag={(start, delta) => {
            const length = side === "bottom" ? dock.rect.w : dock.rect.h;
            layout.value = resizeSplit(start, dock.dock.id, i, length > 0 ? delta / length : 0);
          }}
        />
      ))}
    </>
  );
}

/**
 * A header's tabs. Their natural sizes are measured from a hidden copy; `fitTabs` decides which
 * show (shrunk very slightly at most) and which go behind the "» N" button, the active one always
 * showing. In a collapsed side strip the tabs run vertically.
 */
function TabStrip(props: { panels: PanelId[]; active: PanelId; selected?: readonly PanelId[]; vertical: boolean; root: Root; collapsedStrip?: boolean }) {
  const { panels, active, vertical, root } = props;
  const selected = props.selected ?? [active];
  const self = useRef({}).current;
  const moreButton = useRef<HTMLButtonElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<number[]>([]);
  const [moreSize, setMoreSize] = useState(0);
  const [available, setAvailable] = useState(0);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  // Only one strip's menu is open at a time: opening another closes this one.
  const menu = openMenu.value === self ? menuAt : null;
  const setMenu = (at: { x: number; y: number } | null) => {
    setMenuAt(at);
    openMenu.value = at ? self : openMenu.peek() === self ? null : openMenu.peek();
  };
  useEffect(() => () => void (openMenu.peek() === self && (openMenu.value = null)), []);
  const key = panels.join("|");

  useLayoutEffect(() => {
    const read = () => {
      const m = measure.current, a = area.current;
      if (!m || !a) return;
      // The last child is a sample "» N" button: the room the real one takes at this UI scale.
      const lengths = [...m.children].map((c) => (vertical ? (c as HTMLElement).offsetHeight : (c as HTMLElement).offsetWidth));
      setMoreSize(lengths.pop() ?? 0);
      setSizes(lengths);
      setAvailable(vertical ? a.clientHeight : a.clientWidth);
    };
    read();
    const observer = new ResizeObserver(read);
    if (area.current) observer.observe(area.current);
    if (measure.current) observer.observe(measure.current); // fonts and UI scale change natural sizes
    return () => observer.disconnect();
  }, [key, vertical]);

  const solo = panels.length === 1 && !props.collapsedStrip;
  const activeIndex = Math.max(0, panels.indexOf(active));
  const measured = sizes.length === panels.length && available > 0;
  const fit = measured && !solo ? fitTabs(sizes, available, activeIndex, undefined, moreSize || undefined) : { visible: panels.map((_, i) => i), hidden: [] as number[], scale: 1 };
  const hidden = fit.hidden.map((i) => panels[i]);

  return (
    <div ref={area} class={`dock-tabs${vertical ? " vertical" : ""}`} role="tablist" aria-orientation={vertical ? "vertical" : "horizontal"}>
      {fit.visible.map((i) => {
        const p = panels[i];
        const length = measured && fit.scale < 1 ? `${Math.floor(sizes[i] * fit.scale)}px` : undefined;
        return (
          <div
            key={p}
            role="tab"
            aria-selected={selected.includes(p)}
            class={`dock-tab${selected.includes(p) ? " active" : ""}${solo ? " solo" : ""}`}
            style={length ? (vertical ? { height: length } : { width: length }) : undefined}
            title={`${panelTitle(p)}: drag to move`}
            onPointerDown={(e) => startDrag(e, p, root)}
          >
            <span class="dock-tab-label">{panelTitle(p)}</span>
          </div>
        );
      })}
      {hidden.length > 0 && (
        <button
          ref={moreButton}
          class="dock-more"
          aria-label="More tabs"
          aria-haspopup="menu"
          aria-expanded={!!menu}
          title={hidden.map((p) => panelTitle(p)).join(", ")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setMenu(menu ? null : { x: vertical ? r.right + 2 : r.right, y: vertical ? r.top : r.bottom + 2 });
          }}
        >
          » {hidden.length}
        </button>
      )}
      {menu && hidden.length > 0 && <OverflowMenu panels={hidden} at={menu} vertical={vertical} root={root} button={moreButton} onClose={() => setMenu(null)} />}
      <div ref={measure} class={`dock-tabs-measure${vertical ? " vertical" : ""}`} aria-hidden="true">
        {panels.map((p) => (
          <div key={p} class="dock-tab-measure">
            <span class="dock-tab-label">{panelTitle(p)}</span>
          </div>
        ))}
        <span class="dock-more">» 9</span>
      </div>
    </div>
  );
}

/**
 * The tabs behind a header's "» N" button. Picking one shows it (it swaps into the header, since
 * the active tab always shows); dragging one moves its panel, as dragging a tab does.
 */
function OverflowMenu(props: { panels: PanelId[]; at: { x: number; y: number }; vertical: boolean; root: Root; button: { current: HTMLButtonElement | null }; onClose: () => void }) {
  const { panels, at, root, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    // Measured, then placed to stay on screen: right-aligned under a header's button, beside a strip's.
    const el = ref.current!;
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = props.vertical ? at.x : at.x - w;
    setPos({ left: Math.max(4, Math.min(left, window.innerWidth - w - 4)), top: Math.max(4, Math.min(at.y, window.innerHeight - h - 4)) });
  }, [at.x, at.y]);
  useEffect(() => {
    // Outside the menu closes it; its own "» N" button toggles it itself.
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && !props.button.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
    };
  }, []);
  return (
    <div ref={ref} class="context-menu dock-more-menu" role="menu" aria-label="Hidden tabs" style={pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { left: "-9999px", top: "0px" }}>
      {panels.map((p) => (
        <button key={p} role="menuitem" title={`Show ${panelTitle(p)} (drag to move it)`} onPointerDown={(e) => startDrag(e, p, root, onClose)}>
          {panelTitle(p)}
        </button>
      ))}
    </div>
  );
}

/**
 * A thin drag handle. `onDrag` gets the layout from when the drag began and the pointer's travel.
 * A dock's own border shows a grip mark in its middle and toggles the dock on double-click.
 */
function ResizeHandle(props: { rect: Rect; axis: "x" | "y"; label: string; grip?: boolean; onDrag: (start: typeof layout.value, delta: number) => void; onDoubleClick?: () => void }) {
  const { rect, axis, label, onDrag, onDoubleClick } = props;
  return (
    <div
      class={`resize-handle axis-${axis}`}
      style={box(rect)}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={label}
      title={onDoubleClick ? "Drag to resize; double-click to collapse or expand" : undefined}
      onDblClick={onDoubleClick}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget as HTMLElement;
        el.setPointerCapture(e.pointerId);
        const start = layout.value;
        const origin = axis === "x" ? e.clientX : e.clientY;
        let moving = false;
        const move = (m: PointerEvent) => {
          const delta = (axis === "x" ? m.clientX : m.clientY) - origin;
          if (!moving && Math.abs(delta) < RESIZE_THRESHOLD) return;
          moving = true;
          onDrag(start, delta);
        };
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
      }}
    >
      {props.grip && <span class="resize-grip" aria-hidden="true" />}
    </div>
  );
}

/**
 * Press on a header tab (or an overflow menu item): a click shows that tab, expanding its dock if
 * it's collapsed; moving past the threshold starts dragging the panel. While dragging, the drop
 * target under the pointer is previewed; releasing applies it (or nothing, over an invalid spot);
 * Escape cancels. `done` runs when the press ends either way.
 */
function startDrag(e: PointerEvent, panel: PanelId, root: Root, done?: () => void): void {
  if (e.button !== 0 || !root.current) return;
  e.preventDefault();
  const startX = e.clientX, startY = e.clientY;
  let active = false;

  const local = (m: PointerEvent) => {
    const r = root.current!.getBoundingClientRect();
    return { x: m.clientX - r.left, y: m.clientY - r.top };
  };
  const track = (m: PointerEvent) => {
    if (!active && Math.hypot(m.clientX - startX, m.clientY - startY) < DRAG_THRESHOLD) return;
    active = true;
    const { x, y } = local(m);
    const geo = computeGeometry(layout.value, { x: 0, y: 0, ...size.value }, headerHeight());
    drag.value = { panel, x, y, hit: hitTest(layout.value, geo, panel, x, y) };
  };
  const finish = (apply: boolean) => {
    window.removeEventListener("pointermove", track);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
    const hit = drag.value?.hit;
    drag.value = null;
    if (!active) layout.value = activatePanel(layout.value, panel); // a click: show this tab
    else if (apply && hit) layout.value = movePanel(layout.value, panel, hit.target);
    done?.();
  };
  const up = (m: PointerEvent) => {
    if (active) track(m);
    finish(true);
  };
  const cancel = () => finish(false);
  const key = (k: KeyboardEvent) => {
    if (k.key !== "Escape" || !active) return;
    k.preventDefault();
    k.stopPropagation();
    finish(false);
  };
  window.addEventListener("pointermove", track);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
}
