/**
 * The device snapshot (ADR 0310, 0335): the Engine's one keyboard and pointer, its touchscreen and
 * pen, and its gamepads, shared by its Worlds.
 *
 * - **Input end** (`DeviceEventSink`): adapters (the DOM listener, `domDevices.ts`; the gamepad
 *   adapters, `webGamepads.ts` and `tauriGamepads.ts`) report device events as they happen; keys,
 *   buttons, movement, scroll, touches, pen samples and gamepad changes queue, timestamped, until
 *   the next snapshot.
 * - **Snapshot** (`beginFrame`, ADR 0011 step 2): once per Engine frame, applies the queue, then the
 *   routing step. A key, button or touch reads down in a frame it's held at the end of or went down
 *   in (a tap between two frames isn't lost), and the queue is applied so that every press shows
 *   (ADR 0336, build notes): **one press per control per frame, with a frame that reads it up between
 *   two** (a press of a control that read down this frame or last waits for the next frame), and
 *   **every press with what was held at that moment** (a key or button held when another went down
 *   this frame keeps reading held: its release waits for the next frame, so a chord's modifier lifted
 *   after its key still counts). An event that waits keeps its place: it and every event queued after
 *   it (on that device kind) are applied from the next frame, in order. So N presses of one key
 *   inside a frame play out over the next 2N frames, none merged or lost.
 * - **Routing step** (ADR 0069): each router (the UI core) is handed what the pointer did this frame
 *   and answers what it claims; this frame's mouse presses over claimed UI then go to the UI until
 *   they're released, and so do the primary touch and the pen's buttons pressed in that frame (the
 *   DOM adapter reports them as the pointer too).
 * - **Reading end**: what the game sees after routing, which the `Input` getters and each World's
 *   input systems (`deviceEntities.ts`, ADR 0335) read, plus the frame's raw device events.
 *
 * Nothing here is public API: scripts read `Input` and actions; `Input.inject` is the input end.
 */
import { Vector2 } from "../core/math";
import { GAMEPAD_AXES, GAMEPAD_BUTTONS, PEN_BUTTONS, PRESS_POINT, TOUCHPAD_FINGERS, TOUCH_SLOTS, normalizeKey, type DeviceFamily } from "./controls";
import type { TriggerEffect } from "./triggerEffects";

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
  /** An adaptive trigger effect (DualSense through WebHID). */
  triggerEffect?(id: number, trigger: "left" | "right", effect: TriggerEffect): void;
  setLed?(id: number, r: number, g: number, b: number): void;
  setSensors?(id: number, enabled: boolean): void;
}

/** The device id the keyboard, pointer, touchscreen and pen have in raw events (gamepads have their adapter's ids, ≥ 0). */
export const KEYBOARD_DEVICE = -1;
export const POINTER_DEVICE = -2;
export const TOUCH_DEVICE = -3;
export const PEN_DEVICE = -4;

/** A swipe: the primary touch lifted within this many seconds of touching down… */
export const SWIPE_MAX_SECONDS = 0.5;
/** …at least this many CSS pixels from where it touched down. */
export const SWIPE_MIN_DISTANCE = 40;

/** Bit `PRIMARY_TOUCH` of the touch bitmasks is the primary touch; bits 0–9 are fingers by slot. */
export const PRIMARY_TOUCH = TOUCH_SLOTS;

/** One raw device event of this frame, after routing (`DeviceEvents`, rebinding, recording). */
export interface RawDeviceEvent {
  /** `KEYBOARD_DEVICE`, `POINTER_DEVICE`, `TOUCH_DEVICE`, `PEN_DEVICE`, or a gamepad's id. */
  readonly device: number;
  /** A control path: `<Keyboard>/space`, `<Pointer>/button0`, `<Gamepad>/buttonSouth`, `<Gamepad>/leftStickX`, `<Gamepad>/touchpad0`, `<Touch>/touch0`, `<Pen>/tip`. */
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
  /** Touchpad fingers (bit i: finger i): touching, touched down this frame, lifted this frame. */
  touchHeld: number;
  touchDown: number;
  touchUp: number;
  /** Each finger's position, 0..1 of the touchpad (origin top-left, +Y down); its last one after it lifts. */
  readonly touchX: Float32Array;
  readonly touchY: Float32Array;
  /** Battery charge 0..1, or -1 when unknown (or wired without a battery). */
  battery: number;
  /** Plugged in and charging (or full). */
  charging: boolean;
}

/**
 * The touchscreen as the game sees it this frame (after routing). Fingers keep the slot they took
 * when they touched down (the lowest free one) until they lift. The **primary** touch is the one
 * that touched down when no other finger was down; it stays primary until it lifts, and the next
 * primary is the next finger down after every finger has lifted (the browser's `isPrimary`).
 */
export interface TouchscreenSnapshot {
  /** Bits 0–9: the finger in that slot is down (held), touched down this frame, lifted this frame; bit 10 (`PRIMARY_TOUCH`): the primary touch. */
  readonly held: number;
  readonly down: number;
  readonly up: number;
  /** Fingers down. */
  readonly count: number;
  /** Each slot's position in canvas pixels (its last one after it lifts). */
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly primaryX: number;
  readonly primaryY: number;
  /** The primary touch's movement this frame, CSS pixels, +Y down. */
  readonly primaryDeltaX: number;
  readonly primaryDeltaY: number;
  /** How much the distance between the two lowest-slot fingers grew this frame, CSS pixels (negative: pinching in). */
  readonly pinch: number;
  /**
   * A swipe ended this frame: the primary touch's stroke from touch-down to lift, CSS pixels (+Y down), when it
   * was quick (`SWIPE_MAX_SECONDS`) and long enough (`SWIPE_MIN_DISTANCE`); 0 otherwise.
   */
  readonly swipeX: number;
  readonly swipeY: number;
}

/** The pen as the game sees it this frame (after routing). */
export interface PenSnapshot {
  /** Bit i: `PEN_BUTTONS[i]` (tip, barrel, eraser) held, went down this frame, went up this frame. */
  readonly held: number;
  readonly down: number;
  readonly up: number;
  /** Canvas pixels, and the movement this frame (+Y down). */
  readonly x: number;
  readonly y: number;
  readonly deltaX: number;
  readonly deltaY: number;
  /** 0..1 (0 while hovering). */
  readonly pressure: number;
  /** -1..1 (±90°): +X tilted right, +Y tilted toward the user (the W3C convention). */
  readonly tiltX: number;
  readonly tiltY: number;
  /** Rotation about its own axis, 0..1 of a turn. */
  readonly twist: number;
  /** Hovering or touching within range. */
  readonly inRange: boolean;
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
  /** A gamepad touchpad finger (0 or 1): down, and where, normalized 0..1 with (0, 0) top-left. */
  gamepadTouch(id: number, finger: number, down: boolean, x: number, y: number): void;
  /** A gamepad's battery: level 0..1 (-1 unknown), and whether it's charging. */
  gamepadBattery(id: number, level: number, charging: boolean): void;
  /**
   * A touchpad finger (0 or 1; DualSense, DualShock 4): `down` while it touches (each move reports
   * it again), false when it lifts. `x`, `y` are 0..1 of the touchpad, origin top-left, +Y down.
   */
  gamepadTouch(id: number, finger: number, down: boolean, x: number, y: number): void;
  /** The battery: `level` 0..1, or -1 when unknown or wired without a battery; `charging` while plugged in. */
  gamepadBattery(id: number, level: number, charging: boolean): void;
  /**
   * A finger touched the touchscreen at canvas pixels. `id` is the adapter's (the DOM's `pointerId`),
   * the same until it lifts. The DOM adapter also reports the primary touch as the pointer.
   */
  touchStart(id: number, x: number, y: number): void;
  touchMove(id: number, x: number, y: number): void;
  /** The finger lifted (or the browser cancelled it) at canvas pixels. */
  touchEnd(id: number, x: number, y: number): void;
  /**
   * Where the pen is, hovering or touching: canvas pixels, pressure 0..1, tilt in degrees (-90..90,
   * +X right, +Y toward the user) and twist in degrees (0..359), as a `PointerEvent` reports them.
   * The DOM adapter also reports the pen as the pointer.
   */
  penAt(x: number, y: number, pressure: number, tiltX: number, tiltY: number, twist: number): void;
  /** A pen button: 0 the tip touching, 1 the barrel button, 2 the eraser touching (`PEN_BUTTONS`). */
  penButtonDown(button: number): void;
  penButtonUp(button: number): void;
  /** The pen left the range where it's sensed: its buttons are released. */
  penLeave(): void;
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

/**
 * What a router takes this frame: the pointer (it's over interactable UI), the keyboard (a text field
 * is typing), and single key presses (`keys`: Tab or Escape that left a text field), which stay the
 * UI's until released.
 */
export interface InputClaim {
  readonly pointer?: boolean;
  readonly keyboard?: boolean;
  readonly keys?: readonly string[];
}

export type InputRouter = (pointer: PointerFrame) => InputClaim | void;

/** The key name `Input` gives a pointer button. */
export const mouseKey = (button: number): string => `mouse${button}`;
const isMouseKey = (k: string) => /^mouse\d+$/.test(k);

/** A key or pointer button change; a pointer button's carries where the pointer was then (`x`, `y`, canvas pixels). */
type QueuedEvent = { down: boolean; key: string; time: number; x?: number; y?: number };

type PadEvent =
  | { kind: "connect"; info: GamepadInfo; time: number }
  | { kind: "disconnect"; id: number; time: number }
  | { kind: "button"; id: number; index: number; value: number; time: number }
  | { kind: "axis"; id: number; index: number; value: number; time: number }
  | { kind: "sensor"; id: number; sensor: "gyro" | "accel"; x: number; y: number; z: number; time: number }
  | { kind: "touch"; id: number; finger: number; down: boolean; x: number; y: number; time: number }
  | { kind: "battery"; id: number; level: number; charging: boolean; time: number };

type TouchEvent = { kind: "start" | "move" | "end"; id: number; x: number; y: number; time: number };

type PenEvent =
  | { kind: "at"; x: number; y: number; pressure: number; tiltX: number; tiltY: number; twist: number; time: number }
  | { kind: "down" | "up"; bit: number; time: number }
  | { kind: "leave"; time: number };

const PRIMARY = 1 << PRIMARY_TOUCH;

/** The touchscreen's state before routing. */
class Touchscreen {
  readonly queue: TouchEvent[] = [];
  /** Each slot's adapter id (-1: free). A slot freed this frame is reused from the next. */
  readonly ids = new Int32Array(TOUCH_SLOTS).fill(-1);
  held = 0;
  down = 0;
  up = 0;
  /** Bits lifted this frame: their slots are freed, and the UI's claim on them dropped, next frame. */
  ended = 0;
  /** Bits the UI took (the primary touch and its finger, pressed over UI) until they lift. */
  ui = 0;
  primaryId = -1;
  primarySlot = -1;
  dx = 0;
  dy = 0;
  pinchA = -1;
  pinchB = -1;
  pinchDistance = 0;
  /** This frame's touch-downs and lifts, by slot, for the raw events. */
  readonly changes: { slot: number; value: number; time: number }[] = [];
  /** What the game sees. */
  readonly view = { held: 0, down: 0, up: 0, count: 0, x: new Float32Array(TOUCH_SLOTS), y: new Float32Array(TOUCH_SLOTS), primaryX: 0, primaryY: 0, primaryDeltaX: 0, primaryDeltaY: 0, pinch: 0, swipeX: 0, swipeY: 0 };
  /** Where and when the primary touch touched down (swipes), and this frame's swipe. */
  private startX = 0;
  private startY = 0;
  private startTime = 0;
  private sx = 0;
  private sy = 0;

  slotOf(id: number): number {
    for (let i = 0; i < TOUCH_SLOTS; i++) if (this.ids[i] === id && this.held & (1 << i)) return i;
    return -1;
  }

  apply(): void {
    const v = this.view;
    for (let i = 0; i < TOUCH_SLOTS; i++) if (this.ended & (1 << i)) this.ids[i] = -1;
    this.ui &= ~this.ended;
    const lastDown = this.down;
    this.ended = this.down = this.up = 0;
    this.dx = this.dy = 0;
    this.sx = this.sy = 0;
    this.changes.length = 0;
    let applied = 0;
    for (; applied < this.queue.length; applied++) {
      const ev = this.queue[applied];
      if (ev.kind === "start") {
        if (this.slotOf(ev.id) >= 0) continue;
        let slot = -1;
        for (let i = 0; i < TOUCH_SLOTS && slot < 0; i++) if (this.ids[i] === -1) slot = i;
        if (slot < 0) continue; // more fingers than slots
        const bit = 1 << slot;
        // One press per frame (the keys' rule): a touch that would take a slot, or be the primary touch, read down
        // this frame or last waits, with the events after it, for the next frame.
        const primary = this.primaryId === -1 && (this.held & ~PRIMARY) === 0;
        if ((lastDown | this.down | this.up) & (bit | (primary ? PRIMARY : 0))) break;
        this.ids[slot] = ev.id;
        this.held |= bit;
        this.down |= bit;
        v.x[slot] = ev.x;
        v.y[slot] = ev.y;
        this.changes.push({ slot, value: 1, time: ev.time });
        if (this.primaryId === -1 && (this.held & ~bit & ~PRIMARY) === 0) {
          this.primaryId = ev.id;
          this.primarySlot = slot;
          this.held |= PRIMARY;
          this.down |= PRIMARY;
          v.primaryX = ev.x;
          v.primaryY = ev.y;
          this.startX = ev.x;
          this.startY = ev.y;
          this.startTime = ev.time;
        }
        continue;
      }
      const slot = this.slotOf(ev.id);
      if (slot < 0) continue;
      if (ev.id === this.primaryId) {
        this.dx += ev.x - v.primaryX;
        this.dy += ev.y - v.primaryY;
        v.primaryX = ev.x;
        v.primaryY = ev.y;
      }
      v.x[slot] = ev.x;
      v.y[slot] = ev.y;
      if (ev.kind === "end") {
        const bit = 1 << slot;
        this.held &= ~bit;
        this.up |= bit;
        this.ended |= bit;
        this.changes.push({ slot, value: 0, time: ev.time });
        if (ev.id === this.primaryId) {
          const sx = ev.x - this.startX;
          const sy = ev.y - this.startY;
          if ((ev.time - this.startTime) / 1000 <= SWIPE_MAX_SECONDS && Math.hypot(sx, sy) >= SWIPE_MIN_DISTANCE) {
            this.sx += sx;
            this.sy += sy;
          }
          this.primaryId = -1;
          this.held &= ~PRIMARY;
          this.up |= PRIMARY;
          this.ended |= PRIMARY;
        }
      }
    }
    this.queue.splice(0, applied);
  }

  /** After routing: the primary touch pressed this frame over claimed UI is the UI's until it lifts. */
  route(pointerToUI: boolean): void {
    if (pointerToUI && this.down & PRIMARY) this.ui |= PRIMARY | (1 << this.primarySlot);
    const v = this.view;
    const game = ~this.ui;
    v.held = this.held & game;
    v.down = this.down & game;
    v.up = this.up & game;
    v.count = 0;
    let a = -1;
    let b = -1;
    for (let i = 0; i < TOUCH_SLOTS; i++) {
      if (!(v.held & (1 << i))) continue;
      v.count++;
      if (a < 0) a = i;
      else if (b < 0) b = i;
    }
    v.primaryDeltaX = this.dx;
    v.primaryDeltaY = this.dy;
    // A swipe whose touch the UI took is the UI's.
    const uiPrimary = (this.ui & PRIMARY) !== 0;
    v.swipeX = uiPrimary ? 0 : this.sx;
    v.swipeY = uiPrimary ? 0 : this.sy;
    // Pinch: the change in distance between the same two fingers since last frame.
    v.pinch = 0;
    if (b >= 0) {
      const d = Math.hypot(v.x[b] - v.x[a], v.y[b] - v.y[a]);
      if (this.pinchA === this.ids[a] && this.pinchB === this.ids[b]) v.pinch = d - this.pinchDistance;
      this.pinchA = this.ids[a];
      this.pinchB = this.ids[b];
      this.pinchDistance = d;
    } else this.pinchA = this.pinchB = -1;
  }

  /** Lift every finger (the devices lost focus). */
  releaseAll(time: number): void {
    for (let i = 0; i < TOUCH_SLOTS; i++) if (this.held & (1 << i)) this.queue.push({ kind: "end", id: this.ids[i], x: this.view.x[i], y: this.view.y[i], time });
    // Touches whose start still waits in the queue without their end.
    const waiting = new Map<number, TouchEvent>();
    for (const ev of this.queue) {
      if (ev.kind === "end") waiting.delete(ev.id);
      else waiting.set(ev.id, ev);
    }
    for (const [id, ev] of waiting) if (this.slotOf(id) < 0) this.queue.push({ kind: "end", id, x: ev.x, y: ev.y, time });
  }

  reset(): void {
    this.queue.length = 0;
    this.ids.fill(-1);
    this.held = this.down = this.up = this.ended = this.ui = 0;
    this.primaryId = this.primarySlot = this.pinchA = this.pinchB = -1;
    this.dx = this.dy = 0;
    this.changes.length = 0;
    const v = this.view;
    v.held = v.down = v.up = v.count = 0;
    v.primaryDeltaX = v.primaryDeltaY = v.pinch = 0;
  }
}

/** The pen's state before routing. */
class Pen {
  readonly queue: PenEvent[] = [];
  held = 0;
  down = 0;
  up = 0;
  /** Buttons the UI took (pressed in a frame the pointer was over UI) until they're released. */
  ui = 0;
  readonly changes: { bit: number; value: number; time: number }[] = [];
  readonly view = { held: 0, down: 0, up: 0, x: 0, y: 0, deltaX: 0, deltaY: 0, pressure: 0, tiltX: 0, tiltY: 0, twist: 0, inRange: false };

  apply(): void {
    const v = this.view;
    this.ui &= this.held;
    const lastDown = this.down;
    this.down = this.up = 0;
    v.deltaX = v.deltaY = 0;
    this.changes.length = 0;
    const release = (bit: number, time: number) => {
      if (!(this.held & (1 << bit))) return;
      this.held &= ~(1 << bit);
      this.up |= 1 << bit;
      this.changes.push({ bit, value: 0, time });
    };
    let applied = 0;
    for (; applied < this.queue.length; applied++) {
      const ev = this.queue[applied];
      if (ev.kind === "at") {
        if (v.inRange) {
          v.deltaX += ev.x - v.x;
          v.deltaY += ev.y - v.y;
        }
        v.x = ev.x;
        v.y = ev.y;
        v.pressure = clamp(ev.pressure, 0, 1);
        v.tiltX = clamp(ev.tiltX / 90, -1, 1);
        v.tiltY = clamp(ev.tiltY / 90, -1, 1);
        v.twist = Number.isFinite(ev.twist) ? (((ev.twist % 360) + 360) % 360) / 360 : 0;
        v.inRange = true;
      } else if (ev.kind === "down") {
        const bit = 1 << ev.bit;
        if (this.held & bit) continue;
        // The keys' rules: one press per button per frame, and a button held while another went down stays held through it.
        if ((lastDown | this.down | this.up) & bit) break;
        this.held |= bit;
        this.down |= bit;
        this.changes.push({ bit: ev.bit, value: 1, time: ev.time });
      } else if (ev.kind === "up") {
        const bit = 1 << ev.bit;
        if (this.held & bit && this.down && !(this.down & bit)) break;
        release(ev.bit, ev.time);
      } else {
        for (let i = 0; i < PEN_BUTTONS.length; i++) release(i, ev.time);
        v.inRange = false;
        v.pressure = 0;
      }
    }
    this.queue.splice(0, applied);
  }

  /** After routing: buttons pressed this frame while the pointer is over claimed UI are the UI's until released. */
  route(pointerToUI: boolean): void {
    if (pointerToUI) this.ui |= this.down;
    const v = this.view;
    v.held = this.held & ~this.ui;
    v.down = this.down & ~this.ui;
    v.up = this.up & ~this.ui;
  }

  releaseAll(time: number): void {
    // Held buttons, and buttons whose press still waits in the queue without its release.
    let down = this.held;
    for (const ev of this.queue) {
      if (ev.kind === "down") down |= 1 << ev.bit;
      else if (ev.kind === "up") down &= ~(1 << ev.bit);
      else if (ev.kind === "leave") down = 0;
    }
    for (let i = 0; i < PEN_BUTTONS.length; i++) if (down & (1 << i)) this.queue.push({ kind: "up", bit: i, time });
  }

  reset(): void {
    this.queue.length = 0;
    this.held = this.down = this.up = this.ui = 0;
    this.changes.length = 0;
    const v = this.view;
    v.held = v.down = v.up = 0;
    v.deltaX = v.deltaY = v.pressure = 0;
    v.inRange = false;
  }
}

class DeviceSnapshot implements DeviceEventSink {
  private readonly queue: QueuedEvent[] = [];
  private readonly heldKeys = new Set<string>();
  private readonly downNow = new Set<string>();
  private readonly upNow = new Set<string>();
  /** Last frame's `downNow`: a key read down then (pressed, maybe released too) isn't pressed again until a frame reads it up. */
  private readonly lastDown = new Set<string>();
  private readonly pointer = new Vector2();
  /**
   * Where the pointer was at the last pointer button change applied this frame, or null when none was: the frame's
   * pointer position then, so a press or release that waited in the queue reads where it happened, not where the
   * pointer has moved since (two quick taps on two buttons during a long frame each hit their own).
   */
  private pressAt: Vector2 | null = null;
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
  /** Keys whose press a router took (`InputClaim.keys`): the game doesn't see them until they're released, nor the release. */
  private readonly uiKeys = new Set<string>();
  private readonly uiKeyUp = new Set<string>();
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
  /** True once an adapter has reported a touch, or a pen, until the devices are reset. */
  hasTouch = false;
  hasPen = false;
  private readonly touchscreen = new Touchscreen();
  private readonly penDevice = new Pen();
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
    this.queue.push({ down: true, key: mouseKey(button), time: now(), x: this.pointer.x, y: this.pointer.y });
  }

  buttonUp(button: number): void {
    this.queue.push({ down: false, key: mouseKey(button), time: now(), x: this.pointer.x, y: this.pointer.y });
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
    // Held keys, and keys whose press still waits in the queue without its release.
    const down = new Set(this.heldKeys);
    for (const ev of this.queue) {
      if (ev.down) down.add(ev.key);
      else down.delete(ev.key);
    }
    for (const k of down) this.queue.push(isMouseKey(k) ? { down: false, key: k, time, x: this.pointer.x, y: this.pointer.y } : { down: false, key: k, time });
    this.touchscreen.releaseAll(time);
    this.penDevice.releaseAll(time);
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

  gamepadTouch(id: number, finger: number, down: boolean, x: number, y: number): void {
    if (Number.isInteger(finger) && finger >= 0 && finger < TOUCHPAD_FINGERS) this.padQueue.push({ kind: "touch", id, finger, down: !!down, x: clamp(x, 0, 1), y: clamp(y, 0, 1), time: now() });
  }

  gamepadBattery(id: number, level: number, charging: boolean): void {
    const known = Number.isFinite(level) && level >= 0;
    this.padQueue.push({ kind: "battery", id, level: known ? Math.min(1, level) : -1, charging: !!charging, time: now() });
  }

  touchStart(id: number, x: number, y: number): void {
    this.hasTouch = true;
    this.touchscreen.queue.push({ kind: "start", id, x, y, time: now() });
  }

  touchMove(id: number, x: number, y: number): void {
    this.hasTouch = true;
    this.touchscreen.queue.push({ kind: "move", id, x, y, time: now() });
  }

  touchEnd(id: number, x: number, y: number): void {
    this.hasTouch = true;
    this.touchscreen.queue.push({ kind: "end", id, x, y, time: now() });
  }

  penAt(x: number, y: number, pressure: number, tiltX: number, tiltY: number, twist: number): void {
    this.hasPen = true;
    this.penDevice.queue.push({ kind: "at", x, y, pressure, tiltX, tiltY, twist, time: now() });
  }

  penButtonDown(button: number): void {
    this.hasPen = true;
    if (button >= 0 && button < PEN_BUTTONS.length) this.penDevice.queue.push({ kind: "down", bit: button, time: now() });
  }

  penButtonUp(button: number): void {
    this.hasPen = true;
    if (button >= 0 && button < PEN_BUTTONS.length) this.penDevice.queue.push({ kind: "up", bit: button, time: now() });
  }

  penLeave(): void {
    this.hasPen = true;
    this.penDevice.queue.push({ kind: "leave", time: now() });
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
    this.lastDown.clear();
    for (const k of this.downNow) this.lastDown.add(k);
    this.downNow.clear();
    this.upNow.clear();
    this.rawEvents.length = 0;
    const keyEvents: QueuedEvent[] = [];
    this.pressAt = null;
    // One press per key per frame, each with the keys held at that moment (see the module comment): an event that
    // would break that waits, with every event after it, for the next frame.
    let applied = 0;
    for (; applied < this.queue.length; applied++) {
      const ev = this.queue[applied];
      if (ev.down) {
        if (this.heldKeys.has(ev.key)) continue;
        if (this.downNow.has(ev.key) || this.upNow.has(ev.key) || this.lastDown.has(ev.key)) break;
        this.downNow.add(ev.key);
        this.heldKeys.add(ev.key);
        keyEvents.push(ev);
        this.notePress(ev);
      } else if (this.heldKeys.has(ev.key)) {
        if (this.downNow.size > 0 && !this.downNow.has(ev.key)) break;
        this.heldKeys.delete(ev.key);
        this.upNow.add(ev.key);
        keyEvents.push(ev);
        this.notePress(ev);
      }
    }
    this.queue.splice(0, applied);
    this.applyPads();
    this.touchscreen.apply();
    this.penDevice.apply();
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
    const touch = this.touchscreen;
    for (const c of touch.changes) if (!(touch.ui & (1 << c.slot))) this.rawEvents.push({ device: TOUCH_DEVICE, control: `<Touch>/touch${c.slot}`, value: c.value, time: c.time });
    const pen = this.penDevice;
    for (const c of pen.changes) if (!(pen.ui & (1 << c.bit))) this.rawEvents.push({ device: PEN_DEVICE, control: `<Pen>/${PEN_BUTTONS[c.bit]}`, value: c.value, time: c.time });
    this.rawEvents.sort((a, b) => a.time - b.time);
  }

  private applyPads(): void {
    this.padsConnected.length = 0;
    this.padsDisconnected.length = 0;
    // Last frame's presses (buttons, touchpad fingers), for the one-press-per-frame rule the keys follow.
    const lastDown = new Map<GamepadSnapshot, [number, number]>();
    for (const pad of this.pads.values()) {
      lastDown.set(pad, [pad.down, pad.touchDown]);
      pad.down = pad.up = pad.touchDown = pad.touchUp = 0;
    }
    let applied = 0;
    for (; applied < this.padQueue.length; applied++) {
      const ev = this.padQueue[applied];
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
          touchHeld: 0,
          touchDown: 0,
          touchUp: 0,
          touchX: new Float32Array(TOUCHPAD_FINGERS),
          touchY: new Float32Array(TOUCHPAD_FINGERS),
          battery: -1,
          charging: false,
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
        const bit = 1 << ev.index;
        const pressed = ev.value >= PRESS_POINT;
        if (pressed && !(pad.held & bit) && (pad.down | pad.up | (lastDown.get(pad)?.[0] ?? 0)) & bit) break;
        if (!pressed && pad.held & bit && pad.down && !(pad.down & bit)) break;
        pad.buttons[ev.index] = ev.value;
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
      } else if (ev.kind === "touch") {
        const bit = 1 << ev.finger;
        if (ev.down && !(pad.touchHeld & bit) && (pad.touchDown | pad.touchUp | (lastDown.get(pad)?.[1] ?? 0)) & bit) break;
        pad.touchX[ev.finger] = ev.x;
        pad.touchY[ev.finger] = ev.y;
        const control = `<Gamepad>/touchpad${ev.finger}`;
        if (ev.down && !(pad.touchHeld & bit)) {
          pad.touchHeld |= bit;
          pad.touchDown |= bit;
          this.rawEvents.push({ device: ev.id, control, value: 1, time: ev.time });
        } else if (!ev.down && pad.touchHeld & bit) {
          pad.touchHeld &= ~bit;
          pad.touchUp |= bit;
          this.rawEvents.push({ device: ev.id, control, value: 0, time: ev.time });
        }
      } else if (ev.kind === "battery") {
        pad.battery = ev.level;
        pad.charging = ev.charging;
      } else {
        const v = ev.sensor === "gyro" ? pad.gyro : pad.accel;
        v[0] = ev.x;
        v[1] = ev.y;
        v[2] = ev.z;
      }
    }
    this.padQueue.splice(0, applied);
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

  private notePress(ev: QueuedEvent): void {
    if (ev.x !== undefined && ev.y !== undefined) (this.pressAt ??= new Vector2()).set(ev.x, ev.y);
  }

  /** The frame's pointer: where the last applied pointer button change happened, else where the pointer is. */
  private get framePointer(): Vector2 {
    return this.pressAt ?? this.pointer;
  }

  private route(): void {
    this.pointerToUI = false;
    this.keyboardToUI = false;
    this.uiDown.clear();
    this.uiUp.clear();
    const frame: PointerFrame = {
      x: this.framePointer.x,
      y: this.framePointer.y,
      down: (b) => this.downNow.has(mouseKey(b)),
      held: (b) => this.heldKeys.has(mouseKey(b)),
      up: (b) => this.upNow.has(mouseKey(b)),
    };
    for (const router of [...this.routers]) {
      try {
        const claim = router(frame);
        if (claim?.pointer) this.pointerToUI = true;
        if (claim?.keyboard) this.keyboardToUI = true;
        for (const k of claim?.keys ?? []) this.uiKeys.add(normalizeKey(k));
      } catch (err) {
        console.error("[myco] UI input routing failed:", err);
      }
    }
    this.uiKeyUp.clear();
    for (const k of this.uiKeys) {
      if (this.heldKeys.has(k) || this.downNow.has(k)) continue;
      this.uiKeys.delete(k);
      if (this.upNow.has(k)) this.uiKeyUp.add(k);
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
    this.touchscreen.route(this.pointerToUI);
    this.penDevice.route(this.pointerToUI);
  }

  /** Forget everything held and queued (the devices were detached). */
  reset(): void {
    this.padQueue.length = 0;
    this.rawEvents.length = 0;
    for (const pad of this.pads.values()) {
      pad.buttons.fill(0);
      pad.axes.fill(0);
      pad.held = pad.down = pad.up = 0;
      pad.touchHeld = pad.touchDown = pad.touchUp = 0;
    }
    this.heldKeys.clear();
    this.downNow.clear();
    this.upNow.clear();
    this.lastDown.clear();
    this.queue.length = 0;
    this.pressAt = null;
    this.moved.set(0, 0);
    this.pendingMove.set(0, 0);
    this.scrolled.set(0, 0);
    this.pendingScroll.set(0, 0);
    this.pointerToUI = false;
    this.keyboardToUI = false;
    this.uiHeld.clear();
    this.uiDown.clear();
    this.uiUp.clear();
    this.uiKeys.clear();
    this.uiKeyUp.clear();
    this.touchscreen.reset();
    this.penDevice.reset();
    this.hasTouch = this.hasPen = false;
  }

  // --- Reading end: what the game sees after routing -------------------------------------------

  /** False for a key the UI took: a mouse button in `uiTook`, a key press a router claimed (until released), or any other key while a text field is focused. */
  private gameSees(k: string, uiTook: Set<string>): boolean {
    return isMouseKey(k) ? !uiTook.has(k) : !this.keyboardToUI && !this.uiKeys.has(k) && !this.uiKeyUp.has(k);
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
    return this.framePointer.clone();
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
    return this.framePointer.x;
  }
  get pointerY(): number {
    return this.framePointer.y;
  }

  /** The touchscreen this frame, after routing. */
  get touch(): TouchscreenSnapshot {
    return this.touchscreen.view;
  }

  /** The pen this frame, after routing. */
  get pen(): PenSnapshot {
    return this.penDevice.view;
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
