// The curve editor's dope sheet (ADR 0346, time curves only): a ruler (drag to zoom the plot to a range, click to move
// the playhead, double-click for the whole clip), one row per time-driven lane with its keys as diamonds (drag moves a
// key in time; right-click opens the key menu) and "Add key at playhead".
import { useRef, useState } from "preact/hooks";
import { curveKeyHandles, type CurveKey } from "../../../engine/core/curve";
import { ContextMenu, SEPARATOR, type MenuEntry } from "../ContextMenu";
import {
  axisOf,
  deleteKey,
  dopeLanes,
  formatValue,
  formatX,
  KEY_SHAPES,
  keyAtPlayhead,
  laneColor,
  laneContext,
  laneOf,
  playheadAt,
  rulerRange,
  setKeyFree,
  setKeyShape,
  setKeyX,
  shapeOf,
  shapeRefusal,
  SHAPE_LABELS,
  TIME_INPUT,
  withLane,
  xTicks,
  type CurveDraft,
  type CurveEditorSpec,
} from "./curveEditorModel";
import { Icon, type DraftEditor } from "./CurvePlot";

export interface DopeSheetProps {
  readonly spec: CurveEditorSpec;
  readonly draft: CurveDraft;
  readonly activeId: string;
  readonly hidden: ReadonlySet<string>;
  readonly selected: { readonly lane: string; readonly index: number } | null;
  readonly playhead: number;
  readonly range: readonly [number, number] | null;
  readonly editor: DraftEditor;
  onPick(lane: string): void;
  onSelect(lane: string, index: number | null): void;
  onPlayhead(t: number): void;
  onRange(range: readonly [number, number] | null): void;
  onMenu(open: boolean): void;
}

const ADD_AT_PLAYHEAD = "M10 3l7 7-7 7-7-7zM19 15v6M16 18h6";
const WHOLE = "M3 12h18M3 12l4-4M3 12l4 4M21 12l-4-4M21 12l-4 4";

export function DopeSheet(props: DopeSheetProps) {
  const { spec, draft, editor, playhead, range } = props;
  const axis = axisOf(spec, TIME_INPUT);
  const len = axis.max;
  const pc = (x: number) => `${((x / len) * 100).toFixed(3)}%`;
  const rows = dopeLanes(spec, draft);
  const [menu, setMenu] = useState<{ lane: string; index: number; x: number; y: number } | null>(null);
  const ruler = useRef<{ rect: DOMRect; x0: number; px: number; dragged: boolean } | null>(null);
  const dia = useRef<{ lane: string; index: number; rect: DOMRect; moved: boolean } | null>(null);
  const timeAt = (clientX: number, rect: DOMRect) => ((clientX - rect.left) / (rect.width || 1)) * len;
  const ticks = xTicks(axis, [0, len]);

  const editKeys = (label: string, laneId: string, r: { next: readonly CurveKey[] } | { refused: string }) => {
    if ("refused" in r) editor.refused(label, r.refused);
    else editor.commit(label, withLane(editor.live(), laneId, { curve: r.next }));
  };
  const closeMenu = () => {
    setMenu(null);
    props.onMenu(false);
  };
  const menuEntries = (m: { lane: string; index: number }): MenuEntry[] => {
    const ctx = laneContext(spec, draft, m.lane);
    const curve = laneOf(spec, draft, m.lane)?.state.curve;
    if (!ctx || !curve || !curve[m.index]) return [];
    const k = curve[m.index];
    const end = m.index === 0 || m.index === curve.length - 1;
    const shapes: MenuEntry[] = ctx.linearOnly || ctx.lane.bool ? [] : KEY_SHAPES.map((s) => ({ id: s, label: `${shapeOf(k) === s ? "✓ " : ""}${SHAPE_LABELS[s]}`, disabled: shapeRefusal(ctx, s) !== null, run: () => editKeys(`Set key shape: ${SHAPE_LABELS[s]}`, m.lane, setKeyShape(ctx, curve, m.index, s)) }));
    const free = !!curveKeyHandles(k)?.free;
    return [
      ...shapes,
      ...(shapes.length ? [{ id: "free", label: `${free ? "✓ " : ""}Free handles`, disabled: shapeOf(k) !== "bezier", run: () => editKeys(free ? "Mirror handles" : "Free handles", m.lane, setKeyFree(curve, m.index, !free)) }, SEPARATOR] : []),
      { id: "playhead", label: "Move to playhead", disabled: end, title: end ? "End keys stay at the ends" : undefined, run: () => editKeys("Move key to playhead", m.lane, setKeyX(ctx, curve, m.index, playhead)) },
      {
        id: "delete",
        label: "Delete key",
        danger: true,
        hint: "Del",
        disabled: end || curve.length <= 2,
        run: () => {
          editKeys("Delete key", m.lane, deleteKey(curve, m.index));
          props.onSelect(m.lane, null);
        },
      },
    ];
  };

  return (
    <section class="ce-dope" aria-label="Dope sheet">
      <div class="ce-ph">
        <span class="ce-cap">Dope sheet</span>
      </div>
      <div class="ce-bar" role="toolbar" aria-label="Dope sheet tools">
        <span class="ce-muted">{range ? `Curve editor shows ${formatX(axis, range[0])} – ${formatX(axis, range[1])}` : "Drag on the ruler to zoom the curve editor to a range"}</span>
        <button type="button" class="ce-ib" disabled={!range} aria-label="Show whole clip" title="Show the whole length (zoom out)" onClick={() => props.onRange(null)}>
          <Icon d={WHOLE} />
        </button>
        <span class="ce-spacer" />
        <span class="ce-muted">
          Playhead <b class="ce-num">{formatX(axis, playhead)}</b>
        </span>
        <button
          type="button"
          class="ce-ib"
          aria-label="Add key at playhead"
          title="Add a key to the selected curve at the playhead"
          onClick={() => {
            const ctx = laneContext(spec, draft, props.activeId);
            const curve = laneOf(spec, draft, props.activeId)?.state.curve;
            if (!ctx || !curve || ctx.axis.kind !== "time") return;
            const r = keyAtPlayhead(ctx, curve, playhead);
            if ("refused" in r) return editor.refused("Add key at playhead", r.refused);
            editor.commit("Add key at playhead", withLane(editor.live(), props.activeId, { curve: r.next.curve }));
            props.onSelect(props.activeId, r.next.index);
          }}
        >
          <Icon d={ADD_AT_PLAYHEAD} />
        </button>
      </div>
      <div class="ce-dope-grid">
        <span class="ce-muted ce-dope-name">{axis.name}</span>
        <div
          class="ce-ruler"
          title="Drag to choose what the curve editor shows · click to move the playhead · double-click to show the whole length"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            ruler.current = { rect, x0: timeAt(e.clientX, rect), px: e.clientX, dragged: false };
          }}
          onPointerMove={(e) => {
            const r = ruler.current;
            if (!r) return;
            if (!r.dragged && Math.abs(e.clientX - r.px) < 4) return;
            r.dragged = true;
            const picked = rulerRange(r.x0, timeAt(e.clientX, r.rect), len);
            if (picked) props.onRange(picked);
          }}
          onPointerUp={(e) => {
            const r = ruler.current;
            ruler.current = null;
            if (r && !r.dragged) props.onPlayhead(playheadAt(timeAt(e.clientX, r.rect), len));
          }}
          onPointerCancel={() => (ruler.current = null)}
          onDblClick={() => props.onRange(null)}
        >
          {range && <div class="ce-range" style={{ left: pc(range[0]), width: pc(range[1] - range[0]) }} />}
          {ticks.map((t, i) => (
            <span key={i} class="ce-tick" style={{ left: pc(t), transform: `translateX(${i === 0 ? "3px" : i === ticks.length - 1 ? "calc(-100% - 3px)" : "-50%"})` }}>
              {t.toFixed(2)}
            </span>
          ))}
          <div class="ce-playhead-flag" style={{ left: pc(playhead) }} />
        </div>
        {rows.map((id) => {
          const found = laneOf(spec, draft, id)!;
          const { lane, state, index: li } = found;
          const color = laneColor(lane, li);
          const on = id === props.activeId;
          const hidden = props.hidden.has(id);
          return [
            <button key={`${id}-n`} type="button" class={`ce-dl${on ? " on" : ""}${hidden ? " off" : ""}`} aria-pressed={on} onClick={() => props.onPick(id)}>
              <span class="ce-swatch" style={{ background: color }} aria-hidden="true" />
              {lane.name}
            </button>,
            <div key={`${id}-r`} class="ce-drow" onPointerDown={(e) => e.target === e.currentTarget && props.onPick(id)}>
              {range && <div class="ce-range-faint" style={{ left: pc(range[0]), width: pc(range[1] - range[0]) }} />}
              <div class="ce-drow-playhead" style={{ left: pc(playhead) }} />
              {!hidden &&
                state.curve.map((k, i) => {
                  const s = props.selected?.lane === id && props.selected.index === i;
                  return (
                    <button
                      key={i}
                      type="button"
                      class={`ce-dia${s ? " on" : ""}`}
                      style={{ left: pc(k[0]), borderColor: color, ...(s ? { background: color } : {}) }}
                      aria-label={`${lane.name} key at ${formatX(axis, k[0])}, ${formatValue(lane, k[1])}`}
                      title={`${lane.name} key at ${formatX(axis, k[0])}, ${formatValue(lane, k[1])}`}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        e.preventDefault();
                        props.onSelect(id, i);
                        const row = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
                        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                        dia.current = { lane: id, index: i, rect: row, moved: false };
                      }}
                      onPointerMove={(e) => {
                        const d = dia.current;
                        if (!d) return;
                        const live = editor.live();
                        const ctx = laneContext(spec, live, d.lane)!;
                        const curve = laneOf(spec, live, d.lane)!.state.curve;
                        const r = setKeyX(ctx, curve, d.index, timeAt(e.clientX, d.rect), { snap: !e.altKey });
                        if ("refused" in r) return; // an end key: stays
                        d.moved = true;
                        editor.preview(withLane(live, d.lane, { curve: r.next }));
                      }}
                      onPointerUp={() => {
                        const d = dia.current;
                        dia.current = null;
                        if (d?.moved) editor.commit("Move key");
                      }}
                      onPointerCancel={() => {
                        dia.current = null;
                        editor.cancel();
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        props.onSelect(id, i);
                        setMenu({ lane: id, index: i, x: e.clientX, y: e.clientY });
                        props.onMenu(true);
                      }}
                    />
                  );
                })}
            </div>,
          ];
        })}
      </div>
      {menu && <ContextMenu label="Key menu" at={{ x: menu.x, y: menu.y }} entries={menuEntries(menu)} onClose={closeMenu} />}
    </section>
  );
}
