// A level meter (ADR 0349 `Meter`): a peak bar with an RMS bar inside it, a peak hold line, a clip light that stays lit
// until clicked, and an optional dB scale, horizontal or vertical, on the fader's scale so it lines up beside one. It
// draws the values it is given (`peakDb`, `rmsDb`, dBFS) and never reads audio; the owner passes readings as they come.
import { useRef, useState } from "preact/hooks";
import { FADER_MIN_DB, dbToPosition } from "./faderModel";
import { EMPTY_HOLD, METER_MARKS, clearClip, meterFill, meterText, meterZone, nextHold, type MeterHold } from "./meterModel";
import "./audioParts.css";

export interface MeterProps {
  /** The latest peak, dBFS (null or −∞ for silence). */
  readonly peakDb: number | null;
  /** The latest RMS, dBFS. */
  readonly rmsDb?: number | null;
  readonly orientation?: "horizontal" | "vertical";
  /** Draw the dB marks beside it. */
  readonly scale?: boolean;
  /** Its accessible name ("SFX meter"). */
  readonly label: string;
  /** The meter is fed by a monitor (solo, Compare): drawn hatched, as 0172's taint rule asks. */
  readonly tainted?: boolean;
  /** Playback is paused: the peak hold line stays where it was instead of falling with the clock. */
  readonly frozen?: boolean;
  /** Milliseconds now, for the hold (default `performance.now()`); stories pass a fixed clock. */
  readonly now?: number;
}

export function Meter(props: MeterProps) {
  const orientation = props.orientation ?? "vertical";
  const hold = useRef<MeterHold>(EMPTY_HOLD);
  const [, redraw] = useState(0);
  const now = props.now ?? (typeof performance !== "undefined" ? performance.now() : 0);
  hold.current = nextHold(hold.current, props.peakDb, props.frozen ? hold.current.heldAt : now);
  const h = hold.current;
  const size = (f: number) => (orientation === "horizontal" ? { width: `${f * 100}%` } : { height: `${f * 100}%` });
  const along = (f: number) => (orientation === "horizontal" ? { left: `${f * 100}%` } : { bottom: `${f * 100}%` });
  const text = meterText(props.peakDb, props.rmsDb);
  return (
    <div class={`studio-meter ${orientation}${props.tainted ? " tainted" : ""}`} role="meter" aria-label={props.label} aria-valuemin={FADER_MIN_DB} aria-valuemax={6} aria-valuenow={props.peakDb != null && props.peakDb > FADER_MIN_DB ? Math.round(props.peakDb * 10) / 10 : FADER_MIN_DB} aria-valuetext={text} title={text}>
      <div class="studio-meter-bar">
        <span class={`studio-meter-peak ${meterZone(props.peakDb)}`} style={size(meterFill(props.peakDb))} />
        {props.rmsDb !== undefined && <span class="studio-meter-rms" style={size(meterFill(props.rmsDb))} />}
        {h.holdDb > FADER_MIN_DB && <span class={`studio-meter-hold ${meterZone(h.holdDb)}`} style={along(meterFill(h.holdDb))} />}
      </div>
      <button
        type="button"
        class={`studio-meter-clip${h.clipped ? " on" : ""}`}
        aria-label={h.clipped ? "Clipped: click to clear" : "No clip"}
        title={h.clipped ? "Clipped (0 dBFS or over): click to clear" : "Lights when the level reaches 0 dBFS"}
        onClick={() => {
          hold.current = clearClip(hold.current);
          redraw((n) => n + 1);
        }}
      />
      {props.scale && (
        <div class="studio-meter-scale" aria-hidden="true">
          {METER_MARKS.map((m) => (
            <span key={m} style={along(dbToPosition(m))}>
              {m === FADER_MIN_DB ? "−∞" : m > 0 ? `+${m}` : m < 0 ? `−${-m}` : "0"}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
