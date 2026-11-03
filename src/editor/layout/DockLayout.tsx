import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import {
  PANEL_TITLES,
  activatePanel,
  computeGeometry,
  hitTest,
  movePanel,
  resizeDock,
  resizeSplit,
  type DockRect,
  type DropHit,
  type PanelId,
  type Rect,
} from "./model";
import { layout } from "./store";

/** Pointer travel (CSS px) before pressing a panel header becomes a drag. */
const DRAG_THRESHOLD = 5;

/** Size of the layout area, measured from the DOM. */
const size = signal({ w: 0, h: 0 });

/** The panel being dragged and where it would land; null when not dragging. */
const drag = signal<{ panel: PanelId; x: number; y: number; hit: DropHit | null } | null>(null);

const box = (r: Rect): Record<string, string> => ({ left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });

/**
 * Dockable, resizable editor panels, the scene view among them (see `model.ts` for the rules).
 * Drag a panel by its header (title or tab) to move it: the highlighted area shows where it will
 * go, and dropping on an invalid spot (or pressing Escape) leaves everything as it was. Drag the
 * handles between panels to resize. (The Scene panel keeps the engine's canvas alive across moves:
 * see ScenePanel.tsx.)
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
  const geo = computeGeometry(current, { x: 0, y: 0, ...size.value });
  const dragging = drag.value;
  return (
    <div ref={root} class={`dock-layout${dragging ? (dragging.hit ? " dragging" : " dragging invalid") : ""}`}>
      {geo.docks.map((d) => (
        <DockView key={d.dock.id} dock={d} root={root} panels={props.panels} />
      ))}
      {dragging?.hit && <div class="drop-preview" style={box(dragging.hit.preview)} />}
      {dragging && (
        <div class="drag-ghost" style={{ left: `${dragging.x + 12}px`, top: `${dragging.y + 12}px` }}>
          {PANEL_TITLES[dragging.panel]}
        </div>
      )}
    </div>
  );
}

function DockView(props: { dock: DockRect; root: { current: HTMLDivElement | null }; panels: Record<PanelId, () => ComponentChildren> }) {
  const { dock, root, panels } = props;
  const side = dock.dock.side;
  return (
    <>
      {dock.groups.map((g) => (
        <div key={g.group.id} class={`dock-group side-${side}`} style={box(g.rect)}>
          <div class="dock-header" role="tablist">
            {g.group.panels.map((p) => (
              <div
                key={p}
                role="tab"
                aria-selected={p === g.group.active}
                class={`dock-tab${p === g.group.active ? " active" : ""}${g.group.panels.length === 1 ? " solo" : ""}`}
                title={`${PANEL_TITLES[p]}: drag to move`}
                onPointerDown={(e) => startDrag(e, p, root)}
              >
                {PANEL_TITLES[p]}
              </div>
            ))}
          </div>
          <section class={`panel ${g.group.active}`}>
            <div class="panel-body">{panels[g.group.active]()}</div>
          </section>
        </div>
      ))}
      {dock.handle && <ResizeHandle
        rect={dock.handle}
        axis={side === "bottom" ? "y" : "x"}
        label={`Resize ${side} panels`}
        onDrag={(start, delta) => {
          const sign = side === "left" ? 1 : -1;
          layout.value = resizeDock(start, dock.dock.id, dock.dock.size + sign * delta);
        }}
      />}
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

/** A thin drag handle. `onDrag` gets the layout from when the drag began and the pointer's travel. */
function ResizeHandle(props: { rect: Rect; axis: "x" | "y"; label: string; onDrag: (start: typeof layout.value, delta: number) => void }) {
  const { rect, axis, label, onDrag } = props;
  return (
    <div
      class={`resize-handle axis-${axis}`}
      style={box(rect)}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={label}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget as HTMLElement;
        el.setPointerCapture(e.pointerId);
        const start = layout.value;
        const origin = axis === "x" ? e.clientX : e.clientY;
        const move = (m: PointerEvent) => onDrag(start, (axis === "x" ? m.clientX : m.clientY) - origin);
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
      }}
    />
  );
}

/**
 * Press on a header tab: a click shows that tab; moving past the threshold starts dragging the
 * panel. While dragging, the drop target under the pointer is previewed; releasing applies it
 * (or nothing, over an invalid spot); Escape cancels.
 */
function startDrag(e: PointerEvent, panel: PanelId, root: { current: HTMLDivElement | null }): void {
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
    const geo = computeGeometry(layout.value, { x: 0, y: 0, ...size.value });
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
