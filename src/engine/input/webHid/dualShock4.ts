/**
 * DualShock 4 (both models) and Sony's USB wireless adapter over WebHID, USB and Bluetooth.
 * Ported from SDL's HIDAPI driver (`SDL_hidapi_ps4.c`, zlib licence, copyright (C) 1997-2025 Sam
 * Lantinga); altered: rewritten in TypeScript for WebHID.
 *
 * - **Input:** USB report 0x01 (63 bytes) and Bluetooth report 0x11 (77 bytes, the same state
 *   two bytes in, ending in a CRC-32). Over Bluetooth the pad starts in a simple mode (report
 *   0x01, 9 bytes, no motion) until it's sent an output report.
 * - **Output:** USB report 0x05 and Bluetooth report 0x11 (with a CRC-32): motors and light bar.
 * - **Motion:** through the factory calibration in feature report 0x02 (USB, the adapter) or 0x05
 *   (Bluetooth).
 * - **Touchpad and battery:** two touch points (normalized as SDL does, 1920 × 920: the pad
 *   reports up to about 943, but SDL finds 920 feels better) and the battery byte.
 * - **The wireless adapter** reports whether a controller is paired with it; the pad is reported
 *   connected only while one is.
 */
import { Later, PadState, SLOT_COLOURS, byte01, byte255, bytesOf, featureBody, hasOutputReport, outputLength, send, type HidPadFactory, type HidPadOutput } from "./driver";
import { BluetoothCrcCheck, NOMINAL_IMU, reportImu, reportSonyControls, reportTouchpad, sealBluetoothReport, sonyImuCalibration, type ImuCalibration } from "./sony";

export const DUALSHOCK4_PRODUCTS: readonly number[] = [0x05c4, 0x09cc, 0x0ba0];
const WIRELESS_ADAPTER = 0x0ba0;
const TOUCHPAD_HEIGHT = 920;

/** The battery byte: level in the low nibble; bit 4 on the cable (then 0..10 charging, 11 full). */
function battery(v: number): [number, boolean] {
  const level = v & 0x0f;
  if (!(v & 0x10)) return [Math.min(1, (level * 10 + 5) / 100), false];
  if (level <= 10) return [Math.min(1, (level * 10 + 5) / 100), true];
  return level === 11 ? [1, false] : [-1, false];
}

export const dualShock4: HidPadFactory = (device, link) => {
  const pad = new PadState(link);
  const adapter = device.productId === WIRELESS_ADAPTER;
  let bluetooth = !adapter && hasOutputReport(device, 0x11);
  let imu: ImuCalibration = NOMINAL_IMU;
  let sensors = false;
  /** The adapter has a controller (always true for a pad itself, once started). */
  let present = false;
  let started = false;
  const crc = new BluetoothCrcCheck();
  let low = 0;
  let high = 0;
  const colour = [...SLOT_COLOURS[link.slot % SLOT_COLOURS.length]];
  const rumbleEnd = new Later();
  const info = {
    name: adapter ? "DualShock 4 USB Wireless Adaptor" : "DualShock 4 Wireless Controller",
    vendor: device.vendorId,
    product: device.productId,
    family: "playstation" as const,
    sensors: true,
    rumble: true,
    triggerRumble: false,
    led: true,
  };

  const push = () => {
    if (bluetooth) {
      const data = new Uint8Array(outputLength(device, 0x11, 77));
      data[0] = 0xc0 | 4; // HID report with CRC, polled every 4 ms
      data[2] = 0x03; // motors and light bar
      data[5] = high;
      data[6] = low;
      data[7] = colour[0];
      data[8] = colour[1];
      data[9] = colour[2];
      sealBluetoothReport(0x11, data);
      send(device, 0x11, data);
    } else {
      const data = new Uint8Array(outputLength(device, 0x05, 31));
      data[0] = 0x03;
      data[3] = high;
      data[4] = low;
      data[5] = colour[0];
      data[6] = colour[1];
      data[7] = colour[2];
      send(device, 0x05, data);
    }
  };

  const full = (b: Uint8Array, o: number) => {
    reportSonyControls(pad, b, o, o + 4, b[o + 7], b[o + 8], false);
    if (sensors) reportImu(pad, imu, b, o + 12, o + 18);
    reportTouchpad(pad, b, o + 34, TOUCHPAD_HEIGHT);
    pad.battery(...battery(b[o + 29]));
  };

  const calibrate = async () => {
    const [id, full, layout] = bluetooth ? ([0x05, 41, "grouped"] as const) : ([0x02, 37, adapter ? "grouped" : "interleaved"] as const);
    let body: Uint8Array | null = null;
    try {
      body = featureBody(await device.receiveFeatureReport(id), id, full);
    } catch {
      // No calibration: nominal scales.
    }
    imu = sonyImuCalibration(body, layout);
  };

  const setPresent = (now: boolean) => {
    if (now === present) return;
    present = now;
    if (now) {
      link.connected(info);
      push();
      // The adapter's controller: its own calibration (each controller has its own).
      if (adapter) void calibrate();
    } else link.disconnected();
  };

  const output: HidPadOutput = {
    rumble(l, h, durationMs) {
      const on = durationMs > 0;
      low = on ? byte01(l) : 0;
      high = on ? byte01(h) : 0;
      push();
      if (on && (low || high)) {
        rumbleEnd.set(durationMs, () => {
          low = high = 0;
          push();
        });
      } else rumbleEnd.clear();
    },
    setLed(r, g, b) {
      colour[0] = byte255(r);
      colour[1] = byte255(g);
      colour[2] = byte255(b);
      push();
    },
    setSensors(enabled) {
      sensors = enabled;
    },
  };

  return {
    output,
    async start() {
      if (!adapter) await calibrate();
      started = true;
      if (!adapter) setPresent(true);
    },
    report(reportId, view) {
      if (!started) return;
      const b = bytesOf(view);
      if (reportId === 0x11 && b.length >= 77) {
        if (!bluetooth) {
          bluetooth = true;
          push();
        }
        if (b[0] & 0x80 && crc.accept(0x11, b)) full(b, 2);
      } else if (reportId === 0x01) {
        if (b.length >= 63) {
          // Byte 30 bit 2: the adapter has no controller.
          if (adapter) setPresent(!(b[30] & 0x04));
          if (present) full(b, 0);
        } else if (b.length >= 9) {
          if (!bluetooth && !adapter) {
            bluetooth = true;
            push(); // switches the pad to full reports
          }
          reportSonyControls(pad, b, 0, 4, b[7], b[8], false);
        }
      }
    },
    stop() {
      rumbleEnd.clear();
      if (low || high) {
        low = high = 0;
        push();
      }
    },
  };
};
