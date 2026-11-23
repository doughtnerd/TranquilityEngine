/**
 * What the Switch Pro Controller and Joy-Con drivers share: the USB handshake, subcommands and
 * their replies, stick and motion calibration from SPI flash, the full report's sticks, motion
 * and battery, and HD rumble. Ported from SDL's HIDAPI driver (`SDL_hidapi_switch.c`, zlib licence,
 * copyright (C) 1997-2025 Sam Lantinga); altered: rewritten in TypeScript for WebHID, the rumble
 * refresh timer-driven.
 *
 * - **Setup:** over USB, the handshake (proprietary report 0x80: handshake, high speed, handshake,
 *   no USB timeout); then subcommands in output report 0x01, each answered by input report 0x21:
 *   read the stick and motion calibration from SPI flash, enable vibration, switch to full
 *   reports (0x30), set the player lights.
 * - **HD rumble:** each actuator takes four bytes, a frequency and an amplitude for its high and
 *   low bands. Amplitudes go through SDL's table; both bands play at SDL's frequency (about 150
 *   Hz). Rumble is written at most once per 30 ms per device (faster writes can switch a Bluetooth
 *   controller off), keeping the strongest request made in between, and re-sent every 50 ms while
 *   it plays, or the controller stops it.
 */
import { DEG_TO_RAD, Later, STANDARD_GRAVITY, int16, outputLength, hasOutputReport, send } from "./driver";
import type { HidDevice } from "./hidTypes";

export const NINTENDO_VENDOR = 0x057e;

/** Player light patterns by slot, as SDL sets them. */
const PLAYER_LIGHTS = [0x1, 0x3, 0x7, 0xf, 0x9, 0x5, 0xd, 0x6];

/** The player light pattern for a slot. */
export function playerLights(slot: number): number {
  return PLAYER_LIGHTS[slot % PLAYER_LIGHTS.length];
}

const REPLY_TIMEOUT_MS = 300;
const ATTEMPTS = 3;

/** How often rumble may be written, and how often it must be re-sent to keep playing (SDL's). */
const RUMBLE_WRITE_MS = 30;
const RUMBLE_REFRESH_MS = 50;

const NEUTRAL_RUMBLE: readonly number[] = [0x00, 0x01, 0x40, 0x40];

/**
 * SDL's amplitude table (from dekuNukem's Nintendo Switch reverse-engineering notes): a rumble
 * strength 0..65535 takes the first step at or above it. Step i is encoded 2i in the high band and
 * 0x40 + i/2 (odd steps with bit 15 set) in the low band.
 */
const AMPLITUDE_STEPS: readonly number[] = [
  0, 514, 775, 921, 1096, 1303, 1550, 1843, 2192, 2606, 3100, 3686, 4383, 5213, 6199, 7372, 7698, 8039, 8395, 8767, 9155, 9560, 9984, 10426, 10887, 11369, 11873, 12398, 12947,
  13520, 14119, 14744, 15067, 15397, 15734, 16079, 16431, 16790, 17158, 17534, 17918, 18310, 18711, 19121, 19540, 19967, 20405, 20851, 21308, 21775, 22251, 22739, 23236, 23745,
  24265, 24797, 25340, 25894, 26462, 27041, 27633, 28238, 28856, 29488, 30134, 30794, 31468, 32157, 32861, 33581, 34316, 35068, 35836, 36620, 37422, 38242, 39079, 39935, 40809,
  41703, 42616, 43549, 44503, 45477, 46473, 47491, 48531, 49593, 50679, 51789, 52923, 54082, 55266, 56476, 57713, 58977, 60268, 61588, 62936, 64315, 65535,
];

function amplitudeStep(strength: number): number {
  for (let i = 0; i < AMPLITUDE_STEPS.length; i++) if (strength <= AMPLITUDE_STEPS[i]) return i;
  return AMPLITUDE_STEPS.length - 1;
}

/** A frequency's step on the controller's logarithmic scale: 32 steps per octave from 10 Hz. */
const frequencyStep = (hz: number) => Math.round(32 * Math.log2(hz / 10));
/** The high band's 9-bit frequency code (81.75–1252 Hz) and the low band's 7-bit one (40.875–626 Hz). */
const highBandFrequency = (hz: number) => Math.min(0x1fc, Math.max(0, (frequencyStep(hz) - 0x60) * 4));
const lowBandFrequency = (hz: number) => Math.min(0x7f, Math.max(1, frequencyStep(hz) - 0x40));

/** The frequency SDL plays both bands at (its codes 0x74 and 0x3d); controllers mostly ignore it. */
const RUMBLE_HZ = 150;
const HIGH_FREQUENCY = highBandFrequency(RUMBLE_HZ);
const LOW_FREQUENCY = lowBandFrequency(RUMBLE_HZ);

/** One actuator's four rumble bytes for low- and high-band strengths 0..65535 (`EncodeRumble` in SDL). */
function encodeRumble(low: number, high: number): readonly number[] {
  if (!low && !high) return NEUTRAL_RUMBLE;
  const hi = amplitudeStep(high);
  const lo = amplitudeStep(low);
  const highAmp = hi * 2;
  const lowAmp = (0x40 + (lo >> 1)) | ((lo & 1) << 15);
  return [HIGH_FREQUENCY & 0xff, highAmp | ((HIGH_FREQUENCY >> 8) & 0x01), LOW_FREQUENCY | ((lowAmp >> 8) & 0x80), lowAmp & 0xff];
}

/** 0..1 as a rumble strength 0..65535. */
const strength16 = (v: number) => Math.round(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)) * 65535);

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

const hasMagic = (b: Uint8Array | null, at: number) => !!b && b[at] === 0xb2 && b[at + 1] === 0xa1;

export type Vec3 = [number, number, number];

/** A Switch controller's connection: setup, its full reports' contents, sensors, rumble. */
export interface SwitchSession {
  /** Set the controller up (handshake over USB, calibration, vibration, full reports, the slot's player lights). */
  start(): Promise<void>;
  /** An input report (the bytes after its id): answers a pending request; true if it's a full report (0x30) to read. */
  report(reportId: number, b: Uint8Array): boolean;
  /**
   * Stick `stick` (0 left, 1 right) in a full report, calibrated: [x, y], -1..1, +Y up as the
   * controller reports it.
   */
  stick(b: Uint8Array, stick: 0 | 1): [number, number];
  /**
   * The newest motion sample in a full report, calibrated, in SDL's PlayStation-ordered axes
   * (before a Joy-Con's own turns); null while sensors are off or the sample is empty.
   */
  motion(b: Uint8Array): { gyro: Vec3; accel: Vec3 } | null;
  /** The battery in a full report: level 0..1 and whether it's charging (a full battery on the charger isn't). */
  battery(b: Uint8Array): [number, boolean];
  setSensors(enabled: boolean): void;
  setPlayerLights(pattern: number): void;
  /** Rumble: low- and high-band strengths 0..1 for `durationMs` (0 stops it). */
  rumble(low: number, high: number, durationMs: number): void;
  stop(): void;
}

export function switchSession(device: HidDevice, slot: number): SwitchSession {
  const usb = hasOutputReport(device, 0x80);
  const subLength = outputLength(device, 0x01, usb ? 63 : 48);
  const rumbleLength = outputLength(device, 0x10, usb ? 63 : 48);
  const sticks: StickCal[] = [DEFAULT_STICK, DEFAULT_STICK, DEFAULT_STICK, DEFAULT_STICK];
  let accelScale = [1, 1, 1].map(() => STANDARD_GRAVITY / 4096);
  let gyroScale = [1, 1, 1].map(() => DEG_TO_RAD / 14.2842);
  let gyroOffset = [0, 0, 0];
  let counter = 0;
  let sensors = false;
  let ready = false;
  let stopped = false;
  /** The reply being waited for. */
  let waiting: { match: (reportId: number, b: Uint8Array) => boolean; done: (b: Uint8Array | null) => void } | null = null;
  /** Subcommands go one at a time. */
  let queue: Promise<unknown> = Promise.resolve();

  // Rumble: what's playing (also sent in every subcommand report), and the rate limit's state.
  let block: readonly number[] = NEUTRAL_RUMBLE;
  let playing = false;
  let cooling = false;
  /** The strongest request made while cooling down, and whether a stop is due after it. */
  let pending: [number, number] | null = null;
  let stopPending = false;
  const cooldown = new Later();
  const refresh = new Later();
  const rumbleEnd = new Later();

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
          data.set(block, 1);
          data.set(block, 5);
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

  const writeRumble = () => {
    const data = new Uint8Array(rumbleLength);
    data[0] = nextCounter();
    data.set(block, 1);
    data.set(block, 5);
    send(device, 0x10, data);
    cooling = true;
    cooldown.set(RUMBLE_WRITE_MS, flush);
    if (playing) refresh.set(RUMBLE_REFRESH_MS, writeRumble);
    else refresh.clear();
  };

  const play = (low: number, high: number) => {
    block = encodeRumble(low, high);
    playing = block !== NEUTRAL_RUMBLE;
    writeRumble();
  };

  /** The cooldown is over: send what was asked for meanwhile. */
  function flush(): void {
    cooling = false;
    if (pending) {
      const [low, high] = pending;
      pending = null;
      play(low, high);
    } else if (stopPending) {
      stopPending = false;
      play(0, 0);
    }
  }

  /** Ask for rumble; within the cooldown it waits (the strongest request wins, as in SDL). */
  const request16 = (low: number, high: number) => {
    if (!cooling) {
      play(low, high);
    } else if (low || high) {
      if (!pending || low * 65536 + high > pending[0] * 65536 + pending[1]) pending = [low, high];
      stopPending = false;
    } else stopPending = true;
  };

  return {
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
      await subcommand(0x30, [playerLights(slot)]);
      if (usb) await proprietary(0x04, false);
      if (stopped) throw new Error("closed while starting");
      ready = true;
    },

    report(reportId, b) {
      if (waiting?.match(reportId, b)) waiting.done(b.slice());
      return reportId === 0x30 && ready && b.length >= 12;
    },

    stick(b, stick) {
      const o = 5 + stick * 3;
      const x = b[o] | ((b[o + 1] & 0x0f) << 8);
      const y = (b[o + 1] >> 4) | (b[o + 2] << 4);
      const norm = (raw: number, cal: StickCal) => {
        const d = raw - cal.center;
        const v = d / (d >= 0 ? cal.above : cal.below);
        return v < -1 ? -1 : v > 1 ? 1 : v;
      };
      return [norm(x, sticks[stick * 2]), norm(y, sticks[stick * 2 + 1])];
    },

    motion(b) {
      if (!sensors || b.length < 24) return null;
      // Sample 0 (the newest): accelerometer x, y, z, then gyro; reordered to the PlayStation axes as SDL does.
      const a = [int16(b, 12), int16(b, 14), int16(b, 16)];
      if (!a[0] && !a[1] && !a[2]) return null; // no sample yet
      const g = [int16(b, 18) - gyroOffset[0], int16(b, 20) - gyroOffset[1], int16(b, 22) - gyroOffset[2]];
      return {
        gyro: [-gyroScale[1] * g[1], gyroScale[2] * g[2], -gyroScale[0] * g[0]],
        accel: [-accelScale[1] * a[1], accelScale[2] * a[2], -accelScale[0] * a[0]],
      };
    },

    battery(b) {
      // High nibble: level 0 (empty) to 8 (full) in its top three bits, charging in its lowest.
      const level = (b[1] & 0xe0) >> 4;
      return [level / 8, !!(b[1] & 0x10) && level < 8];
    },

    setSensors(enabled) {
      if (enabled === sensors) return;
      sensors = enabled;
      void subcommand(0x40, [enabled ? 1 : 0]);
    },

    setPlayerLights(pattern) {
      void subcommand(0x30, [pattern]);
    },

    rumble(low, high, durationMs) {
      const on = durationMs > 0;
      const lo = on ? strength16(low) : 0;
      const hi = on ? strength16(high) : 0;
      request16(lo, hi);
      if (lo || hi) rumbleEnd.set(durationMs, () => request16(0, 0));
      else rumbleEnd.clear();
    },

    stop() {
      stopped = true;
      waiting?.done(null);
      rumbleEnd.clear();
      cooldown.clear();
      refresh.clear();
      pending = null;
      stopPending = false;
      // Leave it quiet, whatever the rate limit.
      if (playing) play(0, 0);
      cooldown.clear();
    },
  };
}
