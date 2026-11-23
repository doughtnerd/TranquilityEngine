// A fader (ADR 0349 `Fader`, ADR 0344): a level in dB from −60 (silence, "−∞") to +6, horizontal (the mixer's list) or
// vertical (its strips), drawn as the owner's prototype Mixer draws it: a thin track, a dashed 0 dB tick, a slim thumb,
// and the meter (its children) in a thin lane of its own under the track or beside it — not a filled bar. Drag anywhere on the track (the pointer is captured, so the drag keeps going outside it);
// double-click returns to 0 dB; the keys a slider has (arrows 0.5 dB, Shift or Page 3 dB, Home, End, 0 for unity). A
// ghost tick shows a second level: fader plus VCA, or the base level while a snapshot is edited; `ghosts` draws both at
// once (each kind in its own colour).
//
// Values are reported as `onValue(db, drag)` (ADR 0282's rule): `drag` true while the pointer moves, then the last
// value again with false on release; keys and double-clicks report once with false. The owner makes the drag one undo step.
import { useRef } from "preact/hooks";
import type { ValueReport } from "../../editor/ui/valueControls";
import { FADER_MAX_DB, FADER_MIN_DB, FADER_UNITY_DB, dbToPosition, faderGhosts, faderKey, formatDb, pointerToDb, type FaderGhost } from "./faderModel";
import "./audioParts.css";

export interface FaderProps {
  /** The level, dB. */
  readonly value: number;
  readonly orientation?: "horizontal" | "vertical";
  /** Its accessible name ("SFX level"). */
  readonly label: string;
  /** A second level drawn as a tick (VCA, base level). */
  readonly ghostDb?: number | null;
  /** What the ghost tick is ("With VCAs: −6.0 dB"). */
  readonly ghostTitle?: string;
  /** More ticks, by kind (the VCA tick and the base-level tick together in snapshot mode); added after `ghostDb`. */
  readonly ghosts?: readonly FaderGhost[];
  readonly disabled?: boolean;
  /** Why it can't be moved (automated), as its tooltip. */
  readonly title?: string;
  /** The owner's selected item (a selected bus): the thumb takes the accent border, as in the prototype's Mixer. */
  readonly selected?: boolean;
  /** A level drawn in a thin lane under the track (horizontal) or beside it (vertical): a `Meter`. */
  readonly children?: preact.ComponentChildren;
  onValue: ValueReport<number>;
}

export function Fader(props: FaderProps) {
  const { value, onValue, disabled } = props;
  const orientation = props.orientation ?? "horizontal";
  const drag = useRef<{ last: number } | null>(null);
  const pos = dbToPosition(value);
  const at = (e: PointerEvent) => pointerToDb((e.currentTarget as HTMLElement).getBoundingClientRect(), e.clientX, e.clientY, orientation);
  const along = (p: number) => (orientation === "horizontal" ? { left: `${p * 100}%` } : { bottom: `${p * 100}%` });
  return (
    <div
      class={`studio-fader ${orientation}${props.children ? " has-meter" : ""}${props.selected ? " selected" : ""}${disabled ? " disabled" : ""}`}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={props.label}
      aria-orientation={orientation}
      aria-valuemin={FADER_MIN_DB}
      aria-valuemax={FADER_MAX_DB}
      aria-valuenow={value}
      aria-valuetext={`${formatDb(value)} dB`}
      aria-disabled={disabled || undefined}
      title={props.title ?? `${formatDb(value)} dB · double-click for 0 dB`}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        (e.currentTarget as HTMLElement).focus({ preventScroll: true });
        const db = at(e);
        drag.current = { last: db };
        onValue(db, true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const db = at(e);
        if (db === d.last) return;
        d.last = db;
        onValue(db, true);
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d) onValue(d.last, false);
      }}
      onPointerCancel={() => {
        const d = drag.current;
        drag.current = null;
        if (d) onValue(d.last, false);
      }}
      onDblClick={() => !disabled && onValue(FADER_UNITY_DB, false)}
      onKeyDown={(e) => {
        if (disabled) return;
        const next = faderKey(value, e.key, e.shiftKey);
        if (next === null) return;
        e.preventDefault();
        if (next !== value) onValue(next, false);
      }}
    >
      {props.children && <div class="studio-fader-meter">{props.children}</div>}
      <span class="studio-fader-track" aria-hidden="true" />
      <span class="studio-fader-unity" style={along(dbToPosition(0))} aria-hidden="true" />
      {faderGhosts(props.ghostDb, props.ghostTitle, props.ghosts).map((g) => (
        <span key={g.kind} class={`studio-fader-ghost ${g.kind}`} style={along(dbToPosition(g.db))} title={g.title} aria-hidden="true" />
      ))}
      <span class="studio-fader-thumb" style={along(pos)} aria-hidden="true" />
    </div>
  );
}
