// "Press to bind" in the input context editor (ADR 0336): the next press on any device becomes a control path, named
// as the engine names it (`<Keyboard>/space`, `<Pointer>/button0`, `<Gamepad>/buttonSouth`, `<Gamepad>/leftStickX`,
// `<Touch>/primary`, `<Pen>/tip`). Escape cancels, as a running game's rebind does, and so does a press on the button
// that started capture.
//
// Two sources, first press wins:
// - The editor window's own key and pointer events (taken in the capture phase, so they don't reach the page): keys,
//   mouse buttons, and a touch or pen pressed anywhere in the window.
// - The Engine's device snapshot, through the editor SDK's `watchRawPresses`: every gamepad adapter (the Gamepad API,
//   WebHID, SDL in the desktop editor, whose pads the webview's Gamepad API can't see), and anything else the snapshot
//   sees, with or without a play World.
import { watchRawPresses, type RawPress } from "../engine/editor";
import { normalizeKey } from "../engine/input/controls";

/** The control a key press names, or null for Escape (which cancels). */
export function keyControl(key: string): string | null {
  const k = normalizeKey(key);
  return k === "escape" ? null : `<Keyboard>/${k}`;
}

export const pointerControl = (button: number): string => `<Pointer>/button${button}`;

/** `PointerEvent.buttons` bits of the pen's barrel button and eraser. */
const PEN_BARREL = 2;
const PEN_ERASER = 32;

/** The control a pointer press names: a mouse button, the primary touch, or the pen's tip, barrel button or eraser. */
export function pointerPressControl(e: { readonly pointerType?: string; readonly button: number; readonly buttons?: number }): string {
  if (e.pointerType === "touch") return "<Touch>/primary";
  if (e.pointerType === "pen") {
    const buttons = e.buttons ?? 0;
    return buttons & PEN_ERASER ? "<Pen>/eraser" : buttons & PEN_BARREL || e.button === 2 ? "<Pen>/barrel" : "<Pen>/tip";
  }
  return pointerControl(e.button);
}

/** The control a press from the device snapshot binds, or null for Escape (which cancels). A finger binds the primary touch. */
export function pressControl(press: RawPress): string | null {
  if (press.control === "<Keyboard>/escape") return null;
  if (press.device === "touch") return "<Touch>/primary";
  return press.control;
}

/**
 * Wait for the next press on any device: `done(path)` with its control, or `done(null)` on Escape or on a press inside
 * `cancelOn` (the button that started capture, now reading "Cancel"). Returns a function that stops waiting (without
 * calling `done`). Key presses and clicks in the window are taken (they don't reach the page).
 */
export function captureControl(done: (path: string | null) => void, cancelOn?: Element | null): () => void {
  let stopped = false;
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
    finish(cancelOn && e.target instanceof Node && cancelOn.contains(e.target) ? null : pointerPressControl(e));
  };
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const stopPresses = watchRawPresses((press) => finish(pressControl(press)));
  function stop() {
    if (stopped) return;
    stopped = true;
    stopPresses();
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
  return stop;
}
