/**
 * Nintendo Switch Pro Controller over WebHID, USB and Bluetooth. Ported from SDL's HIDAPI driver
 * (`SDL_hidapi_switch.c`, zlib licence, copyright (C) 1997-2025 Sam Lantinga); altered: rewritten
 * in TypeScript for WebHID.
 *
 * - **Setup, calibration, rumble:** shared with the Joy-Cons (`nintendo.ts`). `setSensors`
 *   enables the IMU (subcommand 0x40).
 * - **Input:** report 0x30: buttons, 12-bit sticks, three IMU samples (the newest is reported),
 *   the battery.
 * - **Output:** HD rumble in report 0x10 (and in every subcommand report): both actuators, low
 *   band driven by `low`, high band by `high`.
 */
import { PadState, bytesOf, type HidPadFactory, type HidPadOutput } from "./driver";
import { switchSession } from "./nintendo";

export { NINTENDO_VENDOR } from "./nintendo";
export const SWITCH_PRO_PRODUCT = 0x2009;

export const switchPro: HidPadFactory = (device, link) => {
  const pad = new PadState(link);
  const session = switchSession(device, link.slot);
  let ready = false;

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
    for (const s of [0, 1] as const) {
      const [x, y] = session.stick(b, s);
      pad.axis(s * 2, x);
      pad.axis(s * 2 + 1, -y); // up is +Y on the pad, -Y on the wire
    }
    const motion = session.motion(b);
    if (motion) {
      pad.sensor("gyro", ...motion.gyro);
      pad.sensor("accel", ...motion.accel);
    }
    pad.battery(...session.battery(b));
  };

  const output: HidPadOutput = {
    rumble: (low, high, durationMs) => session.rumble(low, high, durationMs),
    setSensors: (enabled) => session.setSensors(enabled),
  };

  return {
    output,
    async start() {
      await session.start();
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
      if (session.report(reportId, b) && ready) fullState(b);
    },
    stop() {
      session.stop();
    },
  };
};
