import { vi } from "vitest";
import { DomInput } from "./domInput";
import { UICore } from "../ui/UICore";
import type { World } from "../core/World";
import type { UIComponentType } from "../ui/components";

// Test helpers that drive UI the way a player does: a UI core lays a World's UI out and routes the
// pointer as the renderer's does (ADR 0076), and presses go in through `Input`'s DOM adapter (`dom`). A headless World has
// no core of its own, so its buttons never click and its fields never change or submit without one.

/** A UI core for `world` at a canvas size, and pointer gestures on its elements. */
export class UIPointer {
  readonly core: UICore;
  /** The keyboard and mouse, through `Input`'s DOM adapter. */
  readonly dom: DomInput;

  private constructor(
    private readonly world: World,
    readonly width: number,
    readonly height: number,
  ) {
    this.core = new UICore({ interactive: true });
    this.dom = DomInput.attach();
  }

  static async create(world: World, width = 1280, height = 720): Promise<UIPointer> {
    const p = new UIPointer(world, width, height);
    await p.core.ready;
    p.sync();
    return p;
  }

  /** Lay the World's UI out again (the renderer does every frame), `dt` seconds on: smooth scrolls and momentum move on by it (ADR 0423). */
  sync(dt = 0): void {
    this.core.sync(this.world, this.width, this.height, dt);
  }

  /** A point in `el` at fractions of its box (default its middle), in canvas pixels, after laying out; no hit check. */
  pointIn(el: UIComponentType, fx = 0.5, fy = 0.5): { x: number; y: number } {
    this.sync();
    const r = this.core.rectOf(el);
    if (!r) throw new Error(`"${el.owner.name}" isn't laid out on a screen canvas.`);
    return { x: r.x + r.width * fx, y: r.y + r.height * fy };
  }

  /** Move the pointer over `el` (at fractions of its box) and turn the wheel by `dx`, `dy` CSS pixels. */
  wheel(el: UIComponentType, dx: number, dy: number, fx = 0.5, fy = 0.5): void {
    const { x, y } = this.pointIn(el, fx, fy);
    this.dom.moveTo(x, y);
    this.dom.scroll(dx, dy);
  }

  /** The middle of `el` in canvas pixels, after laying out; throws if the pointer there wouldn't hit it. */
  centreOf(el: UIComponentType): { x: number; y: number } {
    this.sync();
    const r = this.core.rectOf(el);
    if (!r) throw new Error(`"${el.owner.name}" isn't laid out on a screen canvas.`);
    const at = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    const hit = this.core.hitTest(at.x, at.y);
    if (hit !== el) throw new Error(`The pointer at "${el.owner.name}" would hit ${hit ? `"${hit.owner.name}"` : "nothing"}.`);
    return at;
  }

  /** Move the pointer over `el`; routing sees it at the next frame. */
  hover(el: UIComponentType): void {
    const { x, y } = this.centreOf(el);
    this.dom.moveTo(x, y);
  }

  /** Move the pointer off every element. */
  leave(): void {
    this.dom.moveTo(-1, -1);
  }

  /** Press and release the left button over `el`: scripts see `clicked` in the next frame. */
  click(el: UIComponentType): void {
    this.hover(el);
    this.dom.click();
  }

  dispose(): void {
    this.core.dispose();
  }
}

/** Node has no document: a minimal stand-in for the one hidden `<input>` a UI core types into. */
export class FakeInput {
  value = "";
  maxLength = -1;
  type = "";
  autocomplete = "";
  tabIndex = 0;
  selectionStart: number | null = 0;
  style = { cssText: "" };
  listeners = new Map<string, ((e: unknown) => void)[]>();
  removed = false;
  setAttribute() {}
  removeAttribute(n: string) {
    if (n === "maxlength") this.maxLength = -1;
  }
  addEventListener(t: string, f: (e: unknown) => void) {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), f]);
  }
  removeEventListener(t: string, f: (e: unknown) => void) {
    this.listeners.set(t, (this.listeners.get(t) ?? []).filter((x) => x !== f));
  }
  emit(t: string, e: unknown = {}) {
    for (const f of this.listeners.get(t) ?? []) f(e);
  }
  focus() {
    fakeDocument().activeElement = this;
  }
  blur() {
    const d = fakeDocument();
    if (d.activeElement === this) d.activeElement = null;
    this.emit("blur");
  }
  setSelectionRange(a: number) {
    this.selectionStart = a;
  }
  remove() {
    this.removed = true;
  }

  /** Type `text` into the field, as the browser's `input` event reports it. */
  typeText(text: string): void {
    this.value = text;
    this.emit("input");
  }
}

/** The stubbed global document (`stubDocument`). */
export function fakeDocument(): { activeElement: unknown } {
  return (globalThis as unknown as { document: { activeElement: unknown } }).document;
}

/** Stub the global document so a UI core's hidden input is `FakeInput`; undo with `vi.unstubAllGlobals()`. */
export function stubDocument(): FakeInput {
  const fake = new FakeInput();
  vi.stubGlobal("document", { activeElement: null, body: { appendChild() {} }, createElement: () => fake });
  return fake;
}
