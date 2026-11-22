// The output device's name for the device menu and status bar. The Studio plays through the system's output (the
// engine has no public device choice yet), so this names that device from the browser's device list where it
// gives labels, else "System output", and follows changes.
import { signal, type ReadonlySignal, type Signal } from "@preact/signals";
import { DEFAULT_DEVICE } from "../components/deviceOffsets";

export interface OutputDevice {
  /** The key offsets are kept under. */
  readonly id: string;
  readonly name: string;
}

const SYSTEM: OutputDevice = { id: DEFAULT_DEVICE, name: "System output" };

/** The default output as the browser lists it: its label without the "Default - " prefix. */
export function outputName(devices: readonly { kind: string; deviceId: string; label: string }[]): string {
  const d = devices.find((x) => x.kind === "audiooutput" && x.deviceId === "default") ?? devices.find((x) => x.kind === "audiooutput");
  const label = d?.label.replace(/^Default\s*-\s*/i, "").trim();
  return label ? `System output · ${label}` : SYSTEM.name;
}

let device: Signal<OutputDevice> | null = null;

/** The output device, followed while the page lives. */
export function outputDevice(): ReadonlySignal<OutputDevice> {
  if (device) return device;
  const s = (device = signal<OutputDevice>(SYSTEM));
  const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!media?.enumerateDevices) return s;
  const read = () => void media.enumerateDevices().then((list) => (s.value = { id: DEFAULT_DEVICE, name: outputName(list) }), () => {});
  read();
  media.addEventListener?.("devicechange", read);
  return s;
}
