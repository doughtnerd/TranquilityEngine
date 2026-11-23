// The output device for the device menu and status bar, and the outputs the browser lists. The Studio plays through
// the system's output (the engine has no public device choice yet), so this names that device from the browser's
// device list where it gives labels, else "System output", lists the other outputs for the menu (shown, not
// choosable: the system's sound settings switch them), and follows changes.
import { signal, type ReadonlySignal, type Signal } from "@preact/signals";
import { DEFAULT_DEVICE } from "../components/deviceOffsets";

export interface OutputDevice {
  /** The key offsets are kept under. */
  readonly id: string;
  readonly name: string;
}

/** An output in the device menu's list. */
export interface OutputChoice extends OutputDevice {
  /** The Studio plays through it now (the system's output). */
  readonly current: boolean;
}

type MediaDevice = { kind: string; deviceId: string; label: string };

const SYSTEM: OutputDevice = { id: DEFAULT_DEVICE, name: "System output" };

/** The default output as the browser lists it: its label without the "Default - " prefix. */
export function outputName(devices: readonly MediaDevice[]): string {
  const d = devices.find((x) => x.kind === "audiooutput" && x.deviceId === "default") ?? devices.find((x) => x.kind === "audiooutput");
  const label = d?.label.replace(/^Default\s*-\s*/i, "").trim();
  return label ? `System output · ${label}` : SYSTEM.name;
}

/**
 * The menu's list: the system's output first (the one playing), then every other output the browser names (a browser
 * without the permission to name devices lists none). The "default" and "communications" aliases aren't listed twice.
 */
export function outputChoices(devices: readonly MediaDevice[]): OutputChoice[] {
  const outputs = devices.filter((d) => d.kind === "audiooutput");
  const system = outputs.find((d) => d.deviceId === "default");
  const systemLabel = system?.label.replace(/^Default\s*-\s*/i, "").trim() ?? "";
  const others = outputs.filter((d) => d.deviceId !== "default" && d.deviceId !== "communications" && d.label.trim() !== "" && d.label.trim() !== systemLabel);
  return [{ id: DEFAULT_DEVICE, name: outputName(devices), current: true }, ...others.map((d) => ({ id: d.deviceId, name: d.label.trim(), current: false }))];
}

let device: Signal<OutputDevice> | null = null;
let choices: Signal<OutputChoice[]> | null = null;

function follow(): void {
  if (device) return;
  device = signal<OutputDevice>(SYSTEM);
  choices = signal<OutputChoice[]>([{ ...SYSTEM, current: true }]);
  const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!media?.enumerateDevices) return;
  const read = () =>
    void media.enumerateDevices().then(
      (list) => {
        device!.value = { id: DEFAULT_DEVICE, name: outputName(list) };
        choices!.value = outputChoices(list);
      },
      () => {},
    );
  read();
  media.addEventListener?.("devicechange", read);
}

/** The output device, followed while the page lives. */
export function outputDevice(): ReadonlySignal<OutputDevice> {
  follow();
  return device!;
}

/** The outputs the browser lists, the system's (the one playing) first, followed while the page lives. */
export function outputDevices(): ReadonlySignal<readonly OutputChoice[]> {
  follow();
  return choices!;
}
