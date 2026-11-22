// The Scene view (ADR 0333; the prototype's Scene panel, B.4): a top-down plan of the test scene (x across, north up), a
// tool palette, the legend, a zoom bar (− % + Fit, Side view), the elevation strip and the optional side view. A press
// selects and drags (handles of the selected box first, then the path being edited, then points, then the smallest box);
// a placing tool puts its object where you click; wheel and pinch zoom about the pointer, Space-drag, the middle button
// and a drag on empty ground pan. A floating toolbar over the selection plays it solo, mutes it, edits its attenuation,
// renames, deletes and edits its path; a listener's plays all from it or listens there. Rays run from the listener that
// hears the scene to each sound heard in place: solid when clear, dashed when occluded (the player's readout).
import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { ContextMenu, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { HistoryPopover } from "../../../editor/ui/HistoryPopover";
import type { SceneBox, Vec3 } from "../../../engine/audio/spatial/testSceneTypes";
import { dragSlabEdge, heightMarks, heightRange, inRange, inSlab, LISTENER_STEP, moveSlab, relativeHeight, shiftSpan, slabRange, type HeightMark } from "./elevation";
import { boxCorners, boxSpanX, growBox, nearestOnBox, rotateKnob, routeMidpoints, type P2 } from "./geometry";
import { shownInPlan } from "./outline";
import { beginDrag, dragTo, editLabel, hitTest, KNOB_PX, type Drag } from "./pointerModel";
import type { SceneHost } from "./sceneHost";
import { activeListener, allObjects, boxOf, findObject, insertRoutePoint, moveObjectTo, positionOf, removeRoutePoint, renameObject, setBoxHeights, setHeight, type SceneObject } from "./sceneEdits";
import { pickTool, placesByClick, TOOLS, type Tool } from "./tools";
import { LEGEND, raysOf } from "./voicesTable";
import { gridStep, panBy, pinch, toPlan, toScreen, visibleBounds, zoomAt, zoomPercent, ZOOM_STEP, type Px, type Size, type View } from "./viewTransform";

const useSize = (ref: { current: Element | null }, onSize?: (s: Size) => void): Size => {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = (w: number, h: number) => {
      const s = { width: Math.round(w), height: Math.round(h) };
      setSize(s);
      onSize?.(s);
    };
    const r = el.getBoundingClientRect();
    set(r.width, r.height);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const c = entries[0]?.contentRect;
      if (c) set(c.width, c.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return size;
};

const pts = (list: readonly Px[]) => list.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

/** The class an emitter or zone gets from how it is heard. */
function renderClass(host: SceneHost, id: string): string {
  if (host.silenced(id) && host.playing) return " silenced";
  const row = host.voices.find((v) => v.id === id);
  if (!row?.playing || !row.rendered) return "";
  return row.rendered === "hrtf" ? " hrtf" : row.rendered === "panned" ? " panned" : row.rendered === "2d" ? "" : " bed";
}

export interface SceneViewProps {
  readonly host: SceneHost;
}

export function SceneView(props: SceneViewProps) {
  const { host } = props;
  const s = host.scene;
  const listener = activeListener(s);
  const range = heightRange(s);
  const slabNow = slabRange(host.slab, listener.position.y, range);
  return (
    <div class="sp-scene" data-keyscope="spatial-scene" data-asset-document={host.path} tabIndex={-1}>
      <div class="sp-toolbar" role="toolbar" aria-label="Scene">
        <HistoryPopover none="Click into the scene to see its edit history" />
        <ul class="sp-legend" aria-label="Legend">
          {LEGEND.map((l) => (
            <li key={l.id}>
              <span class={`sp-swatch ${l.id}`} aria-hidden="true" />
              {l.label}
            </li>
          ))}
        </ul>
        <span class="sp-toolbar-status">{host.playing ? (host.solo ? `Auditioning ${findObject(s, host.solo)?.obj.name ?? ""} on its own` : `Hearing it from ${listener.name}`) : host.readOnly ? "Read-only" : ""}</span>
      </div>
      <div class="sp-body">
        <Palette host={host} />
        <Viewport host={host} slab={slabNow} />
        <ElevationStrip host={host} range={range} slab={slabNow} />
      </div>
      {host.sideView && <SideView host={host} range={range} slab={slabNow} />}
    </div>
  );
}

function Palette(props: { host: SceneHost }) {
  const { host } = props;
  const pick = (t: Tool) => {
    if (t === "sound2d") return host.place("sound2d", { x: 0, z: 0 }, 0);
    host.setTools(pickTool(host.tools, t));
  };
  return (
    <div class="sp-palette" role="toolbar" aria-orientation="vertical" aria-label="Tools">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          class={`sp-tool${host.tools.tool === t.id ? " on" : ""}`}
          aria-pressed={host.tools.tool === t.id}
          aria-label={t.label}
          title={`${t.label}: ${t.hint}`}
          disabled={host.readOnly && t.id !== "select"}
          onClick={() => pick(t.id)}
        >
          <span aria-hidden="true">{t.glyph}</span>
        </button>
      ))}
    </div>
  );
}

/** One pointer gesture in the viewport. */
type Gesture =
  | { kind: "pan"; last: Px }
  | { kind: "drag"; drag: Drag; moved: boolean; start: Px }
  | { kind: "place"; tool: Exclude<Tool, "select">; start: Px }
  | { kind: "pinch" };

function Viewport(props: { host: SceneHost; slab: [number, number] }) {
  const { host, slab } = props;
  const ref = useRef<HTMLDivElement>(null);
  const size = useSize(ref, host.setSize);
  const gesture = useRef<Gesture | null>(null);
  const touches = useRef(new Map<number, Px>());
  const space = useRef(false);
  const hostRef = useRef(host);
  hostRef.current = host;
  const s = host.scene;
  const v = host.view;
  const S = (p: P2) => toScreen(v, size, p);
  const local = (e: { clientX: number; clientY: number }): Px => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const plan = (px: Px) => toPlan(hostRef.current.view, size, px);
  const visible = (o: SceneObject) => {
    const b = boxOf(o);
    if (b) return inSlab(slab, b.bottom, b.top);
    const p = positionOf(o);
    return p ? inSlab(slab, p.y) : true;
  };

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const h = hostRef.current;
      const r = el.getBoundingClientRect();
      h.setView(zoomAt(h.view, { width: r.width, height: r.height }, { x: e.clientX - r.left, y: e.clientY - r.top }, Math.exp(-e.deltaY * 0.0015)));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === " " && !(e.target instanceof HTMLInputElement)) {
      space.current = true;
      e.preventDefault();
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === " ") space.current = false;
  };

  const onPointerDown = (e: PointerEvent) => {
    const el = ref.current!;
    el.focus({ preventScroll: true });
    const at = local(e);
    if (e.pointerType === "touch") {
      touches.current.set(e.pointerId, at);
      if (touches.current.size === 2) {
        gesture.current = { kind: "pinch" };
        return;
      }
    }
    el.setPointerCapture?.(e.pointerId);
    if (e.button === 1 || space.current) {
      gesture.current = { kind: "pan", last: at };
      return;
    }
    if (e.button !== 0) return;
    const h = hostRef.current;
    if (placesByClick(h.tools.tool) && !h.readOnly) {
      gesture.current = { kind: "place", tool: h.tools.tool as Exclude<Tool, "select">, start: at };
      return;
    }
    const p = plan(at);
    const hit = hitTest(h.scene, p, { mpp: 1 / h.view.ppm, selected: h.selected, pathEdit: h.tools.pathEdit, visible: () => true });
    if (hit.kind === "midpoint") {
      if (!h.readOnly) h.edit("Edit path", (x) => insertRoutePoint(x, hit.id, hit.index));
      return;
    }
    if (hit.kind === "waypoint" && e.shiftKey) {
      if (!h.readOnly) h.edit("Edit path", (x) => removeRoutePoint(x, hit.id, hit.index));
      return;
    }
    if (hit.kind === "none") {
      if (!h.tools.pathEdit) h.select(null);
      gesture.current = { kind: "pan", last: at };
      return;
    }
    const wasSelected = h.selected === hit.id;
    if (hit.kind === "object") h.select(hit.id);
    // Touch: a tap selects; dragging needs the object selected first.
    if (h.readOnly || (e.pointerType === "touch" && hit.kind === "object" && !wasSelected)) return;
    const drag = beginDrag(h.scene, hit, p);
    if (drag) gesture.current = { kind: "drag", drag, moved: false, start: at };
  };

  const onPointerMove = (e: PointerEvent) => {
    const g = gesture.current;
    const at = local(e);
    const h = hostRef.current;
    if (e.pointerType === "touch" && touches.current.has(e.pointerId)) {
      const before = [...touches.current.values()];
      touches.current.set(e.pointerId, at);
      if (g?.kind === "pinch" && before.length === 2) {
        const after = [...touches.current.values()];
        h.setView(pinch(h.view, size, [before[0]!, before[1]!], [after[0]!, after[1]!]));
        return;
      }
    }
    if (!g) return;
    if (g.kind === "pan") {
      h.setView(panBy(h.view, at.x - g.last.x, at.y - g.last.y));
      g.last = at;
    } else if (g.kind === "drag") {
      if (!g.moved && Math.hypot(at.x - g.start.x, at.y - g.start.y) < 3) return;
      g.moved = true;
      const p = plan(at);
      // The label from the scene as drawn; the edit from the document's latest value (a burst's earlier steps included).
      h.edit(dragTo(h.scene, g.drag, p).label, (latest) => dragTo(latest, g.drag, p).result, true);
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    touches.current.delete(e.pointerId);
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const h = hostRef.current;
    if (g.kind === "drag" && g.moved) h.endDrag();
    if (g.kind === "place") {
      const at = local(e);
      if (Math.hypot(at.x - g.start.x, at.y - g.start.y) < 6) h.place(g.tool, plan(at), slab[0]);
    }
  };

  const onDblClick = (e: MouseEvent) => {
    const h = hostRef.current;
    if (h.readOnly) return;
    const hit = hitTest(h.scene, plan(local(e)), { mpp: 1 / h.view.ppm, selected: null, pathEdit: null });
    if (hit.kind === "object") h.setRenaming(hit.id);
  };

  const sel = host.selected ? findObject(s, host.selected) : null;
  return (
    <div
      ref={ref}
      class={`sp-viewport${placesByClick(host.tools.tool) ? " placing" : ""}`}
      tabIndex={0}
      aria-label="Scene plan: drag to move, wheel to zoom"
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDblClick={onDblClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      {size.width > 0 && (
        <svg class="sp-plan" width={size.width} height={size.height} role="img" aria-label={`Plan of the scene, ${allObjects(s).length} objects`}>
          <Grid view={v} size={size} />
          <PlanObjects host={host} S={S} visible={visible} />
          {sel && <Selection host={host} o={sel} S={S} />}
        </svg>
      )}
      {sel && size.width > 0 && <NodeToolbar host={host} o={sel} S={S} size={size} />}
      {host.renaming && size.width > 0 && <RenameField host={host} S={S} />}
      <div class="sp-zoombar" role="toolbar" aria-label="Zoom" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" aria-label="Zoom out" title="Zoom out (−)" onClick={() => host.setView(zoomAt(v, size, { x: size.width / 2, y: size.height / 2 }, 1 / ZOOM_STEP))}>−</button>
        <span class="sp-zoom-readout" aria-live="polite">{zoomPercent(v)}%</span>
        <button type="button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => host.setView(zoomAt(v, size, { x: size.width / 2, y: size.height / 2 }, ZOOM_STEP))}>+</button>
        <button type="button" title="Frame the scene (0)" onClick={host.fit}>Fit</button>
        <button type="button" aria-pressed={host.sideView} class={host.sideView ? "on" : ""} title="Show the scene from the south, looking north" onClick={() => host.setSideView(!host.sideView)}>Side view</button>
      </div>
      {host.tools.pathEdit && (
        <div class="sp-pathbar" role="status" onPointerDown={(e) => e.stopPropagation()}>
          Editing the path: drag waypoints, + adds one, Shift-click removes one.
          <button type="button" class="primary" onClick={() => host.setTools({ ...host.tools, pathEdit: null })}>Done</button>
        </div>
      )}
    </div>
  );
}

function Grid(props: { view: View; size: Size }) {
  const { view, size } = props;
  const step = gridStep(view.ppm);
  const b = visibleBounds(view, size);
  const lines: JSX.Element[] = [];
  const x0 = Math.ceil(b.minX / step) * step, z0 = Math.ceil(b.minZ / step) * step;
  for (let x = x0, i = 0; x <= b.maxX && i < 400; x += step, i++) {
    const sx = toScreen(view, size, { x, z: 0 }).x;
    lines.push(<line key={`x${i}`} class={`sp-grid${Math.abs(x) < 1e-9 ? " axis" : ""}`} x1={sx} y1={0} x2={sx} y2={size.height} />);
  }
  for (let z = z0, i = 0; z <= b.maxZ && i < 400; z += step, i++) {
    const sy = toScreen(view, size, { x: 0, z }).y;
    lines.push(<line key={`z${i}`} class={`sp-grid${Math.abs(z) < 1e-9 ? " axis" : ""}`} x1={0} y1={sy} x2={size.width} y2={sy} />);
  }
  return (
    <g aria-hidden="true">
      {lines}
      <text class="sp-grid-label" x={8} y={size.height - 8}>{`grid ${step} m · N ↑`}</text>
    </g>
  );
}

function PlanObjects(props: { host: SceneHost; S: (p: P2) => Px; visible: (o: SceneObject) => boolean }) {
  const { host, S, visible } = props;
  const s = host.scene;
  const listener = activeListener(s);
  const objects = allObjects(s).filter((o) => shownInPlan(s, o));
  const dim = (o: SceneObject) => (visible(o) ? "" : " dim");
  const hover = (o: SceneObject) => (host.hover === o.obj.id ? " hover" : "");
  const label = (o: SceneObject, at: Px, y?: number) => (
    <text class="sp-label" x={at.x + 9} y={at.y - 7}>
      {o.obj.name}
      {y !== undefined && relativeHeight(y, listener.position.y) ? <tspan class="sp-rel">{` ${relativeHeight(y, listener.position.y)}`}</tspan> : null}
    </text>
  );
  const boxes = objects.filter((o) => boxOf(o));
  // Big boxes first, so a smaller one inside stays on top.
  boxes.sort((a, b) => boxOf(b)!.width * boxOf(b)!.depth - boxOf(a)!.width * boxOf(a)!.depth);
  const rays = raysOf(host.voices);
  return (
    <g>
      {boxes.map((o) => {
        const b = boxOf(o)!;
        const corners = boxCorners(b).map(S);
        const cls = o.kind === "obstacle" ? "sp-obstacle" : o.kind === "reverbZone" ? "sp-reverb" : `sp-azone${renderClass(host, o.obj.id)}`;
        return (
          <g key={o.obj.id} class={`${dim(o)}${hover(o)}`} data-id={o.obj.id}>
            {o.kind === "audioZone" && o.obj.feather > 0 && <polygon class="sp-zone-edge" points={pts(boxCorners(growBox(b, o.obj.feather)).map(S))} />}
            <polygon class={cls} points={pts(corners)} />
            <text class="sp-label box" x={(corners[3]!.x + corners[2]!.x) / 2} y={Math.min(...corners.map((c) => c.y)) + 14} text-anchor="middle">
              {o.obj.name}
              {o.kind === "obstacle" ? ` · ${o.obj.material}` : o.kind === "reverbZone" ? ` · ${o.obj.preset}` : ""}
            </text>
          </g>
        );
      })}
      {objects.filter((o) => o.kind === "emitter" && o.obj.kind === "moving").map((o) => {
        const e = o.obj as Extract<SceneObject, { kind: "emitter" }>["obj"] & { route: Vec3[] };
        return <polyline key={`route-${o.obj.id}`} class={`sp-route${dim(o)}${host.tools.pathEdit === o.obj.id ? " editing" : ""}`} points={pts(e.route.map(S))} />;
      })}
      {rays.map((r) => {
        const o = findObject(s, r.id);
        if (!o || !shownInPlan(s, o)) return null;
        const b = boxOf(o);
        const to = b ? nearestOnBox(b, listener.position) : positionOf(o);
        if (!to) return null;
        const a = S(listener.position), z = S(to);
        return <line key={`ray-${r.id}`} class={`sp-ray${r.occluded ? " occluded" : ""}`} x1={a.x} y1={a.y} x2={z.x} y2={z.y} />;
      })}
      {objects.filter((o) => o.kind === "emitter").map((o) => {
        const p = positionOf(o)!;
        const at = S(p);
        const moving = o.kind === "emitter" && o.obj.kind === "moving";
        return (
          <g key={o.obj.id} class={`sp-emitter${renderClass(host, o.obj.id)}${dim(o)}${hover(o)}${o.obj.locked ? " locked" : ""}`} data-id={o.obj.id}>
            {moving ? <rect x={at.x - 6} y={at.y - 6} width={12} height={12} transform={`rotate(45 ${at.x} ${at.y})`} /> : <circle cx={at.x} cy={at.y} r={6.5} />}
            {label(o, at, p.y)}
          </g>
        );
      })}
      {objects.filter((o) => o.kind === "listener").map((o) => {
        const l = o.obj as typeof listener;
        const at = S(l.position);
        const r = (l.yaw * Math.PI) / 180;
        const tip = { x: at.x + Math.sin(r) * 14, y: at.y - Math.cos(r) * 14 };
        const active = l.id === listener.id;
        return (
          <g key={l.id} class={`sp-listener${active ? " active" : ""}${dim(o)}${hover(o)}${host.playing && active ? " playing" : ""}`} data-id={l.id}>
            {active && <circle class="sp-listener-ring" cx={at.x} cy={at.y} r={12} />}
            <line class="sp-facing" x1={at.x} y1={at.y} x2={tip.x} y2={tip.y} />
            <circle cx={at.x} cy={at.y} r={7} />
            {label(o, at, l.position.y)}
          </g>
        );
      })}
    </g>
  );
}

function Selection(props: { host: SceneHost; o: SceneObject; S: (p: P2) => Px }) {
  const { host, o, S } = props;
  const b = boxOf(o);
  const out: JSX.Element[] = [];
  if (b) {
    const c = boxCorners(b).map(S);
    out.push(<polygon key="outline" class="sp-sel" points={pts(c)} />);
    if (!o.obj.locked && !host.readOnly) {
      const northMid = { x: (c[2]!.x + c[3]!.x) / 2, y: (c[2]!.y + c[3]!.y) / 2 };
      const knob = S(rotateKnob(b, KNOB_PX / host.view.ppm));
      out.push(<line key="stem" class="sp-handle-stem" x1={northMid.x} y1={northMid.y} x2={knob.x} y2={knob.y} />);
      out.push(<circle key="knob" class="sp-handle knob" cx={knob.x} cy={knob.y} r={6}><title>Drag to turn (5° steps)</title></circle>);
      c.forEach((p, i) => out.push(<rect key={`c${i}`} class="sp-handle" x={p.x - 5} y={p.y - 5} width={10} height={10}><title>Drag to resize</title></rect>));
    }
  } else {
    const p = positionOf(o);
    if (p) {
      const at = S(p);
      out.push(<circle key="sel" class="sp-sel" cx={at.x} cy={at.y} r={11} />);
    }
  }
  if (host.tools.pathEdit === o.obj.id && o.kind === "emitter" && o.obj.kind === "moving") {
    o.obj.route.forEach((q, i) => {
      const at = S(q);
      out.push(<circle key={`wp${i}`} class="sp-waypoint" cx={at.x} cy={at.y} r={6}><title>Drag to move · Shift-click to remove</title></circle>);
    });
    routeMidpoints(o.obj.route).forEach((m, i) => {
      const at = S(m);
      out.push(
        <g key={`mid${i}`} class="sp-midpoint">
          <circle cx={at.x} cy={at.y} r={7} />
          <text x={at.x} y={at.y + 4} text-anchor="middle">+</text>
          <title>Add a waypoint here</title>
        </g>,
      );
    });
  }
  return <g>{out}</g>;
}

function NodeToolbar(props: { host: SceneHost; o: SceneObject; S: (p: P2) => Px; size: Size }) {
  const { host, o, S, size } = props;
  const b = boxOf(o);
  const anchor = b ? boxCorners(b).map(S).reduce((top, p) => (p.y < top.y ? p : top)) : positionOf(o) ? S(positionOf(o)!) : null;
  if (!anchor) return null;
  const x = Math.min(size.width - 120, Math.max(8, anchor.x - 60));
  const y = Math.max(4, anchor.y - 52);
  const id = o.obj.id;
  const ro = host.readOnly;
  const playable = o.kind === "emitter" || o.kind === "audioZone" || o.kind === "sound2d";
  return (
    <div class="sp-nodebar" role="toolbar" aria-label={`${o.obj.name} actions`} style={{ left: `${x}px`, top: `${y}px` }} onPointerDown={(e) => e.stopPropagation()}>
      {o.kind === "listener" ? (
        <>
          <button type="button" title="Play every unmuted sound, heard from this listener" onClick={() => host.playAll(id)}>▶ Play all</button>
          <button type="button" disabled={ro || host.scene.activeListener === id} title="Hear the scene from this listener" onClick={() => host.listenHere(id)}>Listen here</button>
        </>
      ) : playable ? (
        <>
          <button type="button" aria-pressed={host.solo === id} class={host.solo === id ? "on" : ""} title={host.solo === id ? "Hear everything again" : "Play it on its own"} onClick={() => host.soloToggle(id)}>▶ Solo</button>
          <button type="button" aria-pressed={host.silenced(id) && host.solo !== null ? false : host.silenced(id)} class={host.silenced(id) && host.solo === null ? "on" : ""} title="Mute or unmute it in the audition" onClick={() => host.muteToggle(id)}>Mute</button>
        </>
      ) : null}
      {o.kind === "emitter" && <button type="button" title="The curves of the playlist it plays" onClick={() => host.editAttenuation(id)}>Edit attenuation…</button>}
      {o.kind === "emitter" && o.obj.kind === "moving" && (
        <button type="button" disabled={ro || o.obj.locked} aria-pressed={host.tools.pathEdit === id} class={host.tools.pathEdit === id ? "on" : ""} title="Drag waypoints, add and remove them" onClick={() => host.setTools({ tool: "select", pathEdit: host.tools.pathEdit === id ? null : id })}>
          Edit path
        </button>
      )}
      <button type="button" disabled={ro} aria-label="Rename" title="Rename (double-click)" onClick={() => host.setRenaming(id)}>✎</button>
      <button type="button" disabled={ro || (o.kind === "listener" && host.scene.listeners.length <= 1)} aria-label="Delete" title={o.kind === "listener" && host.scene.listeners.length <= 1 ? "A scene needs a listener" : "Delete (Del)"} class="danger" onClick={() => host.remove(id)}>🗑</button>
    </div>
  );
}

function RenameField(props: { host: SceneHost; S: (p: P2) => Px }) {
  const { host, S } = props;
  const o = host.renaming ? findObject(host.scene, host.renaming) : null;
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    finished.current = false;
    input.current?.focus();
    input.current?.select();
  }, [host.renaming]);
  if (!o) return null;
  const b = boxOf(o);
  const p = b ? b.center : (positionOf(o) ?? { x: 0, y: 0, z: 0 });
  const at = S(p);
  const done = (commit: boolean) => {
    // Enter or Esc ends it; the blur that follows the field going away must not commit again.
    if (finished.current) return;
    finished.current = true;
    const value = input.current?.value ?? "";
    host.setRenaming(null);
    if (commit && value.trim() !== "" && value.trim() !== o.obj.name) host.edit(`Rename ${o.obj.name}`, (x) => renameObject(x, o.obj.id, value));
  };
  return (
    <input
      ref={input}
      class="sp-rename"
      aria-label="Name"
      defaultValue={o.obj.name}
      style={{ left: `${Math.max(4, at.x - 70)}px`, top: `${Math.max(4, at.y + 10)}px` }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") done(true);
        else if (e.key === "Escape") done(false);
      }}
      onBlur={() => done(true)}
    />
  );
}

// --- elevation strip -------------------------------------------------------------------------------------------------

/** The elevation strip's height axis: metres to pixels and back over `range`. */
const axis = (range: readonly [number, number], height: number, pad = 8) => {
  const h = Math.max(1, height - pad * 2);
  return {
    y: (m: number) => pad + h - ((m - range[0]) / (range[1] - range[0])) * h,
    m: (y: number) => range[0] + ((pad + h - y) / h) * (range[1] - range[0]),
  };
};

type StripDrag = { kind: "slab"; grab: number } | { kind: "edge"; edge: "low" | "high" } | { kind: "mark"; mark: HeightMark; grab: number };

function ElevationStrip(props: { host: SceneHost; range: [number, number]; slab: [number, number] }) {
  const { host, range, slab } = props;
  const ref = useRef<HTMLDivElement>(null);
  const size = useSize(ref);
  const drag = useRef<StripDrag | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const a = axis(range, size.height);
  const s = host.scene;
  const listener = activeListener(s);
  const marks = heightMarks(s);
  const at = (e: PointerEvent | MouseEvent) => e.clientY - ref.current!.getBoundingClientRect().top;
  const stepListener = (dir: 1 | -1) => {
    const sel = host.selected ? findObject(s, host.selected) : null;
    const target = sel?.kind === "listener" ? sel.obj : listener;
    host.edit("Move listener", (x) => setHeight(x, target.id, target.position.y + dir * LISTENER_STEP));
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const y = at(e);
    const m = a.m(y);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const mark = !host.readOnly ? marks.find((k) => (k.point ? Math.abs(a.y(k.low) - y) < 5 : y >= a.y(k.high) - 2 && y <= a.y(k.low) + 2) && Math.abs(markX(k) - (e.clientX - ref.current!.getBoundingClientRect().left)) < 6) : undefined;
    if (mark && !findObject(s, mark.id)?.obj.locked) {
      host.select(mark.id);
      drag.current = { kind: "mark", mark, grab: m - mark.low };
      return;
    }
    if (Math.abs(y - a.y(slab[1])) < 5) drag.current = { kind: "edge", edge: "high" };
    else if (Math.abs(y - a.y(slab[0])) < 5) drag.current = { kind: "edge", edge: "low" };
    else if (m >= slab[0] && m <= slab[1]) drag.current = { kind: "slab", grab: m - (slab[0] + slab[1]) / 2 };
    else host.setSlab(moveSlab(host.slab, slab, m, range));
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const m = a.m(at(e));
    if (d.kind === "slab") host.setSlab(moveSlab(host.slab, slab, m - d.grab, range));
    else if (d.kind === "edge") host.setSlab(dragSlabEdge(slab, d.edge, m, range));
    else {
      const k = d.mark;
      if (k.point) host.edit(editLabel(k.kind), (x) => setHeight(x, k.id, m), true);
      else {
        const [lo, hi] = shiftSpan(k.low, k.high, Math.round((m - d.grab) * 2) / 2);
        host.edit(editLabel(k.kind), (x) => setBoxHeights(x, k.id, lo, hi), true);
      }
    }
  };
  const onUp = () => {
    if (drag.current?.kind === "mark") host.endDrag();
    drag.current = null;
  };
  // Marks side by side: bars in columns, points on the right.
  const bars = marks.filter((k) => !k.point);
  const markX = (k: HeightMark) => (k.point ? size.width - 12 : 10 + (bars.indexOf(k) % 4) * 7);
  const entries = (): MenuEntry[] => {
    const list = inRange(s, slab);
    if (list.length === 0) return [{ id: "none", label: "Nothing in range", disabled: true, run: () => {} }];
    return list.map((k) => ({ id: k.id, label: `${k.name} · ${k.point ? `${k.low.toFixed(1)} m` : `${k.low}–${k.high} m`}`, run: () => host.select(k.id) }));
  };
  return (
    <div class="sp-elevation" aria-label="Elevation">
      <div class="sp-elev-tools">
        <button type="button" aria-pressed={host.slab.follow} class={host.slab.follow ? "on" : ""} title="Follow the listener's height (±3 m)" onClick={() => host.setSlab({ ...host.slab, follow: !host.slab.follow, low: slab[0], high: slab[1] })}>
          Follow
        </button>
        <button type="button" aria-label="Raise the listener 1 m" title="Raise the listener (or the selected one) 1 m" disabled={host.readOnly} onClick={() => stepListener(1)}>▲</button>
        <button type="button" aria-label="Lower the listener 1 m" title="Lower the listener (or the selected one) 1 m" disabled={host.readOnly} onClick={() => stepListener(-1)}>▼</button>
      </div>
      <div
        ref={ref}
        class="sp-elev-track"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        title={`Heights ${range[0]}–${range[1]} m; the plan shows ${slab[0].toFixed(1)}–${slab[1].toFixed(1)} m. Right-click for what's in range.`}
      >
        {size.height > 0 && (
          <svg width={size.width} height={size.height} aria-hidden="true">
            <rect class="sp-slab" x={2} y={a.y(slab[1])} width={size.width - 4} height={Math.max(2, a.y(slab[0]) - a.y(slab[1]))} />
            <line class="sp-slab-edge" x1={2} x2={size.width - 2} y1={a.y(slab[1])} y2={a.y(slab[1])} />
            <line class="sp-slab-edge" x1={2} x2={size.width - 2} y1={a.y(slab[0])} y2={a.y(slab[0])} />
            {[range[0], (range[0] + range[1]) / 2, range[1]].map((m) => (
              <text key={m} class="sp-elev-tick" x={size.width - 2} y={a.y(m) + 3} text-anchor="end">{Math.round(m)}</text>
            ))}
            {marks.map((k) =>
              k.point ? (
                <circle key={k.id} class={`sp-mark point ${k.kind}${k.active ? " active" : ""}${host.selected === k.id ? " selected" : ""}`} cx={markX(k)} cy={a.y(k.low)} r={4}><title>{`${k.name} · ${k.low.toFixed(1)} m`}</title></circle>
              ) : (
                <rect key={k.id} class={`sp-mark bar ${k.kind}${host.selected === k.id ? " selected" : ""}`} x={markX(k) - 2.5} y={a.y(k.high)} width={5} height={Math.max(2, a.y(k.low) - a.y(k.high))}><title>{`${k.name} · ${k.low}–${k.high} m`}</title></rect>
              ),
            )}
          </svg>
        )}
      </div>
      <span class="sp-elev-readout">{`${slab[0].toFixed(0)}–${slab[1].toFixed(0)} m`}</span>
      {menu && (
        <ContextMenu
          entries={entries()}
          at={menu}
          label="In range"
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

// --- side view -------------------------------------------------------------------------------------------------------

type SideDrag = { id: string; grab: P2; startY: number; startX: number };

function SideView(props: { host: SceneHost; range: [number, number]; slab: [number, number] }) {
  const { host, range, slab } = props;
  const ref = useRef<HTMLDivElement>(null);
  const size = useSize(ref);
  const drag = useRef<SideDrag | null>(null);
  const s = host.scene;
  const a = axis(range, size.height, 10);
  const v = host.view;
  const X = (x: number) => size.width / 2 + (x - v.cx) * v.ppm;
  const xOf = (px: number) => v.cx + (px - size.width / 2) / v.ppm;
  const objects = allObjects(s).filter((o) => shownInPlan(s, o) && o.kind !== "sound2d");
  const local = (e: PointerEvent): Px => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onDown = (e: PointerEvent, o: SceneObject) => {
    e.stopPropagation();
    host.select(o.obj.id);
    if (host.readOnly || o.obj.locked) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const p = local(e);
    const b = boxOf(o);
    const pos = positionOf(o)!;
    drag.current = { id: o.obj.id, grab: { x: xOf(p.x) - (b ? b.center.x : pos.x), z: a.m(p.y) - (b ? b.bottom : pos.y) }, startY: b ? b.bottom : pos.y, startX: b ? b.center.x : pos.x };
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = local(e);
    const o = findObject(host.scene, d.id);
    if (!o) return;
    const x = xOf(p.x) - d.grab.x;
    const y = Math.round((a.m(p.y) - d.grab.z) * 10) / 10;
    const b = boxOf(o);
    const label = editLabel(o.kind, !b);
    host.edit(label, (sc) => {
      if (b) {
        const [lo, hi] = shiftSpan(b.bottom, b.top, Math.round(y * 2) / 2);
        const moved = moveObjectTo(sc, d.id, { x, z: b.center.z });
        return "refused" in moved ? moved : setBoxHeights(moved.next, d.id, lo, hi);
      }
      const pos = positionOf(o)!;
      const moving = o.kind === "emitter" && o.obj.kind === "moving";
      const moved = moving ? { next: sc } : moveObjectTo(sc, d.id, { x, z: pos.z });
      return "refused" in moved ? moved : setHeight(moved.next, d.id, y);
    }, true);
  };
  const onUp = () => {
    if (drag.current) host.endDrag();
    drag.current = null;
  };
  return (
    <div ref={ref} class="sp-side" aria-label="Side view, looking north" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      {size.width > 0 && (
        <svg width={size.width} height={size.height} role="img" aria-label="Side view: x across, height up">
          <rect class="sp-slab side" x={0} y={a.y(slab[1])} width={size.width} height={Math.max(1, a.y(slab[0]) - a.y(slab[1]))} />
          <line class="sp-grid axis" x1={0} x2={size.width} y1={a.y(0)} y2={a.y(0)} />
          {objects.map((o) => {
            const b = boxOf(o);
            const cls = `${o.kind}${host.selected === o.obj.id ? " selected" : ""}${renderClass(host, o.obj.id)}`;
            if (b) {
              const [x0, x1] = boxSpanX(b as SceneBox);
              return <rect key={o.obj.id} class={`sp-side-box ${cls}`} x={X(x0)} y={a.y(b.top)} width={Math.max(2, X(x1) - X(x0))} height={Math.max(2, a.y(b.bottom) - a.y(b.top))} onPointerDown={(e) => onDown(e, o)}><title>{o.obj.name}</title></rect>;
            }
            const p = positionOf(o)!;
            return <circle key={o.obj.id} class={`sp-side-dot ${cls}`} cx={X(p.x)} cy={a.y(p.y)} r={5} onPointerDown={(e) => onDown(e, o)}><title>{`${o.obj.name} · ${p.y.toFixed(1)} m`}</title></circle>;
          })}
          <text class="sp-grid-label" x={8} y={14}>Side view · looking north</text>
        </svg>
      )}
    </div>
  );
}
