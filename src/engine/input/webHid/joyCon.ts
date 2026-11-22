/**
 * Nintendo Switch Joy-Cons over WebHID (Bluetooth). Ported from SDL's HIDAPI driver
 * (`SDL_hidapi_switch.c`, zlib licence, copyright (C) 1997-2025 Sam Lantinga); altered: rewritten
 * in TypeScript for WebHID, the left and right joined in this module rather than in a separate
 * combining driver.
 *
 * - **Setup, calibration, rumble:** as the Pro Controller (`nintendo.ts`).
 * - **One Joy-Con** is a small pad held sideways (SDL's mini-gamepad mode): face buttons by their
 *   position when held so, SL and SR as the shoulders, the stick turned to match, L/ZL (R/ZR) as
 *   paddles, − or + as start, capture or home as home. Motion is turned to the sideways hold.
 * - **A left and a right** open at the same time join into one pad, as SDL combines Joy-Cons by
 *   default ("Joy-Con (L/R)", product 0x2008): announced under the left's id, laid out like a Pro
 *   Controller with SL and SR as paddles. Motion is the right Joy-Con's; rumble's low band plays on
 *   the left, its high band on the right (as in SDL); the battery is the lower of the two. When
 *   either goes, the other becomes a small pad again (or joins another waiting partner).
 */
import { PadState, bytesOf, type HidPadFactory, type HidPadLink, type HidPadOutput } from "./driver";
import { NINTENDO_VENDOR, playerLights, switchSession, type SwitchSession, type Vec3 } from "./nintendo";
import type { HidDevice } from "./hidTypes";

export const JOYCON_LEFT = 0x2006;
export const JOYCON_RIGHT = 0x2007;
/** The product id a joined pair is announced with (SDL's). */
export const JOYCON_PAIR = 0x2008;

type Side = "left" | "right";

interface Unit {
  readonly side: Side;
  readonly device: HidDevice;
  readonly link: HidPadLink;
  readonly session: SwitchSession;
  ready: boolean;
  partner: Unit | null;
  /** Where its controls go: its own pad, or (in a pair) the pair's. */
  pad: PadState;
  /** Its last battery reading while in a pair (the pair reports the lower). */
  battery: [number, boolean] | null;
  /** The player light pattern it shows. */
  lights: number;
}

const info = (unit: Unit, paired: boolean) => ({
  name: paired ? "Joy-Con (L/R)" : unit.side === "left" ? "Joy-Con (L)" : "Joy-Con (R)",
  vendor: NINTENDO_VENDOR,
  product: paired ? JOYCON_PAIR : unit.device.productId,
  family: "switch" as const,
  sensors: true,
  rumble: true,
  triggerRumble: false,
  led: false,
});

const bit = (v: number, mask: number) => (v & mask ? 1 : 0);

/** One Joy-Con held sideways: buttons by position, the stick turned (`HandleMiniControllerState` in SDL). */
function reportMini(unit: Unit, b: Uint8Array): void {
  const pad = unit.pad;
  const shared = b[3];
  if (unit.side === "left") {
    const left = b[4];
    pad.button(0, bit(left, 0x08)); // d-pad left: the bottom button when held sideways
    pad.button(1, bit(left, 0x01));
    pad.button(2, bit(left, 0x02));
    pad.button(3, bit(left, 0x04));
    pad.button(4, bit(left, 0x20)); // SL
    pad.button(5, bit(left, 0x10)); // SR
    pad.button(19, bit(left, 0x40)); // L: leftPaddle1
    pad.button(21, bit(left, 0x80)); // ZL: leftPaddle2
    pad.button(9, bit(shared, 0x01)); // −
    pad.button(10, bit(shared, 0x08));
    pad.button(16, bit(shared, 0x20)); // capture
    const [x, y] = unit.session.stick(b, 0);
    pad.axis(0, -y);
    pad.axis(1, -x);
  } else {
    const right = b[2];
    pad.button(0, bit(right, 0x08)); // A: the bottom button when held sideways
    pad.button(1, bit(right, 0x02));
    pad.button(2, bit(right, 0x04));
    pad.button(3, bit(right, 0x01));
    pad.button(4, bit(right, 0x20)); // SL
    pad.button(5, bit(right, 0x10)); // SR
    pad.button(18, bit(right, 0x40)); // R: rightPaddle1
    pad.button(20, bit(right, 0x80)); // ZR: rightPaddle2
    pad.button(9, bit(shared, 0x02)); // +
    pad.button(10, bit(shared, 0x04));
    pad.button(16, bit(shared, 0x10)); // home
    const [x, y] = unit.session.stick(b, 1);
    pad.axis(0, y);
    pad.axis(1, x);
  }
}

/** One half of a joined pair (`HandleCombinedControllerState` in SDL). */
function reportHalf(unit: Unit, b: Uint8Array): void {
  const pad = unit.pad;
  const shared = b[3];
  if (unit.side === "left") {
    const left = b[4];
    pad.dpad(!!(left & 0x02), !!(left & 0x01), !!(left & 0x08), !!(left & 0x04));
    pad.button(4, bit(left, 0x40)); // L
    pad.button(6, bit(left, 0x80)); // ZL
    pad.button(19, bit(left, 0x20)); // SL: leftPaddle1
    pad.button(21, bit(left, 0x10)); // SR: leftPaddle2
    pad.button(8, bit(shared, 0x01)); // −
    pad.button(10, bit(shared, 0x08));
    pad.button(17, bit(shared, 0x20)); // capture
    const [x, y] = unit.session.stick(b, 0);
    pad.axis(0, x);
    pad.axis(1, -y);
  } else {
    const right = b[2];
    pad.button(0, bit(right, 0x04)); // B
    pad.button(1, bit(right, 0x08)); // A
    pad.button(2, bit(right, 0x01)); // Y
    pad.button(3, bit(right, 0x02)); // X
    pad.button(5, bit(right, 0x40)); // R
    pad.button(7, bit(right, 0x80)); // ZR
    pad.button(18, bit(right, 0x10)); // SR: rightPaddle1
    pad.button(20, bit(right, 0x20)); // SL: rightPaddle2
    pad.button(9, bit(shared, 0x02)); // +
    pad.button(11, bit(shared, 0x04));
    pad.button(16, bit(shared, 0x10)); // home
    const [x, y] = unit.session.stick(b, 1);
    pad.axis(2, x);
    pad.axis(3, -y);
  }
}

/** Motion in SDL's axes for this Joy-Con and how it's held (`SendSensorUpdate`). */
function turn(unit: Unit, v: Vec3): Vec3 {
  let [x, y, z] = v;
  if (unit.side === "right") {
    // The right Joy-Con's sensor is mounted turned round.
    x = -x;
    y = -y;
  }
  if (unit.partner) return [x, y, z];
  return unit.side === "left" ? [z, y, -x] : [-z, y, x];
}

/**
 * The Joy-Con driver for one adapter: every Joy-Con it opens shares the pairing state, so a left
 * and a right join into one pad. Each adapter makes its own (`webHidGamepads.ts`).
 */
export function joyCons(): HidPadFactory {
  const units: Unit[] = [];

  const lights = (unit: Unit, pattern: number) => {
    if (unit.lights === pattern) return;
    unit.lights = pattern;
    unit.session.setPlayerLights(pattern);
  };

  const announceSolo = (unit: Unit) => {
    unit.partner = null;
    unit.battery = null;
    unit.link.joined(false);
    unit.pad = new PadState(unit.link);
    unit.link.connected(info(unit, false));
    lights(unit, playerLights(unit.link.slot));
  };

  const join = (left: Unit, right: Unit) => {
    left.link.disconnected();
    right.link.disconnected();
    left.partner = right;
    right.partner = left;
    left.battery = right.battery = null;
    left.pad = new PadState(left.link);
    right.pad = new PadState(left.link);
    right.link.joined(true);
    // A new pad: motion off until the game asks for it.
    left.session.setSensors(false);
    right.session.setSensors(false);
    left.link.connected(info(left, true));
    lights(left, playerLights(left.link.slot));
    lights(right, playerLights(left.link.slot));
  };

  /** A ready Joy-Con without a partner: join one waiting on the other side, or stand alone. */
  const settle = (unit: Unit) => {
    const other = units.find((u) => u !== unit && u.ready && !u.partner && u.side !== unit.side);
    if (!other) announceSolo(unit);
    else if (unit.side === "left") join(unit, other);
    else join(other, unit);
  };

  const pairOf = (unit: Unit): [Unit, Unit] | null => {
    const p = unit.partner;
    if (!p) return null;
    return unit.side === "left" ? [unit, p] : [p, unit];
  };

  const reportBattery = (unit: Unit, b: Uint8Array) => {
    const now = unit.session.battery(b);
    const pair = pairOf(unit);
    if (!pair) {
      unit.pad.battery(...now);
      return;
    }
    unit.battery = now;
    const [left, right] = pair;
    if (left.battery && right.battery) {
      left.pad.battery(Math.min(left.battery[0], right.battery[0]), left.battery[1] && right.battery[1]);
    }
  };

  return (device, link) => {
    const side: Side = device.productId === JOYCON_LEFT ? "left" : "right";
    const session = switchSession(device, link.slot);
    const unit: Unit = { side, device, link, session, ready: false, partner: null, pad: new PadState(link), battery: null, lights: playerLights(link.slot) };
    let stopped = false;

    const output: HidPadOutput = {
      rumble(low, high, durationMs) {
        const pair = pairOf(unit);
        if (!pair) session.rumble(low, high, durationMs);
        else {
          pair[0].session.rumble(low, 0, durationMs);
          pair[1].session.rumble(0, high, durationMs);
        }
      },
      setSensors(enabled) {
        // A pair's motion is the right Joy-Con's.
        const pair = pairOf(unit);
        (pair ? pair[1].session : session).setSensors(enabled);
      },
    };

    return {
      output,
      async start() {
        await session.start();
        if (stopped) throw new Error("closed while starting");
        unit.ready = true;
        units.push(unit);
        settle(unit);
      },
      report(reportId, view) {
        const b = bytesOf(view);
        if (!session.report(reportId, b) || !unit.ready) return;
        if (unit.partner) reportHalf(unit, b);
        else reportMini(unit, b);
        const motion = session.motion(b);
        if (motion) {
          unit.pad.sensor("gyro", ...turn(unit, motion.gyro));
          unit.pad.sensor("accel", ...turn(unit, motion.accel));
        }
        reportBattery(unit, b);
      },
      stop() {
        stopped = true;
        session.stop();
        const at = units.indexOf(unit);
        if (at >= 0) units.splice(at, 1);
        const partner = unit.partner;
        unit.partner = null;
        if (!partner) return;
        partner.partner = null;
        // The pair was announced under the left's id: the adapter ends it with the left; ending the right ends it here.
        if (unit.side === "left") partner.link.joined(false);
        else partner.link.disconnected();
        partner.session.setSensors(false);
        settle(partner);
      },
    };
  };
}
