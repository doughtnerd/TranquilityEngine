// The output-device menu (ADR 0335 `AudioDeviceMenu`), the same on every screen: a header button naming the output
// and its audio offset (or "Not calibrated"), opening a popover with the output's latency and the audio and visual
// offsets (−300…300 ms), each with Calibrate… (`LatencyCalibrationDialog`). Offsets are kept per device per user.
// The Studio plays through the system's output device: the engine has no public way to pick another yet, so the
// menu names the device rather than offering a choice.
import { useRef, useState } from "preact/hooks";
import { usePopover } from "../../editor/ui/popover";
import { OFFSET_LIMIT_MS, clampOffset, formatOffset } from "./calibrationModel";
import type { DeviceOffsets } from "./deviceOffsets";
import { LatencyCalibrationDialog } from "./LatencyCalibrationDialog";
import type { ClickTrack } from "./clickTrack";
import "./studioComponents.css";

export interface AudioDeviceMenuProps {
  /** The output's name ("System output · Speakers (Realtek)"). */
  readonly deviceName: string;
  readonly offsets: DeviceOffsets;
  /** Offsets were set for this device. */
  readonly calibrated: boolean;
  /** The output changed since the audio offset was set (the engine's `Audio.calibrationStale`). */
  readonly stale?: boolean;
  /** Output latency, ms, when the runtime knows it. */
  readonly latencyMs?: number | null;
  onOffset(kind: keyof DeviceOffsets, ms: number): void;
  /** The calibration dialog's clicks (stories pass a silent one). */
  readonly clicks?: ClickTrack;
}

const KIND_LABEL: Record<keyof DeviceOffsets, string> = { audio: "Audio offset", visual: "Visual offset" };
const KIND_HINT: Record<keyof DeviceOffsets, string> = {
  audio: "How late sound reaches you through this output; the engine subtracts it when judging taps against the beat.",
  visual: "How late the screen shows a beat; playheads and beat lights are drawn this much earlier.",
};

function Headphones() {
  return (
    <svg class="studio-device-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M2.5 10V8a5.5 5.5 0 0 1 11 0v2" fill="none" stroke="currentColor" stroke-width="1.4" />
      <rect x="1.5" y="9.5" width="3" height="5" rx="1" fill="currentColor" />
      <rect x="11.5" y="9.5" width="3" height="5" rx="1" fill="currentColor" />
    </svg>
  );
}

export function AudioDeviceMenu(props: AudioDeviceMenuProps) {
  const [open, setOpen] = useState(false);
  const [calibrating, setCalibrating] = useState<keyof DeviceOffsets | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  usePopover(pop, open && calibrating === null, { anchor: button.current, align: "end", inside: [button], onDismiss: () => setOpen(false) });
  const warn = !props.calibrated || props.stale;
  const short = props.deviceName.length > 22 ? `${props.deviceName.slice(0, 21)}…` : props.deviceName;
  return (
    <>
      <button
        ref={button}
        class={`studio-device${warn ? " warn" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Output: ${props.deviceName}${warn ? (props.stale ? " · the output changed: calibrate again" : " · not calibrated") : ` · audio offset ${formatOffset(props.offsets.audio)}`}`}
        onClick={() => setOpen(!open)}
      >
        <Headphones />
        <span class="studio-device-name">{short}</span>
        <span class="studio-device-offset">{warn ? (props.stale ? "⚠ Calibrate again" : "⚠ Not calibrated") : formatOffset(props.offsets.audio)}</span>
      </button>
      {open && calibrating === null && (
        <div ref={pop} class="studio-device-menu" role="dialog" aria-label="Output device">
          <div class="studio-device-row">
            <span class="studio-device-label">Output</span>
            <span>{props.deviceName}</span>
          </div>
          <p class="studio-device-note">The Studio plays through the system's output device. Change it in your system's sound settings.</p>
          {props.latencyMs != null && props.latencyMs > 0 && (
            <div class="studio-device-row">
              <span class="studio-device-label">Latency</span>
              <span>{Math.round(props.latencyMs)} ms</span>
            </div>
          )}
          {(Object.keys(KIND_LABEL) as (keyof DeviceOffsets)[]).map((kind) => (
            <div key={kind} class="studio-device-row">
              <label class="studio-device-label" for={`studio-offset-${kind}`} title={KIND_HINT[kind]}>
                {KIND_LABEL[kind]}
              </label>
              <span class="studio-device-field">
                <input id={`studio-offset-${kind}`} type="number" min={-OFFSET_LIMIT_MS} max={OFFSET_LIMIT_MS} step={1} value={props.offsets[kind]} onChange={(e) => props.onOffset(kind, clampOffset(Number((e.target as HTMLInputElement).value)))} />
                <span class="studio-device-unit">ms</span>
                <button onClick={() => setCalibrating(kind)}>Calibrate…</button>
              </span>
            </div>
          ))}
          {props.stale && <p class="studio-device-warn">The output changed since the audio offset was set. Calibrate again for this output.</p>}
        </div>
      )}
      {calibrating !== null && (
        <LatencyCalibrationDialog
          what={KIND_LABEL[calibrating]}
          mode={calibrating === "visual" ? "eye" : "ear"}
          device={props.deviceName}
          clicks={props.clicks}
          onCancel={() => setCalibrating(null)}
          onUse={(ms) => {
            props.onOffset(calibrating, ms);
            setCalibrating(null);
          }}
        />
      )}
    </>
  );
}
