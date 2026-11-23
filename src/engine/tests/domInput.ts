import { onTestFinished } from "vitest";
import { Input } from "../input/Input";

// Drive `Input` as a browser does (ADR 0310): `Input.attach` listens to a stand-in canvas and window
// built on Node's `EventTarget` (the global `window` is the stand-in only while the adapter adds its
// listeners: left defined, it would make engine code believe it runs in a browser), and these helpers dispatch the DOM events a player's keyboard,
// mouse, touch screen and wheel send. What reaches the game goes through the real DOM adapter and
// device snapshot; nothing is injected around them.

type Listener = Parameters<EventTarget["addEventListener"]>[1];

/** An `EventTarget` that counts its listeners by type, as the adapter's tests check none are left behind. */
class CountingTarget extends EventTarget {
  readonly listening = new Map<string, number>();

  override addEventListener(type: string, listener: Listener, options?: boolean | AddEventListenerOptions): void {
    if (listener) this.listening.set(type, (this.listening.get(type) ?? 0) + 1);
    super.addEventListener(type, listener, options);
  }

  override removeEventListener(type: string, listener: Listener, options?: boolean | EventListenerOptions): void {
    if (listener) this.listening.set(type, Math.max(0, (this.listening.get(type) ?? 0) - 1));
    super.removeEventListener(type, listener, options);
  }

  /** How many listeners are attached, of every type. */
  get listeners(): number {
    let n = 0;
    for (const v of this.listening.values()) n += v;
    return n;
  }
}

/** A stand-in canvas: an event target with the few element members the DOM adapter calls. */
export class FakeCanvas extends CountingTarget {
  clientHeight = 720;
  focused = 0;
  constructor(
    readonly left = 0,
    readonly top = 0,
  ) {
    super();
  }
  getBoundingClientRect() {
    return { left: this.left, top: this.top };
  }
  focus() {
    this.focused++;
  }
  setPointerCapture() {}
}

function event(type: string, props: Record<string, unknown>): Event {
  return Object.assign(new Event(type, { cancelable: true }), props);
}

/**
 * Keyboard, mouse, wheel, fingers and pen through `Input`'s DOM adapter. `DomInput.attach()` attaches `Input` to a
 * stand-in canvas and window, and detaches it when the test finishes. The
 * pointer is in canvas pixels; it starts at (0, 0).
 */
export class DomInput {
  readonly window = new CountingTarget();
  private x = 0;
  private y = 0;

  private constructor(public canvas: FakeCanvas) {}

  /** Run `fn` (the adapter adding its listeners) with the stand-in as the global `window`. */
  private withWindow(fn: () => void): void {
    const g = globalThis as { window?: unknown };
    const had = "window" in g;
    const old = g.window;
    g.window = this.window;
    try {
      fn();
    } finally {
      if (had) g.window = old;
      else delete g.window;
    }
  }

  private static active: DomInput | null = null;

  /**
   * `Input` on a stand-in canvas (offset by `left`, `top` in the page), detached when the test
   * finishes. Within a test it's one keyboard and mouse: attaching again gives the same one (moved to
   * `canvas` if one is given).
   */
  static attach(canvas?: FakeCanvas): DomInput {
    const active = DomInput.active;
    if (active) {
      if (canvas) active.retarget(canvas);
      return active;
    }
    const dom = new DomInput(canvas ?? new FakeCanvas());
    DomInput.active = dom;
    dom.withWindow(() => Input.attach(dom.canvas as unknown as HTMLCanvasElement));
    onTestFinished(() => dom.detach());
    return dom;
  }

  /** Move pointer input to another stand-in canvas, as the editor's tiled play view does. */
  retarget(canvas = new FakeCanvas()): FakeCanvas {
    this.canvas = canvas;
    this.withWindow(() => Input.retarget(canvas as unknown as HTMLCanvasElement));
    return canvas;
  }

  /** A key goes down (`KeyboardEvent.key`: `"w"`, `" "`, `"Escape"`; `"space"` works as the friendly name too). */
  keyDown(key: string, target: EventTarget = this.window): Event {
    const e = event("keydown", { key, repeat: false });
    target.dispatchEvent(e);
    return e;
  }

  keyUp(key: string): void {
    this.window.dispatchEvent(event("keyup", { key }));
  }

  /** Down and up in the same frame. */
  tap(key: string): void {
    this.keyDown(key);
    this.keyUp(key);
  }

  /** A pointer button goes down at canvas pixels (default: where the pointer is). */
  pointerDown(button = 0, x = this.x, y = this.y): void {
    this.at(x, y);
    this.canvas.dispatchEvent(this.pointer("pointerdown", button));
  }

  /** A pointer button is released (the window hears it, wherever the pointer is). */
  pointerUp(button = 0, x = this.x, y = this.y): void {
    this.at(x, y);
    this.window.dispatchEvent(this.pointer("pointerup", button));
  }

  /** Press and release `button` at the pointer, in one frame. */
  click(button = 0, x = this.x, y = this.y): void {
    this.pointerDown(button, x, y);
    this.pointerUp(button, x, y);
  }

  /** Move the pointer to canvas pixels; the movement is the difference. */
  moveTo(x: number, y: number): void {
    this.move(x - this.x, y - this.y);
  }

  /** Move the pointer by `dx`, `dy` CSS pixels. */
  move(dx: number, dy: number): void {
    this.at(this.x + dx, this.y + dy);
    this.canvas.dispatchEvent(event("pointermove", { clientX: this.x + this.canvas.left, clientY: this.y + this.canvas.top, movementX: dx, movementY: dy, pointerId: 1 }));
  }

  /** Scroll the wheel (`deltaMode` 0: pixels, 1: lines, 2: pages). */
  scroll(dx: number, dy: number, deltaMode = 0): Event {
    const e = event("wheel", { deltaX: dx, deltaY: dy, deltaMode });
    this.canvas.dispatchEvent(e);
    return e;
  }

  private readonly fingers = new Map<number, { x: number; y: number; primary: boolean }>();

  /** A finger touches the canvas at canvas pixels, as pointer `id`; the first finger down while none is down is primary. */
  touchStart(id: number, x: number, y: number): void {
    const primary = this.fingers.size === 0;
    this.fingers.set(id, { x, y, primary });
    if (primary) this.at(x, y);
    this.canvas.dispatchEvent(this.touchEvent("pointerdown", id, x, y, primary, 0, 0, 1));
  }

  /** Finger `id` moves to canvas pixels. */
  touchMove(id: number, x: number, y: number): void {
    const f = this.fingers.get(id)!;
    const [dx, dy] = [x - f.x, y - f.y];
    f.x = x;
    f.y = y;
    if (f.primary) this.at(x, y);
    this.canvas.dispatchEvent(this.touchEvent("pointermove", id, x, y, f.primary, dx, dy, 1));
  }

  /** Finger `id` lifts (the window hears it), or the browser cancels it (`pointercancel`). */
  touchEnd(id: number, cancel = false): void {
    const f = this.fingers.get(id)!;
    this.fingers.delete(id);
    this.window.dispatchEvent(this.touchEvent(cancel ? "pointercancel" : "pointerup", id, f.x, f.y, f.primary, 0, 0, 0));
  }

  /**
   * The pen at canvas pixels: `type` `pointermove` (hovering, or dragging with `buttons`),
   * `pointerdown` (the tip touches) or `pointerup` (the window hears it). `buttons` as
   * `PointerEvent.buttons` (1 tip, 2 barrel, 32 eraser); tilt and twist in degrees.
   */
  pen(type: "pointermove" | "pointerdown" | "pointerup", x: number, y: number, o: { buttons?: number; pressure?: number; tiltX?: number; tiltY?: number; twist?: number } = {}): void {
    const dx = x - this.x;
    const dy = y - this.y;
    this.at(x, y);
    const buttons = o.buttons ?? (type === "pointerdown" ? 1 : 0);
    const e = event(type, {
      pointerType: "pen", pointerId: 9, isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons,
      clientX: x + this.canvas.left, clientY: y + this.canvas.top, movementX: dx, movementY: dy,
      pressure: o.pressure ?? (buttons ? 0.5 : 0), tiltX: o.tiltX ?? 0, tiltY: o.tiltY ?? 0, twist: o.twist ?? 0,
    });
    (type === "pointerup" ? this.window : this.canvas).dispatchEvent(e);
  }

  /** The pen leaves the range the canvas senses it in. */
  penLeave(): void {
    this.canvas.dispatchEvent(event("pointerleave", { pointerType: "pen", pointerId: 9, isPrimary: true }));
  }

  private touchEvent(type: string, id: number, x: number, y: number, isPrimary: boolean, dx: number, dy: number, buttons: number): Event {
    return event(type, { pointerType: "touch", pointerId: id, isPrimary, button: type === "pointermove" ? -1 : 0, buttons, clientX: x + this.canvas.left, clientY: y + this.canvas.top, movementX: dx, movementY: dy, pressure: buttons ? 0.5 : 0 });
  }

  /** The window loses focus. */
  blur(): void {
    this.window.dispatchEvent(event("blur", {}));
  }

  /** A right-click's context menu. Returns the event (prevented over the canvas). */
  contextMenu(): Event {
    const e = event("contextmenu", {});
    this.canvas.dispatchEvent(e);
    return e;
  }

  detach(): void {
    if (DomInput.active !== this) return;
    DomInput.active = null;
    Input.detach();
  }

  private at(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  private pointer(type: string, button: number): Event {
    return event(type, { clientX: this.x + this.canvas.left, clientY: this.y + this.canvas.top, button, pointerId: 1, movementX: 0, movementY: 0 });
  }
}
