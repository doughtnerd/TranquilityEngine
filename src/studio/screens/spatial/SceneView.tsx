// The Scene view (ADR 0347; the prototype's Scene panel, B.4): a top-down plan of the test scene (x across, north up), a
// tool palette, the legend, a zoom bar (− % + Fit, Side view), the height strip and the optional side view. A press
// selects and drags (the selected box's edge handles and rotate knob first, then the path being edited, then points,
// then the smallest box); a placing tool puts its object where you click; wheel and pinch zoom about the pointer,
// Space-drag, the middle button and a drag on empty ground pan. Emitters are rings coloured by how they are heard (HRTF,
// panned, ambisonic bed): predicted from the project's Listening settings before Play, the runtime's own rows while it
// plays. A floating toolbar over the selected emitter plays it solo, mutes it, edits its attenuation and its path,
// renames and deletes; under a selected shape it renames and deletes; a listener's plays all from it or listens there.
// Rays run from the listener that hears the scene to each sound heard in place: solid when clear, dashed when occluded.
import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { ContextMenu, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { HistoryPopover } from "../../../editor/ui/HistoryPopover";
import { Icon } from "../../components/Icon";
import type { SceneBox, Vec3 } from "../../../engine/audio/spatial/testSceneTypes";
import { dragSlabEdge, heightMarks, heightRange, heightTicks, inRange, inSlab, LISTENER_STEP, moveSlab, relativeHeight, shiftSpan, sideRange, slabRange, type HeightMark } from "./elevation";
import { boxCorners, boxContains, boxEdges, boxSpanX, growBox, rotateKnob, routeMidpoints, type P2 } from "./geometry";
import { livePlace, placeNow, speedText } from "./liveMotion";
import { shownInPlan } from "./outline";
import { beginDrag, dragTo, editLabel, hitTest, hoverTakesFocus, KNOB_PX, type Drag } from "./pointerModel";
import type { SceneHost } from "./sceneHost";
import { BASE_CLASS, baseBanner, basePlanItems } from "./baseLayer";
import { modeOf, predictModes, type RenderMode } from "./renderModes";
import { activeListener, allObjects, boxOf, findObject, insertRoutePoint, moveObjectTo, positionOf, removeRoutePoint, renameObject, setBoxHeights, setHeight, type ObjectKind, type SceneObject } from "./sceneEdits";
import { pickTool, placesByClick, TOOLS, type Tool } from "./tools";
import { LEGEND, rayEnd, raysOf } from "./voicesTable";
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

/** "smallStone" → "Small stone". */
const presetText = (id: string): string => {
  const words = id.replace(/([A-Z])/g, " $1").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** An obstacle's fill by its material (the prototype's: rock, wood, metal). */
const materialClass = (material: string): string => (/wood|timber|plank/i.test(material) ? " wood" : /metal|steel|iron/i.test(material) ? " metal" : "");

/** How the view reads the audition for one object. */
interface Heard {
  /** The ring's mode, or null (a neutral ring: nothing to predict, or not heard while playing). */
  readonly mode: RenderMode | null;
  /** Muted by hand in the audition (not just left out by a solo). */
  readonly muted: boolean;
  /** Silenced: muted, or another object is soloed. */
  readonly silenced: boolean;
  /** Heard now (playing, not silenced). */
  readonly playing: boolean;
}

function heardOf(host: SceneHost, id: string, predicted: ReadonlyMap<string, RenderMode>): Heard {
  const silenced = host.silenced(id);
  const muted = silenced && host.solo === null;
  const row = host.voices.find((v) => v.id === id);
  const mode = modeOf(id, host.playing, host.voices, predicted);
  return { mode, muted, silenced, playing: host.playing && !silenced && !!row?.playing };
}

const heardClass = (h: Heard) => `${h.mode ? ` ${h.mode}` : ""}${h.silenced ? " muted" : ""}${h.playing ? " playing" : ""}`;

export interface SceneViewProps {
  readonly host: SceneHost;
}

export function SceneView(props: SceneViewProps) {
  const { host } = props;
  const s = host.scene;
  const listener = activeListener(s);
  const range = heightRange(s);
  const slabNow = slabRange(host.slab, listener.position.y, range);
  const banner = baseBanner(host.base ?? null);
  return (
    <div class="sp-scene" data-keyscope="spatial-scene" data-asset-document={host.path} tabIndex={-1}>
      <div class="sp-toolbar" role="toolbar" aria-label="Scene">
        <HistoryPopover none="Click into the scene to see its edit history" />
        {banner && (
          <span class={`sp-base-banner${banner.warning ? " warning" : ""}`} role={banner.warning ? "alert" : undefined} title={host.base?.problems.join("\n") || undefined}>
            {banner.text}
          </span>
        )}
        {host.readOnly && <span class="sp-toolbar-status">Read-only</span>}
        <ul class="sp-legend" aria-label="Legend">
          {LEGEND.map((l) => (
            <li key={l.id} title={LEGEND_TIPS[l.id]}>
              <span class={`sp-swatch ${l.id}`} aria-hidden="true" />
              {l.label}
            </li>
          ))}
        </ul>
      </div>
      <div class="sp-body">
        <Palette host={host} />
        <Viewport host={host} slab={slabNow} />
        <ElevationStrip host={host} range={range} slab={slabNow} />
      </div>
      {host.sideView && <SideView host={host} slab={slabNow} />}
    </div>
  );
}

const LEGEND_TIPS: Readonly<Record<string, string>> = {
  hrtf: "HRTF: rendered around your head",
  panned: "Panned between the speakers",
  bed: "Folded into the ambisonic bed (far away)",
  zone: "An audio zone: an area that plays a sound",
  edge: "How far an inside-only zone fades out",
  occluded: "Path to the listener is blocked",
};

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
          <Icon name={t.icon} size={18} />
          <span class="sp-tool-label" aria-hidden="true">{t.short}</span>
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
  const [panning, setPanning] = useState(false);
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
      setPanning(true);
      e.preventDefault();
    }
  };
  const endSpace = () => {
    space.current = false;
    setPanning(false);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === " ") endSpace();
  };
  // The pointer over the plan brings the keyboard with it (D27): Space pans, +/−/0 zoom, the arrows pan.
  const onPointerEnter = (e: PointerEvent) => {
    const el = ref.current;
    if (!el || e.pointerType === "touch" || document.activeElement === el) return;
    if (hoverTakesFocus(document.activeElement)) el.focus({ preventScroll: true });
  };

  const onPointerDown = (e: PointerEvent) => {
    const el = ref.current!;
    el.focus({ preventScroll: true });
    const at = local(e);
    el.setPointerCapture?.(e.pointerId);
    if (e.pointerType === "touch") {
      touches.current.set(e.pointerId, at);
      if (touches.current.size === 2) {
        // A second finger turns whatever the first began into a pinch; a drag it had moved ends as one undo step.
        const g = gesture.current;
        if (g?.kind === "drag" && g.moved) hostRef.current.endDrag();
        gesture.current = { kind: "pinch" };
        return;
      }
      if (touches.current.size > 2) return;
    }
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
  const predicted = predictModes(s, host.listening ?? { hrtf: 2, bedBeyond: null });
  const audition = auditionText(host);
  const pathOf = host.tools.pathEdit ? findObject(s, host.tools.pathEdit) : null;
  return (
    <div
      ref={ref}
      class={`sp-viewport${placesByClick(host.tools.tool) ? " placing" : ""}${panning ? " panning" : ""}`}
      tabIndex={0}
      aria-label="Scene plan: drag to move, wheel or pinch to zoom, arrow keys to pan"
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={endSpace}
      onPointerEnter={onPointerEnter}
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
          {host.base && <BaseLayer host={host} S={S} slab={slab} />}
          <PlanObjects host={host} S={S} visible={visible} predicted={predicted} />
          {sel && <Selection host={host} o={sel} S={S} />}
        </svg>
      )}
      {sel && size.width > 0 && <NodeToolbar host={host} o={sel} S={S} size={size} />}
      {host.renaming && size.width > 0 && <RenameField host={host} S={S} />}
      <div class="sp-zoombar" role="toolbar" aria-label="Zoom" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" aria-label="Zoom out" title="Zoom out (−)" onClick={() => host.setView(zoomAt(v, size, { x: size.width / 2, y: size.height / 2 }, 1 / ZOOM_STEP))}><Icon name="minus" size={14} /></button>
        <span class="sp-zoom-readout" aria-live="polite">{zoomPercent(v)}%</span>
        <button type="button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => host.setView(zoomAt(v, size, { x: size.width / 2, y: size.height / 2 }, ZOOM_STEP))}><Icon name="plus" size={14} /></button>
        <button type="button" title="Frame the scene (0)" onClick={host.fit}>Fit</button>
        <button type="button" aria-pressed={host.sideView} class={host.sideView ? "on" : ""} title="Show the scene from the south, looking north" onClick={() => host.setSideView(!host.sideView)}>{host.sideView ? "Hide side view" : "Side view"}</button>
      </div>
      {panning && <div class="sp-panhint" aria-live="polite">Panning · release Space to edit</div>}
      {audition && <div class="sp-audition" aria-live="polite">{audition}</div>}
      {pathOf && (
        <div class="sp-pathbar" role="status" onPointerDown={(e) => e.stopPropagation()}>
          <span>Editing {pathOf.obj.name} path · drag points, + adds one, Shift-click removes</span>
          <button type="button" onClick={() => host.setTools({ ...host.tools, pathEdit: null })}>Done</button>
        </div>
      )}
    </div>
  );
}

/** The plan's top-right audition label: "▸ Auditioning all emitters (1 muted)" or "▸ Auditioning Campfire on its own". */
function auditionText(host: SceneHost): string | null {
  if (!host.playing) return null;
  const s = host.scene;
  if (host.solo) return `▸ Auditioning ${findObject(s, host.solo)?.obj.name ?? ""} on its own`;
  const sounding = allObjects(s).filter((o) => o.kind === "emitter" || o.kind === "audioZone" || o.kind === "sound2d");
  const muted = sounding.filter((o) => host.silenced(o.obj.id)).length;
  return `▸ Auditioning all emitters${muted ? ` (${muted} muted)` : ""}`;
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

/** The base game scene underneath, read-only: not hit by the pointer, labelled, dimmed outside the height slab. */
function BaseLayer(props: { host: SceneHost; S: (p: P2) => Px; slab: [number, number] }) {
  const { host, S, slab } = props;
  const items = basePlanItems(host.base ?? null);
  const ppm = host.view.ppm;
  return (
    <g class="sp-base" aria-label={`Base scene ${host.base?.path ?? ""}, read-only`}>
      {items.map((item) => {
        const cls = `${BASE_CLASS[item.kind]}${inSlab(slab, item.low, item.high) ? "" : " dim"}${item.active ? "" : " off"}`;
        const sh = item.shape;
        let mark: JSX.Element;
        let at: Px;
        if (sh.kind === "box") {
          const c = sh.corners.map(S);
          mark = <polygon points={pts(c)} />;
          at = { x: (c[3]!.x + c[2]!.x) / 2, y: Math.min(...c.map((p) => p.y)) + 12 };
        } else if (sh.kind === "circle") {
          const c = S(sh.center);
          mark = <circle cx={c.x} cy={c.y} r={Math.max(3, sh.radius * ppm)} />;
          at = { x: c.x, y: c.y - Math.max(3, sh.radius * ppm) - 4 };
        } else {
          const c = S(sh.at);
          mark = item.kind === "emitter" ? <circle cx={c.x} cy={c.y} r={5} /> : <rect x={c.x - 4} y={c.y - 4} width={8} height={8} />;
          at = { x: c.x, y: c.y - 9 };
        }
        return (
          <g key={item.key} class={cls} data-base={item.key}>
            {mark}
            <text class="sp-base-label" x={at.x} y={at.y} text-anchor="middle">{item.label}</text>
          </g>
        );
      })}
    </g>
  );
}

function PlanObjects(props: { host: SceneHost; S: (p: P2) => Px; visible: (o: SceneObject) => boolean; predicted: ReadonlyMap<string, RenderMode> }) {
  const { host, S, visible, predicted } = props;
  const s = host.scene;
  const listener = activeListener(s);
  const objects = allObjects(s).filter((o) => shownInPlan(s, o));
  const dim = (o: SceneObject) => (visible(o) ? "" : " dim");
  const hover = (o: SceneObject) => (host.hover === o.obj.id ? " hover" : "");
  const boxes = objects.filter((o) => boxOf(o));
  // Big boxes first, so a smaller one inside stays on top.
  boxes.sort((a, b) => boxOf(b)!.width * boxOf(b)!.depth - boxOf(a)!.width * boxOf(a)!.depth);
  const rays = raysOf(host.voices);
  const lp = S(listener.position);
  const bed = host.listening?.bedBeyond ?? null;
  const sel = host.selected ? findObject(s, host.selected) : null;
  const att = sel?.kind === "emitter" ? host.attenuationRange?.(sel.obj.id) ?? null : null;
  const attAt = sel && att ? placeNow(sel, host.playing ? (host.motion ?? []) : []) : null;
  return (
    <g>
      {bed !== null && <circle class="sp-bed-circle" cx={lp.x} cy={lp.y} r={bed * host.view.ppm}><title>{`Ambisonic bed beyond ${bed} m`}</title></circle>}
      {boxes.map((o) => {
        const b = boxOf(o)!;
        const corners = boxCorners(b).map(S);
        const inside = o.kind === "audioZone" && boxContains(b, listener.position);
        const cls = o.kind === "obstacle" ? `sp-obstacle${materialClass(o.obj.material)}` : o.kind === "reverbZone" ? "sp-reverb" : `sp-azone${inside ? " inside" : ""}`;
        const muted = o.kind === "audioZone" && host.silenced(o.obj.id) && host.solo === null;
        const text =
          o.kind === "obstacle" ? `${o.obj.name} · ${o.obj.material}`
          : o.kind === "reverbZone" ? `${o.obj.name} · ${presetText(o.obj.preset)} (priority ${o.obj.priority}${o.obj.levelDefault ? ", default" : ""})`
          : o.kind === "audioZone" ? `${o.obj.name} · ${o.obj.heard === "inside" ? "inside" : "from its edge"}${muted ? " · muted" : ""}`
          : o.obj.name;
        return (
          <g key={o.obj.id} class={`${dim(o)}${hover(o)}${muted ? " muted" : ""}`} data-id={o.obj.id}>
            {o.kind === "audioZone" && o.obj.heard === "inside" && o.obj.feather > 0 && <polygon class="sp-zone-edge" points={pts(boxCorners(growBox(b, o.obj.feather)).map(S))} />}
            <polygon class={cls} points={pts(corners)} />
            <text class="sp-label box" x={corners.reduce((sum, c) => sum + c.x, 0) / 4} y={corners.reduce((sum, c) => sum + c.y, 0) / 4 + 3} text-anchor="middle">{text}</text>
          </g>
        );
      })}
      {att && attAt && (() => {
        const c = S(attAt);
        return (
          <g class="sp-att" aria-hidden="true">
            <circle class="sp-att-min" cx={c.x} cy={c.y} r={att.min * host.view.ppm}><title>{`Min ${att.min.toFixed(1)} m: full volume inside`}</title></circle>
            <circle class="sp-att-max" cx={c.x} cy={c.y} r={att.max * host.view.ppm}><title>{`Max ${att.max.toFixed(1)} m: the last value holds beyond`}</title></circle>
          </g>
        );
      })()}
      {objects.filter((o) => o.kind === "emitter" && o.obj.kind === "moving").map((o) => {
        const e = o.obj as Extract<SceneObject, { kind: "emitter" }>["obj"] & { route: Vec3[] };
        const on = host.tools.pathEdit === o.obj.id ? " editing" : host.selected === o.obj.id || host.hover === o.obj.id ? " near" : "";
        return <polyline key={`route-${o.obj.id}`} class={`sp-route${dim(o)}${on}`} points={pts(e.route.map(S))} />;
      })}
      {rays.map((r) => {
        // A moving emitter's ray goes to where it is now; a base scene's sound's to its place underneath (D43).
        const o = findObject(s, r.id);
        if (o && !shownInPlan(s, o)) return null;
        const to = rayEnd(s, r.id, listener.position, host.playing ? (host.motion ?? []) : [], host.base);
        if (!to) return null;
        const z = S(to);
        const zone = o?.kind === "audioZone";
        return <line key={`ray-${r.id}`} class={`sp-ray${r.occluded ? " occluded" : ""}${zone ? " zone" : ""}`} x1={lp.x} y1={lp.y} x2={z.x} y2={z.y} />;
      })}
      {objects.filter((o) => o.kind === "emitter").map((o) => {
        const start = positionOf(o)!;
        const live = host.playing ? livePlace(o, host.motion ?? []) : null;
        const p = live?.position ?? start;
        const at = S(p);
        const moving = o.kind === "emitter" && o.obj.kind === "moving" ? o.obj : null;
        const from = S(start);
        const heard = heardOf(host, o.obj.id, predicted);
        const rel = relativeHeight(p.y, listener.position.y);
        // While it travels: its start stays marked (drag it to move the start), and an arrow shows where it's heading.
        const arrow = live?.direction ? { x: at.x + live.direction.x * 18, y: at.y - live.direction.z * 18 } : null;
        return (
          <g key={o.obj.id} class={`sp-emitter${heardClass(heard)}${dim(o)}${hover(o)}${o.obj.locked ? " locked" : ""}${live ? " live" : ""}`} data-id={o.obj.id}>
            {live && <title>{`${o.obj.name} · ${speedText(live.speed)}`}</title>}
            {live && Math.hypot(at.x - from.x, at.y - from.y) > 3 && <circle class="sp-start" cx={from.x} cy={from.y} r={4}><title>Its start on the path</title></circle>}
            {arrow && <line class="sp-heading" x1={at.x} y1={at.y} x2={arrow.x} y2={arrow.y} />}
            {heard.playing && <circle class="sp-playing-ring" cx={at.x} cy={at.y} r={10.5} />}
            <circle class="sp-dot" cx={at.x} cy={at.y} r={7} />
            <text class="sp-label" x={at.x} y={at.y + 21} text-anchor="middle">
              {o.obj.name}
              {moving ? <tspan class="sp-speed">{` · ${Math.round(moving.speed * 10) / 10} m/s`}</tspan> : null}
              {rel ? <tspan class="sp-rel">{` ${rel}`}</tspan> : null}
              {heard.playing ? <tspan class="sp-status">{" · ▸ playing"}</tspan> : heard.muted ? <tspan class="sp-status">{" · muted"}</tspan> : null}
            </text>
          </g>
        );
      })}
      {objects.filter((o) => o.kind === "listener").map((o) => {
        const l = o.obj as typeof listener;
        const at = S(l.position);
        const r = (l.yaw * Math.PI) / 180;
        const tip = { x: at.x + Math.sin(r) * 15, y: at.y - Math.cos(r) * 15 };
        const active = l.id === listener.id;
        const rel = relativeHeight(l.position.y, listener.position.y);
        return (
          <g key={l.id} class={`sp-listener${active ? " active" : ""}${dim(o)}${hover(o)}${host.playing && active ? " playing" : ""}`} data-id={l.id}>
            {active && host.playing && <circle class="sp-listener-ring" cx={at.x} cy={at.y} r={13} />}
            <line class="sp-facing" x1={at.x} y1={at.y} x2={tip.x} y2={tip.y} />
            <circle class="sp-dot" cx={at.x} cy={at.y} r={8} />
            <text class={`sp-label${active ? " strong" : ""}`} x={at.x} y={at.y + 22} text-anchor="middle">
              {active ? `${l.name} · listening` : l.name}
              {rel ? <tspan class="sp-rel">{` ${rel}`}</tspan> : null}
            </text>
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
      const e = boxEdges(b).map(S);
      const knob = S(rotateKnob(b, KNOB_PX / host.view.ppm));
      out.push(<line key="stem" class="sp-handle-stem" x1={e[2]!.x} y1={e[2]!.y} x2={knob.x} y2={knob.y} />);
      out.push(<circle key="knob" class="sp-handle knob" cx={knob.x} cy={knob.y} r={6}><title>Drag to rotate (5° steps)</title></circle>);
      const cursor = (i: number) => {
        // The resize cursor across the edge, turned with the box.
        const deg = ((((i % 2 === 0 ? 0 : 90) + b.yaw) % 180) + 180) % 180;
        return deg < 22.5 || deg >= 157.5 ? "ns-resize" : deg < 67.5 ? "nesw-resize" : deg < 112.5 ? "ew-resize" : "nwse-resize";
      };
      e.forEach((p, i) => out.push(<rect key={`e${i}`} class="sp-handle" style={{ cursor: cursor(i) }} x={p.x - 5} y={p.y - 5} width={10} height={10}><title>Drag to resize</title></rect>));
    }
  } else {
    const p = placeNow(o, host.playing ? (host.motion ?? []) : []); // a moving emitter's ring follows it while playing
    if (p) {
      const at = S(p);
      out.push(<circle key="halo" class="sp-sel-halo" cx={at.x} cy={at.y} r={o.kind === "listener" ? 11 : 10} />);
      out.push(<circle key="sel" class="sp-sel" cx={at.x} cy={at.y} r={o.kind === "listener" ? 12 : 11} />);
    }
  }
  if (host.tools.pathEdit === o.obj.id && o.kind === "emitter" && o.obj.kind === "moving") {
    o.obj.route.forEach((q, i) => {
      const at = S(q);
      out.push(<rect key={`wp${i}`} class="sp-waypoint" x={at.x - 6} y={at.y - 6} width={12} height={12}><title>Drag to move · Shift-click to remove</title></rect>);
    });
    routeMidpoints(o.obj.route).forEach((m, i) => {
      const at = S(m);
      out.push(
        <g key={`mid${i}`} class="sp-midpoint">
          <circle cx={at.x} cy={at.y} r={8} />
          <text x={at.x} y={at.y + 4} text-anchor="middle">+</text>
          <title>Add a point here</title>
        </g>,
      );
    });
  }
  return <g>{out}</g>;
}

function NodeToolbar(props: { host: SceneHost; o: SceneObject; S: (p: P2) => Px; size: Size }) {
  const { host, o, S, size } = props;
  const bar = useRef<HTMLDivElement>(null);
  // Its own size keeps it inside the view (it wraps when the view is narrower than it).
  const [box, setBox] = useState({ width: 120, height: 30 });
  useLayoutEffect(() => {
    const w = bar.current?.offsetWidth ?? 120;
    const h = bar.current?.offsetHeight ?? 30;
    if (w !== box.width || h !== box.height) setBox({ width: w, height: h });
  });
  const b = boxOf(o);
  const p = b ? null : placeNow(o, host.playing ? (host.motion ?? []) : []);
  if (!b && !p) return null;
  // A point's toolbar sits above it; a shape's under it (the prototype's).
  const corners = b ? boxCorners(b).map(S) : [];
  const anchor = b ? { x: corners.reduce((sum, c) => sum + c.x, 0) / 4, y: Math.max(...corners.map((c) => c.y)) + 10 } : S(p!);
  const x = Math.max(8, Math.min(size.width - box.width - 8, anchor.x - box.width / 2));
  const want = b ? anchor.y : anchor.y - box.height - 16;
  const y = Math.max(4, Math.min(size.height - box.height - 4, want));
  const id = o.obj.id;
  const ro = host.readOnly;
  const playable = o.kind === "emitter" || o.kind === "audioZone" || o.kind === "sound2d";
  const soloed = host.solo === id;
  const muted = host.silenced(id) && host.solo === null;
  return (
    <div ref={bar} class="sp-nodebar" role="toolbar" aria-label={`${o.obj.name} actions`} style={{ left: `${x}px`, top: `${y}px` }} onPointerDown={(e) => e.stopPropagation()}>
      {o.kind === "listener" ? (
        <>
          <button type="button" class={`text${host.playing && !host.solo ? " on" : ""}`} aria-pressed={host.playing && !host.solo} title="Hear every unmuted emitter from the listener" onClick={() => host.playAll(id)}>
            <Icon name={host.playing && !host.solo ? "stop" : "play"} size={12} /> {host.playing && !host.solo ? "Stop all" : "Play all"}
          </button>
          {host.scene.activeListener !== id && <button type="button" class="text" disabled={ro} title="Hear the scene from here" onClick={() => host.listenHere(id)}>Listen here</button>}
        </>
      ) : playable ? (
        <>
          <button type="button" aria-pressed={soloed} class={soloed ? "on" : ""} aria-label={soloed ? "Stop" : "Play solo"} title={soloed ? "Stop: hear everything again" : "Play it on its own"} onClick={() => host.soloToggle(id)}>
            <Icon name={soloed ? "stop" : "play"} size={12} />
          </button>
          <button type="button" aria-pressed={muted} class={muted ? "warn" : ""} aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute it in the audition" : "Mute it in the audition"} onClick={() => host.muteToggle(id)}>
            <Icon name={muted ? "mute" : "volume"} size={14} />
          </button>
        </>
      ) : null}
      {o.kind === "emitter" && (() => {
        const why = host.whyNotEditAttenuation(id);
        return <button type="button" disabled={why !== null} aria-label="Edit attenuation…" title={why ?? "Edit attenuation…: the curves of the playlist it plays"} onClick={() => host.editAttenuation(id)}><Icon name="attenuation" size={14} /></button>;
      })()}
      {o.kind === "emitter" && o.obj.kind === "moving" && (
        <button type="button" disabled={ro || o.obj.locked} aria-label="Edit path" aria-pressed={host.tools.pathEdit === id} class={host.tools.pathEdit === id ? "on" : ""} title="Edit path: drag points, add and remove them" onClick={() => host.setTools({ tool: "select", pathEdit: host.tools.pathEdit === id ? null : id })}>
          <Icon name="path" size={14} />
        </button>
      )}
      <button type="button" disabled={ro} aria-label="Rename" title="Rename (double-click)" onClick={() => host.setRenaming(id)}><Icon name="edit" size={14} /></button>
      <button type="button" disabled={ro || (o.kind === "listener" && host.scene.listeners.length <= 1)} aria-label="Delete" title={o.kind === "listener" && host.scene.listeners.length <= 1 ? "A scene needs at least one listener" : "Delete (Del)"} class="danger" onClick={() => host.remove(id)}><Icon name="trash" size={14} /></button>
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
      style={{ left: `${Math.max(4, at.x - 60)}px`, top: `${Math.max(4, at.y + 12)}px` }}
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

// --- height strip ----------------------------------------------------------------------------------------------------

/** The height axis: metres to pixels and back over `range`. */
const axis = (range: readonly [number, number], height: number, pad = 8) => {
  const h = Math.max(1, height - pad * 2);
  return {
    y: (m: number) => pad + h - ((m - range[0]) / (range[1] - range[0])) * h,
    m: (y: number) => range[0] + ((pad + h - y) / h) * (range[1] - range[0]),
  };
};

type StripDrag = { kind: "slab"; grab: number } | { kind: "edge"; edge: "low" | "high" } | { kind: "mark"; mark: HeightMark; grab: number };

/** A swatch for the In range menu: round for points, square for shapes, in the kind's colour. */
function KindSwatch(props: { kind: ObjectKind; point: boolean; active?: boolean }) {
  return <span class={`sp-kind-swatch ${props.kind}${props.point ? " point" : ""}${props.active ? " active" : ""}`} />;
}

const KIND_TITLE: Readonly<Record<ObjectKind, string>> = { listener: "Listener", emitter: "Emitter", obstacle: "Obstacle", reverbZone: "Reverb zone", audioZone: "Audio zone", sound2d: "2D sound" };
const metres = (v: number) => `${Math.round(v * 10) / 10}`;

function ElevationStrip(props: { host: SceneHost; range: [number, number]; slab: [number, number] }) {
  const { host, range, slab } = props;
  const ref = useRef<HTMLDivElement>(null);
  const size = useSize(ref);
  const drag = useRef<StripDrag | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const a = axis(range, size.height, 14);
  const s = host.scene;
  const listener = activeListener(s);
  const marks = heightMarks(s);
  const predicted = predictModes(s, host.listening ?? { hrtf: 2, bedBeyond: null });
  const at = (e: PointerEvent | MouseEvent) => e.clientY - ref.current!.getBoundingClientRect().top;
  const stepListener = (dir: 1 | -1) => {
    const sel = host.selected ? findObject(s, host.selected) : null;
    const target = sel?.kind === "listener" ? sel.obj : listener;
    host.edit("Move listener", (x) => setHeight(x, target.id, target.position.y + dir * LISTENER_STEP));
  };
  // Marks side by side: bars in columns, emitter dots in the middle, listeners as triangles on the right edge.
  const bars = marks.filter((k) => !k.point);
  const markX = (k: HeightMark) => (k.kind === "listener" ? size.width - 6 : k.point ? size.width - 18 : 10 + (bars.indexOf(k) % 5) * 7);
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const y = at(e);
    const m = a.m(y);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    // A finger gets a wider reach for the marks and the slab's edges.
    const reach = e.pointerType === "touch" ? 12 : 5;
    const px = e.clientX - ref.current!.getBoundingClientRect().left;
    const mark = !host.readOnly ? marks.find((k) => (k.point ? Math.abs(a.y(k.low) - y) < reach : y >= a.y(k.high) - 2 && y <= a.y(k.low) + 2) && Math.abs(markX(k) - px) < reach + 1) : undefined;
    if (mark && !findObject(s, mark.id)?.obj.locked) {
      host.select(mark.id);
      drag.current = { kind: "mark", mark, grab: m - mark.low };
      return;
    }
    if (Math.abs(y - a.y(slab[1])) < reach) drag.current = { kind: "edge", edge: "high" };
    else if (Math.abs(y - a.y(slab[0])) < reach) drag.current = { kind: "edge", edge: "low" };
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
  // The keyboard moves the shown heights: arrows 1 m, Page Up / Page Down 5 m, Home / End to the ends of the range.
  const center = (slab[0] + slab[1]) / 2;
  const onKey = (e: KeyboardEvent) => {
    const half = (slab[1] - slab[0]) / 2;
    const to = e.key === "ArrowUp" ? center + 1 : e.key === "ArrowDown" ? center - 1 : e.key === "PageUp" ? center + 5 : e.key === "PageDown" ? center - 5 : e.key === "Home" ? range[0] + half : e.key === "End" ? range[1] - half : null;
    if (to === null) return;
    e.preventDefault();
    host.setSlab(moveSlab(host.slab, slab, to, range));
  };
  const readout = `${metres(slab[0])}–${metres(slab[1])} m`;
  const entries = (): MenuEntry[] => {
    const list = inRange(s, slab);
    const head: MenuEntry = { kind: "group", label: `In range · ${readout}` };
    if (list.length === 0) return [head, { id: "none", label: "Nothing in this range", disabled: true, run: () => {} }];
    return [
      head,
      ...list.map((k): MenuEntry => ({
        id: k.id,
        label: k.name,
        icon: <KindSwatch kind={k.kind} point={k.point} active={k.active} />,
        note: `${KIND_TITLE[k.kind]} · ${k.point ? `${metres(k.low)} m` : `${metres(k.low)}–${metres(k.high)} m`}`,
        hover: (on) => host.setHover(on ? k.id : null),
        run: () => host.select(k.id),
      })),
    ];
  };
  const follow = host.slab.follow;
  return (
    <div class="sp-elevation" aria-label="Height">
      <div class="sp-elev-cap" aria-hidden="true">Height</div>
      <div
        ref={ref}
        class="sp-elev-track"
        role="slider"
        tabIndex={0}
        aria-label="Heights the plan shows"
        aria-orientation="vertical"
        aria-valuemin={range[0]}
        aria-valuemax={range[1]}
        aria-valuenow={Math.round(center * 10) / 10}
        aria-valuetext={`${slab[0].toFixed(1)} to ${slab[1].toFixed(1)} m`}
        onKeyDown={onKey}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        title={follow ? `Following ${listener.name} (±3 m). Drag to set your own range. Right-click for what's in range.` : "Drag to move · drag the edges to resize · right-click for what's in range"}
      >
        {size.height > 0 && (
          <svg width={size.width} height={size.height} aria-hidden="true">
            {heightTicks(range).map((m) => (
              <g key={m}>
                <line class="sp-elev-grid" x1={0} x2={size.width} y1={a.y(m)} y2={a.y(m)} />
                <text class="sp-elev-tick" x={2} y={a.y(m) - 2}>{m === range[1] ? `${m} m` : m}</text>
              </g>
            ))}
            <rect class="sp-slab" x={0} y={a.y(slab[1])} width={size.width} height={Math.max(2, a.y(slab[0]) - a.y(slab[1]))} />
            <line class="sp-slab-edge" x1={0} x2={size.width} y1={a.y(slab[1])} y2={a.y(slab[1])} />
            <line class="sp-slab-edge" x1={0} x2={size.width} y1={a.y(slab[0])} y2={a.y(slab[0])} />
            {marks.map((k) => {
              const cls = `${k.kind}${host.selected === k.id ? " selected" : ""}${host.hover === k.id ? " hover" : ""}${inSlab(slab, k.low, k.high) ? "" : " out"}`;
              const title = `${k.name} · ${k.point ? `${metres(k.low)} m` : `${metres(k.low)}–${metres(k.high)} m`} · drag to ${k.point ? "change height" : "raise or lower"}`;
              if (k.kind === "listener") {
                const x = markX(k), y = a.y(k.low);
                return <polygon key={k.id} class={`sp-mark tri ${cls}${k.active ? " active" : ""}`} points={`${x + 5},${y - 5} ${x + 5},${y + 5} ${x - 4},${y}`}><title>{title}</title></polygon>;
              }
              if (k.point) return <circle key={k.id} class={`sp-mark point ${cls} ${predicted.get(k.id) ?? ""}`} cx={markX(k)} cy={a.y(k.low)} r={3.5}><title>{title}</title></circle>;
              return <rect key={k.id} class={`sp-mark bar ${cls}`} x={markX(k) - 2} y={a.y(k.high)} width={4} height={Math.max(2, a.y(k.low) - a.y(k.high))}><title>{title}</title></rect>;
            })}
          </svg>
        )}
      </div>
      <div class="sp-elev-tools">
        <button type="button" aria-pressed={follow} class={`sp-elev-follow${follow ? " on" : ""}`} title="Keep the range centred on the listening player" onClick={() => host.setSlab({ ...host.slab, follow: !follow, low: slab[0], high: slab[1] })}>
          Follow
        </button>
        <span class="sp-elev-steps">
          <button type="button" aria-label="Raise the player 1 m" title="Raise the player 1 m (or the selected listener)" disabled={host.readOnly} onClick={() => stepListener(1)}>▲</button>
          <button type="button" aria-label="Lower the player 1 m" title="Lower the player 1 m (or the selected listener)" disabled={host.readOnly} onClick={() => stepListener(-1)}>▼</button>
        </span>
        <span class="sp-elev-readout">{readout}</span>
      </div>
      {menu && (
        <ContextMenu
          entries={entries()}
          at={menu}
          label="In range"
          onClose={() => {
            host.setHover(null);
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}

// --- side view -------------------------------------------------------------------------------------------------------

type SideDrag = { id: string; grab: P2; startY: number; startX: number };

function SideView(props: { host: SceneHost; slab: [number, number] }) {
  const { host, slab } = props;
  const ref = useRef<HTMLDivElement>(null);
  const size = useSize(ref);
  const drag = useRef<SideDrag | null>(null);
  const s = host.scene;
  const range = sideRange(s, slab);
  const a = axis(range, size.height, 12);
  const v = host.view;
  const listener = activeListener(s);
  const predicted = predictModes(s, host.listening ?? { hrtf: 2, bedBeyond: null });
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
  const rays = raysOf(host.voices);
  const lx = X(listener.position.x), ly = a.y(listener.position.y);
  return (
    <div class="sp-side-row">
      <div class="sp-side-spacer start" aria-hidden="true" />
      <div ref={ref} class="sp-side" aria-label="Side view, looking north" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {size.width > 0 && (
          <svg width={size.width} height={size.height} role="img" aria-label="Side view: x across, height up">
            <rect class="sp-slab side" x={0} y={a.y(slab[1])} width={size.width} height={Math.max(1, a.y(slab[0]) - a.y(slab[1]))} />
            <line class="sp-grid axis" x1={0} x2={size.width} y1={a.y(0)} y2={a.y(0)} />
            {objects.filter((o) => boxOf(o)).map((o) => {
              const b = boxOf(o)!;
              const [x0, x1] = boxSpanX(b as SceneBox);
              const cls = `${o.kind}${host.selected === o.obj.id ? " selected" : ""}${host.hover === o.obj.id ? " hover" : ""}`;
              return <rect key={o.obj.id} class={`sp-side-box ${cls}`} x={X(x0)} y={a.y(b.top)} width={Math.max(2, X(x1) - X(x0))} height={Math.max(2, a.y(b.bottom) - a.y(b.top))} onPointerDown={(e) => onDown(e, o)}><title>{`${o.obj.name} · ${metres(b.bottom)}–${metres(b.top)} m`}</title></rect>;
            })}
            {rays.map((r) => {
              const o = findObject(s, r.id);
              if (!o || o.kind !== "emitter") return null;
              const p = placeNow(o, host.playing ? (host.motion ?? []) : []);
              return p ? <line key={`ray-${r.id}`} class={`sp-ray${r.occluded ? " occluded" : ""}`} x1={lx} y1={ly} x2={X(p.x)} y2={a.y(p.y)} /> : null;
            })}
            {objects.filter((o) => !boxOf(o)).map((o) => {
              const p = placeNow(o, host.playing ? (host.motion ?? []) : [])!;
              const listenerDot = o.kind === "listener";
              const mode = o.kind === "emitter" ? modeOf(o.obj.id, host.playing, host.voices, predicted) : null;
              const cls = `${o.kind}${o.obj.id === listener.id ? " active" : ""}${host.selected === o.obj.id ? " selected" : ""}${mode ? ` ${mode}` : ""}`;
              return (
                <g key={o.obj.id} class={`sp-side-pt ${cls}`} onPointerDown={(e) => onDown(e, o)}>
                  <circle class="sp-side-dot" cx={X(p.x)} cy={a.y(p.y)} r={listenerDot ? 6 : 5} />
                  <text class="sp-side-label" x={X(p.x) + 9} y={a.y(p.y) + 3}>{o.obj.name}</text>
                  <title>{`${o.obj.name} · ${metres(p.y)} m`}</title>
                </g>
              );
            })}
            <text class="sp-grid-label" x={8} y={14}>{`Side view · looking north · across = X, up = height (${range[0]}–${range[1]} m)`}</text>
          </svg>
        )}
      </div>
      <div class="sp-side-spacer end" aria-hidden="true" />
    </div>
  );
}
