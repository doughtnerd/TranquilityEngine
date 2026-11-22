/**
 * The WebHID gamepad adapter (ADR 0335, build notes): in Chromium browsers on desktop, DualSense,
 * DualShock 4, Switch Pro controllers and Joy-Cons can be opened as HID devices, which gives what
 * the Gamepad API doesn't: gyro and accelerometer, adaptive triggers, light bars, player lights,
 * touchpad points, battery. A left and a right Joy-Con join into one pad (`joyCon.ts`).
 *
 * - **Permission:** a page sees a device only after the user picks it in the browser's chooser,
 *   which `request()` opens (from a click or key press). Devices granted before are reopened at
 *   start and whenever they're plugged back in.
 * - **Ownership:** a pad this adapter reports is skipped by the Gamepad API adapter (`owns`), so
 *   it isn't reported twice; if the HID device fails or goes away, the Gamepad API reports it again.
 * - **Output:** for pads this adapter reports it encodes the output itself; other pads' output
 *   goes to the Gamepad API's (`output`).
 *
 * Desktop builds never use this: under Tauri, SDL3 reports these controllers natively.
 */
import type { DeviceEventSink, GamepadOutput } from "../devices";
import { tapHidDevice, type HidDeviceTap } from "../recording";
import type { HidPadDriver, HidPadFactory, HidPadLink } from "./driver";
import { DUALSENSE_PRODUCTS, SONY_VENDOR, dualSense } from "./dualSense";
import { DUALSHOCK4_PRODUCTS, dualShock4 } from "./dualShock4";
import type { Hid, HidConnectionEvent, HidDevice, HidDeviceFilter, HidInputReportEvent } from "./hidTypes";
import { JOYCON_LEFT, JOYCON_RIGHT, joyCons } from "./joyCon";
import { NINTENDO_VENDOR, SWITCH_PRO_PRODUCT, switchPro } from "./switchPro";

/** HID pads' device ids start here, clear of the Gamepad API's indices. */
const FIRST_ID = 0x4000;

/** Each family's driver; Joy-Cons' is made per adapter, since the Joy-Cons it opens pair up. */
const DRIVERS: readonly { readonly vendorId: number; readonly productId: number; readonly factory: HidPadFactory | "joyCon" }[] = [
  ...DUALSENSE_PRODUCTS.map((productId) => ({ vendorId: SONY_VENDOR, productId, factory: dualSense })),
  ...DUALSHOCK4_PRODUCTS.map((productId) => ({ vendorId: SONY_VENDOR, productId, factory: dualShock4 })),
  { vendorId: NINTENDO_VENDOR, productId: SWITCH_PRO_PRODUCT, factory: switchPro },
  { vendorId: NINTENDO_VENDOR, productId: JOYCON_LEFT, factory: "joyCon" },
  { vendorId: NINTENDO_VENDOR, productId: JOYCON_RIGHT, factory: "joyCon" },
];

/** What the browser's device chooser lists. */
const FILTERS: HidDeviceFilter[] = DRIVERS.map(({ vendorId, productId }) => ({ vendorId, productId }));

export interface WebHidGamepads {
  /**
   * Open the browser's chooser for supported controllers (call it from a user gesture) and start
   * reporting the ones picked. Resolves with how many of them are now open.
   */
  request(): Promise<number>;
  /** Whether a Gamepad API pad is one this adapter reports (the Gamepad API adapter skips it). */
  owns(pad: Gamepad): boolean;
  /** Output for every pad: this adapter's pads' through their drivers, any other's through `fallback`. */
  output(fallback: GamepadOutput | null): GamepadOutput;
  /** Close every device (reporting their pads disconnected) and stop listening. */
  stop(): void;
}

interface Entry {
  readonly device: HidDevice;
  readonly id: number;
  readonly slot: number;
  readonly key: string;
  driver: HidPadDriver | null;
  announced: boolean;
  /** The announced pad's vendor and product (a joined Joy-Con pair's differ from the device's). */
  padKey: string;
  /** In use as part of another entry's pad (a joined Joy-Con). */
  joined: boolean;
  listener: ((e: HidInputReportEvent) => void) | null;
  tap?: HidDeviceTap;
}

const keyOf = (vendor: number, product: number) => `${vendor.toString(16).padStart(4, "0")}:${product.toString(16).padStart(4, "0")}`;

/** A Gamepad API id's vendor and product: Chromium's `… Vendor: 054c Product: 0ce6)`, Firefox's `054c-0ce6-…`. */
function gamepadKey(id: string): string | null {
  const m = /Vendor:\s*([0-9a-f]{1,4})\s+Product:\s*([0-9a-f]{1,4})/i.exec(id) ?? /^([0-9a-f]{1,4})-([0-9a-f]{1,4})-/i.exec(id);
  return m ? keyOf(parseInt(m[1], 16), parseInt(m[2], 16)) : null;
}

/** Start the adapter, or null where there's no WebHID (other browsers, Node). */
export function webHidGamepads(sink: DeviceEventSink, nav: Navigator): WebHidGamepads | null {
  const hid = (nav as Navigator & { hid?: Hid }).hid;
  if (!hid || typeof hid.getDevices !== "function") return null;
  const entries = new Map<HidDevice, Entry>();
  const byId = new Map<number, Entry>();
  let nextId = FIRST_ID;
  let stopped = false;
  const joyCon = joyCons();

  const freeSlot = () => {
    const used = new Set([...entries.values()].map((e) => e.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    return slot;
  };

  const release = (entry: Entry, close: boolean) => {
    if (entries.get(entry.device) !== entry) return;
    entries.delete(entry.device);
    byId.delete(entry.id);
    if (entry.listener) entry.device.removeEventListener("inputreport", entry.listener);
    entry.tap?.close();
    try {
      entry.driver?.stop();
    } catch {
      // the device is going anyway
    }
    if (entry.announced) {
      entry.announced = false;
      sink.gamepadDisconnected(entry.id);
    }
    if (close && entry.device.opened) void entry.device.close().catch(() => {});
  };

  /** Open a device and start its driver; true if it's now in use. */
  const adopt = async (device: HidDevice): Promise<boolean> => {
    if (stopped) return false;
    if (entries.has(device)) return true;
    const known = DRIVERS.find((d) => d.vendorId === device.vendorId && d.productId === device.productId);
    if (!known) return false;
    const entry: Entry = { device, id: nextId++, slot: freeSlot(), key: keyOf(device.vendorId, device.productId), driver: null, announced: false, padKey: "", joined: false, listener: null };
    entries.set(device, entry);
    byId.set(entry.id, entry);
    try {
      if (!device.opened) await device.open();
      if (entries.get(device) !== entry) return false; // unplugged or stopped meanwhile
      const link: HidPadLink = {
        id: entry.id,
        sink,
        slot: entry.slot,
        connected(info) {
          if (stopped || entry.announced || entries.get(device) !== entry) return;
          entry.announced = true;
          entry.padKey = keyOf(info.vendor ?? device.vendorId, info.product ?? device.productId);
          sink.gamepadConnected({ ...info, id: entry.id });
        },
        disconnected() {
          if (!entry.announced) return;
          entry.announced = false;
          sink.gamepadDisconnected(entry.id);
        },
        joined(on) {
          entry.joined = on;
        },
      };
      const tap = tapHidDevice(device); // input recording (recording.ts): notes the setup exchange
      entry.tap = tap;
      const driver = (known.factory === "joyCon" ? joyCon : known.factory)(tap.device, link);
      entry.driver = driver;
      entry.listener = (e) => {
        try {
          tap.input(e);
          driver.report(e.reportId, e.data);
        } catch (err) {
          console.error("[myco] A WebHID gamepad report couldn't be read:", err);
        }
      };
      device.addEventListener("inputreport", entry.listener);
      await driver.start();
      tap.ready();
      return entries.get(device) === entry;
    } catch (err) {
      console.warn(`[myco] ${device.productName || "A controller"} couldn't be opened over WebHID; the Gamepad API reports it instead:`, err);
      release(entry, true);
      return false;
    }
  };

  const onConnect = (e: HidConnectionEvent) => void adopt(e.device);
  const onDisconnect = (e: HidConnectionEvent) => {
    const entry = entries.get(e.device);
    if (entry) release(entry, false);
  };
  hid.addEventListener("connect", onConnect);
  hid.addEventListener("disconnect", onDisconnect);
  void hid.getDevices().then(
    (granted) => granted.forEach((d) => void adopt(d)),
    () => {}, // a permissions policy can forbid WebHID
  );

  const announcedFor = (id: number) => {
    const entry = byId.get(id);
    return entry?.announced ? entry.driver : null;
  };

  return {
    request() {
      if (stopped) return Promise.resolve(0);
      let chosen: Promise<HidDevice[]>;
      try {
        // Called before any await: the browser needs the user gesture that's running now.
        chosen = hid.requestDevice({ filters: FILTERS });
      } catch {
        return Promise.resolve(0);
      }
      return chosen.then(
        async (picked) => (await Promise.all(picked.map(adopt))).filter(Boolean).length,
        () => 0, // no gesture, or WebHID forbidden
      );
    },

    owns(pad) {
      if (!entries.size) return false;
      const key = gamepadKey(pad.id);
      if (!key) return false;
      let owned = 0;
      for (const e of entries.values()) if ((e.announced && (e.key === key || e.padKey === key)) || (e.joined && e.key === key)) owned++;
      if (!owned) return false;
      // The first `owned` Gamepad API pads of the same model, in index order.
      let before = 0;
      let pads: ArrayLike<Gamepad | null>;
      try {
        pads = nav.getGamepads();
      } catch {
        return true;
      }
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        if (p && p.connected && p.index < pad.index && gamepadKey(p.id) === key) before++;
      }
      return before < owned;
    },

    output(fallback) {
      return {
        rumble(id, low, high, durationMs) {
          const d = announcedFor(id);
          if (d) d.output.rumble(low, high, durationMs);
          else fallback?.rumble(id, low, high, durationMs);
        },
        triggerRumble(id, left, right, durationMs) {
          const d = announcedFor(id);
          if (d) d.output.triggerRumble?.(left, right, durationMs);
          else fallback?.triggerRumble?.(id, left, right, durationMs);
        },
        triggerEffect(id, trigger, effect) {
          const d = announcedFor(id);
          if (d) d.output.triggerEffect?.(trigger, effect);
          else fallback?.triggerEffect?.(id, trigger, effect);
        },
        setLed(id, r, g, b) {
          const d = announcedFor(id);
          if (d) d.output.setLed?.(r, g, b);
          else fallback?.setLed?.(id, r, g, b);
        },
        setSensors(id, enabled) {
          const d = announcedFor(id);
          if (d) d.output.setSensors(enabled);
          else fallback?.setSensors?.(id, enabled);
        },
      };
    },

    stop() {
      stopped = true;
      hid.removeEventListener("connect", onConnect);
      hid.removeEventListener("disconnect", onDisconnect);
      for (const entry of [...entries.values()]) release(entry, true);
    },
  };
}
