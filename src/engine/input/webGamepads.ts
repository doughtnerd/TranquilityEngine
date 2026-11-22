/**
 * The browser gamepad adapter (ADR 0335): web builds read only raw state from the Gamepad API,
 * once per snapshot. Everything above that is the engine's and shared with desktop: device
 * families, the SDL controller database for pads the browser doesn't map ("standard"), and the
 * wire indices (`controls.ts`). Those come from the mapping module (`native/input`, as wasm),
 * loaded the first time a gamepad connects, so games that never see a gamepad never download it.
 *
 * Desktop builds never use this: under Tauri the SDL3 adapter (`tauriGamepads.ts`) is the only
 * gamepad source.
 */
import { GAMEPAD_AXES, GAMEPAD_BUTTONS, GAMEPAD_FAMILIES, type DeviceFamily } from "./controls";
import type { DeviceEventSink, GamepadOutput } from "./devices";
import { loadInputMapping, type InputMapping } from "./mapping";
import { tapWebPads, type WebPlatform } from "./recording";

/** What the adapter needs of `navigator`. */
interface GamepadNavigator {
  getGamepads(): ArrayLike<Gamepad | null>;
}

type Platform = 0 | 1 | 2 | 3;

const PLATFORM_NAMES: readonly WebPlatform[] = ["windows", "mac", "linux", "other"];

/** The SDL database's platform for the page's OS: 0 Windows, 1 macOS, 2 Linux, 3 other. */
function platformOf(nav: Navigator | undefined): Platform {
  const ua = nav?.userAgent ?? "";
  if (/Windows/.test(ua)) return 0;
  if (/Mac OS X|Macintosh/.test(ua) && !/iPhone|iPad/.test(ua)) return 1;
  if (/Linux/.test(ua) && !/Android/.test(ua)) return 2;
  return 3;
}

interface Tracked {
  readonly index: number;
  /** Per control in wire order (23 buttons, then 4 axes): `[kind, index, kind2, index2]` (`InputMapping.webMapping`), or null for the standard layout. */
  readonly table: Int16Array | null;
  readonly buttons: Float32Array;
  readonly axes: Float32Array;
}

/**
 * Start reporting the page's gamepads to `sink`. `poll` is called once per snapshot, before it
 * (`devices.addPoller`). Returns the poller and the output to give the snapshot, and a function
 * that stops (reporting every tracked pad as disconnected). Pads `skip` accepts aren't reported
 * (another adapter, WebHID, reports them); one that stops being skipped is reported again.
 */
export function webGamepads(
  sink: DeviceEventSink,
  nav: Navigator & Partial<GamepadNavigator> = navigator,
  skip?: (pad: Gamepad) => boolean,
): { poll: () => void; output: GamepadOutput; stop: () => void } | null {
  if (typeof nav?.getGamepads !== "function") return null;
  const tracked = new Map<number, Tracked>();
  /** Pads seen whose mapping is still loading. */
  const pending = new Set<number>();
  const platform = platformOf(nav);
  let mapping: InputMapping | null = null;
  let stopped = false;

  const connect = (pad: Gamepad, map: InputMapping | null) => {
    const ids = map?.parseWebGamepadId(pad.id) ?? null;
    const family: DeviceFamily = map ? GAMEPAD_FAMILIES[map.familyOf(ids?.vendor ?? 0, ids?.product ?? 0, pad.id)] ?? "generic" : "generic";
    const table = pad.mapping === "standard" || !map || !ids ? null : map.webMapping(ids.vendor, ids.product, platform) ?? null;
    tracked.set(pad.index, { index: pad.index, table, buttons: new Float32Array(GAMEPAD_BUTTONS.length), axes: new Float32Array(GAMEPAD_AXES.length) });
    sink.gamepadConnected({ id: pad.index, name: pad.id, vendor: ids?.vendor, product: ids?.product, family, rumble: !!pad.vibrationActuator });
  };

  const read = (pad: Gamepad, t: Tracked) => {
    for (let i = 0; i < GAMEPAD_BUTTONS.length; i++) {
      const v = t.table ? mapped(pad, t.table, i) : (pad.buttons[i]?.value ?? 0);
      if (v !== t.buttons[i]) sink.gamepadButton(t.index, i, (t.buttons[i] = v));
    }
    for (let i = 0; i < GAMEPAD_AXES.length; i++) {
      const v = t.table ? mapped(pad, t.table, GAMEPAD_BUTTONS.length + i) : (pad.axes[i] ?? 0);
      if (v !== t.axes[i]) sink.gamepadAxis(t.index, i, (t.axes[i] = v));
    }
  };

  const poll = () => {
    if (stopped) return;
    let pads: ArrayLike<Gamepad | null>;
    try {
      pads = nav.getGamepads();
    } catch {
      return; // a permissions policy can forbid it
    }
    tapWebPads(pads, PLATFORM_NAMES[platform], skip); // input recording (recording.ts): one check unless recording
    const seen = new Set<number>();
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (!pad || !pad.connected || skip?.(pad)) continue;
      seen.add(pad.index);
      const t = tracked.get(pad.index);
      if (t) read(pad, t);
      else if (mapping) {
        connect(pad, mapping);
        read(pad, tracked.get(pad.index)!);
      } else if (!pending.has(pad.index)) {
        pending.add(pad.index);
        loadInputMapping().then(
          (m) => {
            mapping = m;
            pending.clear();
          },
          (err: unknown) => {
            console.warn("[myco] The gamepad mapping module didn't load; gamepads use the browser's layout:", err);
            mapping = null;
            pending.clear();
            // Report pads without the database: standard-layout pads still work.
            for (let j = 0; j < pads.length; j++) {
              const p = pads[j];
              if (p?.connected && !tracked.has(p.index) && !skip?.(p)) connect(p, null);
            }
          },
        );
      }
    }
    for (const index of [...tracked.keys()]) {
      if (seen.has(index)) continue;
      tracked.delete(index);
      sink.gamepadDisconnected(index);
    }
  };

  const output: GamepadOutput = {
    rumble(id, low, high, durationMs) {
      const pad = nav.getGamepads()[id];
      void pad?.vibrationActuator?.playEffect("dual-rumble", { duration: durationMs, weakMagnitude: low, strongMagnitude: high }).catch(() => {});
    },
    triggerRumble(id, left, right, durationMs) {
      const pad = nav.getGamepads()[id];
      // "trigger-rumble" is Chromium's; elsewhere playEffect rejects and nothing happens.
      void (pad?.vibrationActuator as unknown as { playEffect(type: string, params: object): Promise<unknown> } | undefined)
        ?.playEffect("trigger-rumble", { duration: durationMs, leftTrigger: left, rightTrigger: right })
        .catch(() => {});
    },
  };

  return {
    poll,
    output,
    stop() {
      stopped = true;
      for (const index of tracked.keys()) sink.gamepadDisconnected(index);
      tracked.clear();
    },
  };
}

/**
 * A control's value from a raw (non-standard) pad through a mapping table entry: its first source
 * minus its second (a stick axis driven by two buttons or hat directions has both).
 */
function mapped(pad: Gamepad, table: Int16Array, control: number): number {
  const at = control * 4;
  const kind = table[at];
  const index = table[at + 1];
  // A button (the triggers) read from a full axis: -1..1 becomes 0..1.
  if (control < GAMEPAD_BUTTONS.length && (kind === 2 || kind === 5)) {
    const v = pad.axes[index] ?? -1;
    return ((kind === 5 ? -v : v) + 1) / 2;
  }
  const v = source(pad, kind, index);
  return table[at + 2] ? v - source(pad, table[at + 2], table[at + 3]) : v;
}

/** One source's value: a raw button, axis or half axis, or a hat direction (`InputMapping.webMapping`'s kinds). */
function source(pad: Gamepad, kind: number, index: number): number {
  switch (kind) {
    case 1:
      return pad.buttons[index]?.value ?? 0;
    case 2:
      return pad.axes[index] ?? 0;
    case 3:
      return Math.max(0, pad.axes[index] ?? 0);
    case 4:
      return Math.max(0, -(pad.axes[index] ?? 0));
    case 5:
      return -(pad.axes[index] ?? 0);
    case 6: {
      // Browsers report a hat as one axis stepping through eight directions (-1 up, clockwise,
      // ~1.29 centred); SDL names a hat bit (1 up, 2 right, 4 down, 8 left).
      const v = pad.axes[index >> 4] ?? 0;
      const bit = index & 15;
      if (v > 1.1 || v < -1.1) return 0;
      const step = Math.round(((v + 1) / 2) * 7); // 0 up, 1 up-right, 2 right … 7 up-left
      const bits = [1, 3, 2, 6, 4, 12, 8, 9][step] ?? 0;
      return bits & bit ? 1 : 0;
    }
    default:
      return 0;
  }
}
