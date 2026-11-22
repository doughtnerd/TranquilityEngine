/**
 * What a WebHID controller driver is (ADR 0335): one per opened device, made by its family's
 * module (`dualSense.ts`, `dualShock4.ts`, `switchPro.ts`, `joyCon.ts`). The adapter (`webHidGamepads.ts`) feeds
 * it the device's input reports; the driver announces the pad through its link once it's ready,
 * reports its controls on the engine's wire indices (`controls.ts`), and encodes output.
 */
import { GAMEPAD_AXES, GAMEPAD_BUTTONS } from "../controls";
import type { DeviceEventSink, GamepadInfo } from "../devices";
import type { TriggerEffect } from "../triggerEffects";
import type { HidDevice } from "./hidTypes";

/** The driver's way back to the adapter and the device snapshot. */
export interface HidPadLink {
  /** The pad's device id in the snapshot. */
  readonly id: number;
  readonly sink: DeviceEventSink;
  /** The pad's place among the adapter's pads (0 first): picks its player lights and default colour. */
  readonly slot: number;
  /** The pad is ready (or, through a wireless adapter, a controller appeared): report it. */
  connected(info: Omit<GamepadInfo, "id">): void;
  /** The controller went away (a wireless adapter whose controller switched off). */
  disconnected(): void;
  /**
   * The device is (or no longer is) in use as part of another pad (a Joy-Con joined to its
   * partner): it announces no pad of its own, but the Gamepad API still skips it.
   */
  joined(on: boolean): void;
}

/** Output a driver sends to its device. */
export interface HidPadOutput {
  rumble(low: number, high: number, durationMs: number): void;
  triggerRumble?(left: number, right: number, durationMs: number): void;
  triggerEffect?(trigger: "left" | "right", effect: TriggerEffect): void;
  setLed?(r: number, g: number, b: number): void;
  setSensors(enabled: boolean): void;
}

export interface HidPadDriver {
  /** Set the device up (calibration, report modes); resolves once the pad is announced. Rejects if the device can't be used. */
  start(): Promise<void>;
  /** One input report: its id and the bytes after it. */
  report(reportId: number, data: DataView): void;
  readonly output: HidPadOutput;
  /** Stop timers and output (the device is closing or gone). */
  stop(): void;
}

export type HidPadFactory = (device: HidDevice, link: HidPadLink) => HidPadDriver;

/** A pad's last reported controls: reports only what changed. */
export class PadState {
  private readonly buttons = new Float32Array(GAMEPAD_BUTTONS.length);
  private readonly axes = new Float32Array(GAMEPAD_AXES.length);
  /** Per touchpad finger: down, x, y. */
  private readonly touches = [
    { down: false, x: 0, y: 0 },
    { down: false, x: 0, y: 0 },
  ];
  private batteryLevel = Number.NaN;
  private charging = false;

  constructor(private readonly link: HidPadLink) {}

  button(index: number, value: number): void {
    if (this.buttons[index] !== value) this.link.sink.gamepadButton(this.link.id, index, (this.buttons[index] = value));
  }

  axis(index: number, value: number): void {
    if (this.axes[index] !== value) this.link.sink.gamepadAxis(this.link.id, index, (this.axes[index] = value));
  }

  /** The d-pad from a hat: 0 up, 1 up-right, … 7 up-left, anything else centred. */
  hat(value: number): void {
    const bits = value >= 0 && value < 8 ? HAT_BITS[value] : 0;
    this.dpad(!!(bits & 1), !!(bits & 4), !!(bits & 8), !!(bits & 2));
  }

  dpad(up: boolean, down: boolean, left: boolean, right: boolean): void {
    this.button(12, up ? 1 : 0);
    this.button(13, down ? 1 : 0);
    this.button(14, left ? 1 : 0);
    this.button(15, right ? 1 : 0);
  }

  sensor(kind: "gyro" | "accel", x: number, y: number, z: number): void {
    this.link.sink.gamepadSensor(this.link.id, kind, x, y, z);
  }

  /** Touchpad finger 0 or 1: down, and where (0..1, top-left 0, 0). A lifted finger's position doesn't matter. */
  touch(finger: 0 | 1, down: boolean, x: number, y: number): void {
    const t = this.touches[finger];
    if (t.down === down && (!down || (t.x === x && t.y === y))) return;
    t.down = down;
    t.x = x;
    t.y = y;
    this.link.sink.gamepadTouch(this.link.id, finger, down, x, y);
  }

  /** Battery level 0..1 (-1 unknown) and whether it's charging. */
  battery(level: number, charging: boolean): void {
    if (level === this.batteryLevel && charging === this.charging) return;
    this.batteryLevel = level;
    this.charging = charging;
    this.link.sink.gamepadBattery(this.link.id, level, charging);
  }
}

/** Hat value → d-pad bits (1 up, 2 right, 4 down, 8 left). */
const HAT_BITS = [1, 3, 2, 6, 4, 12, 8, 9];

/** A stick byte 0..255 (128 centred) as -1..1. */
export function stickByte(v: number): number {
  return v < 128 ? (v - 128) / 128 : (v - 128) / 127;
}

/** The bytes of a report view. */
export function bytesOf(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/** A little-endian signed 16-bit value. */
export function int16(b: ArrayLike<number>, at: number): number {
  const v = (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
  return v & 0x8000 ? v - 0x10000 : v;
}

/**
 * The body of a feature report as `receiveFeatureReport` returned it. Browsers differ on whether
 * the report id comes first: when the view is `fullLength` long (the length with the id) and
 * starts with the id, the id is dropped.
 */
export function featureBody(view: DataView, reportId: number, fullLength: number): Uint8Array {
  const b = bytesOf(view);
  return b.length >= fullLength && b[0] === reportId ? b.subarray(1) : b;
}

/** Whether the device's report descriptor declares output report `reportId`. */
export function hasOutputReport(device: HidDevice, reportId: number): boolean {
  return device.collections.some((c) => c.outputReports?.some((r) => r.reportId === reportId));
}

/**
 * An output report's length after its id, from the device's report descriptor (some platforms
 * reject reports of another length), or `fallback` if the descriptor doesn't say.
 */
export function outputLength(device: HidDevice, reportId: number, fallback: number): number {
  for (const c of device.collections) {
    for (const r of c.outputReports ?? []) {
      if (r.reportId !== reportId || !r.items?.length) continue;
      let bits = 0;
      for (const item of r.items) bits += (item.reportSize ?? 0) * (item.reportCount ?? 0);
      if (bits > 0) return Math.ceil(bits / 8);
    }
  }
  return fallback;
}

/** A timer that runs one thing later; setting it again replaces what was pending. */
export class Later {
  private handle: ReturnType<typeof setTimeout> | null = null;

  set(ms: number, run: () => void): void {
    this.clear();
    if (ms > 0 && Number.isFinite(ms)) {
      this.handle = setTimeout(() => {
        this.handle = null;
        run();
      }, ms);
    }
  }

  clear(): void {
    if (this.handle !== null) clearTimeout(this.handle);
    this.handle = null;
  }
}

/** 0..1 as a byte. */
export function byte01(v: number): number {
  return Math.round(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)) * 255);
}

/** A colour component 0..255 as a byte. */
export function byte255(v: number): number {
  return Math.round(Math.min(255, Math.max(0, Number.isFinite(v) ? v : 0)));
}

/** Send a report, ignoring a failure (the device went away: its disconnect event follows). */
export function send(device: HidDevice, reportId: number, data: Uint8Array<ArrayBuffer>): void {
  void device.sendReport(reportId, data).catch(() => {});
}

/** Default light bar colours by slot (SDL's player colours). */
export const SLOT_COLOURS: readonly (readonly [number, number, number])[] = [
  [0x00, 0x00, 0x40],
  [0x40, 0x00, 0x00],
  [0x00, 0x40, 0x00],
  [0x20, 0x00, 0x20],
  [0x02, 0x01, 0x00],
  [0x00, 0x01, 0x01],
  [0x01, 0x01, 0x01],
];

export const STANDARD_GRAVITY = 9.80665;
export const DEG_TO_RAD = Math.PI / 180;
