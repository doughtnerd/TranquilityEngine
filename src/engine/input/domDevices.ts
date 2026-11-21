/**
 * The DOM adapter of the device snapshot (ADR 0310): keyboard events on the window, pointer, wheel
 * and context-menu events on a canvas, reported as device events.
 */
import { normalizeKey, type DeviceEventSink } from "./devices";

/** Listen for `sink`. Returns one function that removes every listener this added. */
export function listenToDom(canvas: HTMLCanvasElement, sink: DeviceEventSink): () => void {
  // Chromium's autofill sends keydown and keyup events with no key; they're not key presses.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat || typeof e.key !== "string") return;
    const key = normalizeKey(e.key);
    // Keep Space and the arrows from scrolling the page, but not from typing in a text field.
    if ((key === "space" || key.startsWith("arrow")) && !isTextEntry(e.target)) e.preventDefault();
    sink.keyDown(e.key);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (typeof e.key === "string") sink.keyUp(e.key);
  };
  // A touch press arrives with no pointermove before it, so down and up set the position too, or the
  // UI would hit-test the previous touch's position when it reads the button state.
  const setPointer = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    sink.pointerAt(e.clientX - rect.left, e.clientY - rect.top);
  };
  const onPointerDown = (e: PointerEvent) => {
    setPointer(e);
    canvas.focus();
    e.preventDefault();
    try {
      canvas.setPointerCapture(e.pointerId); // keep receiving moves while dragging outside the canvas
    } catch {
      // Synthetic events can carry a pointer id the browser doesn't know; input still works.
    }
    sink.buttonDown(e.button);
  };
  const onPointerUp = (e: PointerEvent) => {
    setPointer(e);
    sink.buttonUp(e.button);
  };
  const onPointerMove = (e: PointerEvent) => {
    setPointer(e);
    sink.move(e.movementX, e.movementY);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1; // lines / pages → pixels
    sink.scroll(e.deltaX * scale, e.deltaY * scale);
  };
  const onContextMenu = (e: Event) => e.preventDefault();
  const onBlur = () => sink.releaseAll();

  const listeners: [EventTarget, string, EventListener, AddEventListenerOptions?][] = [
    [window, "keydown", onKeyDown as EventListener],
    [window, "keyup", onKeyUp as EventListener],
    [window, "blur", onBlur],
    [canvas, "pointerdown", onPointerDown as EventListener],
    [window, "pointerup", onPointerUp as EventListener],
    [canvas, "pointermove", onPointerMove as EventListener],
    [canvas, "wheel", onWheel as EventListener, { passive: false }],
    [canvas, "contextmenu", onContextMenu],
  ];
  for (const [target, type, fn, options] of listeners) target.addEventListener(type, fn, options);
  return () => {
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
  };
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
