// Latency calibration (ADR 0349 `LatencyCalibrationDialog`; the prototype's `.dvd` dialog): tap on the beat, by ear
// (clicks) or by eye, a beat every 500 ms, with four beat lights showing the beat either way. Each tap's error is folded
// into ±250 ms and the last 16 are plotted as dots on a ±150 ms strip with their average; the large readout gives the
// offset, and "Use −142 ms" works from 4 taps (`calibrationModel.ts`). Tap with the big button, Space or Enter. Start
// over clears the taps; Cancel, × or Escape leaves the offset as it was. Its owner draws it at the page's floating root.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { BEAT_MS, MIN_TAPS, addTap, beatIndex, foldError, formatOffset, summarize } from "./calibrationModel";
import { webAudioClickTrack, type ClickTrack } from "./clickTrack";
import { Icon } from "./Icon";
import "./studioComponents.css";

export type CalibrationMode = "ear" | "eye";

export interface LatencyCalibrationDialogProps {
  /** Which offset this sets, for the title ("Audio offset", "Visual offset"). */
  readonly what: string;
  readonly mode?: CalibrationMode;
  /** The device it is for (the dialog's description). */
  readonly device?: string;
  onUse(offsetMs: number): void;
  onCancel(): void;
  /** The clicks (default: Web Audio on the system output). */
  readonly clicks?: ClickTrack;
}

/** The strip's half-width, ms. */
const STRIP_MS = 150;
/** The share of each beat its light stays lit. */
const LIT_SHARE = 0.35;
const stripX = (ms: number) => `${50 + (Math.max(-STRIP_MS, Math.min(STRIP_MS, ms)) / STRIP_MS) * 50}%`;
const MODES: { value: CalibrationMode; label: string }[] = [
  { value: "ear", label: "By ear" },
  { value: "eye", label: "By eye" },
];

export function LatencyCalibrationDialog(props: LatencyCalibrationDialogProps) {
  const [mode, setMode] = useState<CalibrationMode>(props.mode ?? "ear");
  const [taps, setTaps] = useState<number[]>([]);
  /** The beat light lit now (0–3), or -1 between beats. */
  const [lit, setLit] = useState(-1);
  const start = useRef(0);
  const clicks = useMemo(() => props.clicks ?? webAudioClickTrack(), [props.clicks]);
  const tapButton = useRef<HTMLButtonElement>(null);

  // The beat: a fresh start whenever the mode changes; clicks by ear, the lights follow it either way.
  useEffect(() => {
    start.current = performance.now() + 400;
    setTaps([]);
    if (mode === "ear") clicks.start(start.current, BEAT_MS);
    let frame = 0;
    const loop = () => {
      const now = performance.now();
      const beat = beatIndex(now, start.current);
      const phase = (now - start.current - beat * BEAT_MS) / BEAT_MS;
      setLit(beat >= 0 && phase < LIT_SHARE ? beat % 4 : -1);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    tapButton.current?.focus();
    return () => {
      cancelAnimationFrame(frame);
      clicks.stop();
    };
  }, [mode, clicks]);

  const tap = (timeStamp: number) => {
    if (timeStamp < start.current - BEAT_MS / 2) return; // before the first beat
    setTaps((t) => addTap(t, foldError(timeStamp, start.current)));
  };
  const summary = summarize(taps);
  const title = `Calibrate ${props.what.toLowerCase()}`;

  return (
    <>
      <div class="studio-calibrate-backdrop" onPointerDown={props.onCancel} />
      <div
        class="studio-calibrate"
        role="dialog"
        aria-modal="true"
        aria-labelledby="studio-calibrate-title"
        aria-describedby={props.device ? "studio-calibrate-device" : undefined}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            props.onCancel();
          } else if ((e.key === " " || e.key === "Enter") && !e.repeat && !(e.target as HTMLElement).closest?.("button:not(.studio-tap), [role=radio]")) {
            e.preventDefault();
            tap(e.timeStamp);
          }
        }}
      >
        <div class="studio-calibrate-head">
          <h2 id="studio-calibrate-title" class="studio-calibrate-title">
            {title}
          </h2>
          <button type="button" class="studio-calibrate-close" aria-label="Close" title="Close (Esc)" onClick={props.onCancel}>
            <Icon name="close" size={12} />
          </button>
        </div>
        {props.device && (
          <p id="studio-calibrate-device" class="studio-calibrate-device">
            {props.device}
          </p>
        )}
        <div class="studio-calibrate-modes" role="radiogroup" aria-label="Calibrate by">
          {MODES.map((m) => (
            <button key={m.value} type="button" role="radio" aria-checked={mode === m.value} class={mode === m.value ? "on" : undefined} onClick={() => setMode(m.value)}>
              {m.label}
            </button>
          ))}
        </div>
        <p class="studio-calibrate-instruction">{mode === "ear" ? "Tap when you hear each click, on the device you play with." : "Tap when each box lights."}</p>
        <div class="studio-calibrate-lights" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} class={`studio-calibrate-light${lit === i ? " lit" : ""}`} />
          ))}
        </div>
        <button
          ref={tapButton}
          type="button"
          class="studio-tap"
          title="Tap on the beat (Space or Enter)"
          onPointerDown={(e) => {
            e.preventDefault();
            tap(e.timeStamp);
          }}
          onKeyDown={(e) => {
            if ((e.key === " " || e.key === "Enter") && !e.repeat) {
              e.preventDefault();
              e.stopPropagation();
              tap(e.timeStamp);
            }
          }}
        >
          Tap on the beat
        </button>
        <div class="studio-calibrate-scale" aria-hidden="true">
          <span>{STRIP_MS} ms early</span>
          <span>on the beat</span>
          <span>{STRIP_MS} ms late</span>
        </div>
        <div class="studio-calibrate-strip" role="img" aria-label={summary.average === null ? "No taps yet" : `${summary.count} taps, average ${formatOffset(summary.average)}`}>
          <span class="studio-calibrate-zero" aria-hidden="true" />
          {taps.map((t, i) => (
            <span key={i} class="studio-calibrate-dot" style={{ left: stripX(t) }} />
          ))}
          {summary.average !== null && <span class="studio-calibrate-average" style={{ left: stripX(summary.average) }} />}
        </div>
        <div class="studio-calibrate-readout" aria-live="polite">
          <span class="studio-calibrate-readout-label">Offset</span>
          <span class="studio-calibrate-readout-value">{summary.average === null ? "—" : formatOffset(summary.average)}</span>
          <span class="studio-calibrate-readout-taps">
            {summary.count} tap{summary.count === 1 ? "" : "s"}
            {summary.spread !== null && summary.count > 1 ? ` · spread ±${summary.spread} ms` : ""}
          </span>
        </div>
        <div class="studio-calibrate-buttons">
          {/* Start over disables itself: focus goes back to Tap, so the keys (Space, Escape) stay in the dialog. */}
          <button type="button" disabled={taps.length === 0} onClick={() => (setTaps([]), tapButton.current?.focus())}>
            Start over
          </button>
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" class="primary" disabled={!summary.usable} title={summary.usable ? undefined : `Tap at least ${MIN_TAPS} times`} onClick={() => summary.offset !== null && props.onUse(summary.offset)}>
            {summary.offset === null ? `Use (${MIN_TAPS}+ taps)` : `Use ${formatOffset(summary.offset)}`}
          </button>
        </div>
      </div>
    </>
  );
}
