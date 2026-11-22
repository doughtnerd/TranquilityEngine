// The one shared curve editor (ADR 0332): a draggable window with the properties list and values readout on the left,
// the plot with its key fields, tangent toolbar and presets on the right, and a dope sheet under it for time curves.
// Editing is a draft with its own panel history (ADR 0145: Ctrl+Z inside the window undoes the dialog's edits);
// Apply returns the curves in units with each lane's input and bypass, Cancel (or Escape) drops the draft.
import type { Signal } from "@preact/signals";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { CurveKey } from "../../../engine/core/curve";
import { usePanelHistory, type UndoHistory } from "../../activeHistory";
import { EditHistory } from "../../editHistory";
import { persisted } from "../../preferences";
import { ContextMenu, SEPARATOR } from "../ContextMenu";
import {
  applyUserPreset,
  axisOf,
  clearLane,
  createDraft,
  deleteKey,
  draftChanged,
  draftResult,
  inputChoices,
  isShaped,
  keyCountText,
  laneColor,
  laneContext,
  laneOf,
  parseUserPresets,
  presetCurve,
  presetIcon,
  presetsFor,
  readout,
  readoutHeading,
  saveUserPreset,
  setKeyValue,
  setKeyX,
  setLaneInput,
  withLane,
  type CurveDraft,
  type CurveEditorResult,
  type CurveEditorSpec,
  type UserPreset,
} from "./curveEditorModel";
import { CurvePlot, Icon, type DraftEditor, type WaveformFn } from "./CurvePlot";
import { DopeSheet } from "./DopeSheet";
import { ScrubNumber } from "./ScrubNumber";
import "../kit.css";
import "./curveEditor.css";

export interface CurveEditorDialogProps extends CurveEditorSpec {
  /** The window's title; default by kind ("Time curves", "Parameter curves", "Distance curves"). */
  readonly title?: string;
  /** What Apply writes to ("boost_tail"), for the title bar and the footer. */
  readonly target: string;
  /** A line after the target ("HoverBike / Boost · Tail track"). */
  readonly context?: string;
  /** The lane selected when it opens. */
  readonly initialLane?: string;
  /** Where the playhead starts (time). */
  readonly playhead?: number;
  /** Backdrops: the clip's waveform (time), how often the game sends each value (parameter, bins over its range), where listeners are (distance, 0..1). */
  readonly waveform?: WaveformFn;
  readonly histogram?: readonly number[];
  readonly listenerDensity?: (d: number) => number;
  /** A shaded band on a parameter plot ("This zone"). */
  readonly band?: readonly [number, number];
  onApply(result: CurveEditorResult): void;
  onCancel(): void;
}

const DEFAULT_TITLE = { time: "Time curves", parameter: "Parameter curves", distance: "Distance curves" } as const;
const CURVE_ICON = "M3 19C8 19 9 5 14 5S19 12 21 12";
const CLOSE_ICON = "M6 6l12 12M18 6L6 18";
const EYE = "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z";
const EYE_OFF = "M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.8M6.6 6.6A17 17 0 0 0 2 12s4 6 10 6a9.7 9.7 0 0 0 4.4-1";
const POWER = "M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0";
const PLUS = "M12 5v14M5 12h14";

let presetStore: Signal<unknown> | null = null;
/** The user presets preference (`myco.curvePresets`), shared by every curve editor (made on first use). */
function userPresetStore(): Signal<unknown> {
  return (presetStore ??= persisted<unknown>("myco.curvePresets", []));
}

/** The draft and its history: edits, previews (a drag in progress) and undo. */
function useDraftHistory(initial: CurveDraft) {
  const history = useRef(new EditHistory<CurveDraft>(initial));
  const live = useRef(initial);
  const [draft, setDraft] = useState(initial);
  const [version, setVersion] = useState(0);
  const show = (d: CurveDraft) => {
    live.current = d;
    setDraft(d);
  };
  const changed = () => setVersion((v) => v + 1);
  const undoHistory = useMemo<UndoHistory>(
    () => ({
      name: "Curves",
      canUndo: history.current.canUndo,
      canRedo: history.current.canRedo,
      undoLabel: history.current.undoLabel,
      redoLabel: history.current.redoLabel,
      undo: () => {
        const s = history.current.undo();
        if (s) show(s), changed();
      },
      redo: () => {
        const s = history.current.redo();
        if (s) show(s), changed();
      },
    }),
    [version],
  );
  return {
    draft,
    undoHistory,
    live: () => live.current,
    preview: show,
    commit(label: string, next?: CurveDraft) {
      const d = next ?? live.current;
      if (d === history.current.current) return;
      history.current.push(label, d);
      show(d);
      changed();
    },
    cancel: () => show(history.current.current),
  };
}

export function CurveEditorDialog(props: CurveEditorDialogProps) {
  const spec: CurveEditorSpec = props;
  const initial = useMemo(() => createDraft(spec), []);
  const h = useDraftHistory(initial);
  const { draft } = h;
  const root = useRef<HTMLDivElement>(null);
  usePanelHistory(root, h.undoHistory);

  const [active, setActive] = useState(() => (props.initialLane && spec.lanes.some((l) => l.id === props.initialLane) ? props.initialLane : spec.lanes[0]?.id ?? ""));
  const [selection, setSelection] = useState<{ lane: string; index: number; fromDope?: boolean } | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [playhead, setPlayhead] = useState(() => Math.max(0, Math.min(props.length ?? 0, props.playhead ?? (props.length ?? 0) * 0.25)));
  const [range, setRange] = useState<readonly [number, number] | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [notice, setNotice] = useState<string | null>(null);
  const [laneMenu, setLaneMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [dopeMenu, setDopeMenu] = useState(false);
  const win = useRef<{ x: number; y: number } | null>(null);
  const store = userPresetStore();
  const userPresets: UserPreset[] = parseUserPresets(store.value);

  // Focus moves into the window when it opens and back to where it was when it closes.
  useEffect(() => {
    const before = root.current?.ownerDocument.activeElement as HTMLElement | null;
    root.current?.focus();
    return () => before?.focus?.();
  }, []);

  const editor: DraftEditor = {
    live: h.live,
    preview: h.preview,
    commit: (label, next) => {
      setNotice(null);
      h.commit(label, next);
    },
    cancel: h.cancel,
    refused: (label, reason) => setNotice(`Can't ${label.charAt(0).toLowerCase()}${label.slice(1)}: ${reason}.`),
  };

  const found = laneOf(spec, draft, active);
  const ctx = laneContext(spec, draft, active);
  if (!found || !ctx) return null;
  const { lane, state } = found;
  const curve = state.curve;
  const axis = ctx.axis;
  const sel = selection && selection.lane === active && selection.index < curve.length ? selection.index : null;
  const viewRange: readonly [number, number] = axis.kind === "time" && range ? range : [axis.min, axis.max];
  const choices = inputChoices(spec);
  const dirty = draftChanged(draft, initial);
  const title = props.title ?? DEFAULT_TITLE[props.kind];
  const pick = (id: string) => {
    setActive(id);
    setSelection(null);
  };
  const setCurve = (label: string, next: readonly CurveKey[]) => editor.commit(label, withLane(h.live(), active, { curve: next }));

  const cancel = () => props.onCancel();
  const apply = () => props.onApply(draftResult(spec, h.live()));

  const onKeyDown = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (e.key === "Escape") {
      if (laneMenu || dopeMenu) return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else if ((e.key === "Delete" || e.key === "Backspace") && tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") {
      e.stopPropagation(); // not the editor's Delete (it would delete the selected node)
      if (sel === null) return;
      e.preventDefault();
      const r = deleteKey(curve, sel);
      if ("refused" in r) return editor.refused("Delete key", r.refused);
      setCurve("Delete key", r.next);
      setSelection(null);
    }
  };

  const laneMenuEntries = (id: string) => {
    const l = laneOf(spec, draft, id)!;
    const shown = !hidden.has(id);
    return [
      { id: "clear", label: "Clear curve", title: "Back to a flat curve at the plain value", disabled: !isShaped(l.state.curve), run: () => doClear(id) },
      SEPARATOR,
      { id: "bypass", label: l.state.bypass ? "Turn on" : "Turn off (bypass)", run: () => toggleBypass(id) },
      { id: "hide", label: shown ? "Hide" : "Show", run: () => toggleHidden(id) },
    ];
  };
  const doClear = (id: string) => {
    const r = clearLane(spec, h.live(), id);
    if ("refused" in r) return editor.refused("Clear curve", r.refused);
    editor.commit(`Clear ${laneOf(spec, draft, id)!.lane.name}`, r.next);
    setSelection(null);
  };
  const toggleBypass = (id: string) => {
    const s = laneOf(spec, h.live(), id)!;
    editor.commit(`${s.state.bypass ? "Turn on" : "Turn off"} ${s.lane.name}`, withLane(h.live(), id, { bypass: !s.state.bypass }));
  };
  const toggleHidden = (id: string) =>
    setHidden((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selKey = sel !== null ? curve[sel] : null;
  const selEnd = sel !== null && (sel === 0 || sel === curve.length - 1);
  const status = notice ?? (dirty ? `Unsaved changes. Apply writes them to ${props.target}.` : "No changes yet");
  const note =
    axis.kind === "time"
      ? `X is ${axis.name.toLowerCase()}. Apply writes every curve listed here to ${props.target}.`
      : axis.kind === "parameter"
        ? `X is ${axis.name}, not time.${props.histogram?.length ? " Bars show how often the game sends each value, so tune where the bars are tall first." : ""}`
        : "Inside Min the sound plays at full volume. Dragging Min or Max stretches every curve with it. Beyond Max the last value holds.";

  return (
    <div class="ce-backdrop" onPointerDown={(e) => e.target === e.currentTarget && e.preventDefault()}>
      <div
        ref={root}
        class="dialog ce-window"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ce-title"
        tabIndex={-1}
        style={{ left: `${offset.x}px`, top: `${offset.y}px` }}
        data-kind={props.kind}
        onKeyDown={onKeyDown}
      >
        <div
          class="ce-titlebar"
          title="Drag to move this window"
          onPointerDown={(e) => {
            if (e.button !== 0 || (e.target as Element).closest("button")) return;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            win.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
          }}
          onPointerMove={(e) => win.current && setOffset({ x: e.clientX - win.current.x, y: e.clientY - win.current.y })}
          onPointerUp={() => (win.current = null)}
          onPointerCancel={() => (win.current = null)}
        >
          <Icon d={CURVE_ICON} size={16} />
          <span id="ce-title" class="ce-title">
            {title} <span class="ce-faint" aria-hidden="true">·</span> <span class="ce-target">{props.target}</span>
          </span>
          {props.context && <span class="ce-context">{props.context}</span>}
          <span class="ce-spacer" />
          <button type="button" class="ce-x" aria-label="Close without applying" title="Close without applying (Esc)" onClick={cancel}>
            <Icon d={CLOSE_ICON} />
          </button>
        </div>

        <div class="ce-main">
          <aside class="ce-side">
            <div class="ce-ph" title={note}>
              <span class="ce-cap">Properties</span>
            </div>
            <ul class="ce-props" aria-label="Properties">
              {spec.lanes.map((l, i) => {
                const s = draft.lanes.find((q) => q.id === l.id)!;
                const on = l.id === active;
                const shown = !hidden.has(l.id);
                const driven = axisOf(spec, s.input);
                const driver = driven.kind === "parameter" && choices.length > 1 ? driven.name : null;
                return (
                  <li
                    key={l.id}
                    class={`ce-prow${on ? " on" : ""}${shown ? "" : " off"}${s.bypass ? " byp" : ""}`}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setLaneMenu({ id: l.id, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <button type="button" class="ce-pn" aria-pressed={on} onClick={() => pick(l.id)}>
                      <span class="ce-swatch" style={{ background: laneColor(l, i) }} aria-hidden="true" />
                      <span class="ce-pnt">
                        <span class="ce-pnn">{l.name}</span>
                        <span class="ce-kc">
                          {keyCountText(s.curve)}
                          {driver && ` · by ${driver}`}
                        </span>
                      </span>
                    </button>
                    {isShaped(s.curve) && (
                      <button type="button" class="ce-eye ce-clr" aria-label={`Clear ${l.name}`} title="Clear: back to a flat curve at the plain value" onClick={() => doClear(l.id)}>
                        <Icon d={CLOSE_ICON} size={12} />
                      </button>
                    )}
                    <button type="button" class={`ce-eye ce-pwr${s.bypass ? " is-off" : ""}`} aria-pressed={!s.bypass} aria-label={s.bypass ? `Turn on ${l.name}` : `Turn off (bypass) ${l.name}`} title={s.bypass ? `Turn on ${l.name}` : `Turn off (bypass) ${l.name}: keeps the keys, uses the plain value`} onClick={() => toggleBypass(l.id)}>
                      <Icon d={POWER} />
                    </button>
                    <button type="button" class="ce-eye" aria-pressed={shown} aria-label={`${shown ? "Hide" : "Show"} ${l.name} behind the active curve`} title={`${shown ? "Hide" : "Show"} ${l.name} behind the active curve`} onClick={() => toggleHidden(l.id)}>
                      <Icon d={shown ? EYE : EYE_OFF} />
                    </button>
                  </li>
                );
              })}
            </ul>
            <div class="ce-ph ce-ph-top">
              <span class="ce-cap">Values</span>
            </div>
            <div class="ce-readhead">{readoutHeading(axis, playhead)}</div>
            <dl class="ce-readout">
              {readout(spec, draft, playhead).map((r) => [
                <dt key={`${r.id}-n`}>{r.name}</dt>,
                <dd key={`${r.id}-v`}>{r.text}</dd>,
              ])}
            </dl>
          </aside>

          <div class="ce-editor">
            <div class="ce-ph">
              <span class="ce-cap">Curve editor</span>
            </div>
            <div class="ce-bar" role="toolbar" aria-label="Curve tools">
              {choices.length > 1 && (
                <label class="ce-drv">
                  <span class="ce-muted">Driven by</span>
                  <select
                    class="ce-sel"
                    value={state.input}
                    title="What X is for this curve: time, or a game parameter (the curve then maps that parameter to the value)"
                    onChange={(e) => {
                      const r = setLaneInput(spec, h.live(), active, (e.currentTarget as HTMLSelectElement).value);
                      if ("refused" in r) return editor.refused("Change what drives the curve", r.refused);
                      editor.commit(`Drive ${lane.name} by ${axisOf(spec, (e.currentTarget as HTMLSelectElement).value).name}`, r.next);
                      setSelection(null);
                      setRange(null);
                    }}
                  >
                    {choices.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <span class="ce-vsep" aria-hidden="true" />
                </label>
              )}
              <ScrubNumber
                label="Key at"
                ariaLabel={`Key position in ${axis.unit || axis.name}`}
                value={selKey ? selKey[0] : null}
                step={axis.snap}
                unit={axis.unit}
                disabled={!selKey || selEnd}
                title={selEnd ? "End keys stay at the ends" : selKey ? "Drag to move the key (Shift faster, Alt finer)" : "Select a key to edit where it sits"}
                onPreview={(x) => {
                  const r = setKeyX(ctx, laneOf(spec, h.live(), active)!.state.curve, sel!, x);
                  if ("next" in r) editor.preview(withLane(h.live(), active, { curve: r.next }));
                }}
                onCommit={(x) => {
                  const r = setKeyX(ctx, laneOf(spec, h.live(), active)!.state.curve, sel!, x);
                  if ("refused" in r) return editor.refused("Move key", r.refused);
                  setCurve("Move key", r.next);
                }}
                onCancel={editor.cancel}
              />
              <ScrubNumber
                label="→"
                ariaLabel={`Key value in ${lane.unit || lane.name}`}
                value={selKey ? selKey[1] : null}
                step={lane.step}
                unit={lane.unit}
                disabled={!selKey}
                title={selKey ? `Drag to change the value (Shift faster, Alt finer)` : "Select a key to type its value"}
                onPreview={(v) => {
                  const r = setKeyValue(ctx, laneOf(spec, h.live(), active)!.state.curve, sel!, v);
                  if ("next" in r) editor.preview(withLane(h.live(), active, { curve: r.next }));
                }}
                onCommit={(v) => {
                  const r = setKeyValue(ctx, laneOf(spec, h.live(), active)!.state.curve, sel!, v);
                  if ("refused" in r) return editor.refused("Set key value", r.refused);
                  setCurve("Set key value", r.next);
                }}
                onCancel={editor.cancel}
              />
              <span class="ce-spacer" />
              <span class="ce-muted ce-xname">{axis.kind === "time" ? axis.name : axis.kind === "distance" ? "Metres from the listener" : axis.name}</span>
            </div>

            <CurvePlot
              spec={spec}
              draft={draft}
              ctx={ctx}
              activeIndex={found.index}
              hidden={hidden}
              range={viewRange}
              selected={sel}
              selectedFromDope={!!selection?.fromDope}
              playhead={playhead}
              waveform={props.waveform}
              histogram={props.histogram}
              listenerDensity={props.listenerDensity}
              band={props.band}
              editor={editor}
              onSelect={(i) => setSelection(i === null ? null : { lane: active, index: i })}
            />

            <div class="ce-presets" role="group" aria-label="Curve presets">
              <span class="ce-cap">Presets</span>
              {presetsFor(ctx).map((p) => (
                <button key={p.id} type="button" class="ce-pt" aria-label={p.name} title={`${p.name}: ${p.tip}`} onClick={() => setCurve(`Preset: ${p.name}`, presetCurve(ctx, h.live(), laneOf(spec, h.live(), active)!.state.curve, p.id))}>
                  <svg width="40" height="24" viewBox="0 0 40 24" aria-hidden="true">
                    <path d={p.icon} />
                  </svg>
                </button>
              ))}
              {userPresets.map((p, i) => (
                <span key={`${p.name}-${i}`} class="ce-up">
                  <button
                    type="button"
                    class="ce-pt"
                    aria-label={p.name}
                    title={`${p.name} (right-click to remove)`}
                    onClick={() => setCurve(`Preset: ${p.name}`, applyUserPreset(ctx, h.live(), p))}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      store.value = userPresets.filter((_, j) => j !== i);
                    }}
                  >
                    <svg width="40" height="24" viewBox="0 0 40 24" aria-hidden="true">
                      <path d={presetIcon(p)} />
                    </svg>
                  </button>
                  <button type="button" class="ce-upx" aria-label={`Remove ${p.name}`} title={`Remove ${p.name}`} onClick={() => (store.value = userPresets.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </span>
              ))}
              <button
                type="button"
                class="ce-ib"
                aria-label="Save as preset"
                title="Save this curve as a preset (every curve editor shows it)"
                onClick={() => {
                  const r = saveUserPreset(ctx, h.live(), curve, userPresets);
                  if ("refused" in r) return editor.refused("Save preset", r.refused);
                  store.value = r.next;
                }}
              >
                <Icon d={PLUS} />
              </button>
            </div>

            {props.kind === "time" && (
              <DopeSheet
                spec={spec}
                draft={draft}
                activeId={active}
                hidden={hidden}
                selected={selection}
                playhead={playhead}
                range={range}
                editor={editor}
                onPick={pick}
                onSelect={(laneId, i) => {
                  setActive(laneId);
                  setSelection(i === null ? null : { lane: laneId, index: i, fromDope: true });
                }}
                onPlayhead={setPlayhead}
                onRange={setRange}
                onMenu={setDopeMenu}
              />
            )}
          </div>
        </div>

        <div class="ce-footer">
          <span class={`ce-status${notice ? " notice" : dirty ? " dirty" : ""}`} role="status">
            {status}
          </span>
          <span class="ce-spacer" />
          <button type="button" onClick={cancel}>
            Cancel
          </button>
          <button type="button" class="primary" onClick={apply}>
            Apply
          </button>
        </div>
        {laneMenu && <ContextMenu label="Curve menu" at={{ x: laneMenu.x, y: laneMenu.y }} entries={laneMenuEntries(laneMenu.id)} onClose={() => setLaneMenu(null)} />}
      </div>
    </div>
  );
}

