/**
 * The device snapshot (ADR 0310, 0333): the Engine's one keyboard and pointer and its gamepads,
 * shared by its Worlds.
 *
 * - **Input end** (`DeviceEventSink`): adapters (the DOM listener, `domDevices.ts`; the gamepad
 *   adapters, `webGamepads.ts` and `tauriGamepads.ts`) report device events as they happen; keys,
 *   buttons, movement, scroll and gamepad changes queue, timestamped, until the next snapshot.
 * - **Snapshot** (`beginFrame`, ADR 0011 step 2): once per Engine frame, applies the queue, then the
 *   routing step.
 * - **Routing step** (ADR 0069): each router (the UI core) is handed what the pointer did this frame
 *   and answers what it claims; this frame's mouse presses over claimed UI then go to the UI until
 *   they're released.
 * - **Reading end**: what the game sees after routing, which the `Input` getters and each World's
 *   input systems (`deviceEntities.ts`, ADR 0333) read, plus the frame's raw device events.
 *
 * Nothing here is public API: scripts read `Input` and actions; `Input.inject` is the input end.
 */
import { Vector2 } from "../core/math";
import { GAMEPAD_AXES, GAMEPAD_BUTTONS, PRESS_POINT, normalizeKey, type DeviceFamily } from "./controls";

export { normalizeKey };

/** A gamepad an adapter reports. `id` is the adapter's (SDL's instance id, or the Gamepad API index). */
export interface GamepadInfo {
  readonly id: number;
  readonly name: string;
  readonly vendor?: number;
  readonly product?: number;
  readonly family?: DeviceFamily;
  /** What it can do (the SDL adapter knows; the browser doesn't). */
  readonly sensors?: boolean;
  readonly rumble?: boolean;
  readonly triggerRumble?: boolean;
  readonly led?: boolean;
}

/** Output to gamepads (rumble, trigger effects, lights, sensors), sent by the adapter that reports them. */
export interface GamepadOutput {
  rumble(id: number, low: number, high: number, durationMs: number): void;
  triggerRumble?(id: number, left: number, right: number, durationMs: number): void;
  setLed?(id: number, r: number, g: number, b: number): void;
  setSensors?(id: number, enabled: boolean): void;
}

/** The device id the keyboard and the pointer have in raw events (gamepads have their adapter's ids, ≥ 0). */
export const KEYBOARD_DEVICE = -1;
export const POINTER_DEVICE = -2;

/** One raw device event of this frame, after routing (`DeviceEvents`, rebinding, recording). */
export interface RawDeviceEvent {
  /** `KEYBOARD_DEVICE`, `POINTER_DEVICE`, or a gamepad's id. */
  readonly device: number;
  /** A control path: `<Keyboard>/space`, `<Pointer>/button0`, `<Gamepad>/buttonSouth`, `<Gamepad>/leftStickX`. */
  readonly control: string;
  readonly value: number;
  /** `performance.now()` milliseconds when the adapter reported it. */
  readonly time: number;
}

/** A gamepad as the snapshot sees it. Arrays are indexed by wire index (`controls.ts`). */
export interface GamepadSnapshot {
  readonly info: GamepadInfo;
  readonly family: DeviceFamily;
  readonly buttons: Float32Array;
  readonly axes: Float32Array;
  /** Bit i: button i held (value ≥ PRESS_POINT), went down this frame, went up this frame. */
  held: number;
  down: number;
  up: number;
  readonly gyro: Float32Array;
  readonly accel: Float32Array;
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** What an adapter reports. Positions and movement are in CSS pixels, the pointer relative to the canvas. */
export interface DeviceEventSink {
  keyDown(key: string): void;
  keyUp(key: string): void;
  buttonDown(button: number): void;
  buttonUp(button: number): void;
  /** The pointer is at canvas pixels now (not queued: a press reads where it happened). */
  pointerAt(x: number, y: number): void;
  move(dx: number, dy: number): void;
  scroll(dx: number, dy: number): void;
  /** The devices lost focus: everything held is released. */
  releaseAll(): void;
  /** A gamepad was plugged in (or was already there when the adapter started). */
  gamepadConnected(info: GamepadInfo): void;
  gamepadDisconnected(id: number): void;
  /** A gamepad button's value, 0..1 (digital buttons send 0 or 1). `index` is the wire index. */
  gamepadButton(id: number, index: number, value: number): void;
  /** A gamepad axis's value, -1..1, +Y down (wire convention). */
  gamepadAxis(id: number, index: number, value: number): void;
  /** Motion sensors (the SDL adapter): gyro in rad/s, accelerometer in m/s². */
  gamepadSensor(id: number, kind: "gyro" | "accel", x: number, y: number, z: number): void;
}

/** What the pointer did this frame, before routing: handed to each router. */
export interface PointerFrame {
  /** Canvas pixels. */
  readonly x: number;
  readonly y: number;
  /** The button went down this frame. */
  down(button: number): boolean;
  /** The button is held (it went down in this frame or an earlier one, and hasn't been released). */
  held(button: number): boolean;
  /** The button was released this frame. */
  up(button: number): boolean;
}

/** What a router takes this frame: the pointer (it's over interactable UI) and the keyboard (a text field is focused). */
export interface InputClaim {
  readonly pointer?: boolean;
  readonly keyboard?: boolean;
}

export type InputRouter = (pointer: PointerFrame) => InputClaim | void;

/** The key name `Input` gives a pointer button. */
export const mouseKey = (button: number): string => `mouse${button}`;
const isMouseKey = (k: string) => /^mouse\d+$/.test(k);

type QueuedEvent = { down: boolean; key: string; time: number };

type PadEvent =
  | { kind: "connect"; info: GamepadInfo; time: number }
  | { kind: "disconnect"; id: number; time: number }
  | { kind: "button"; id: number; index: number; value: number; time: number }
  | { kind: "axis"; id: number; index: number; value: number; time: number }
  | { kind: "sensor"; id: number; sensor: "gyro" | "accel"; x: number; y: number; z: number; time: number };

class DeviceSnapshot implements DeviceEventSink {
  private readonly queue: QueuedEvent[] = [];
  private readonly heldKeys = new Set<string>();
  private readonly downNow = new Set<string>();
  private readonly upNow = new Set<string>();
  private readonly pointer = new Vector2();
  private readonly pendingMove = new Vector2();
  private readonly moved = new Vector2();
  private readonly pendingScroll = new Vector2();
  private readonly scrolled = new Vector2();
  private readonly routers: InputRouter[] = [];
  private pointerToUI = false;
  private keyboardToUI = false;
  /** Mouse buttons pressed over UI and still held: the game doesn't see them held or released. */
  private readonly uiHeld = new Set<string>();
  /** This frame's mouse presses and releases that went to the UI. */
  private readonly uiDown = new Set<string>();
  private readonly uiUp = new Set<string>();
  private readonly padQueue: PadEvent[] = [];
  private readonly pads = new Map<number, GamepadSnapshot>();
  /** Gamepads connected and disconnected this frame. */
  private readonly padsConnected: GamepadSnapshot[] = [];
  private readonly padsDisconnected: GamepadSnapshot[] = [];
  private readonly rawEvents: RawDeviceEvent[] = [];
  /** The adapter that reports gamepads sends their output too. */
  output: GamepadOutput | null = null;
  /** Bumped on every snapshot. */
  frame = 0;
  /** True while an adapter reports a keyboard and pointer (the DOM adapter, or `Input.inject`). */
  hasKeyboardAndPointer = false;
  /** Adapters that read their devices by polling (the Gamepad API), called first in each snapshot. */
  private readonly pollers = new Set<() => void>();

  // --- Input end --------------------------------------------------------------------------------

  keyDown(key: string): void {
    this.queue.push({ down: true, key: normalizeKey(key), time: now() });
  }

  keyUp(key: string): void {
    this.queue.push({ down: false, key: normalizeKey(key), time: now() });
  }

  buttonDown(button: number): void {
    this.queue.push({ down: true, key: mouseKey(button), time: now() });
  }

  buttonUp(button: number): void {
    this.queue.push({ down: false, key: mouseKey(button), time: now() });
  }

  pointerAt(x: number, y: number): void {
    this.pointer.set(x, y);
  }

  move(dx: number, dy: number): void {
    this.pendingMove.set(this.pendingMove.x + dx, this.pendingMove.y + dy);
  }

  scroll(dx: number, dy: number): void {
    this.pendingScroll.set(this.pendingScroll.x + dx, this.pendingScroll.y + dy);
  }

  releaseAll(): void {
    const time = now();
    for (const k of this.heldKeys) this.queue.push({ down: false, key: k, time });
  }

  gamepadConnected(info: GamepadInfo): void {
    this.padQueue.push({ kind: "connect", info, time: now() });
  }

  gamepadDisconnected(id: number): void {
    this.padQueue.push({ kind: "disconnect", id, time: now() });
  }

  gamepadButton(id: number, index: number, value: number): void {
    if (index >= 0 && index < GAMEPAD_BUTTONS.length) this.padQueue.push({ kind: "button", id, index, value: clamp(value, 0, 1), time: now() });
  }

  gamepadAxis(id: number, index: number, value: number): void {
    if (index >= 0 && index < GAMEPAD_AXES.length) this.padQueue.push({ kind: "axis", id, index, value: clamp(value, -1, 1), time: now() });
  }

  gamepadSensor(id: number, sensor: "gyro" | "accel", x: number, y: number, z: number): void {
    this.padQueue.push({ kind: "sensor", id, sensor, x, y, z, time: now() });
  }

  // --- Snapshot and routing ---------------------------------------------------------------------

  /** Step 2 of the frame: apply queued events to this frame's snapshot, then route the pointer and keyboard. */
  beginFrame(): void {
    for (const poll of this.pollers) {
      try {
        poll();
      } catch (err) {
        console.error("[myco] A device adapter failed:", err);
      }
    }
    this.frame++;
    this.downNow.clear();
    this.upNow.clear();
    this.rawEvents.length = 0;
    const keyEvents: QueuedEvent[] = [];
    for (const ev of this.queue) {
      if (ev.down) {
        if (!this.heldKeys.has(ev.key)) {
          this.downNow.add(ev.key);
          keyEvents.push(ev);
        }
        this.heldKeys.add(ev.key);
      } else if (this.heldKeys.delete(ev.key)) {
        this.upNow.add(ev.key);
        keyEvents.push(ev);
      }
    }
    this.queue.length = 0;
    this.applyPads();
    this.moved.copy(this.pendingMove);
    this.pendingMove.set(0, 0);
    this.scrolled.copy(this.pendingScroll);
    this.pendingScroll.set(0, 0);
    this.route();
    // Raw key and pointer-button events the game sees (after routing), for rebinding and recording.
    for (const ev of keyEvents) {
      const pointer = isMouseKey(ev.key);
      if (!this.gameSees(ev.key, ev.down ? this.uiDown : this.uiUp)) continue;
      this.rawEvents.push({
        device: pointer ? POINTER_DEVICE : KEYBOARD_DEVICE,
        control: pointer ? `<Pointer>/button${ev.key.slice(5)}` : `<Keyboard>/${ev.key}`,
        value: ev.down ? 1 : 0,
        time: ev.time,
      });
    }
    this.rawEvents.sort((a, b) => a.time - b.time);
  }

  private applyPads(): void {
    this.padsConnected.length = 0;
    this.padsDisconnected.length = 0;
    for (const pad of this.pads.values()) pad.down = pad.up = 0;
    for (const ev of this.padQueue) {
      if (ev.kind === "connect") {
        if (this.pads.has(ev.info.id)) continue;
        const pad: GamepadSnapshot = {
          info: ev.info,
          family: ev.info.family ?? "generic",
          buttons: new Float32Array(GAMEPAD_BUTTONS.length),
          axes: new Float32Array(GAMEPAD_AXES.length),
          held: 0,
          down: 0,
          up: 0,
          gyro: new Float32Array(3),
          accel: new Float32Array(3),
        };
        this.pads.set(ev.info.id, pad);
        this.padsConnected.push(pad);
        continue;
      }
      const pad = this.pads.get(ev.id);
      if (!pad) continue;
      if (ev.kind === "disconnect") {
        this.pads.delete(ev.id);
        this.padsDisconnected.push(pad);
      } else if (ev.kind === "button") {
        pad.buttons[ev.index] = ev.value;
        const bit = 1 << ev.index;
        const pressed = ev.value >= PRESS_POINT;
        if (pressed && !(pad.held & bit)) {
          pad.held |= bit;
          pad.down |= bit;
          this.rawEvents.push({ device: ev.id, control: `<Gamepad>/${GAMEPAD_BUTTONS[ev.index]}`, value: ev.value, time: ev.time });
        } else if (!pressed && pad.held & bit) {
          pad.held &= ~bit;
          pad.up |= bit;
          this.rawEvents.push({ device: ev.id, control: `<Gamepad>/${GAMEPAD_BUTTONS[ev.index]}`, value: ev.value, time: ev.time });
        }
      } else if (ev.kind === "axis") {
        const before = pad.axes[ev.index];
        pad.axes[ev.index] = ev.value;
        // An axis crossing the press point counts as an event (rebinding a stick direction).
        if (Math.abs(ev.value) >= PRESS_POINT && (Math.abs(before) < PRESS_POINT || Math.sign(ev.value) !== Math.sign(before))) {
          this.rawEvents.push({ device: ev.id, control: `<Gamepad>/${GAMEPAD_AXES[ev.index]}`, value: ev.value, time: ev.time });
        }
      } else {
        const v = ev.sensor === "gyro" ? pad.gyro : pad.accel;
        v[0] = ev.x;
        v[1] = ev.y;
        v[2] = ev.z;
      }
    }
    this.padQueue.length = 0;
  }

  /** Call `poll` at the start of every snapshot (adapters that poll their devices). Returns its removal. */
  addPoller(poll: () => void): () => void {
    this.pollers.add(poll);
    return () => void this.pollers.delete(poll);
  }

  /** Run `router` in every snapshot, after the devices are read and before any World steps. Returns its removal. */
  addRouter(router: InputRouter): () => void {
    this.routers.push(router);
    return () => {
      const i = this.routers.indexOf(router);
      if (i >= 0) this.routers.splice(i, 1);
    };
  }

  private route(): void {
    this.pointerToUI = false;
    this.keyboardToUI = false;
    this.uiDown.clear();
    this.uiUp.clear();
    const frame: PointerFrame = {
      x: this.pointer.x,
      y: this.pointer.y,
      down: (b) => this.downNow.has(mouseKey(b)),
      held: (b) => this.heldKeys.has(mouseKey(b)),
      up: (b) => this.upNow.has(mouseKey(b)),
    };
    for (const router of [...this.routers]) {
      try {
        const claim = router(frame);
        if (claim?.pointer) this.pointerToUI = true;
        if (claim?.keyboard) this.keyboardToUI = true;
      } catch (err) {
        console.error("[myco] UI input routing failed:", err);
      }
    }
    for (const k of this.downNow) {
      if (!isMouseKey(k)) continue;
      if (this.pointerToUI) {
        this.uiDown.add(k);
        this.uiHeld.add(k);
      } else this.uiHeld.delete(k); // pressed in the game: the game's until released
    }
    for (const k of this.upNow) if (this.uiHeld.delete(k)) this.uiUp.add(k);
    for (const k of this.uiHeld) if (!this.heldKeys.has(k)) this.uiHeld.delete(k);
  }

  /** Forget everything held and queued (the devices were detached). */
  reset(): void {
    this.padQueue.length = 0;
    this.rawEvents.length = 0;
    for (const pad of this.pads.values()) {
      pad.buttons.fill(0);
      pad.axes.fill(0);
      pad.held = pad.down = pad.up = 0;
    }
    this.heldKeys.clear();
    this.downNow.clear();
    this.upNow.clear();
    this.queue.length = 0;
    this.moved.set(0, 0);
    this.pendingMove.set(0, 0);
    this.scrolled.set(0, 0);
    this.pendingScroll.set(0, 0);
    this.pointerToUI = false;
    this.keyboardToUI = false;
    this.uiHeld.clear();
    this.uiDown.clear();
    this.uiUp.clear();
  }

  // --- Reading end: what the game sees after routing -------------------------------------------

  /** False for a key the UI took: a mouse button in `uiTook`, or any other key while a text field is focused. */
  private gameSees(k: string, uiTook: Set<string>): boolean {
    return isMouseKey(k) ? !uiTook.has(k) : !this.keyboardToUI;
  }

  /** Held, including the frame it went down. `key` is normalized. */
  isHeld(key: string): boolean {
    return (this.heldKeys.has(key) || this.downNow.has(key)) && this.gameSees(key, this.uiHeld) && this.gameSees(key, this.uiDown);
  }

  wentDown(key: string): boolean {
    return this.downNow.has(key) && this.gameSees(key, this.uiDown);
  }

  wentUp(key: string): boolean {
    return this.upNow.has(key) && this.gameSees(key, this.uiUp);
  }

  get anyDown(): boolean {
    for (const k of this.downNow) if (this.gameSees(k, this.uiDown)) return true;
    return false;
  }

  get pointerOverUI(): boolean {
    return this.pointerToUI;
  }

  get keyboardOverUI(): boolean {
    return this.keyboardToUI;
  }

  /** Copies. */
  get pointerPosition(): Vector2 {
    return this.pointer.clone();
  }

  get movement(): Vector2 {
    return this.moved.clone();
  }

  get scrolling(): Vector2 {
    return this.scrolled.clone();
  }

  /** This frame's movement and scroll, without copying (CSS pixels, +y down). */
  get movementX(): number {
    return this.moved.x;
  }
  get movementY(): number {
    return this.moved.y;
  }
  get scrollX(): number {
    return this.scrolled.x;
  }
  get scrollY(): number {
    return this.scrolled.y;
  }
  get pointerX(): number {
    return this.pointer.x;
  }
  get pointerY(): number {
    return this.pointer.y;
  }

  /** The connected gamepads. */
  gamepads(): IterableIterator<GamepadSnapshot> {
    return this.pads.values();
  }

  gamepad(id: number): GamepadSnapshot | undefined {
    return this.pads.get(id);
  }

  /** Gamepads connected, and disconnected, in this snapshot. */
  get connectedThisFrame(): readonly GamepadSnapshot[] {
    return this.padsConnected;
  }
  get disconnectedThisFrame(): readonly GamepadSnapshot[] {
    return this.padsDisconnected;
  }

  /** This frame's raw device events the game sees, oldest first. */
  get events(): readonly RawDeviceEvent[] {
    return this.rawEvents;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : Number.isFinite(v) ? v : 0;
}

/** The Engine's devices. */
export const devices = new DeviceSnapshot();
