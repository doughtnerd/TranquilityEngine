import { onTestFinished } from "vitest";
import { Input } from "../input/Input";

// Drive `Input` as a browser does (ADR 0310): `Input.attach` listens to a stand-in canvas and window
// built on Node's `EventTarget`, and these helpers dispatch the DOM events a player's keyboard,
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
 * Keyboard, mouse and wheel through `Input`'s DOM adapter. `DomInput.attach()` stubs `window` with a
 * stand-in, attaches `Input` to a stand-in canvas, and undoes both when the test finishes. The
 * pointer is in canvas pixels; it starts at (0, 0).
 */
export class DomInput {
  readonly window = new CountingTarget();
  private readonly hadWindow = "window" in globalThis;
  private readonly oldWindow: unknown = (globalThis as { window?: unknown }).window;
  private x = 0;
  private y = 0;

  private constructor(public canvas: FakeCanvas) {
    (globalThis as { window?: unknown }).window = this.window;
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
    Input.attach(dom.canvas as unknown as HTMLCanvasElement);
    onTestFinished(() => dom.detach());
    return dom;
  }

  /** Move pointer input to another stand-in canvas, as the editor's tiled play view does. */
  retarget(canvas = new FakeCanvas()): FakeCanvas {
    this.canvas = canvas;
    Input.retarget(canvas as unknown as HTMLCanvasElement);
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
    const g = globalThis as { window?: unknown };
    if (g.window !== this.window) return; // the test stubbed it again since
    if (this.hadWindow) g.window = this.oldWindow;
    else delete g.window;
  }

  private at(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  private pointer(type: string, button: number): Event {
    return event(type, { clientX: this.x + this.canvas.left, clientY: this.y + this.canvas.top, button, pointerId: 1, movementX: 0, movementY: 0 });
  }
}
