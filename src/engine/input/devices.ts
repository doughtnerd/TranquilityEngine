/**
 * The device snapshot (ADR 0310): the Engine's one keyboard and pointer, shared by its Worlds.
 *
 * - **Input end** (`DeviceEventSink`): an adapter (the DOM listener, `domDevices.ts`) reports device
 *   events as they happen; keys, buttons, movement and scroll queue until the next snapshot.
 * - **Snapshot** (`beginFrame`, ADR 0011 step 2): once per Engine frame, applies the queue, then the
 *   routing step.
 * - **Routing step** (ADR 0069): each router (the UI core) is handed what the pointer did this frame
 *   and answers what it claims; this frame's mouse presses over claimed UI then go to the UI until
 *   they're released.
 * - **Reading end**: what the game sees after routing, which the `Input` getters read.
 *
 * Nothing here is public API: scripts read `Input`.
 */
import { Vector2 } from "../core/math";

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

const ALIASES: Record<string, string> = { " ": "space", spacebar: "space", esc: "escape", return: "enter" };

/** A key name as `Input` uses it: lower-case `KeyboardEvent.key`, with `space`, `escape` and `enter`. */
export function normalizeKey(key: string): string {
  const k = key.toLowerCase();
  return ALIASES[k] ?? k;
}

/** The key name `Input` gives a pointer button. */
export const mouseKey = (button: number): string => `mouse${button}`;
const isMouseKey = (k: string) => /^mouse\d+$/.test(k);

type QueuedEvent = { down: boolean; key: string };

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

  // --- Input end --------------------------------------------------------------------------------

  keyDown(key: string): void {
    this.queue.push({ down: true, key: normalizeKey(key) });
  }

  keyUp(key: string): void {
    this.queue.push({ down: false, key: normalizeKey(key) });
  }

  buttonDown(button: number): void {
    this.queue.push({ down: true, key: mouseKey(button) });
  }

  buttonUp(button: number): void {
    this.queue.push({ down: false, key: mouseKey(button) });
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
    for (const k of this.heldKeys) this.queue.push({ down: false, key: k });
  }

  // --- Snapshot and routing ---------------------------------------------------------------------

  /** Step 2 of the frame: apply queued events to this frame's snapshot, then route the pointer and keyboard. */
  beginFrame(): void {
    this.downNow.clear();
    this.upNow.clear();
    for (const ev of this.queue) {
      if (ev.down) {
        if (!this.heldKeys.has(ev.key)) this.downNow.add(ev.key);
        this.heldKeys.add(ev.key);
      } else if (this.heldKeys.delete(ev.key)) {
        this.upNow.add(ev.key);
      }
    }
    this.queue.length = 0;
    this.moved.copy(this.pendingMove);
    this.pendingMove.set(0, 0);
    this.scrolled.copy(this.pendingScroll);
    this.pendingScroll.set(0, 0);
    this.route();
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
}

/** The Engine's devices. */
export const devices = new DeviceSnapshot();
