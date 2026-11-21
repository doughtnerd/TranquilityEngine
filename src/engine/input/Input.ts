import { Vector2 } from "../core/math";
import { World } from "../core/World";
import { devices, mouseKey, normalizeKey } from "./devices";
import { listenToDom } from "./domDevices";

let detachDom: (() => void) | null = null;

/**
 * The devices are the Engine's, attached once and shared; what they report reaches only Worlds
 * that take local input (ADR 0032). A server World, or any World created with `input: false`,
 * sees nothing pressed and zero movement. Outside any World (no active World) input is live.
 */
function live(): boolean {
  return World.active?._takesInput ?? true;
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
   * True when the pointer is over interactable UI (a `UIButton` or `UIInputField`, ADR 0069). That
   * frame's mouse-button presses go to the UI: `getMouseButtonDown` reports false for them, and
   * `getMouseButton` and `getMouseButtonUp` stay false for them until they're released.
   */
  static get pointerOverUI(): boolean {
    return live() && devices.pointerOverUI;
  }

  /** True while a `UIInputField` is focused: keys go to it, and `getKey*` report false (ADR 0069). */
  static get keyboardOverUI(): boolean {
    return live() && devices.keyboardOverUI;
  }

  /** Mouse button / touch (button 0) held. */
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

  /** @internal Listen to keyboard on the window and pointer events on the canvas (the DOM adapter). */
  static attach(canvas: HTMLCanvasElement): void {
    Input.detach();
    detachDom = listenToDom(canvas, devices);
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
