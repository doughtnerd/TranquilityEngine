// The output-device menu (ADR 0349 `AudioDeviceMenu`; the prototype's `.dvc` chip and `.dvp` menu), the same on every
// screen: a header chip naming the output and its audio offset (or "Not calibrated"), opening a menu with the output
// list, the buffer and latency, and the audio and visual offsets (−300…300 ms), each with Calibrate…
// (`LatencyCalibrationDialog`). Offsets are kept per device per user. The Studio plays through the system's output
// device: the engine has no public way to pick another yet, so the list shows the outputs the browser names with the
// one playing chosen, and the others say where to switch. The menu and the dialog float at the page's floating root
// (`FloatingPortal`): the header has container queries, which would otherwise trap them inside it.
import { Fragment } from "preact";
import { useRef, useState } from "preact/hooks";
import { FloatingPortal } from "../../editor/ui/FloatingPortal";
import { usePopover } from "../../editor/ui/popover";
import { OFFSET_LIMIT_MS, clampOffset, formatOffset } from "./calibrationModel";
import type { DeviceOffsets } from "./deviceOffsets";
import { LatencyCalibrationDialog } from "./LatencyCalibrationDialog";
import type { ClickTrack } from "./clickTrack";
import { Icon } from "./Icon";
import "./studioComponents.css";

/** An output in the menu's list. */
export interface AudioDeviceChoice {
  readonly id: string;
  readonly name: string;
  /** The Studio plays through it now. */
  readonly current: boolean;
}

export interface AudioDeviceMenuProps {
  /** The output's name ("System output · Speakers (Realtek)"). */
  readonly deviceName: string;
  /** The outputs to list, the one playing marked (default: just this one). */
  readonly devices?: readonly AudioDeviceChoice[];
  readonly offsets: DeviceOffsets;
  /** Offsets were set for this device. */
  readonly calibrated: boolean;
  /** The output changed since the audio offset was set (the engine's `Audio.calibrationStale`). */
  readonly stale?: boolean;
  /** Output latency, ms, when the runtime knows it. */
  readonly latencyMs?: number | null;
  /** The output's processing buffer, ms, and the sample rate it runs at, when known ("256 samples · 5.3 ms"). */
  readonly bufferMs?: number | null;
  readonly sampleRate?: number | null;
  onOffset(kind: keyof DeviceOffsets, ms: number): void;
  /** The calibration dialog's clicks (stories pass a silent one). */
  readonly clicks?: ClickTrack;
}

const KIND_LABEL: Record<keyof DeviceOffsets, string> = { audio: "Audio offset", visual: "Visual offset" };
const KIND_HINT: Record<keyof DeviceOffsets, string> = {
  audio: "How late sound reaches you through this output; the engine subtracts it when judging taps against the beat.",
  visual: "How late the screen shows a beat; playheads and beat lights are drawn this much earlier.",
};
const CALIBRATE_HINT: Record<keyof DeviceOffsets, string> = {
  audio: "Tap along to clicks to measure how late sound reaches you on this device",
  visual: "Tap along to flashing boxes to measure how late the picture reaches you",
};

/** The device's short name for the chip: what follows "System output · " ("Speakers (Realtek)"), cut to fit. */
function shortName(name: string): string {
  const parts = name.split(" · ");
  const short = parts.length > 1 ? parts.slice(1).join(" · ") : name;
  return short.length > 22 ? `${short.slice(0, 21)}…` : short;
}

/** "256 samples · 5.3 ms", or "5.3 ms" without the rate, or "—". */
function bufferText(ms: number | null | undefined, rate: number | null | undefined): string {
  if (!ms || ms <= 0) return "—";
  const time = `${ms.toFixed(1)} ms`;
  return rate && rate > 0 ? `${Math.round((ms / 1000) * rate)} samples · ${time}` : time;
}

export function AudioDeviceMenu(props: AudioDeviceMenuProps) {
  const [open, setOpen] = useState(false);
  const [calibrating, setCalibrating] = useState<keyof DeviceOffsets | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  usePopover(pop, open && calibrating === null, { anchor: button.current, align: "end", inside: [button], focusFirst: true, onDismiss: () => setOpen(false) });
  const warn = !props.calibrated || props.stale;
  const devices = props.devices?.length ? props.devices : [{ id: "current", name: props.deviceName, current: true }];
  const current = devices.find((d) => d.current) ?? devices[0];
  const offsetTip = warn ? (props.stale ? "the output changed: calibrate again" : "not calibrated") : `audio offset ${formatOffset(props.offsets.audio)} · visual offset ${formatOffset(props.offsets.visual)}`;
  const tip = [props.deviceName, props.bufferMs ? `buffer ${bufferText(props.bufferMs, props.sampleRate)}` : null, offsetTip].filter(Boolean).join(" · ");
  return (
    <>
      <button ref={button} class={`studio-device${warn ? " warn" : ""}`} aria-haspopup="dialog" aria-expanded={open} aria-label={`Audio device: ${props.deviceName}, ${offsetTip}`} title={tip} onClick={() => setOpen(!open)}>
        <Icon name="headphones" size={13} class="studio-device-icon" />
        <span class="studio-device-name">{shortName(props.deviceName)}</span>
        {warn ? (
          <span class="studio-device-offset warn">
            <Icon name="warning" size={13} />
            <span class="studio-device-offset-text">{props.stale ? "Calibrate again" : "Not calibrated"}</span>
          </span>
        ) : (
          <span class="studio-device-offset">{formatOffset(props.offsets.audio)}</span>
        )}
        <Icon name="chevronDown" size={10} class="studio-device-chevron" />
      </button>
      {open && calibrating === null && (
        <FloatingPortal>
          <div ref={pop} class="studio-device-menu" role="dialog" aria-label="Audio device">
            <span class="studio-device-caption">Audio device</span>
            <select class="studio-device-select" aria-label="Output device" title="The Studio plays through your system's output: switch it in your system's sound settings." value={current.id}>
              {devices.map((d) => (
                <option key={d.id} value={d.id} disabled={!d.current}>
                  {d.name}
                </option>
              ))}
            </select>
            <div class="studio-device-grid">
              <span class="studio-device-label">Buffer</span>
              <span class="studio-device-value">{bufferText(props.bufferMs, props.sampleRate)}</span>
              {props.latencyMs != null && props.latencyMs > 0 && (
                <>
                  <span class="studio-device-label">Latency</span>
                  <span class="studio-device-value" title="Output latency: buffer, output and limiter">
                    {Math.round(props.latencyMs)} ms
                  </span>
                </>
              )}
              {(Object.keys(KIND_LABEL) as (keyof DeviceOffsets)[]).map((kind) => (
                <Fragment key={kind}>
                  <label class="studio-device-label" for={`studio-offset-${kind}`} title={KIND_HINT[kind]}>
                    {KIND_LABEL[kind]}
                  </label>
                  <span class="studio-device-field">
                    <input
                      id={`studio-offset-${kind}`}
                      class="studio-device-number"
                      type="number"
                      min={-OFFSET_LIMIT_MS}
                      max={OFFSET_LIMIT_MS}
                      step={1}
                      placeholder="—"
                      value={props.calibrated ? props.offsets[kind] : ""}
                      onChange={(e) => {
                        const text = (e.target as HTMLInputElement).value;
                        if (text.trim() !== "") props.onOffset(kind, clampOffset(Number(text)));
                      }}
                    />
                    <span class="studio-device-label">ms</span>
                    <button type="button" class="studio-device-button" title={CALIBRATE_HINT[kind]} onClick={() => setCalibrating(kind)}>
                      Calibrate…
                    </button>
                  </span>
                </Fragment>
              ))}
            </div>
            {props.stale && <p class="studio-device-warn">The output changed since the audio offset was set. Calibrate again for this output.</p>}
          </div>
        </FloatingPortal>
      )}
      {calibrating !== null && (
        <FloatingPortal>
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
        </FloatingPortal>
      )}
    </>
  );
}
