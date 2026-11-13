// One channel strip of the Mixer panel (ADR 0171 change 22, api-and-models §7; task Mp2a): the fader with the effective
// gain beside the authored value, mute, monitor solo, the peak meter with hold and clip latch, momentary and short-term
// LUFS (integrated on metered buses) with the target line, and the gain-reduction meter on ducked buses.
//
// A thin layer: every number comes from a `Strip` (`mixerModel.ts`), the fader's taper and drag arithmetic from
// `faderModel.ts`, the bar's dB scale from `meterFill` (the drawing `BusMeters` uses: the same `audio-meter-track` and
// `audio-meter-fill` elements and the `hot` class). The component holds no state of its own (no hooks), so the panel
// re-renders it from the model and a test can call it as a function. The fader gesture's pointer bookkeeping lives in a
// WeakMap keyed by the model, because a re-render during a drag replaces the handlers. Colours are theme tokens in
// `stripStyle.css`, never literals.
import type { JSX } from "preact";
import type { LoudnessTargetReading } from "../../../../engine/audio/loudnessTypes";
import { FADER_MAX_DB, FINE_DRAG_SCALE, UNITY_POSITION, dragPosition, formatDb, gainToDb, gainToPosition, positionToDb, positionToGain } from "./faderModel";
import { METER_FLOOR_DB, meterFill } from "../meterFill";
import type { MixerModel, Strip } from "./mixerModel";
import "./stripStyle.css";

/** The gain-reduction meter's full scale, in dB of reduction. */
export const GAIN_REDUCTION_MAX_DB = 24;
/** The loudness bar's scale: `METER_FLOOR_DB` (-60) LUFS to 0. */
export const LUFS_FLOOR = METER_FLOOR_DB;

/** What a strip needs of the model: the gestures only. */
export type StripModel = Pick<MixerModel, "beginDrag" | "drag" | "endDrag" | "cancelDrag" | "setVolume" | "toggleMute" | "toggleSolo" | "dragging"> & {
  /** A monitor mute of the bus (never a commit); false when it can't apply (no Play, Compare). Absent: the strip shows no button. */
  toggleMonitorMute?(bus: string): boolean;
};

export interface MixerStripProps {
  readonly strip: Strip;
  readonly model: StripModel;
  /** A gesture changed the model (a drag moved, a button toggled): the panel re-renders the strips. */
  readonly onChange?: () => void;
  /** A click on the peak meter or its lamp: clear this bus's clip latch (`resetClip`). */
  readonly onResetClip?: (bus: string) => void;
  /** The bus is the target of a level-ducking rule, so its gain-reduction meter shows even while not reducing. */
  readonly levelDucked?: boolean;
}

/** A LUFS reading as text: "-inf" for a gated, empty or unmetered reading, else one decimal. */
export function formatLufs(lufs: number): string {
  if (!(lufs > -Infinity)) return "-inf";
  const r = Math.round(lufs * 10) / 10;
  return (r === 0 ? 0 : r).toFixed(1);
}

/** A LUFS value as a 0..1 position on the loudness bar (`LUFS_FLOOR`..0). */
export function lufsFill(lufs: number): number {
  if (!(lufs > LUFS_FLOOR)) return 0;
  return lufs >= 0 ? 1 : (lufs - LUFS_FLOOR) / -LUFS_FLOOR;
}

/** Reduction in dB (>= 0) from a duck gain (1 = not ducked); NaN and over-unity read as none. */
export function gainReductionDb(duckGain: number): number {
  if (!(duckGain < 1)) return 0;
  return Math.min(99, -gainToDb(duckGain)); // a fully ducked bus (gain 0) reads 99, not infinity
}

/** The loudness bar's target marks, 0..1: the line, and the tolerance band around it. */
export function targetMarks(t: LoudnessTargetReading): { line: number; low: number; high: number } {
  return { line: lufsFill(t.integrated), low: lufsFill(t.integrated - t.tolerance), high: lufsFill(t.integrated + t.tolerance) };
}

const pct = (x: number): string => `${Math.round(x * 10000) / 100}%`;
const num = (x: number): number => Math.round(x * 1000) / 1000;

// ---- the fader gesture ----

interface Gesture {
  readonly bus: string;
  /** The travel height in px (the track's rect). */
  readonly height: number;
  readonly pointerId: number | undefined;
  startPos: number;
  y0: number;
  fine: boolean;
  pos: number;
}
const gestures = new WeakMap<object, Gesture>();

type PointerEv = PointerEvent & { currentTarget: HTMLElement };
type KeyEv = KeyboardEvent;

/** A key press moves the fader this much of its travel; a modifier (`fine`) scales it by `FINE_DRAG_SCALE`, as for a drag. */
export const KEY_STEP = 0.02;
/** Page Up and Page Down move the fader this much. */
export const KEY_PAGE_STEP = 0.1;

/**
 * The fader position a key leads to from `pos`, or null for a key the fader doesn't use. Arrows (up and right raise, down and
 * left lower) move `KEY_STEP`, the page keys `KEY_PAGE_STEP`, both scaled when `fine`; Home goes to the bottom (silence), End
 * to the top. Clamped to 0..1 and not snapped to unity: a snap would hold a key from ever leaving 0 dB.
 */
export function keyPosition(pos: number, key: string, fine: boolean): number | null {
  const scale = fine ? FINE_DRAG_SCALE : 1;
  const clamp = (p: number): number => Math.min(1, Math.max(0, p));
  switch (key) {
    case "ArrowUp": case "ArrowRight": return clamp(pos + KEY_STEP * scale);
    case "ArrowDown": case "ArrowLeft": return clamp(pos - KEY_STEP * scale);
    case "PageUp": return clamp(pos + KEY_PAGE_STEP * scale);
    case "PageDown": return clamp(pos - KEY_PAGE_STEP * scale);
    case "Home": return 0;
    case "End": return 1;
    default: return null;
  }
}

/** Pointer handlers for one strip's fader. Exported for tests; the component wires them onto the track. */
export function faderHandlers(props: Pick<MixerStripProps, "strip" | "model" | "onChange">) {
  const { strip, model } = props;
  const changed = (): void => props.onChange?.();
  const end = (commit: boolean, e?: { currentTarget: HTMLElement; pointerId?: number }): void => {
    const g = gestures.get(model);
    gestures.delete(model);
    if (e && g?.pointerId !== undefined) {
      try { e.currentTarget.releasePointerCapture?.(g.pointerId); } catch { /* already released */ }
    }
    if (commit) model.endDrag(); else model.cancelDrag();
    changed();
  };
  return {
    onPointerDown(e: PointerEv): void {
      if (e.button) return; // primary button only (0 or absent)
      if (!model.beginDrag(strip.name)) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const start = gainToPosition(strip.volume);
      gestures.set(model, { bus: strip.name, height: rect.height > 0 ? rect.height : 1, pointerId: e.pointerId, startPos: start, y0: e.clientY, fine: !!e.shiftKey, pos: start });
      try { if (e.pointerId !== undefined) e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
      e.currentTarget.focus?.();
      changed();
    },
    onPointerMove(e: PointerEv): void {
      const g = gestures.get(model);
      if (!g || g.bus !== strip.name) return;
      // A modifier change mid-drag rebases the drag at the current position, so the thumb doesn't jump.
      if (!!e.shiftKey !== g.fine) { g.startPos = g.pos; g.y0 = e.clientY; g.fine = !!e.shiftKey; }
      g.pos = dragPosition(g.startPos, (g.y0 - e.clientY) / g.height, g.fine);
      model.drag(positionToGain(g.pos));
      changed();
    },
    onPointerUp(e: PointerEv): void {
      const g = gestures.get(model);
      if (!g || g.bus !== strip.name) return;
      end(true, e);
    },
    onPointerCancel(e: PointerEv): void {
      const g = gestures.get(model);
      if (!g || g.bus !== strip.name) return;
      end(false, e);
    },
    onKeyDown(e: KeyEv): void {
      const g = gestures.get(model);
      if (e.key === "Escape") {
        if (!g || g.bus !== strip.name) return;
        e.preventDefault?.();
        end(false);
        return;
      }
      // Keyboard control (the ARIA slider pattern): each key press is one committed edit, so one undo step. A pointer drag
      // in progress owns the fader. Shift or Alt makes the step fine, as Shift does for the drag.
      if (g || model.dragging) return;
      const next = keyPosition(gainToPosition(strip.volume), e.key, !!e.shiftKey || !!e.altKey);
      if (next === null) return;
      e.preventDefault?.();
      if (model.setVolume(strip.name, positionToGain(next))) changed();
    },
    onDblClick(): void {
      // Double-click: unity gain, one commit (nothing when the fader already sits there).
      if (model.setVolume(strip.name, 1)) changed();
    },
  };
}

// ---- the view ----

function Meter(props: { strip: Strip; onResetClip?: (bus: string) => void }): JSX.Element {
  const { strip } = props;
  const fill = meterFill(strip.meter.peak);
  const hold = meterFill(strip.meter.hold);
  const clear = (): void => props.onResetClip?.(strip.name);
  return (
    <div class="mixer-peak">
      <button
        type="button"
        class={`mixer-clip${strip.meter.clipLatched ? " latched" : ""}`}
        aria-label={`${strip.name} clip`}
        aria-pressed={strip.meter.clipLatched}
        title={strip.meter.clipLatched ? "Clipped. Click to clear." : "No clip"}
        onClick={clear}
      />
      <div
        class="audio-meter-track mixer-peak-track"
        role="meter"
        aria-label={`${strip.name} level`}
        aria-valuemin={METER_FLOOR_DB}
        aria-valuemax={0}
        aria-valuenow={fill <= 0 ? METER_FLOOR_DB : Math.round(20 * Math.log10(strip.meter.peak) * 10) / 10}
        onClick={clear}
      >
        <div class={`audio-meter-fill${fill >= 1 ? " hot" : ""}`} style={{ transform: `scaleY(${num(fill)})` }} />
        <div class="mixer-peak-hold" style={{ bottom: pct(hold) }} hidden={hold <= 0} />
      </div>
    </div>
  );
}

function GainReduction(props: { strip: Strip }): JSX.Element {
  const db = gainReductionDb(props.strip.duckGain);
  const fill = Math.min(1, db / GAIN_REDUCTION_MAX_DB);
  return (
    <div class="mixer-gr" title="Gain reduction from level ducking">
      <div class="mixer-gr-track" role="meter" aria-label={`${props.strip.name} gain reduction`} aria-valuemin={0} aria-valuemax={GAIN_REDUCTION_MAX_DB} aria-valuenow={Math.round(db * 10) / 10}>
        <div class="mixer-gr-fill" style={{ transform: `scaleY(${num(fill)})` }} />
      </div>
      <span class="mixer-gr-readout">{db > 0 ? `-${db.toFixed(1)}` : "0.0"}</span>
    </div>
  );
}

function Loudness(props: { strip: Strip }): JSX.Element {
  const { strip } = props;
  const l = strip.loudness;
  const t = strip.metered ? l.target : null;
  const marks = t ? targetMarks(t) : null;
  return (
    <div class={`mixer-lufs${strip.metered ? "" : " unmetered"}`} title={strip.metered ? "Loudness (LUFS)" : "Not metered"}>
      <div class="mixer-lufs-row" data-reading="momentary"><span class="mixer-lufs-label">M</span><span class="mixer-lufs-value">{formatLufs(l.momentary)}</span></div>
      <div class="mixer-lufs-row" data-reading="shortTerm"><span class="mixer-lufs-label">S</span><span class="mixer-lufs-value">{formatLufs(l.shortTerm)}</span></div>
      {strip.metered && (
        <div class="mixer-lufs-row" data-reading="integrated"><span class="mixer-lufs-label">I</span><span class="mixer-lufs-value">{formatLufs(l.integrated)}</span></div>
      )}
      {t && marks && (
        <div class={`mixer-target ${t.state}`} role="meter" aria-label={`${strip.name} loudness against target ${t.name}`} aria-valuemin={LUFS_FLOOR} aria-valuemax={0} aria-valuenow={l.shortTerm > -Infinity ? Math.round(l.shortTerm * 10) / 10 : LUFS_FLOOR} title={`${t.name}: ${formatLufs(t.integrated)} LUFS ±${t.tolerance} LU, ${t.state}`}>
          <div class="mixer-target-fill" style={{ transform: `scaleX(${num(lufsFill(l.shortTerm))})` }} />
          <div class="mixer-target-band" style={{ left: pct(marks.low), width: pct(marks.high - marks.low) }} />
          <div class="mixer-target-line" style={{ left: pct(marks.line) }} />
        </div>
      )}
    </div>
  );
}

/** One strip. Stateless: give it the strip the model built and the model's gesture methods. */
export function MixerStrip(props: MixerStripProps): JSX.Element {
  const { strip, model } = props;
  const changed = (): void => props.onChange?.();
  const pos = gainToPosition(strip.shownVolume);
  const db = positionToDb(pos);
  const authored = formatDb(strip.shownVolume);
  const effective = strip.live ? formatDb(strip.effectiveGain) : "-";
  const showGr = !!props.levelDucked || (strip.live && strip.duckGain < 1);
  const h = faderHandlers(props);
  const cls = ["mixer-strip", strip.root ? "root" : "", strip.dragging ? "dragging" : "", strip.mute ? "muted" : "", strip.monitorMute ? "monitor-muted" : "", strip.monitorSolo ? "soloed" : "", strip.live ? "" : "idle"].filter(Boolean).join(" ");
  return (
    <div class={cls} role="group" aria-label={`${strip.name} strip`} data-bus={strip.name} data-depth={strip.depth}>
      <div class="mixer-strip-name" title={strip.name}>{strip.name}</div>
      <div class="mixer-strip-body">
        <div class="mixer-fader-col">
          <div
            class="mixer-fader"
            role="slider"
            tabIndex={0}
            aria-label={`${strip.name} volume`}
            aria-orientation="vertical"
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={num(pos)}
            aria-valuetext={authored}
            onPointerDown={h.onPointerDown}
            onPointerMove={h.onPointerMove}
            onPointerUp={h.onPointerUp}
            onPointerCancel={h.onPointerCancel}
            onKeyDown={h.onKeyDown}
            onDblClick={h.onDblClick}
          >
            <div class="mixer-fader-rail" />
            <div class="mixer-fader-unity" style={{ bottom: pct(UNITY_POSITION) }} title="0 dB" />
            <div class="mixer-fader-thumb" style={{ bottom: pct(pos) }} />
          </div>
        </div>
        <Meter strip={strip} onResetClip={props.onResetClip} />
        {showGr && <GainReduction strip={strip} />}
      </div>
      <div class="mixer-gain" data-db={db > -Infinity ? num(db) : "-inf"} data-max-db={num(FADER_MAX_DB)}>
        <span class="mixer-gain-authored" title="Authored volume">{authored}</span>
        <span class="mixer-gain-effective" title="Effective gain at the speakers (every bus up the tree, ducking and scripts included)">
          <span class="mixer-gain-label">eff</span> {effective}
        </span>
      </div>
      <div class="mixer-buttons">
        <button
          type="button"
          class={`mixer-mute${strip.mute ? " on" : ""}${strip.runtimeMute ? " script" : ""}`}
          aria-pressed={strip.mute}
          aria-label={`Mute ${strip.name}`}
          title={strip.runtimeMute ? "Muted by a script" : "Mute (saved with the project)"}
          onClick={() => { if (model.toggleMute(strip.name)) changed(); }}
        >M</button>
        {model.toggleMonitorMute && (
          <button
            type="button"
            class={`mixer-monitor-mute${strip.monitorMute ? " on" : ""}`}
            aria-pressed={strip.monitorMute}
            aria-label={`Monitor mute ${strip.name}`}
            title="Mute in the monitor only (never saved; marks this bus's meters, its parents' and master's as affected)"
            onClick={() => { if (model.toggleMonitorMute?.(strip.name)) changed(); }}
          >MM</button>
        )}
        <button
          type="button"
          class={`mixer-solo${strip.monitorSolo ? " on" : ""}${strip.solo ? " script" : ""}`}
          aria-pressed={strip.monitorSolo}
          aria-label={`Solo ${strip.name}`}
          title={strip.solo ? "Soloed by a script" : "Solo in the monitor (never saved)"}
          onClick={() => { model.toggleSolo(strip.name, strip.monitorSolo); changed(); }}
        >S</button>
      </div>
      <Loudness strip={strip} />
    </div>
  );
}
