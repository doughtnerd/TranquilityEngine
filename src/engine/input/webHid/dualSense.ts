/**
 * DualSense and DualSense Edge over WebHID, USB and Bluetooth. Ported from SDL's HIDAPI driver
 * (`SDL_hidapi_ps5.c`, zlib licence, copyright (C) 1997-2025 Sam Lantinga); altered: rewritten in
 * TypeScript for WebHID, with adaptive trigger effects added.
 *
 * - **Input:** USB report 0x01 (63 bytes) and Bluetooth report 0x31 (77 bytes, the same state
 *   one byte in, ending in a CRC-32). Over Bluetooth the pad starts in a simple mode (report 0x01,
 *   9 bytes, no motion); the first output report switches it to 0x31.
 * - **Output:** USB report 0x02 and Bluetooth report 0x31 (a sequence byte, 0x10, the same effects
 *   block, a CRC-32): motors, adaptive triggers, light bar, player lights.
 * - **Motion:** gyro and accelerometer through the factory calibration in feature report 0x05.
 * - **Touchpad and battery:** two touch points (normalized as SDL does, 1920 × 1070) and the
 *   battery byte, from the full reports.
 */
import type { TriggerEffect } from "../triggerEffects";
import { Later, PadState, SLOT_COLOURS, byte01, byte255, bytesOf, featureBody, hasOutputReport, outputLength, send, type HidPadFactory, type HidPadOutput } from "./driver";
import { BluetoothCrcCheck, NOMINAL_IMU, reportImu, reportSonyControls, reportTouchpad, sealBluetoothReport, sonyImuCalibration, type ImuCalibration } from "./sony";

export const SONY_VENDOR = 0x054c;
export const DUALSENSE_PRODUCTS: readonly number[] = [0x0ce6, 0x0df2];

/** Player light patterns (five LEDs below the touchpad) by slot, as SDL sets them. */
const PLAYER_LIGHTS = [0x04, 0x0a, 0x15, 0x1b, 0x1f, 0x11, 0x0e];

/**
 * Over Bluetooth the pad ignores light changes until its connection animation ends; SDL waits for
 * this sensor timestamp (in 0.33 µs units, about 3.4 s) and then resets the lights.
 */
const BT_LIGHTS_READY = 10200000;

/** The touchpad's height in its own units, as SDL scales it (the pad reports up to about 1080). */
const TOUCHPAD_HEIGHT = 1070;

/** The battery byte: level 0..10 in the low nibble; status in the high (0 on battery, 1 charging, 2 full). */
function battery(v: number): [number, boolean] {
  const level = Math.min(1, ((v & 0x0f) * 10 + 5) / 100);
  switch (v >> 4) {
    case 0:
      return [level, false];
    case 1:
      return [level, true];
    case 2:
      return [1, false];
    default:
      return [-1, false];
  }
}

/** The frequency trigger rumble vibrates at, Hz. */
const TRIGGER_RUMBLE_HZ = 50;

const TRIGGER_OFF = Uint8Array.of(0x05, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

/** An adaptive trigger effect as the DualSense's 11-byte trigger block. */
function encodeTriggerEffect(effect: TriggerEffect): Uint8Array {
  const out = new Uint8Array(11);
  const frac = (v: number | undefined, d: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? (v as number) : d));
  const zone = (v: number | undefined, d: number) => Math.round(frac(v, d) * 9);
  const level = (v: number | undefined) => Math.round(frac(v, 1) * 8); // 0 none, 1..8
  // Ten zones along the travel: a mask of active zones and a 3-bit value per zone.
  const zones = (start: number, value: number) => {
    let active = 0;
    let values = 0;
    for (let z = start; z < 10; z++) {
      active |= 1 << z;
      values += (value - 1) * 2 ** (3 * z);
    }
    out[1] = active & 0xff;
    out[2] = active >> 8;
    for (let i = 0; i < 4; i++) out[3 + i] = Math.floor(values / 2 ** (8 * i)) & 0xff;
  };
  switch (effect.mode) {
    case "resistance": {
      const strength = level(effect.strength);
      if (!strength) return TRIGGER_OFF;
      out[0] = 0x21;
      zones(zone(effect.start, 0), strength);
      return out;
    }
    case "weapon": {
      const strength = level(effect.strength);
      if (!strength) return TRIGGER_OFF;
      const start = Math.min(7, Math.max(2, zone(effect.start, 0.3)));
      const end = Math.min(8, Math.max(start + 1, zone(effect.end, 0.6)));
      const mask = (1 << start) | (1 << end);
      out[0] = 0x25;
      out[1] = mask & 0xff;
      out[2] = mask >> 8;
      out[3] = strength - 1;
      return out;
    }
    case "vibration": {
      const amplitude = level(effect.amplitude);
      if (!amplitude) return TRIGGER_OFF;
      out[0] = 0x26;
      zones(zone(effect.start, 0), amplitude);
      out[9] = Math.min(255, Math.max(1, Math.round(effect.frequency ?? TRIGGER_RUMBLE_HZ)));
      return out;
    }
    default:
      return TRIGGER_OFF;
  }
}

export const dualSense: HidPadFactory = (device, link) => {
  const pad = new PadState(link);
  const edge = device.productId === 0x0df2;
  /** Bluetooth: from the report descriptor, else from the first report. */
  let bluetooth = hasOutputReport(device, 0x31);
  let imu: ImuCalibration = NOMINAL_IMU;
  let sensors = false;
  let lightsReady = !bluetooth;
  let sequence = 0;
  const crc = new BluetoothCrcCheck();

  let low = 0;
  let high = 0;
  const colour = [...SLOT_COLOURS[link.slot % SLOT_COLOURS.length]];
  const lights = PLAYER_LIGHTS[link.slot % PLAYER_LIGHTS.length] | 0x20; // 0x20: change at once, no fade
  /** The game's trigger effects, and trigger rumble playing over them. */
  const chosen: { left: Uint8Array | null; right: Uint8Array | null } = { left: null, right: null };
  const rumbling: { left: Uint8Array | null; right: Uint8Array | null } = { left: null, right: null };
  const rumbleEnd = new Later();
  const triggerEnd = new Later();

  /** The 47-byte effects block (SDL's `DS5EffectsState_t`). */
  const effects = (resetLights: boolean): Uint8Array => {
    const e = new Uint8Array(47);
    e[0] = 0x01; // compatible vibration: the motor bytes apply
    if (low || high) e[0] |= 0x02; // and mute the audio haptics while they run
    e[2] = high >> 1;
    e[3] = low >> 1;
    const right = rumbling.right ?? chosen.right;
    const left = rumbling.left ?? chosen.left;
    if (right) {
      e[0] |= 0x04;
      e.set(right, 10);
    }
    if (left) {
      e[0] |= 0x08;
      e.set(left, 21);
    }
    if (lightsReady) {
      e[1] = 0x01 | 0x04 | 0x10 | (resetLights ? 0x08 : 0); // mic light, light bar, player lights
      e[43] = lights;
      e[44] = colour[0];
      e[45] = colour[1];
      e[46] = colour[2];
    }
    return e;
  };

  const push = (resetLights = false) => {
    const e = effects(resetLights);
    if (bluetooth) {
      const data = new Uint8Array(outputLength(device, 0x31, 77));
      data[0] = sequence << 4;
      sequence = (sequence + 1) & 0x0f;
      data[1] = 0x10;
      data.set(e, 2);
      sealBluetoothReport(0x31, data);
      send(device, 0x31, data);
    } else {
      const data = new Uint8Array(outputLength(device, 0x02, 47));
      data.set(e.subarray(0, Math.min(e.length, data.length)));
      send(device, 0x02, data);
    }
  };

  /** The full state block at `o`: sticks, triggers, buttons, motion. */
  const full = (b: Uint8Array, o: number) => {
    reportSonyControls(pad, b, o, o + 7, b[o + 4], b[o + 5], true);
    if (sensors) reportImu(pad, imu, b, o + 15, o + 21);
    reportTouchpad(pad, b, o + 32, TOUCHPAD_HEIGHT);
    pad.battery(...battery(b[o + 52]));
    if (!lightsReady) {
      const t = (b[o + 27] | (b[o + 28] << 8) | (b[o + 29] << 16) | (b[o + 30] << 24)) >>> 0;
      if (t >= BT_LIGHTS_READY) {
        lightsReady = true;
        push(true);
        push();
      }
    }
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
    triggerRumble(left, right, durationMs) {
      const on = durationMs > 0;
      const vibrate = (v: number) => (on && v > 0 ? encodeTriggerEffect({ mode: "vibration", amplitude: v, frequency: TRIGGER_RUMBLE_HZ }) : null);
      rumbling.left = vibrate(left);
      rumbling.right = vibrate(right);
      // A trigger that rumbled once needs an explicit "off" to stop.
      chosen.left ??= rumbling.left && TRIGGER_OFF;
      chosen.right ??= rumbling.right && TRIGGER_OFF;
      push();
      if (rumbling.left || rumbling.right) {
        triggerEnd.set(durationMs, () => {
          rumbling.left = rumbling.right = null;
          push();
        });
      } else triggerEnd.clear();
    },
    triggerEffect(trigger, effect) {
      chosen[trigger] = encodeTriggerEffect(effect);
      push();
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
      let body: Uint8Array | null = null;
      try {
        body = featureBody(await device.receiveFeatureReport(0x05), 0x05, 41);
      } catch {
        // No calibration: nominal scales.
      }
      imu = sonyImuCalibration(body, "interleaved");
      // The first output report sets the lights (USB) or switches Bluetooth to full reports.
      push();
      link.connected({
        name: edge ? "DualSense Edge Wireless Controller" : "DualSense Wireless Controller",
        vendor: device.vendorId,
        product: device.productId,
        family: "playstation",
        sensors: true,
        rumble: true,
        triggerRumble: true,
        led: true,
      });
    },
    report(reportId, view) {
      const b = bytesOf(view);
      if (reportId === 0x31 && b.length >= 77) {
        if (!bluetooth) {
          bluetooth = true;
          lightsReady = false;
        }
        if (crc.accept(0x31, b)) full(b, 1);
      } else if (reportId === 0x01) {
        if (b.length >= 63) full(b, 0);
        else if (b.length >= 9) {
          // Bluetooth's simple report: no motion, nothing past the buttons.
          if (!bluetooth) {
            bluetooth = true;
            lightsReady = false;
            push();
          }
          reportSonyControls(pad, b, 0, 4, b[7], b[8], false);
        }
      }
    },
    stop() {
      rumbleEnd.clear();
      triggerEnd.clear();
      // Leave the pad quiet: motors stopped, triggers free.
      low = high = 0;
      rumbling.left = rumbling.right = null;
      chosen.left &&= TRIGGER_OFF;
      chosen.right &&= TRIGGER_OFF;
      push();
    },
  };
};
