/**
 * The desktop gamepad adapter (ADR 0335): under Tauri, gamepads come only from SDL3 in the native
 * process (`src-tauri/src/gamepad.rs`, also in exported desktop games), streamed to the page in
 * batches over a Tauri channel. Output (rumble, trigger effects, lights, sensors) goes back as
 * commands. The browser Gamepad API is never read here.
 */
import { GAMEPAD_FAMILIES } from "./controls";
import type { DeviceEventSink, GamepadOutput } from "./devices";
import { tapNativeBatch } from "./recording";

/** What `myco_gamepad_listen` sends, as `src-tauri/src/gamepad.rs` serialises it. */
export type NativeGamepadEvent =
  | { t: "connect"; id: number; name: string; vendor: number; product: number; family: number; sensors: boolean; rumble: boolean; triggerRumble: boolean; led: boolean }
  | { t: "disconnect"; id: number }
  | { t: "button"; id: number; index: number; value: number; time: number }
  | { t: "axis"; id: number; index: number; value: number; time: number }
  | { t: "sensor"; id: number; kind: "gyro" | "accel"; x: number; y: number; z: number; time: number };

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
    }
  }
}

/** Start listening to the native gamepads. Returns the output and a function that stops listening. */
export function tauriGamepads(sink: DeviceEventSink): { output: GamepadOutput; stop: () => void } {
  let stopped = false;
  const invoke = async (cmd: string, args: Record<string, unknown>) => {
    const core = await import("@tauri-apps/api/core");
    return core.invoke(cmd, args);
  };
  void (async () => {
    const core = await import("@tauri-apps/api/core");
    const channel = new core.Channel<NativeGamepadEvent[]>();
    channel.onmessage = (batch) => {
      if (stopped) return;
      tapNativeBatch(batch); // input recording (recording.ts)
      applyNativeBatch(sink, batch);
    };
    await core.invoke("myco_gamepad_listen", { onEvent: channel });
  })().catch((err: unknown) => console.warn("[myco] Native gamepads aren't available:", err));
  const fire = (cmd: string, args: Record<string, unknown>) => void invoke(cmd, args).catch(() => {});
  return {
    output: {
      rumble: (id, low, high, durationMs) => fire("myco_gamepad_rumble", { id, low, high, durationMs }),
      triggerRumble: (id, left, right, durationMs) => fire("myco_gamepad_trigger_rumble", { id, left, right, durationMs }),
      setLed: (id, r, g, b) => fire("myco_gamepad_set_led", { id, r, g, b }),
      setSensors: (id, enabled) => fire("myco_gamepad_sensors", { id, enabled }),
    },
    stop() {
      stopped = true;
    },
  };
}
