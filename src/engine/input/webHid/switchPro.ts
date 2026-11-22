/**
 * Nintendo Switch Pro Controller over WebHID, USB and Bluetooth. Ported from SDL's HIDAPI driver
 * (`SDL_hidapi_switch.c`, zlib licence, copyright (C) 1997-2025 Sam Lantinga); altered: rewritten
 * in TypeScript for WebHID, the rumble amplitude tables replaced by the curve they follow.
 *
 * - **Setup:** over USB, the handshake (proprietary report 0x80: handshake, high speed, handshake,
 *   no USB timeout); then subcommands in output report 0x01, each answered by input report 0x21:
 *   read the stick and motion calibration from SPI flash, enable vibration, switch to full
 *   reports (0x30), set the player lights. `setSensors` enables the IMU (subcommand 0x40).
 * - **Input:** report 0x30: buttons, 12-bit sticks, three IMU samples (the newest is reported).
 * - **Output:** rumble in report 0x10 (and in every subcommand report): both actuators, low band
 *   driven by `low`, high band by `high`.
 */
import { DEG_TO_RAD, Later, PadState, STANDARD_GRAVITY, byte01, bytesOf, hasOutputReport, int16, outputLength, send, type HidPadFactory, type HidPadOutput } from "./driver";

export const NINTENDO_VENDOR = 0x057e;
export const SWITCH_PRO_PRODUCT = 0x2009;

/** Player light patterns by slot, as SDL sets them. */
const PLAYER_LIGHTS = [0x1, 0x3, 0x7, 0xf, 0x9, 0x5, 0xd, 0x6];

const NEUTRAL_RUMBLE = [0x00, 0x01, 0x40, 0x40];
/** SDL's band frequencies (encoded): about 150 Hz in each band. */
const HIGH_FREQ = 0x0074;
const LOW_FREQ = 0x3d;

const REPLY_TIMEOUT_MS = 300;
const ATTEMPTS = 3;

/**
 * An amplitude 0..1 as the controller's amplitude step 0..100 (SDL looks it up in a table that
 * follows this curve: logarithmic above 0.12, roughly linear below).
 */
function amplitudeStep(a: number): number {
  if (!(a > 0)) return 0;
  const step = a > 0.23 ? 32 * Math.log2(a * 8.7) : a > 0.12 ? 16 * Math.log2(a * 17) : 1 + ((a - 0.0078) / (0.12 - 0.0078)) * 15.5;
  return Math.min(100, Math.max(1, Math.round(step)));
}

/** One actuator's four rumble bytes (`EncodeRumble` in SDL). */
function encodeRumble(low: number, high: number): number[] {
  if (!(low > 0) && !(high > 0)) return NEUTRAL_RUMBLE;
  const hi = amplitudeStep(high);
  const lo = amplitudeStep(low);
  const highAmp = hi * 2;
  const lowAmp = (0x40 + (lo >> 1)) | ((lo & 1) << 15);
  return [HIGH_FREQ & 0xff, highAmp | ((HIGH_FREQ >> 8) & 0x01), LOW_FREQ | ((lowAmp >> 8) & 0x80), lowAmp & 0xff];
}

interface StickCal {
  readonly center: number;
  readonly above: number;
  readonly below: number;
}

/** Six 12-bit values from nine bytes. */
function unpack12(b: Uint8Array, at: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    const o = at + i * 3;
    out.push(((b[o + 1] << 8) & 0xf00) | b[o], (b[o + 2] << 4) | (b[o + 1] >> 4));
  }
  return out;
}

const DEFAULT_STICK: StickCal = { center: 2048, above: 2048 * 0.7, below: 2048 * 0.7 };

function stickCal(center: number, above: number, below: number): StickCal {
  if (center === 0xfff || above === 0xfff || below === 0xfff || !above || !below) return DEFAULT_STICK;
  return { center, above, below };
}

/** [left x, left y, right x, right y] from the left stick's nine bytes (max, centre, min) and the right's (centre, min, max). */
function sticksFrom(left: Uint8Array | null, right: Uint8Array | null, into: StickCal[]): void {
  if (left) {
    const [xMax, yMax, xC, yC, xMin, yMin] = unpack12(left, 0);
    into[0] = stickCal(xC, xMax, xMin);
    into[1] = stickCal(yC, yMax, yMin);
  }
  if (right) {
    const [xC, yC, xMin, yMin, xMax, yMax] = unpack12(right, 0);
    into[2] = stickCal(xC, xMax, xMin);
    into[3] = stickCal(yC, yMax, yMin);
  }
}

function normalize(raw: number, cal: StickCal): number {
  const d = raw - cal.center;
  const v = d / (d >= 0 ? cal.above : cal.below);
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

const hasMagic = (b: Uint8Array | null, at: number) => !!b && b[at] === 0xb2 && b[at + 1] === 0xa1;

export const switchPro: HidPadFactory = (device, link) => {
  const pad = new PadState(link);
  const usb = hasOutputReport(device, 0x80);
  const subLength = outputLength(device, 0x01, usb ? 63 : 48);
  const rumbleLength = outputLength(device, 0x10, usb ? 63 : 48);
  const sticks: StickCal[] = [DEFAULT_STICK, DEFAULT_STICK, DEFAULT_STICK, DEFAULT_STICK];
  let accelScale = [1, 1, 1].map(() => STANDARD_GRAVITY / 4096);
  let gyroScale = [1, 1, 1].map(() => DEG_TO_RAD / 14.2842);
  let gyroOffset = [0, 0, 0];
  let counter = 0;
  let rumble = [...NEUTRAL_RUMBLE, ...NEUTRAL_RUMBLE];
  let sensors = false;
  let ready = false;
  let stopped = false;
  const rumbleEnd = new Later();
  /** The reply being waited for. */
  let waiting: { match: (reportId: number, b: Uint8Array) => boolean; done: (b: Uint8Array | null) => void } | null = null;
  /** Subcommands go one at a time. */
  let queue: Promise<unknown> = Promise.resolve();

  const nextCounter = () => {
    const c = counter;
    counter = (counter + 1) & 0x0f;
    return c;
  };

  /** Send `write` and wait for a reply `match` accepts; retried, null if none came. */
  const request = async (write: () => void, match: (reportId: number, b: Uint8Array) => boolean): Promise<Uint8Array | null> => {
    for (let attempt = 0; attempt < ATTEMPTS && !stopped; attempt++) {
      const reply = await new Promise<Uint8Array | null>((resolve) => {
        const timer = setTimeout(() => {
          waiting = null;
          resolve(null);
        }, REPLY_TIMEOUT_MS);
        waiting = {
          match,
          done: (b) => {
            clearTimeout(timer);
            waiting = null;
            resolve(b);
          },
        };
        write();
      });
      if (reply) return reply;
    }
    return null;
  };

  const proprietary = (command: number, wait: boolean): Promise<Uint8Array | null> => {
    const write = () => {
      const data = new Uint8Array(outputLength(device, 0x80, 63));
      data[0] = command;
      send(device, 0x80, data);
    };
    if (!wait) {
      write();
      return Promise.resolve(null);
    }
    return request(write, (id, b) => id === 0x81 && b[0] === command);
  };

  const subcommand = (id: number, args: readonly number[], match?: (b: Uint8Array) => boolean): Promise<Uint8Array | null> => {
    const run = () =>
      request(
        () => {
          const data = new Uint8Array(subLength);
          data[0] = nextCounter();
          data.set(rumble, 1);
          data[9] = id;
          data.set(args, 10);
          send(device, 0x01, data);
        },
        (reportId, b) => reportId === 0x21 && b[13] === id && (!match || match(b)),
      );
    const result = queue.then(run, run);
    queue = result;
    return result;
  };

  /** Read `size` bytes of SPI flash at `address`. */
  const readSpi = async (address: number, size: number): Promise<Uint8Array | null> => {
    const addr = [address & 0xff, (address >> 8) & 0xff, (address >> 16) & 0xff, (address >>> 24) & 0xff];
    const reply = await subcommand(0x10, [...addr, size], (b) => b[14] === addr[0] && b[15] === addr[1] && b[16] === addr[2] && b[17] === addr[3]);
    return reply && reply.length >= 19 + size ? reply.slice(19, 19 + size) : null;
  };

  const loadCalibration = async () => {
    const factory = await readSpi(0x603d, 18);
    sticksFrom(factory?.subarray(0, 9) ?? null, factory?.subarray(9, 18) ?? null, sticks);
    const user = await readSpi(0x8010, 22);
    sticksFrom(hasMagic(user, 0) ? user!.subarray(2, 11) : null, hasMagic(user, 11) ? user!.subarray(13, 22) : null, sticks);
    const userImu = await readSpi(0x8026, 26);
    const imu = hasMagic(userImu, 0) ? userImu!.subarray(2, 26) : await readSpi(0x6020, 24);
    if (imu && imu.some((v) => v !== 0xff)) {
      const accel = [0, 1, 2].map((i) => int16(imu, 6 + i * 2) - int16(imu, i * 2));
      const gyroOrigin = [0, 1, 2].map((i) => int16(imu, 12 + i * 2));
      const gyro = [0, 1, 2].map((i) => int16(imu, 18 + i * 2) - gyroOrigin[i]);
      if (accel.every((v) => v !== 0) && gyro.every((v) => v !== 0)) {
        accelScale = accel.map((v) => (4 / v) * STANDARD_GRAVITY);
        gyroScale = gyro.map((v) => (936 / v) * DEG_TO_RAD);
        gyroOffset = gyroOrigin;
      }
    }
  };

  const sendRumble = () => {
    const data = new Uint8Array(rumbleLength);
    data[0] = nextCounter();
    data.set(rumble, 1);
    send(device, 0x10, data);
  };

  const fullState = (b: Uint8Array) => {
    const right = b[2];
    const shared = b[3];
    const left = b[4];
    pad.button(0, right & 0x04 ? 1 : 0); // B
    pad.button(1, right & 0x08 ? 1 : 0); // A
    pad.button(2, right & 0x01 ? 1 : 0); // Y
    pad.button(3, right & 0x02 ? 1 : 0); // X
    pad.button(4, left & 0x40 ? 1 : 0); // L
    pad.button(5, right & 0x40 ? 1 : 0); // R
    pad.button(6, left & 0x80 ? 1 : 0); // ZL
    pad.button(7, right & 0x80 ? 1 : 0); // ZR
    pad.button(8, shared & 0x01 ? 1 : 0); // −
    pad.button(9, shared & 0x02 ? 1 : 0); // +
    pad.button(10, shared & 0x08 ? 1 : 0);
    pad.button(11, shared & 0x04 ? 1 : 0);
    pad.dpad(!!(left & 0x02), !!(left & 0x01), !!(left & 0x08), !!(left & 0x04));
    pad.button(16, shared & 0x10 ? 1 : 0); // home
    pad.button(17, shared & 0x20 ? 1 : 0); // capture
    for (let s = 0; s < 2; s++) {
      const o = 5 + s * 3;
      const x = b[o] | ((b[o + 1] & 0x0f) << 8);
      const y = (b[o + 1] >> 4) | (b[o + 2] << 4);
      pad.axis(s * 2, normalize(x, sticks[s * 2]));
      pad.axis(s * 2 + 1, -normalize(y, sticks[s * 2 + 1])); // up is +Y on the pad, -Y on the wire
    }
    if (sensors && b.length >= 24) {
      // Sample 0 (the newest): accelerometer x, y, z, then gyro; reordered to the PlayStation axes as SDL does.
      const a = [int16(b, 12), int16(b, 14), int16(b, 16)];
      const g = [int16(b, 18) - gyroOffset[0], int16(b, 20) - gyroOffset[1], int16(b, 22) - gyroOffset[2]];
      pad.sensor("gyro", -gyroScale[1] * g[1], gyroScale[2] * g[2], -gyroScale[0] * g[0]);
      pad.sensor("accel", -accelScale[1] * a[1], accelScale[2] * a[2], -accelScale[0] * a[0]);
    }
  };

  const output: HidPadOutput = {
    rumble(low, high, durationMs) {
      const on = durationMs > 0;
      const block = on ? encodeRumble(byte01(low) / 255, byte01(high) / 255) : NEUTRAL_RUMBLE;
      rumble = [...block, ...block];
      sendRumble();
      if (on && block !== NEUTRAL_RUMBLE) {
        rumbleEnd.set(durationMs, () => {
          rumble = [...NEUTRAL_RUMBLE, ...NEUTRAL_RUMBLE];
          sendRumble();
        });
      } else rumbleEnd.clear();
    },
    setSensors(enabled) {
      if (enabled === sensors) return;
      sensors = enabled;
      void subcommand(0x40, [enabled ? 1 : 0]);
    },
  };

  return {
    output,
    async start() {
      if (usb) {
        await proprietary(0x02, true);
        await proprietary(0x03, true);
        await proprietary(0x02, true);
        await proprietary(0x04, false);
      }
      await loadCalibration();
      await subcommand(0x48, [1]); // vibration
      await subcommand(0x03, [0x30]); // full reports
      await subcommand(0x30, [PLAYER_LIGHTS[link.slot % PLAYER_LIGHTS.length]]);
      if (usb) await proprietary(0x04, false);
      if (stopped) throw new Error("closed while starting");
      ready = true;
      link.connected({
        name: "Pro Controller",
        vendor: device.vendorId,
        product: device.productId,
        family: "switch",
        sensors: true,
        rumble: true,
        triggerRumble: false,
        led: false,
      });
    },
    report(reportId, view) {
      const b = bytesOf(view);
      if (waiting?.match(reportId, b)) waiting.done(b.slice());
      if (reportId === 0x30 && ready && b.length >= 12) fullState(b);
    },
    stop() {
      stopped = true;
      rumbleEnd.clear();
      waiting?.done(null);
      if (rumble[0] !== NEUTRAL_RUMBLE[0]) {
        rumble = [...NEUTRAL_RUMBLE, ...NEUTRAL_RUMBLE];
        sendRumble();
      }
    },
  };
};
