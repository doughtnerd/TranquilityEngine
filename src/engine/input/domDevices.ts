/**
 * The DOM adapter of the device snapshot (ADR 0310, 0335): keyboard events on the window, pointer,
 * wheel and context-menu events on a canvas, reported as device events.
 *
 * Pointer events come from a mouse, a finger or a pen (`pointerType`). Fingers are reported as
 * touches by `pointerId`, and the pen with its pressure, tilt and buttons; the primary one of each
 * (`isPrimary`: the first finger down, the pen) is also reported as the pointer, as browsers emulate
 * the mouse, so `Input.getMouseButton` and the UI work by touch.
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
  const local = (e: PointerEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };
  // The mouse is always primary; events without `isPrimary` (synthetic ones) count as primary.
  const isPointer = (e: PointerEvent) => e.isPrimary !== false;
  // The pen's buttons come from `buttons` (a chorded press arrives as a move): 1 tip, 2 barrel, 32 eraser.
  let penButtons = 0;
  const pen = (e: PointerEvent, x: number, y: number, buttons: number) => {
    sink.penAt(x, y, buttons & 33 ? (e.pressure ?? 0) : 0, e.tiltX ?? 0, e.tiltY ?? 0, e.twist ?? 0);
    PEN_DOM_BUTTONS.forEach((dom, button) => {
      if (buttons & dom && !(penButtons & dom)) sink.penButtonDown(button);
      else if (!(buttons & dom) && penButtons & dom) sink.penButtonUp(button);
    });
    penButtons = buttons;
  };
  /** Report a pointer event's finger or pen (a mouse is only the pointer); returns its canvas position. */
  const device = (e: PointerEvent, phase: "down" | "move" | "up"): [number, number] => {
    const [x, y] = local(e);
    if (e.pointerType === "touch") {
      if (phase === "down") sink.touchStart(e.pointerId, x, y);
      else if (phase === "move") sink.touchMove(e.pointerId, x, y);
      else sink.touchEnd(e.pointerId, x, y);
    } else if (e.pointerType === "pen") {
      // Synthetic events may lack `buttons`: a press is then the tip, a move keeps what's held.
      const buttons = phase === "down" ? e.buttons || 1 : phase === "move" ? (e.buttons ?? penButtons) : (e.buttons ?? 0);
      pen(e, x, y, buttons);
    }
    return [x, y];
  };
  // A touch press arrives with no pointermove before it, so down and up set the position too, or the
  // UI would hit-test the previous touch's position when it reads the button state.
  const onPointerDown = (e: PointerEvent) => {
    const [x, y] = device(e, "down");
    canvas.focus();
    e.preventDefault();
    try {
      canvas.setPointerCapture(e.pointerId); // keep receiving moves while dragging outside the canvas
    } catch {
      // Synthetic events can carry a pointer id the browser doesn't know; input still works.
    }
    if (!isPointer(e)) return;
    sink.pointerAt(x, y);
    sink.buttonDown(e.button);
  };
  const onPointerUp = (e: PointerEvent) => {
    const [x, y] = device(e, "up");
    if (!isPointer(e)) return;
    sink.pointerAt(x, y);
    sink.buttonUp(e.button);
  };
  const onPointerMove = (e: PointerEvent) => {
    const [x, y] = device(e, "move");
    if (!isPointer(e)) return;
    sink.pointerAt(x, y);
    sink.move(e.movementX, e.movementY);
  };
  // The browser took a finger or the pen (a scroll or system gesture): it lifts, and the pointer's button 0 is released.
  const onPointerCancel = (e: PointerEvent) => {
    if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
    device(e, "up");
    if (isPointer(e)) sink.buttonUp(0);
  };
  const onPointerLeave = (e: PointerEvent) => {
    if (e.pointerType !== "pen" || penButtons) return; // a captured pen keeps reporting while it's down
    sink.penLeave();
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
    [window, "pointercancel", onPointerCancel as EventListener],
    [canvas, "pointerleave", onPointerLeave as EventListener],
    [canvas, "wheel", onWheel as EventListener, { passive: false }],
    [canvas, "contextmenu", onContextMenu],
  ];
  for (const [target, type, fn, options] of listeners) target.addEventListener(type, fn, options);
  return () => {
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
  };
}

/** `PointerEvent.buttons` bits of the pen's buttons, by `PEN_BUTTONS` index: tip, barrel, eraser. */
const PEN_DOM_BUTTONS = [1, 2, 32];

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
