/**
 * The desktop gamepad adapter (ADR 0335): under Tauri, gamepads come only from SDL3 in the native
 * process (`src-tauri/src/gamepad.rs`, also in exported desktop games), streamed to the page in
 * batches over a Tauri channel. Output (rumble, trigger effects, lights, sensors) goes back as
 * commands. The browser Gamepad API is never read here.
 */
import { GAMEPAD_FAMILIES } from "./controls";
import type { DeviceEventSink, GamepadOutput } from "./devices";
import { triggerEffectBlock } from "./dualSenseEffects";
import { DUALSENSE_PRODUCTS, SONY_VENDOR } from "./webHid/dualSense";

/** What `myco_gamepad_listen` sends, as `src-tauri/src/gamepad.rs` serialises it. */
export type NativeGamepadEvent =
  | { t: "connect"; id: number; name: string; vendor: number; product: number; family: number; sensors: boolean; rumble: boolean; triggerRumble: boolean; led: boolean }
  | { t: "disconnect"; id: number }
  | { t: "button"; id: number; index: number; value: number; time: number }
  | { t: "axis"; id: number; index: number; value: number; time: number }
  | { t: "sensor"; id: number; kind: "gyro" | "accel"; x: number; y: number; z: number; time: number }
  /** A touchpad finger (0 or 1): down (or moved) at x, y in 0..1, origin top-left; or lifted. */
  | { t: "touch"; id: number; finger: number; down: boolean; x: number; y: number; time: number }
  /** The battery: level 0..1, or -1 when unknown or wired without a battery; charging while plugged in. */
  | { t: "battery"; id: number; level: number; charging: boolean };

/** Report a batch from the native side to `sink`. */
export function applyNativeBatch(sink: DeviceEventSink, batch: readonly NativeGamepadEvent[]): void {
  for (const e of batch) {
    switch (e.t) {
      case "connect":
        sink.gamepadConnected({
          id: e.id,
          name: e.name,
          vendor: e.vendor,
          product: e.product,
          family: GAMEPAD_FAMILIES[e.family] ?? "generic",
          sensors: e.sensors,
          rumble: e.rumble,
          triggerRumble: e.triggerRumble,
          led: e.led,
        });
        break;
      case "disconnect":
        sink.gamepadDisconnected(e.id);
        break;
      case "button":
        sink.gamepadButton(e.id, e.index, e.value);
        break;
      case "axis":
        sink.gamepadAxis(e.id, e.index, e.value);
        break;
      case "sensor":
        sink.gamepadSensor(e.id, e.kind, e.x, e.y, e.z);
        break;
      case "touch":
        sink.gamepadTouch(e.id, e.finger, e.down, e.x, e.y);
        break;
      case "battery":
        sink.gamepadBattery(e.id, e.level, e.charging);
        break;
    }
  }
}

/** Start listening to the native gamepads. Returns the output and a function that stops listening. */
export function tauriGamepads(sink: DeviceEventSink): { output: GamepadOutput; stop: () => void } {
  let stopped = false;
  /** Pads that take DualSense effect blocks (adaptive triggers), by SDL id. */
  const dualSenses = new Set<number>();
  // Tauri's API, loaded once (only desktop builds reach this adapter).
  const tauri = import("@tauri-apps/api/core");
  const invoke = async (cmd: string, args: Record<string, unknown>) => (await tauri).invoke(cmd, args);
  void (async () => {
    const core = await tauri;
    const channel = new core.Channel<NativeGamepadEvent[]>();
    channel.onmessage = (batch) => {
      if (stopped) return;
      for (const e of batch) {
        if (e.t === "connect" && e.vendor === SONY_VENDOR && DUALSENSE_PRODUCTS.includes(e.product)) dualSenses.add(e.id);
        else if (e.t === "disconnect") dualSenses.delete(e.id);
      }
      applyNativeBatch(sink, batch);
    };
    await core.invoke("myco_gamepad_listen", { onEvent: channel });
  })().catch((err: unknown) => console.warn("[myco] Native gamepads aren't available:", err));
  const fire = (cmd: string, args: Record<string, unknown>) => void invoke(cmd, args).catch(() => {});
  return {
    output: {
      rumble: (id, low, high, durationMs) => fire("myco_gamepad_rumble", { id, low, high, durationMs }),
      triggerRumble: (id, left, right, durationMs) => fire("myco_gamepad_trigger_rumble", { id, left, right, durationMs }),
      // SDL sends DualSense effect blocks as they are (`SDL_SendGamepadEffect`); other pads have no adaptive triggers.
      triggerEffect: (id, trigger, effect) => {
        if (dualSenses.has(id)) fire("myco_gamepad_trigger_effect", { id, bytes: Array.from(triggerEffectBlock(trigger, effect)) });
      },
      setLed: (id, r, g, b) => fire("myco_gamepad_set_led", { id, r, g, b }),
      setSensors: (id, enabled) => fire("myco_gamepad_sensors", { id, enabled }),
    },
    stop() {
      stopped = true;
    },
  };
}
