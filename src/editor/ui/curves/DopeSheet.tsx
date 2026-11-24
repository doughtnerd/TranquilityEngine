// The curve editor's dope sheet (ADR 0346, time curves only): a ruler (drag to zoom the plot to a range, click to move
// the playhead, double-click for the whole clip), one row per time-driven lane with its keys as diamonds (drag moves a
// key in time; right-click opens the key menu) and "Add key at playhead". The ruler and rows are the shared grid
// (`DopeSheetGrid.tsx`, which the Animation window's dope sheet draws through too); one key is selected here.
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
  setKeyFree,
  setKeyShape,
  setKeyX,
  shapeOf,
  shapeRefusal,
  SHAPE_LABELS,
  TIME_INPUT,
  withLane,
  type CurveDraft,
  type CurveEditorSpec,
} from "./curveEditorModel";
import { Icon, type DraftEditor } from "./CurvePlot";
import { DopeSheetGrid, type DopeRow } from "./DopeSheetGrid";

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

/** A key's id on the grid: its lane and index. */
const keyId = (lane: string, index: number) => `${index}:${lane}`;
const parseKeyId = (id: string): { lane: string; index: number } | null => {
  const at = id.indexOf(":");
  return at > 0 ? { lane: id.slice(at + 1), index: Number(id.slice(0, at)) } : null;
};

const ADD_AT_PLAYHEAD = "M10 3l7 7-7 7-7-7zM19 15v6M16 18h6";
const WHOLE = "M3 12h18M3 12l4-4M3 12l4 4M21 12l-4-4M21 12l-4 4";

export function DopeSheet(props: DopeSheetProps) {
  const { spec, draft, editor, playhead, range } = props;
  const axis = axisOf(spec, TIME_INPUT);
  const len = axis.max;
  const rows = dopeLanes(spec, draft);
  const [menu, setMenu] = useState<{ lane: string; index: number; x: number; y: number } | null>(null);
  const dia = useRef<{ lane: string; index: number; x0: number; moved: boolean } | null>(null);

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
      <DopeSheetGrid
        length={len}
        axisName={axis.name}
        rows={rows.map((id): DopeRow => {
          const { lane, state, index: li } = laneOf(spec, draft, id)!;
          const hidden = props.hidden.has(id);
          return {
            id,
            label: lane.name,
            color: laneColor(lane, li),
            muted: hidden,
            keys: hidden ? [] : state.curve.map((k, i) => ({ id: keyId(id, i), x: k[0], label: `${lane.name} key at ${formatX(axis, k[0])}, ${formatValue(lane, k[1])}` })),
          };
        })}
        selected={new Set(props.selected ? [keyId(props.selected.lane, props.selected.index)] : [])}
        activeRow={props.activeId}
        playhead={playhead}
        range={range}
        onPlayhead={props.onPlayhead}
        onRange={props.onRange}
        onRow={props.onPick}
        onSelect={(ids) => {
          const k = ids.length ? parseKeyId(ids[ids.length - 1]) : null;
          if (k) props.onSelect(k.lane, k.index);
          else if (props.selected) props.onSelect(props.selected.lane, null);
        }}
        onDrag={(phase, dx, alt, key) => {
          if (phase === "start") {
            const sel = parseKeyId(key);
            const k = sel && laneOf(spec, editor.live(), sel.lane)?.state.curve[sel.index];
            dia.current = sel && k ? { lane: sel.lane, index: sel.index, x0: k[0], moved: false } : null;
            return;
          }
          const d = dia.current;
          if (!d) return;
          if (phase === "cancel") {
            dia.current = null;
            if (d.moved) editor.cancel();
            return;
          }
          if (phase === "end") {
            dia.current = null;
            if (d.moved) editor.commit("Move key");
            return;
          }
          const live = editor.live();
          const ctx = laneContext(spec, live, d.lane)!;
          const curve = laneOf(spec, live, d.lane)!.state.curve;
          const r = setKeyX(ctx, curve, d.index, d.x0 + dx, { snap: !alt });
          if ("refused" in r) return; // an end key: stays
          d.moved = true;
          editor.preview(withLane(live, d.lane, { curve: r.next }));
        }}
        onKeyMenu={(id, at) => {
          const k = parseKeyId(id);
          if (!k) return;
          props.onSelect(k.lane, k.index);
          setMenu({ lane: k.lane, index: k.index, x: at.x, y: at.y });
          props.onMenu(true);
        }}
      />
      {/* Inline: the dialog may sit in a detached window (ADR 0174), whose menus must open there, not in the main page. */}
      {menu && <ContextMenu inline label="Key menu" at={{ x: menu.x, y: menu.y }} entries={menuEntries(menu)} onClose={closeMenu} />}
    </section>
  );
}
