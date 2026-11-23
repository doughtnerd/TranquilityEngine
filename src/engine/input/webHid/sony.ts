/**
 * What the DualSense and DualShock 4 drivers share: their button bytes, touchpad points, motion
 * calibration (feature report 0x05 / 0x02) and Bluetooth report checksums. Ported from SDL's HIDAPI drivers
 * (`SDL_hidapi_ps4.c`, `SDL_hidapi_ps5.c`, zlib licence, copyright (C) 1997-2025 Sam Lantinga);
 * altered: rewritten in TypeScript for WebHID.
 */
import { crc32 } from "./crc32";
import { DEG_TO_RAD, PadState, STANDARD_GRAVITY, int16, stickByte } from "./driver";

/** Per axis (x, y, z): value = (raw - bias) * scale, in rad/s (gyro) and m/s² (accelerometer). */
export interface ImuCalibration {
  readonly gyroBias: readonly number[];
  readonly gyroScale: readonly number[];
  readonly accelBias: readonly number[];
  readonly accelScale: readonly number[];
}

/** Sony's nominal resolutions: 1024 gyro steps per degree/s after a ×64 gain (so 16 per degree/s), 8192 accelerometer steps per g. */
const GYRO_STEPS_PER_DEG = 16;
const ACCEL_STEPS_PER_G = 8192;

export const NOMINAL_IMU: ImuCalibration = {
  gyroBias: [0, 0, 0],
  gyroScale: [0, 1, 2].map(() => DEG_TO_RAD / GYRO_STEPS_PER_DEG),
  accelBias: [0, 0, 0],
  accelScale: [0, 1, 2].map(() => STANDARD_GRAVITY / ACCEL_STEPS_PER_G),
};

/**
 * How a calibration report lays out the gyro's plus and minus readings: `interleaved` (pitch+,
 * pitch-, yaw+, yaw-, roll+, roll-: DualSense, DualShock 4 over USB) or `grouped` (pitch+, yaw+,
 * roll+, pitch-, yaw-, roll-: DualShock 4 over Bluetooth and through its wireless adapter).
 */
export type GyroLayout = "interleaved" | "grouped";

/**
 * The factory motion calibration from a calibration feature report's body (after its id), or the
 * nominal scales if it's missing, short, or implausible (some controllers ship bad data).
 */
export function sonyImuCalibration(b: Uint8Array | null, layout: GyroLayout): ImuCalibration {
  if (!b || b.length < 34) return NOMINAL_IMU;
  const bias = [int16(b, 0), int16(b, 2), int16(b, 4)];
  const plus: number[] = [];
  const minus: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    if (layout === "interleaved") {
      plus.push(int16(b, 6 + axis * 4));
      minus.push(int16(b, 8 + axis * 4));
    } else {
      plus.push(int16(b, 6 + axis * 2));
      minus.push(int16(b, 12 + axis * 2));
    }
  }
  const speed = int16(b, 18) + int16(b, 20);
  const gyroScale: number[] = [];
  const accelBias: number[] = [];
  const accelScale: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const span = Math.abs(plus[axis] - bias[axis]) + Math.abs(minus[axis] - bias[axis]);
    if (span === 0) return NOMINAL_IMU;
    // Degrees per second per step, then checked against the nominal 1/16.
    const degPerStep = speed / span;
    if (Math.abs(bias[axis]) > 1024 || Math.abs(1 - degPerStep * GYRO_STEPS_PER_DEG) > 0.5) return NOMINAL_IMU;
    gyroScale.push(degPerStep * DEG_TO_RAD);
    const accPlus = int16(b, 22 + axis * 4);
    const accMinus = int16(b, 24 + axis * 4);
    const range2g = accPlus - accMinus;
    if (range2g === 0) return NOMINAL_IMU;
    const gPerStep = 2 / range2g;
    const accBias = accPlus - range2g / 2;
    if (Math.abs(accBias) > 1024 || Math.abs(1 - gPerStep * ACCEL_STEPS_PER_G) > 0.5) return NOMINAL_IMU;
    accelBias.push(accBias);
    accelScale.push(gPerStep * STANDARD_GRAVITY);
  }
  return { gyroBias: bias, gyroScale, accelBias, accelScale };
}

/** Report gyro and accelerometer readings (raw int16 x, y, z at `gyroAt` and `accelAt`) through `cal`. */
export function reportImu(pad: PadState, cal: ImuCalibration, b: Uint8Array, gyroAt: number, accelAt: number): void {
  const g = (i: number) => (int16(b, gyroAt + i * 2) - cal.gyroBias[i]) * cal.gyroScale[i];
  const a = (i: number) => (int16(b, accelAt + i * 2) - cal.accelBias[i]) * cal.accelScale[i];
  pad.sensor("gyro", g(0), g(1), g(2));
  pad.sensor("accel", a(0), a(1), a(2));
}

/**
 * Sticks (four bytes at `sticksAt`), the three button bytes at `buttonsAt` and the triggers.
 * `extras`: the third byte's DualSense buttons (mute; the Edge's function buttons and paddles).
 */
export function reportSonyControls(pad: PadState, b: Uint8Array, sticksAt: number, buttonsAt: number, l2: number, r2: number, extras: boolean): void {
  for (let i = 0; i < 4; i++) pad.axis(i, stickByte(b[sticksAt + i]));
  const b0 = b[buttonsAt];
  const b1 = b[buttonsAt + 1];
  const b2 = b[buttonsAt + 2];
  pad.button(0, b0 & 0x20 ? 1 : 0); // cross
  pad.button(1, b0 & 0x40 ? 1 : 0); // circle
  pad.button(2, b0 & 0x10 ? 1 : 0); // square
  pad.button(3, b0 & 0x80 ? 1 : 0); // triangle
  pad.hat(b0 & 0x0f);
  pad.button(4, b1 & 0x01 ? 1 : 0);
  pad.button(5, b1 & 0x02 ? 1 : 0);
  // A trigger reading 0 with its digital bit set is fully pulled (SDL does the same).
  pad.button(6, l2 === 0 && b1 & 0x04 ? 1 : l2 / 255);
  pad.button(7, r2 === 0 && b1 & 0x08 ? 1 : r2 / 255);
  pad.button(8, b1 & 0x10 ? 1 : 0); // create / share
  pad.button(9, b1 & 0x20 ? 1 : 0); // options
  pad.button(10, b1 & 0x40 ? 1 : 0);
  pad.button(11, b1 & 0x80 ? 1 : 0);
  pad.button(16, b2 & 0x01 ? 1 : 0); // PS
  pad.button(22, b2 & 0x02 ? 1 : 0); // touchpad click
  if (!extras) return;
  pad.button(17, b2 & 0x04 ? 1 : 0); // mute
  pad.button(18, b2 & 0x80 ? 1 : 0); // Edge: right paddle
  pad.button(19, b2 & 0x40 ? 1 : 0); // Edge: left paddle
  pad.button(20, b2 & 0x20 ? 1 : 0); // Edge: right function button
  pad.button(21, b2 & 0x10 ? 1 : 0); // Edge: left function button
}

const TOUCHPAD_WIDTH = 1920;

/**
 * The two touchpad points at `at` (four bytes each: bit 7 of the first clear while the finger is
 * down, then 12-bit x and y), normalized by the pad's width (1920) and `height` and clamped to 0..1.
 */
export function reportTouchpad(pad: PadState, b: Uint8Array, at: number, height: number): void {
  for (const finger of [0, 1] as const) {
    const o = at + finger * 4;
    const down = !(b[o] & 0x80);
    const x = b[o + 1] | ((b[o + 2] & 0x0f) << 8);
    const y = (b[o + 2] >> 4) | (b[o + 3] << 4);
    pad.touch(finger, down, Math.min(1, x / TOUCHPAD_WIDTH), Math.min(1, y / height));
  }
}

/**
 * Bluetooth reports end in a CRC-32 over a header byte (0xA1 input, 0xA2 output, the HIDP
 * transaction header), the report id and the report's other bytes.
 */
function bluetoothCrc(header: number, reportId: number, data: Uint8Array): number {
  return crc32(data.subarray(0, data.length - 4), crc32([header, reportId]));
}

/** Write an output report's CRC into its last four bytes. */
export function sealBluetoothReport(reportId: number, data: Uint8Array): void {
  const crc = bluetoothCrc(0xa2, reportId, data);
  const at = data.length - 4;
  data[at] = crc & 0xff;
  data[at + 1] = (crc >>> 8) & 0xff;
  data[at + 2] = (crc >>> 16) & 0xff;
  data[at + 3] = (crc >>> 24) & 0xff;
}

/** Counts input reports with good checksums; one with a bad checksum is dropped once good ones have arrived (as SDL does). */
export class BluetoothCrcCheck {
  private good = 0;

  accept(reportId: number, data: Uint8Array): boolean {
    const at = data.length - 4;
    const stored = (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0;
    if (stored === bluetoothCrc(0xa1, reportId, data)) {
      this.good = Math.min(this.good + 1, 3);
      return true;
    }
    return this.good < 3;
  }
}
