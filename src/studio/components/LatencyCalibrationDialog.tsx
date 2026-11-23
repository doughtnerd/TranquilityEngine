// Latency calibration (ADR 0349 `LatencyCalibrationDialog`): tap on the beat, by ear (clicks) or by eye (four boxes
// flashing in turn), a beat every 500 ms. Each tap's error is folded into ±250 ms and the last 16 are plotted on a
// ±150 ms strip with their average; "Use +N ms" works from 4 taps (`calibrationModel.ts`). Tap with the button,
// Space or Enter. Start over clears the taps; Cancel (or Escape) leaves the offset as it was.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { SegmentedControl } from "../../editor/ui/SegmentedControl";
import { BEAT_MS, MIN_TAPS, addTap, beatIndex, foldError, formatOffset, summarize } from "./calibrationModel";
import { webAudioClickTrack, type ClickTrack } from "./clickTrack";
import "./studioComponents.css";

export type CalibrationMode = "ear" | "eye";

export interface LatencyCalibrationDialogProps {
  /** Which offset this sets, for the title ("Audio offset", "Visual offset"). */
  readonly what: string;
  readonly mode?: CalibrationMode;
  /** The device it is for, shown under the title. */
  readonly device?: string;
  onUse(offsetMs: number): void;
  onCancel(): void;
  /** The clicks (default: Web Audio on the system output). */
  readonly clicks?: ClickTrack;
}

/** The strip's half-width, ms. */
const STRIP_MS = 150;
const stripX = (ms: number) => `${50 + (Math.max(-STRIP_MS, Math.min(STRIP_MS, ms)) / STRIP_MS) * 50}%`;

export function LatencyCalibrationDialog(props: LatencyCalibrationDialogProps) {
  const [mode, setMode] = useState<CalibrationMode>(props.mode ?? "ear");
  const [taps, setTaps] = useState<number[]>([]);
  const [beat, setBeat] = useState(-1);
  const start = useRef(0);
  const clicks = useMemo(() => props.clicks ?? webAudioClickTrack(), [props.clicks]);
  const tapButton = useRef<HTMLButtonElement>(null);

  // The beat: a fresh start whenever the mode changes; clicks by ear, the boxes follow it either way.
  useEffect(() => {
    start.current = performance.now() + 400;
    setTaps([]);
    if (mode === "ear") clicks.start(start.current, BEAT_MS);
    let frame = 0;
    const loop = () => {
      setBeat(beatIndex(performance.now(), start.current));
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

  return (
    <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div
        class="dialog studio-calibrate"
        role="dialog"
        aria-modal="true"
        aria-labelledby="studio-calibrate-title"
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
        <h2 id="studio-calibrate-title">Calibrate: {props.what}</h2>
        {props.device && <p class="studio-calibrate-device">{props.device}</p>}
        <SegmentedControl label="Calibrate by" value={mode} onChange={setMode} options={[{ value: "ear", label: "By ear" }, { value: "eye", label: "By eye" }]} />
        <p>{mode === "ear" ? "Tap on each click you hear." : "Tap as each box lights."} Keep going until the average settles.</p>
        {mode === "eye" && (
          <div class="studio-calibrate-boxes" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} class={`studio-calibrate-box${beat >= 0 && beat % 4 === i ? " lit" : ""}`} />
            ))}
          </div>
        )}
        <button
          ref={tapButton}
          type="button"
          class="studio-tap primary"
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
          Tap
        </button>
        <div class="studio-calibrate-strip" role="img" aria-label={summary.average === null ? "No taps yet" : `${summary.count} taps, average ${formatOffset(summary.average)}`}>
          <span class="studio-calibrate-zero" style={{ left: "50%" }} aria-hidden="true" />
          {taps.map((t, i) => (
            <span key={i} class="studio-calibrate-tap" style={{ left: stripX(t) }} />
          ))}
          {summary.average !== null && <span class="studio-calibrate-average" style={{ left: stripX(summary.average) }} />}
          <span class="studio-calibrate-scale">−{STRIP_MS} ms</span>
          <span class="studio-calibrate-scale end">+{STRIP_MS} ms</span>
        </div>
        <p class="studio-calibrate-summary" aria-live="polite">
          {summary.count === 0 ? "No taps yet." : `${summary.count} tap${summary.count === 1 ? "" : "s"} · average ${formatOffset(summary.average!)} · spread ±${summary.spread} ms${summary.usable ? "" : ` · ${MIN_TAPS - summary.count} more to use it`}`}
        </p>
        <div class="dialog-buttons">
          {/* Start over disables itself: focus goes back to Tap, so the keys (Space, Escape) stay in the dialog. */}
          <button type="button" disabled={taps.length === 0} onClick={() => (setTaps([]), tapButton.current?.focus())}>
            Start over
          </button>
          <button type="button" onClick={props.onCancel}>Cancel</button>
          <button type="button" class="primary" disabled={!summary.usable} onClick={() => summary.offset !== null && props.onUse(summary.offset)}>
            {summary.offset === null ? "Use" : `Use ${formatOffset(summary.offset)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
