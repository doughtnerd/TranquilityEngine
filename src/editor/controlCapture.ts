// "Press to bind" in the input context editor (ADR 0336): the next key, mouse button or gamepad button or stick the
// user presses becomes a control path, named as the engine names it (`<Keyboard>/space`, `<Pointer>/button0`,
// `<Gamepad>/buttonSouth`, `<Gamepad>/leftStickX`). Escape cancels, as a running game's rebind does. Gamepads are read
// through the browser's Gamepad API, whose "standard" button and axis order is the engine's wire order; where the
// browser can't see a pad (the desktop editor reads pads through SDL in the engine), type the path or pick it instead.
import { GAMEPAD_AXES, GAMEPAD_BUTTONS, PRESS_POINT, normalizeKey } from "../engine/input/controls";

/** The control a key press names, or null for Escape (which cancels). */
export function keyControl(key: string): string | null {
  const k = normalizeKey(key);
  return k === "escape" ? null : `<Keyboard>/${k}`;
}

export const pointerControl = (button: number): string => `<Pointer>/button${button}`;

/** What a gamepad reads, as the Gamepad API reports it. */
export interface PadReading {
  readonly buttons: readonly number[];
  readonly axes: readonly number[];
}

/**
 * The first control pressed on a pad since `before` (a button past the press point, or a stick axis past it in either
 * direction), or null. Comparing with the earlier reading ignores a button already held when capture started.
 */
export function padControl(before: PadReading | undefined, now: PadReading): string | null {
  for (let i = 0; i < now.buttons.length && i < GAMEPAD_BUTTONS.length; i++) {
    if (now.buttons[i] >= PRESS_POINT && !((before?.buttons[i] ?? 0) >= PRESS_POINT)) return `<Gamepad>/${GAMEPAD_BUTTONS[i]}`;
  }
  for (let i = 0; i < now.axes.length && i < GAMEPAD_AXES.length; i++) {
    if (Math.abs(now.axes[i]) >= PRESS_POINT && !(Math.abs(before?.axes[i] ?? 0) >= PRESS_POINT)) return `<Gamepad>/${GAMEPAD_AXES[i]}`;
  }
  return null;
}

const readPads = (): (PadReading | null)[] => {
  const pads = typeof navigator !== "undefined" && typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
  return [...pads].map((p) => (p ? { buttons: p.buttons.map((b) => b.value), axes: [...p.axes] } : null));
};

/**
 * Wait for the next press anywhere in the window: `done(path)` with its control, or `done(null)` on Escape or on a
 * press inside `cancelOn` (the button that started capture, now reading "Cancel"). Returns a function that stops
 * waiting (without calling `done`). Key presses and clicks are taken (they don't reach the page).
 */
export function captureControl(done: (path: string | null) => void, cancelOn?: Element | null): () => void {
  let stopped = false;
  let frame = 0;
  const finish = (path: string | null) => {
    stop();
    done(path);
  };
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    finish(keyControl(e.key));
  };
  const onPointer = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // The click (or context menu) this press ends in mustn't reach the page either.
    const after = (ev: Event) => swallow(ev);
    for (const type of ["click", "contextmenu"]) window.addEventListener(type, after, { capture: true, once: true });
    setTimeout(() => ["click", "contextmenu"].forEach((type) => window.removeEventListener(type, after, true)), 1000);
    finish(cancelOn && e.target instanceof Node && cancelOn.contains(e.target) ? null : pointerControl(e.button));
  };
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  let before = readPads();
  const poll = () => {
    if (stopped) return;
    const now = readPads();
    for (let i = 0; i < now.length; i++) {
      const pad = now[i];
      const path = pad && padControl(before[i] ?? undefined, pad);
      if (path) return finish(path);
    }
    before = now;
    frame = requestAnimationFrame(poll);
  };
  function stop() {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onPointer, true);
    window.removeEventListener("click", swallow, true);
    window.removeEventListener("contextmenu", swallow, true);
  }
  window.addEventListener("keydown", onKey, true);
  // The click that started capture has finished; the next pointer press is the binding.
  window.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("click", swallow, true);
  window.addEventListener("contextmenu", swallow, true);
  frame = requestAnimationFrame(poll);
  return stop;
}
