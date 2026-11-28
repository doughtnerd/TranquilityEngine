import { Vector2 } from "../core/math";
import { World } from "../core/World";
import { devices, mouseKey, normalizeKey, type DeviceEventSink } from "./devices";
import { listenToDom } from "./domDevices";
import { tauriGamepads } from "./tauriGamepads";
import { webGamepads } from "./webGamepads";
import { webHidGamepads, type WebHidGamepads } from "./webHid/webHidGamepads";
// The input systems (ADR 0335–0337) come with Input: players, evaluation, rebinding, netcode, the script facade.
import "./players";
import "./evaluate";
import "./rebind";
import "./inputNet";
import "./facade";

let detachDom: (() => void) | null = null;
let detachGamepads: (() => void) | null = null;
/** The WebHID adapter, where the browser has WebHID (never under Tauri). */
let hidGamepads: WebHidGamepads | null = null;

/**
 * The devices are the Engine's, attached once and shared; what they report reaches only Worlds
 * that take local input (ADR 0032). A server World, or any World created with `input: false`,
 * sees nothing pressed and zero movement. Outside any World (no active World) input is live.
 * The editor's World reads these raw getters too (its tools), though it gets no device entities.
 */
function live(): boolean {
  return World.active?._takesInput ?? true;
}

/** Start the gamepad adapter: SDL3 under Tauri (ADR 0335), else the browser's Gamepad API. */
function attachGamepads(): void {
  if (detachGamepads || typeof window === "undefined") return;
  if ("__TAURI_INTERNALS__" in window) {
    const native = tauriGamepads(devices);
    devices.output = native.output;
    detachGamepads = native.stop;
    return;
  }
  if (typeof navigator === "undefined") return;
  // WebHID (Chromium) reports the controllers it opens; the Gamepad API reports the rest.
  const hid = webHidGamepads(devices, navigator);
  const web = webGamepads(devices, navigator, hid ? (pad) => hid.owns(pad) : undefined);
  if (!web && !hid) return;
  const removePoller = web ? devices.addPoller(web.poll) : null;
  devices.output = hid ? hid.output(web?.output ?? null) : web!.output;
  hidGamepads = hid;
  detachGamepads = () => {
    removePoller?.();
    web?.stop();
    hid?.stop();
    hidGamepads = null;
  };
}

/**
 * The input end (`Input.inject`): report device events as an adapter does. They reach the game
 * at the next snapshot, through the same routing, device entities and actions as real devices.
 */
const injector: DeviceEventSink = {
  keyDown: (key) => (keyboardAndPointer(), devices.keyDown(key)),
  keyUp: (key) => (keyboardAndPointer(), devices.keyUp(key)),
  buttonDown: (button) => (keyboardAndPointer(), devices.buttonDown(button)),
  buttonUp: (button) => (keyboardAndPointer(), devices.buttonUp(button)),
  pointerAt: (x, y) => (keyboardAndPointer(), devices.pointerAt(x, y)),
  move: (dx, dy) => (keyboardAndPointer(), devices.move(dx, dy)),
  scroll: (dx, dy) => (keyboardAndPointer(), devices.scroll(dx, dy)),
  releaseAll: () => devices.releaseAll(),
  gamepadConnected: (info) => devices.gamepadConnected(info),
  gamepadDisconnected: (id) => devices.gamepadDisconnected(id),
  gamepadButton: (id, index, value) => devices.gamepadButton(id, index, value),
  gamepadAxis: (id, index, value) => devices.gamepadAxis(id, index, value),
  gamepadSensor: (id, kind, x, y, z) => devices.gamepadSensor(id, kind, x, y, z),
  gamepadTouch: (id, finger, down, x, y) => devices.gamepadTouch(id, finger, down, x, y),
  gamepadBattery: (id, level, charging) => devices.gamepadBattery(id, level, charging),
  touchStart: (id, x, y) => devices.touchStart(id, x, y),
  touchMove: (id, x, y) => devices.touchMove(id, x, y),
  touchEnd: (id, x, y) => devices.touchEnd(id, x, y),
  penAt: (x, y, pressure, tiltX, tiltY, twist) => devices.penAt(x, y, pressure, tiltX, tiltY, twist),
  penButtonDown: (button) => devices.penButtonDown(button),
  penButtonUp: (button) => devices.penButtonUp(button),
  penLeave: () => devices.penLeave(),
};

function keyboardAndPointer(): void {
  devices.hasKeyboardAndPointer = true;
}

/**
 * Keyboard and pointer input, snapshotted once per frame (ADR 0011 step 2) so `getKeyDown`
 * gives the same answer everywhere in a frame. Key names are lower-case `KeyboardEvent.key`
 * values, with `"space"`, `"escape"` and `"enter"` as friendly names. What the devices did comes
 * from the device snapshot (`devices.ts`, ADR 0310), after UI-first routing (ADR 0069).
 */
export class Input {
  /** True while the key is held (including the frame it went down). */
  static getKey(key: string): boolean {
    return live() && devices.isHeld(normalizeKey(key));
  }

  /** True only in the frame the key went down. */
  static getKeyDown(key: string): boolean {
    return live() && devices.wentDown(normalizeKey(key));
  }

  /** True only in the frame the key was released. */
  static getKeyUp(key: string): boolean {
    return live() && devices.wentUp(normalizeKey(key));
  }

  /** True if any key or pointer button went down this frame (and didn't go to the UI). */
  static get anyKeyDown(): boolean {
    return live() && devices.anyDown;
  }

  /**
   * True when the pointer is over UI that stops it: any element whose `raycastTarget` is on (text,
   * images, buttons, input fields, and panels that draw a background or border; ADR 0069, 0385), not
   * only interactable UI. That frame's mouse-button presses go to the UI: `getMouseButtonDown`
   * reports false for them, and `getMouseButton` and `getMouseButtonUp` stay false for them until
   * they're released. It says where presses go, not whether the pointer is over the game: aiming by
   * hover can ignore it, and HUD elements that shouldn't block presses turn `raycastTarget` off.
   */
  static get pointerOverUI(): boolean {
    return live() && devices.pointerOverUI;
  }

  /** True while a `UIInputField` is focused: keys go to it, and `getKey*` report false (ADR 0069). */
  static get keyboardOverUI(): boolean {
    return live() && devices.keyboardOverUI;
  }

  /** Mouse button held; the primary touch and the pen's tip are button 0 (the DOM adapter reports them as the pointer). */
  static getMouseButton(button = 0): boolean {
    return Input.getKey(mouseKey(button));
  }

  static getMouseButtonDown(button = 0): boolean {
    return Input.getKeyDown(mouseKey(button));
  }

  static getMouseButtonUp(button = 0): boolean {
    return Input.getKeyUp(mouseKey(button));
  }

  /** Pointer position in canvas pixels (origin top-left). Returns a copy. */
  static get mousePosition(): Vector2 {
    return live() ? devices.pointerPosition : new Vector2();
  }

  /**
   * Pointer movement since the last frame in CSS pixels (+x right, +y down). A drag that
   * starts on the canvas keeps reporting movement outside it. Returns a copy.
   */
  static get mouseDelta(): Vector2 {
    return live() ? devices.movement : new Vector2();
  }

  /** Wheel / trackpad scroll since the last frame in pixels (+y = scrolled down). Returns a copy. */
  static get mouseScrollDelta(): Vector2 {
    return live() ? devices.scrolling : new Vector2();
  }

  /**
   * Report device events yourself, as an adapter does (ADR 0337): virtual devices (on-screen
   * controls), automation, replaying raw input, tests. Events reach the game at the next frame's
   * snapshot, through UI routing, the device entities and actions, like real devices'. Gamepads
   * are identified by any id ≥ 0 you choose; announce one with `gamepadConnected` first. Touches
   * and the pen are devices of their own here: unlike the DOM adapter, injecting them doesn't also
   * move or press the pointer.
   *
   * ```ts
   * Input.inject.gamepadConnected({ id: 7, name: "Virtual pad", family: "xbox" });
   * Input.inject.gamepadButton(7, 0, 1); // buttonSouth down
   * ```
   */
  static get inject(): DeviceEventSink {
    return injector;
  }

  /**
   * Enhanced gamepads in Chromium browsers (WebHID): open the browser's chooser for DualSense,
   * DualShock 4 and Switch Pro controllers and report the ones the player picks with gyro,
   * accelerometer, adaptive triggers and lights. Call it from a click or key press (the browser
   * requires one). Resolves with how many controllers are now open; 0 where WebHID doesn't exist
   * (other browsers, desktop builds, where SDL already gives all of this) or nothing was picked.
   * Controllers picked once are reopened automatically on later visits.
   *
   * ```ts
   * enhanceButton.addEventListener("click", async () => {
   *   const opened = await Input.requestHidGamepads();
   * });
   * ```
   */
  static requestHidGamepads(): Promise<number> {
    return hidGamepads ? hidGamepads.request() : Promise.resolve(0);
  }

  /** @internal Listen to keyboard on the window and pointer events on the canvas (the DOM adapter), and start the gamepad adapter. */
  static attach(canvas: HTMLCanvasElement): void {
    Input.detach();
    detachDom = listenToDom(canvas, devices);
    devices.hasKeyboardAndPointer = true;
    attachGamepads();
  }

  /**
   * @internal Move pointer input to another canvas (the editor's tiled play view gives input to
   * another World), keeping what's held: it's the same keyboard and mouse.
   */
  static retarget(canvas: HTMLCanvasElement): void {
    detachDom?.();
    detachDom = listenToDom(canvas, devices);
  }

  /** @internal */
  static detach(): void {
    detachDom?.();
    detachDom = null;
    detachGamepads?.();
    detachGamepads = null;
    devices.output = null;
    devices.hasKeyboardAndPointer = false;
    Input.reset();
  }

  /**
   * @internal Step 2 of the frame: apply queued device events to this frame's snapshot and route
   * them to the UI. The devices are shared, so with several Worlds this runs once per Engine frame,
   * not once per World: every World that takes input then sees the same snapshot.
   */
  static beginFrame(): void {
    devices.beginFrame();
  }

  /** @internal Forget everything held and queued. */
  static reset(): void {
    devices.reset();
  }
}
