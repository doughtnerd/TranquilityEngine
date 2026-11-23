// Long-press opens context menus on touch screens (ADR 0361). Every Studio row, tab and clip that has a right-click menu
// listens for `contextmenu`; Android browsers send one for a long press, iOS Safari never does. This listens on the
// page for a touch held still for `LONG_PRESS_MS` and sends the pressed element a `contextmenu` at the finger, unless
// the browser sent its own first, then swallows the click that lifting the finger would make.

/** How long a touch is held still before it opens the menu. */
export const LONG_PRESS_MS = 550;
/** How far (CSS px) the finger may drift before the press counts as a drag or scroll instead. */
export const LONG_PRESS_SLOP = 10;

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

/** Listen on `target` (the page's window); returns the function that stops listening. */
export function installLongPress(target: EventTarget, timers: Timers = globalThis as unknown as Timers): () => void {
  let press: { id: number; x: number; y: number; el: EventTarget | null; timer: unknown } | null = null;
  let swallowClick = false;

  const cancel = () => {
    if (press) timers.clearTimeout(press.timer);
    press = null;
  };
  const down = (e: Event) => {
    const p = e as PointerEvent;
    cancel();
    if (p.pointerType !== "touch" || !p.isPrimary) return;
    const pending: { id: number; x: number; y: number; el: EventTarget | null; timer: unknown } = { id: p.pointerId, x: p.clientX, y: p.clientY, el: p.target, timer: null };
    pending.timer = timers.setTimeout(() => {
      if (press !== pending) return;
      press = null;
      const MouseEventCtor = (globalThis as { MouseEvent?: typeof MouseEvent }).MouseEvent;
      const menu = MouseEventCtor ? new MouseEventCtor("contextmenu", { bubbles: true, cancelable: true, clientX: pending.x, clientY: pending.y, button: 2 }) : Object.assign(new Event("contextmenu", { bubbles: true, cancelable: true }), { clientX: pending.x, clientY: pending.y, button: 2 });
      pending.el?.dispatchEvent(menu);
      // Only a menu someone opened eats the lift's click.
      swallowClick = menu.defaultPrevented;
    }, LONG_PRESS_MS);
    press = pending;
  };
  const move = (e: Event) => {
    const p = e as PointerEvent;
    if (press && p.pointerId === press.id && Math.hypot(p.clientX - press.x, p.clientY - press.y) > LONG_PRESS_SLOP) cancel();
  };
  const up = (e: Event) => {
    if (press && (e as PointerEvent).pointerId === press.id) cancel();
  };
  // The browser's own long-press menu (Android) came first: let it stand alone.
  const nativeMenu = (e: Event) => {
    if (e.isTrusted) cancel();
  };
  const click = (e: Event) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  };
  const listeners: [string, (e: Event) => void, boolean][] = [
    ["pointerdown", down, true],
    ["pointermove", move, true],
    ["pointerup", up, true],
    ["pointercancel", up, true],
    ["contextmenu", nativeMenu, true],
    ["click", click, true],
  ];
  // Options objects, not a bare `true`: Node's EventTarget only matches a removal to them.
  for (const [type, fn, capture] of listeners) target.addEventListener(type, fn, { capture });
  return () => {
    cancel();
    for (const [type, fn, capture] of listeners) target.removeEventListener(type, fn, { capture });
  };
}
