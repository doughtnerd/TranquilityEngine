import { Vector2 } from "../core/math";

type InputEvent = { type: "down" | "up"; key: string };

const held = new Set<string>();
const downThisFrame = new Set<string>();
const upThisFrame = new Set<string>();
const queue: InputEvent[] = [];
const pointer = new Vector2();
let detachFns: (() => void)[] = [];

const ALIASES: Record<string, string> = { " ": "space", spacebar: "space", esc: "escape", return: "enter" };

function normalizeKey(key: string): string {
  const k = key.toLowerCase();
  return ALIASES[k] ?? k;
}

function mouseKey(button: number): string {
  return `mouse${button}`;
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
    return held.has(k) || downThisFrame.has(k);
  }

  /** True only in the frame the key went down. */
  static getKeyDown(key: string): boolean {
    return downThisFrame.has(normalizeKey(key));
  }

  /** True only in the frame the key was released. */
  static getKeyUp(key: string): boolean {
    return upThisFrame.has(normalizeKey(key));
  }

  /** True if any key or pointer button went down this frame. */
  static get anyKeyDown(): boolean {
    return downThisFrame.size > 0;
  }

  /** Mouse button / touch (button 0) held. */
  static getMouseButton(button = 0): boolean {
    return Input.getKey(mouseKey(button));
  }

  static getMouseButtonDown(button = 0): boolean {
    return downThisFrame.has(mouseKey(button));
  }

  static getMouseButtonUp(button = 0): boolean {
    return upThisFrame.has(mouseKey(button));
  }

  /** Pointer position in canvas pixels (origin top-left). Returns a copy. */
  static get mousePosition(): Vector2 {
    return pointer.clone();
  }

  /** @internal Listen to keyboard on the window and pointer events on the canvas. */
  static attach(canvas: HTMLCanvasElement): void {
    Input.detach();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const key = normalizeKey(e.key);
      if (key === "space" || key.startsWith("arrow")) e.preventDefault();
      queue.push({ type: "down", key });
    };
    const onKeyUp = (e: KeyboardEvent) => queue.push({ type: "up", key: normalizeKey(e.key) });
    const onPointerDown = (e: PointerEvent) => {
      canvas.focus();
      e.preventDefault();
      queue.push({ type: "down", key: mouseKey(e.button) });
    };
    const onPointerUp = (e: PointerEvent) => queue.push({ type: "up", key: mouseKey(e.button) });
    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.set(e.clientX - rect.left, e.clientY - rect.top);
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
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    detachFns = [
      () => window.removeEventListener("keydown", onKeyDown),
      () => window.removeEventListener("keyup", onKeyUp),
      () => window.removeEventListener("blur", onBlur),
      () => canvas.removeEventListener("pointerdown", onPointerDown),
      () => window.removeEventListener("pointerup", onPointerUp),
      () => canvas.removeEventListener("pointermove", onPointerMove),
    ];
  }

  /** @internal */
  static detach(): void {
    for (const fn of detachFns) fn();
    detachFns = [];
    Input.reset();
  }

  /** @internal Step 2 of the frame: apply queued events to this frame's snapshot. */
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
  }

  /** @internal Inject an event (tests, editor play mode). Applied at the next `beginFrame`. */
  static simulate(type: "down" | "up", key: string): void {
    queue.push({ type, key: normalizeKey(key) });
  }

  /** @internal */
  static reset(): void {
    held.clear();
    downThisFrame.clear();
    upThisFrame.clear();
    queue.length = 0;
  }
}
