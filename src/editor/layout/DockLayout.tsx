import { signal, type Signal } from "@preact/signals";
import { createContext, type ComponentChildren } from "preact";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  HEADER_HEIGHT,
  activatePanel,
  addPanel,
  closePanel,
  instanceTitle,
  typeOf,
  MAIN_WINDOW,
  windowView,
  fromWindowView,
  movePanelToWindow,
  windowOf,
  type Layout,
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
  type TabSpan,
} from "./model";
import { canClosePanel, canDetach, panelTitle } from "./catalog";
import { foldCandidate, foldView, unfoldEdit } from "./narrowFold";
import { DockHostContext, type DockHost } from "./dockHost";
import { editorDockHost } from "./editorDockHost";
import { PanelHeader } from "./PanelHeader";
import { PanelInstanceContext, type PanelInstance } from "../ui/panel/Panel";
import { usePopover } from "../ui/popover";
import { startPointerDrag } from "../pointerDrag";

/** Pointer travel on a dock's border before it resizes, so a double-click never nudges it. */
const RESIZE_THRESHOLD = 3;

/**
 * One window's dock layout (ADR 0174): the main window's, or a detached window's. It reads and writes
 * the shared layout through `get` and `set` (a detached window's view of it, `windowView`), and keeps
 * its own measured size and drag.
 */
export interface DockScope {
  /** Whose layout it is: the editor's, or an Audio Studio screen's (ADR 0341). */
  readonly host: DockHost;
  /** `MAIN_WINDOW`, or the detached window's id. */
  readonly windowId: string;
  /** This window's view of the layout (its docks as `docks`). Reads the signal, so callers re-render. */
  get(): Layout;
  /** Replace this window's view of the layout. */
  set(next: Layout): void;
  /** Size of the layout area, measured from the DOM. */
  readonly size: Signal<{ w: number; h: number }>;
  /** The panel being dragged and where it would land; null when not dragging. */
  readonly drag: Signal<{ panel: PanelId; x: number; y: number; hit: DropHit | null } | null>;
}

/** The scope for `windowId`'s dock layout in `host`'s layout. */
function dockScope(host: DockHost, windowId: string): DockScope {
  const layout = host.store.layout;
  const size = signal({ w: 0, h: 0 });
  const below = windowId === MAIN_WINDOW ? host.foldBelow : undefined;
  if (below === undefined) {
    return {
      host,
      windowId,
      get: () => (windowId === MAIN_WINDOW ? layout.value : (windowView(layout.value, windowId) ?? { ...layout.value, docks: [], windows: [] })),
      set: (next) => (layout.value = fromWindowView(next, windowId, layout.peek())),
      size,
      drag: signal(null),
    };
  }
  // ADR 0361: the main window folds its left dock on a narrow screen. `opened` holds the folded dock the user opened
  // while narrow; it's forgotten once the layout is wide again.
  const opened = signal<string | null>(null);
  return {
    host,
    windowId,
    get: () => {
      const stored = layout.value;
      const candidate = foldCandidate(stored, size.value.w, below);
      if (candidate === null) {
        if (opened.peek() !== null && size.value.w >= below) queueMicrotask(() => (opened.value = null));
        return stored;
      }
      return opened.value === candidate ? stored : foldView(stored, candidate);
    },
    set: (next) => {
      const candidate = foldCandidate(layout.peek(), size.peek().w, below);
      const r = unfoldEdit(next, candidate);
      if (r.open !== undefined) opened.value = r.open ? candidate : null;
      layout.value = r.layout;
    },
    size,
    drag: signal(null),
  };
}

/** Each host's main-window scope, made once. */
const mainScopes = new WeakMap<DockHost, DockScope>();
function mainScope(host: DockHost): DockScope {
  let scope = mainScopes.get(host);
  if (!scope) mainScopes.set(host, (scope = dockScope(host, MAIN_WINDOW)));
  return scope;
}

const ScopeContext = createContext<DockScope | null>(null);
const useScope = () => useContext(ScopeContext)!;

/** The open "» N" menu's strip, so opening one closes any other; null when none is open. */
const openMenu = signal<object | null>(null);

/** The open header menu (right-click on a tab or a header): the dock layout, where, which group, and the tab under the pointer. */
const headerMenu = signal<{ scope: DockScope; x: number; y: number; group: string; panel?: PanelId } | null>(null);

/** The scope's whole layout (every window's) and its catalog. */
const fullLayout = (scope: DockScope) => scope.host.store.layout.value;
const catalogOf = (scope: DockScope) => scope.host.store.catalog();
/** A panel instance's title in the scope's layout. */
const titleOf = (scope: DockScope, id: PanelId) => instanceTitle(fullLayout(scope), id, catalogOf(scope));

/**
 * A header's height at the current UI scale (the CSS draws `.dock-header` at 28px × `--ui-scale`,
 * at least 24px), so collapsed strips and drop targets match what's drawn.
 */
function headerHeight(doc: Document | undefined = typeof document === "undefined" ? undefined : document): number {
  const scale = !doc ? 1 : parseFloat(getComputedStyle(doc.documentElement).getPropertyValue("--ui-scale")) || 1;
  return Math.max(24, Math.round(HEADER_HEIGHT * scale));
}

const box = (r: Rect): Record<string, string> => ({ left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });

type Root = { current: HTMLDivElement | null };

/**
 * Dockable, resizable editor panels, the scene view among them (see `model.ts` for the rules).
 * Drag a panel by its header (title or tab) to move it: the highlighted area shows where it will
 * go, and dropping on an invalid spot (or pressing Escape) leaves everything as it was. Over a
 * header, a mark between the tabs shows where it goes in the tab order; dropping on its own
 * group's header reorders the tabs (ADR 0381). Drag the
 * handles between panels to resize; double-click a dock's border (or use the chevron in its
 * header) to collapse it to its edge. Tabs that don't fit a header go behind a "» N" button. (The
 * Scene panel keeps the engine's canvas alive across moves: see ScenePanel.tsx.)
 */
export function DockLayout(props: { view: (type: PanelId) => ComponentChildren; windowId?: string; host?: DockHost }) {
  const root = useRef<HTMLDivElement>(null);
  const windowId = props.windowId ?? MAIN_WINDOW;
  const fromContext = useContext(DockHostContext);
  const host = props.host ?? fromContext ?? editorDockHost;
  const scope = useMemo(() => (windowId === MAIN_WINDOW ? mainScope(host) : dockScope(host, windowId)), [windowId, host]);
  const { size, drag } = scope;
  useEffect(() => {
    const el = root.current!;
    // The element's own window's ResizeObserver: a detached window's content is in another document (ADR 0174).
    const RO = (el.ownerDocument.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null)?.ResizeObserver ?? ResizeObserver;
    const observer = new RO(() => (size.value = { w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    size.value = { w: el.clientWidth, h: el.clientHeight };
    return () => observer.disconnect();
  }, [scope]);

  const current = scope.get();
  const geo = computeGeometry(current, { x: 0, y: 0, ...size.value }, headerHeight(root.current?.ownerDocument));
  const dragging = drag.value;
  return (
    <ScopeContext.Provider value={scope}>
      <div ref={root} class={`dock-layout${dragging ? (dragging.hit ? " dragging" : " dragging invalid") : ""}`}>
        {geo.docks.map((d) => (
          <DockView key={d.dock.id} dock={d} root={root} view={props.view} />
        ))}
        {dragging?.hit?.preview && <div class="drop-preview" style={box(dragging.hit.preview)} />}
        {dragging?.hit?.insert && <div class="tab-insert-mark" style={box(dragging.hit.insert)} />}
        {dragging && (
          <div class="drag-ghost" style={{ left: `${dragging.x + 12}px`, top: `${dragging.y + 12}px` }}>
            {titleOf(scope, dragging.panel)}
          </div>
        )}
        {headerMenu.value?.scope === scope && <HeaderMenu />}
      </div>
    </ScopeContext.Provider>
  );
}

/** The arrow on a dock's collapse button: towards its edge to collapse, away from it to expand. */
const CHEVRON: Record<Side, [collapse: string, expand: string]> = { bottom: ["▾", "▴"], left: ["◂", "▸"], right: ["▸", "◂"] };

/** A dock's name for labels: its first group's visible panel ("Assets dock"). */
const dockName = (scope: DockScope, d: DockRect) => `${titleOf(scope, d.dock.groups[0].active)} dock`;

function CollapseButton(props: { dock: DockRect }) {
  const { dock } = props;
  const scope = useScope();
  const collapsed = dock.collapsed;
  const label = `${collapsed ? "Expand" : "Collapse"} ${dockName(scope, dock)}`;
  return (
    <button
      class="dock-collapse"
      aria-expanded={!collapsed}
      aria-label={label}
      title={`${label} (or double-click its border)`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => scope.set(toggleDock(scope.get(), dock.dock.id))}
    >
      {CHEVRON[dock.dock.side][collapsed ? 1 : 0]}
    </button>
  );
}

function DockView(props: { dock: DockRect; root: Root; view: (type: PanelId) => ComponentChildren }) {
  const { dock, root, view } = props;
  const scope = useScope();
  const side = dock.dock.side;
  const collapsible = canCollapse(scope.get(), dock.dock.id);
  // The chevron sits once per dock: at the top of a side dock, at the right end of a bottom dock.
  const chevronGroup = side === "bottom" ? dock.groups.length - 1 : 0;
  const handle = dock.handle && (
    <ResizeHandle
      rect={dock.handle}
      axis={side === "bottom" ? "y" : "x"}
      label={`Resize ${side} panels`}
      grip
      onDoubleClick={() => scope.set(toggleDock(scope.get(), dock.dock.id))}
      onDrag={(start, delta) => {
        const sign = side === "left" ? 1 : -1;
        const from = start.docks.find((d) => d.id === dock.dock.id);
        const base = from?.collapsed ? headerHeight(root.current?.ownerDocument) : (from?.size ?? dock.dock.size);
        scope.set(resizeDock(start, dock.dock.id, base + sign * delta));
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
          <TabStrip panels={tabs} active={active} selected={selected} vertical={side !== "bottom"} root={root} group={dock.dock.groups[0].id} collapsedStrip />
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
          <div class="dock-header" data-dock-group={g.group.id} onContextMenu={(e) => openHeaderMenu(scope, e, g.group.id)}>
            <TabStrip panels={g.group.panels} active={g.group.active} vertical={false} root={root} group={g.group.id} />
            {collapsible && i === chevronGroup && <CollapseButton dock={dock} />}
          </div>
          <PanelInstanceContext.Provider key={g.group.active} value={instanceOf(scope, g.group.active)}>{view(typeOf(fullLayout(scope), g.group.active))}</PanelInstanceContext.Provider>

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
            scope.set(resizeSplit(start, dock.dock.id, i, length > 0 ? delta / length : 0));
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
function TabStrip(props: { panels: PanelId[]; active: PanelId; selected?: readonly PanelId[]; vertical: boolean; root: Root; group: string; collapsedStrip?: boolean }) {
  const { panels, active, vertical, root } = props;
  const scope = useScope();
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
  const title = (p: PanelId) => titleOf(scope, p);
  const key = `${panels.map(title).join("|")}|${!!props.collapsedStrip}`;

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
  // No × in a collapsed strip (ADR 0174): the panel isn't showing there.
  const closable = (p: PanelId) => !props.collapsedStrip && canClosePanel(catalogOf(scope), typeOf(fullLayout(scope), p));
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
          <PanelHeader
            key={p}
            id={p}
            title={title(p)}
            selected={selected.includes(p)}
            solo={solo}
            closable={closable(p)}
            style={length ? (vertical ? { height: length } : { width: length }) : undefined}
            onPress={(e) => startDrag(scope, e, p, root)}
            onClose={() => scope.set(closePanel(scope.get(), p, catalogOf(scope)))}
            onMenu={(e) => openHeaderMenu(scope, e, props.group, p)}
          />
        );
      })}
      {hidden.length > 0 && (
        <button
          ref={moreButton}
          class="dock-more"
          aria-label="More tabs"
          aria-haspopup="menu"
          aria-expanded={!!menu}
          title={hidden.map(title).join(", ")}
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
          <div key={p} class={`dock-tab-measure${closable(p) ? " closable" : ""}`}>
            <span class="dock-tab-label">{title(p)}</span>
            {closable(p) && <span class="dock-tab-close">×</span>}
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
  const scope = useScope();
  const ref = useRef<HTMLDivElement>(null);
  // Measured and kept on screen in its own window: right-aligned under a header's button, beside a
  // strip's. Its own "» N" button toggles it itself.
  usePopover(ref, true, { anchor: at, align: props.vertical ? "start" : "end", inside: [props.button], onDismiss: onClose });
  return (
    <div ref={ref} class="context-menu dock-more-menu" role="menu" aria-label="Hidden tabs">
      {panels.map((p) => (
        <button key={p} role="menuitem" title={`Show ${titleOf(scope, p)} (drag to move it)`} onPointerDown={(e) => startDrag(scope, e, p, root, onClose)}>
          {titleOf(scope, p)}
        </button>
      ))}
    </div>
  );
}

/**
 * A thin drag handle. `onDrag` gets the layout from when the drag began and the pointer's travel.
 * A dock's own border shows a grip mark in its middle and toggles the dock on double-click.
 */
function ResizeHandle(props: { rect: Rect; axis: "x" | "y"; label: string; grip?: boolean; onDrag: (start: Layout, delta: number) => void; onDoubleClick?: () => void }) {
  const { rect, axis, label, onDrag, onDoubleClick } = props;
  const scope = useScope();
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
        const start = scope.get();
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
 * it's collapsed; moving past the drag threshold (`pointerDrag.ts`) starts dragging the panel. While dragging, the drop
 * target under the pointer is previewed (with an insertion mark over a header's tabs, ADR 0381);
 * releasing applies it (or nothing, over an invalid spot); Escape cancels. `done` runs when the press ends either way.
 */
function startDrag(scope: DockScope, e: PointerEvent, panel: PanelId, root: Root, done?: () => void): void {
  if (e.button !== 0 || !root.current) return;
  const { size, drag } = scope;
  e.preventDefault();
  let tabs: Record<string, TabSpan[]> = {};

  const local = (m: PointerEvent) => {
    const r = root.current!.getBoundingClientRect();
    return { x: m.clientX - r.left, y: m.clientY - r.top };
  };
  startPointerDrag(e, {
    begin: () => {
      tabs = drawnTabs(root.current!); // the tabs don't move while dragging
    },
    move: (m) => {
      const { x, y } = local(m);
      const view = scope.get();
      const geo = computeGeometry(view, { x: 0, y: 0, ...size.value }, headerHeight(root.current!.ownerDocument));
      drag.value = { panel, x, y, hit: hitTest(view, geo, panel, x, y, tabs) };
    },
    end: (how) => {
      const hit = drag.value?.hit;
      drag.value = null;
      if (how === "click") scope.set(activatePanel(scope.get(), panel, catalogOf(scope))); // show this tab
      else if (how === "drop" && hit) scope.set(movePanel(scope.get(), panel, hit.target));
      done?.();
    },
  });
}

/**
 * Each expanded group's tabs as drawn in `root` (layout coordinates), by group id, for placing a drop among them
 * (ADR 0381). A group drawn as its title stretches its one tab across the header; its span ends after the title and its ×.
 */
function drawnTabs(root: HTMLElement): Record<string, TabSpan[]> {
  const origin = root.getBoundingClientRect().left;
  const out: Record<string, TabSpan[]> = {};
  for (const header of root.querySelectorAll<HTMLElement>(".dock-header[data-dock-group]")) {
    out[header.dataset.dockGroup!] = [...header.querySelectorAll<HTMLElement>(".dock-tabs > .dock-tab[data-panel-instance]")].map((tab) => {
      const r = tab.getBoundingClientRect();
      let end = r.right;
      if (tab.classList.contains("solo") && tab.lastElementChild) {
        const pad = parseFloat((tab.ownerDocument.defaultView ?? window).getComputedStyle(tab).paddingLeft) || 0;
        end = Math.min(r.right, tab.lastElementChild.getBoundingClientRect().right + pad);
      }
      return { panel: tab.dataset.panelInstance!, start: r.left - origin, end: end - origin };
    });
  }
  return out;
}

/** The `PanelInstance` a group's showing panel is drawn as. */
function instanceOf(scope: DockScope, id: PanelId): PanelInstance {
  return { id, type: typeOf(fullLayout(scope), id), title: titleOf(scope, id), close: () => scope.set(closePanel(scope.get(), id, catalogOf(scope))) };
}

function openHeaderMenu(scope: DockScope, e: MouseEvent, group: string, panel?: PanelId): void {
  e.preventDefault();
  headerMenu.value = { scope, x: e.clientX, y: e.clientY, group, panel };
}

/**
 * Right-click on a tab or a group's header (ADR 0174): Add Panel… (into this group; or, for a host without an Add
 * Panel dialog, "Add <panel>" for each panel type not open), Close, then what the host offers: Detach and Move to
 * (detached windows) and Reset layout (ADR 0341).
 */
function HeaderMenu() {
  const m = headerMenu.value!;
  const scope = useScope();
  const { host } = scope;
  const ref = useRef<HTMLDivElement>(null);
  const close = () => (headerMenu.value = null);
  usePopover(ref, true, { anchor: m, onDismiss: close });
  // The tab under the pointer, else the group's showing one.
  const view = scope.get();
  const group = view.docks.flatMap((d) => d.groups).find((g) => g.id === m.group);
  const target = m.panel ?? group?.active;
  const catalog = catalogOf(scope);
  const title = (id: PanelId) => titleOf(scope, id);
  const closable = target !== undefined && canClosePanel(catalog, typeOf(view, target));
  // Detach and Move to (ADR 0174): a panel that can't be detached (the Scene view) stays in the main window.
  const full = fullLayout(scope);
  const windows = host.windows;
  const detachable = windows !== undefined && target !== undefined && canDetach(catalog, typeOf(full, target));
  const here = target !== undefined ? (windowOf(full, target)?.id ?? MAIN_WINDOW) : MAIN_WINDOW;
  const destinations = detachable ? [...(here !== MAIN_WINDOW ? [{ id: MAIN_WINDOW, title: "Main Window" }] : []), ...(full.windows ?? []).filter((w) => w.id !== here).map((w) => ({ id: w.id, title: windows.title(full, w).replace(/ · Myco Engine$/, "") }))] : [];
  // Without an Add Panel dialog: the panel types not open now, each added to this group.
  const open = new Set(Object.values(full.instances).map((i) => i.type));
  const addable = host.requestAddPanel ? [] : [...catalog.keys()].filter((type) => !open.has(type));
  return (
    <div ref={ref} class="context-menu dock-header-menu" role="menu" aria-label="Panel menu">
      {host.requestAddPanel ? (
        <button
          role="menuitem"
          title="Choose panels to add to this group"
          onClick={() => {
            close();
            host.requestAddPanel!(m.group, scope.windowId === MAIN_WINDOW ? undefined : scope.windowId);
          }}
        >
          Add Panel…
        </button>
      ) : (
        addable.map((type) => (
          <button
            key={type}
            role="menuitem"
            title={`Add ${panelTitle(catalog, type)} to this group`}
            onClick={() => {
              close();
              scope.set(addPanel(scope.get(), type, catalog, m.group).layout);
            }}
          >
            Add {panelTitle(catalog, type)}
          </button>
        ))
      )}
      <button
        role="menuitem"
        disabled={!closable}
        title={closable || target === undefined ? undefined : `${title(target)} can't be closed`}
        onClick={() => {
          close();
          if (target !== undefined) scope.set(closePanel(scope.get(), target, catalog));
        }}
      >
        {target !== undefined ? `Close ${title(target)}` : "Close"}
      </button>
      {windows && (
        <>
          <div class="context-sep" role="separator" />
          <button
            role="menuitem"
            disabled={!detachable}
            title={detachable ? "Open this panel in a window of its own" : target !== undefined ? `${title(target)} stays in the main window` : undefined}
            onClick={() => {
              close();
              if (target !== undefined) windows.detach(target, ref.current?.ownerDocument.defaultView ?? undefined);
            }}
          >
            Detach
          </button>
          {destinations.map((d) => (
            <button
              key={d.id}
              role="menuitem"
              title={`Move this panel to ${d.id === MAIN_WINDOW ? "the main window" : `the window with ${d.title}`}`}
              onClick={() => {
                close();
                const store = host.store.layout;
                if (target !== undefined) store.value = movePanelToWindow(store.peek(), target, d.id, catalog);
              }}
            >
              Move to {d.id === MAIN_WINDOW ? "Main Window" : d.title}
            </button>
          ))}
        </>
      )}
      {host.reset && (
        <>
          <div class="context-sep" role="separator" />
          <button
            role="menuitem"
            title="Put every panel back where it starts"
            onClick={() => {
              close();
              host.reset!();
            }}
          >
            Reset layout
          </button>
        </>
      )}
    </div>
  );
}
