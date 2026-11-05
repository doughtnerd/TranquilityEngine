import { Vector2 } from "../core/math";
import { World } from "../core/World";

type InputEvent = { type: "down" | "up"; key: string };

const held = new Set<string>();
const downThisFrame = new Set<string>();
const upThisFrame = new Set<string>();
const queue: InputEvent[] = [];
const pointer = new Vector2();
const pointerDelta = new Vector2();
const pendingDelta = new Vector2();
const scrollDelta = new Vector2();
const pendingScroll = new Vector2();
let detachFns: (() => void)[] = [];

// UI-first routing (ADR 0069). Hooks run in `beginFrame` after the snapshot, before any World steps;
// the UI runtime claims the pointer when it's over interactable UI and the keyboard while a text
// field is focused. Mouse buttons pressed over UI go to the UI until released.
const frameHooks: (() => void)[] = [];
let pointerOverUI = false;
let keyboardToUI = false;
/** Mouse buttons pressed over UI and still held: the game doesn't see them held or released. */
const uiHeld = new Set<string>();
/** This frame's mouse presses and releases that went to the UI. */
const uiDown = new Set<string>();
const uiUp = new Set<string>();

const ALIASES: Record<string, string> = { " ": "space", spacebar: "space", esc: "escape", return: "enter" };

function normalizeKey(key: string): string {
  const k = key.toLowerCase();
  return ALIASES[k] ?? k;
}

function mouseKey(button: number): string {
  return `mouse${button}`;
}

/**
 * The devices are the Engine's, attached once and shared; what they report reaches only Worlds
 * that take local input (ADR 0032). A server World, or any World created with `input: false`,
 * sees nothing pressed and zero movement. Outside any World (no active World) input is live.
 */
function live(): boolean {
  return World.active?._takesInput ?? true;
}

const NONE = new Set<string>();
const ZERO = new Vector2();

function heldKeys(): Set<string> { return live() ? held : NONE; }
function keysDown(): Set<string> { return live() ? downThisFrame : NONE; }
function keysUp(): Set<string> { return live() ? upThisFrame : NONE; }

const isMouseKey = (k: string) => /^mouse\d+$/.test(k);

/** False for a key the UI took: a mouse button in `uiTook`, or any other key while a text field is focused. */
function gameSees(k: string, uiTook: Set<string>): boolean {
  return isMouseKey(k) ? !uiTook.has(k) : !keyboardToUI;
}

/**
 * Keyboard and pointer input, snapshotted once per frame (ADR 0011 step 2) so `getKeyDown`
 * gives the same answer everywhere in a frame. Key names are lower-case `KeyboardEvent.key`
 * values, with `"space"`, `"escape"` and `"enter"` as friendly names.
 */
export class Input {
  /** True while the key is held (including the frame it went down). */
  static getKey(key: string): boolean {
    const k = normalizeKey(key);
    return (heldKeys().has(k) || keysDown().has(k)) && gameSees(k, uiHeld) && gameSees(k, uiDown);
  }

  /** True only in the frame the key went down. */
  static getKeyDown(key: string): boolean {
    const k = normalizeKey(key);
    return keysDown().has(k) && gameSees(k, uiDown);
  }

  /** True only in the frame the key was released. */
  static getKeyUp(key: string): boolean {
    const k = normalizeKey(key);
    return keysUp().has(k) && gameSees(k, uiUp);
  }

  /** True if any key or pointer button went down this frame (and didn't go to the UI). */
  static get anyKeyDown(): boolean {
    for (const k of keysDown()) if (gameSees(k, uiDown)) return true;
    return false;
  }

  /**
   * True when the pointer is over interactable UI (a `UIButton` or `UIInputField`, ADR 0069). That
   * frame's mouse-button presses go to the UI: `getMouseButtonDown` reports false for them, and
   * `getMouseButton` and `getMouseButtonUp` stay false for them until they're released.
   */
  static get pointerOverUI(): boolean {
    return live() && pointerOverUI;
  }

  /** True while a `UIInputField` is focused: keys go to it, and `getKey*` report false (ADR 0069). */
  static get keyboardOverUI(): boolean {
    return live() && keyboardToUI;
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
    return (live() ? pointer : ZERO).clone();
  }

  /**
   * Pointer movement since the last frame in CSS pixels (+x right, +y down). A drag that
   * starts on the canvas keeps reporting movement outside it. Returns a copy.
   */
  static get mouseDelta(): Vector2 {
    return (live() ? pointerDelta : ZERO).clone();
  }

  /** Wheel / trackpad scroll since the last frame in pixels (+y = scrolled down). Returns a copy. */
  static get mouseScrollDelta(): Vector2 {
    return (live() ? scrollDelta : ZERO).clone();
  }

  /** @internal Listen to keyboard on the window and pointer events on the canvas. */
  static attach(canvas: HTMLCanvasElement): void {
    Input.detach();
    Input.listen(canvas);
  }

  /**
   * @internal Move pointer input to another canvas (the editor's tiled play view gives input to
   * another World), keeping what's held: it's the same keyboard and mouse.
   */
  static retarget(canvas: HTMLCanvasElement): void {
    for (const fn of detachFns) fn();
    detachFns = [];
    Input.listen(canvas);
  }

  private static listen(canvas: HTMLCanvasElement): void {
    // Chromium's autofill sends keydown and keyup events with no key; they're not key presses.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || typeof e.key !== "string") return;
      const key = normalizeKey(e.key);
      // Keep Space and the arrows from scrolling the page, but not from typing in a text field.
      if ((key === "space" || key.startsWith("arrow")) && !isTextEntry(e.target)) e.preventDefault();
      queue.push({ type: "down", key });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (typeof e.key === "string") queue.push({ type: "up", key: normalizeKey(e.key) });
    };
    const onPointerDown = (e: PointerEvent) => {
      canvas.focus();
      e.preventDefault();
      try {
        canvas.setPointerCapture(e.pointerId); // keep receiving moves while dragging outside the canvas
      } catch {
        // Synthetic events can carry a pointer id the browser doesn't know; input still works.
      }
      queue.push({ type: "down", key: mouseKey(e.button) });
    };
    const onPointerUp = (e: PointerEvent) => queue.push({ type: "up", key: mouseKey(e.button) });
    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.set(e.clientX - rect.left, e.clientY - rect.top);
      pendingDelta.set(pendingDelta.x + e.movementX, pendingDelta.y + e.movementY);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1; // lines / pages → pixels
      pendingScroll.set(pendingScroll.x + e.deltaX * scale, pendingScroll.y + e.deltaY * scale);
    };
    const onBlur = () => {
      for (const k of held) queue.push({ type: "up", key: k });
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    detachFns = [
      () => window.removeEventListener("keydown", onKeyDown),
      () => window.removeEventListener("keyup", onKeyUp),
      () => window.removeEventListener("blur", onBlur),
      () => canvas.removeEventListener("pointerdown", onPointerDown),
      () => window.removeEventListener("pointerup", onPointerUp),
      () => canvas.removeEventListener("pointermove", onPointerMove),
      () => canvas.removeEventListener("wheel", onWheel),
    ];
  }

  /** @internal */
  static detach(): void {
    for (const fn of detachFns) fn();
    detachFns = [];
    Input.reset();
  }

  /**
   * @internal Step 2 of the frame: apply queued events to this frame's snapshot. The devices are
   * shared, so with several Worlds this runs once per Engine frame, not once per World: every
   * World that takes input then sees the same snapshot.
   */
  static beginFrame(): void {
    downThisFrame.clear();
    upThisFrame.clear();
    for (const ev of queue) {
      if (ev.type === "down") {
        if (!held.has(ev.key)) downThisFrame.add(ev.key);
        held.add(ev.key);
      } else if (held.delete(ev.key)) {
        upThisFrame.add(ev.key);
      }
    }
    queue.length = 0;
    pointerDelta.copy(pendingDelta);
    pendingDelta.set(0, 0);
    scrollDelta.copy(pendingScroll);
    pendingScroll.set(0, 0);
    Input.routeToUI();
  }

  /** UI-first routing (ADR 0069): the hooks claim the pointer and keyboard, then this frame's mouse presses over UI go to it. */
  private static routeToUI(): void {
    pointerOverUI = false;
    keyboardToUI = false;
    uiDown.clear();
    uiUp.clear();
    for (const hook of [...frameHooks]) {
      try {
        hook();
      } catch (err) {
        console.error("[myco] UI input routing failed:", err);
      }
    }
    for (const k of downThisFrame) {
      if (!isMouseKey(k)) continue;
      if (pointerOverUI) {
        uiDown.add(k);
        uiHeld.add(k);
      } else uiHeld.delete(k); // pressed in the game: the game's until released
    }
    for (const k of upThisFrame) if (uiHeld.delete(k)) uiUp.add(k);
    for (const k of uiHeld) if (!held.has(k)) uiHeld.delete(k);
  }

  /**
   * @internal The UI runtime (ADR 0069): run `hook` in every `beginFrame`, after the snapshot and
   * before any World steps. Returns a function that removes it.
   */
  static _addFrameHook(hook: () => void): () => void {
    frameHooks.push(hook);
    return () => {
      const i = frameHooks.indexOf(hook);
      if (i >= 0) frameHooks.splice(i, 1);
    };
  }

  /** @internal From a frame hook: the pointer is over interactable UI this frame. */
  static _claimPointer(): void {
    pointerOverUI = true;
  }

  /** @internal From a frame hook: a text field is focused this frame, so keys go to it. */
  static _claimKeyboard(): void {
    keyboardToUI = true;
  }

  /**
   * @internal For the UI runtime's frame hook: the devices before routing, whichever World is
   * current. The pointer in canvas pixels, and whether a mouse button went down, is held, or went up.
   */
  static _raw(): { pointer: Vector2; down(button: number): boolean; held(button: number): boolean; up(button: number): boolean } {
    return {
      pointer: pointer.clone(),
      down: (b) => downThisFrame.has(mouseKey(b)),
      held: (b) => held.has(mouseKey(b)),
      up: (b) => upThisFrame.has(mouseKey(b)),
    };
  }

  /** @internal Inject an event (tests, editor play mode). Applied at the next `beginFrame`. */
  static simulate(type: "down" | "up", key: string): void {
    queue.push({ type, key: normalizeKey(key) });
  }

  /** @internal Put the pointer at canvas pixels (tests), at once. */
  static simulatePointer(x: number, y: number): void {
    pointer.set(x, y);
  }

  /** @internal Inject pointer movement (tests). Applied at the next `beginFrame`. */
  static simulateMouseMove(dx: number, dy: number): void {
    pendingDelta.set(pendingDelta.x + dx, pendingDelta.y + dy);
  }

  /** @internal Inject wheel scrolling (tests). Applied at the next `beginFrame`. */
  static simulateScroll(dx: number, dy: number): void {
    pendingScroll.set(pendingScroll.x + dx, pendingScroll.y + dy);
  }

  /** @internal */
  static reset(): void {
    held.clear();
    downThisFrame.clear();
    upThisFrame.clear();
    queue.length = 0;
    pointerDelta.set(0, 0);
    pendingDelta.set(0, 0);
    scrollDelta.set(0, 0);
    pendingScroll.set(0, 0);
    pointerOverUI = false;
    keyboardToUI = false;
    uiHeld.clear();
    uiDown.clear();
    uiUp.clear();
  }
}

/**
 * True if a key event's target takes typed text, where keys mean characters: an input, a
 * textarea, an editable element, or one using the EditContext API (as code editors do).
 */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { editContext?: unknown }) | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA" || el.editContext) return true;
  return el.tagName === "INPUT" && !["checkbox", "radio", "button", "range", "color", "submit", "reset"].includes((el as HTMLInputElement).type);
}
