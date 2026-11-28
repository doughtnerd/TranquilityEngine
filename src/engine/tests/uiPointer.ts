import { vi } from "vitest";
import { DomInput } from "./domInput";
import { UICore } from "../ui/UICore";
import type { World } from "../core/World";
import type { UIComponentType } from "../ui/components";
import type { UICoreLike } from "../ui/uiCoreTypes";
import type { UITextEntry } from "../ui/textEntry";
import { UI_KIND_TYPES, isInteractiveKind, isRaycastTarget, uiKindOf } from "../ui/elementKinds";

// Test helpers that drive UI the way a player does: a UI core lays a World's UI out and routes the
// pointer as the renderer's does (ADR 0076), and presses go in through `Input`'s DOM adapter (`dom`). A headless World has
// no core of its own, so its buttons never click and its fields never change or submit without one.

/** The UI element on `node` (the first, as the core lays out), or null. */
function uiComponentOf(node: UIComponentType["owner"]): UIComponentType | null {
  for (const type of UI_KIND_TYPES) {
    const c = node.getComponent(type);
    if (c) return c;
  }
  return null;
}

/**
 * The element the pointer at a canvas CSS point goes to (ADR 0385), read from what the core reports to every caller:
 * the topmost raycast target among the drawn elements `pickAll` lists there, or the button or input field (any
 * interactive element) it's in, below its canvas. Null when no raycast target is there: the pointer reaches the game.
 */
export function pointerTargetAt(core: UICoreLike, x: number, y: number): UIComponentType | null {
  const target = core.pickAll(x, y).find(isRaycastTarget);
  if (!target) return null;
  for (let at: UIComponentType | null = target; at && uiKindOf(at) !== "canvas"; at = at.owner.parent ? uiComponentOf(at.owner.parent) : null) {
    if (isInteractiveKind(uiKindOf(at))) return at;
  }
  return target;
}

/** A UI core for `world` at a canvas size, and pointer gestures on its elements. */
export class UIPointer {
  readonly core: UICore;
  /** The keyboard and mouse, through `Input`'s DOM adapter. */
  readonly dom: DomInput;

  private constructor(
    private readonly world: World,
    readonly width: number,
    readonly height: number,
    textEntry?: UITextEntry,
  ) {
    this.core = new UICore({ interactive: true, textEntry });
    this.dom = DomInput.attach();
  }

  /** `textEntry`: how typing reaches fields (ADR 0449); by default the DOM's, which types nothing in Node unless `stubDocument` stands in. */
  static async create(world: World, width = 1280, height = 720, options: { textEntry?: UITextEntry } = {}): Promise<UIPointer> {
    const p = new UIPointer(world, width, height, options.textEntry);
    await p.core.ready;
    p.sync();
    return p;
  }

  /** Lay the World's UI out again (the renderer does every frame), `dt` seconds on: smooth scrolls and momentum move on by it (ADR 0427). */
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
    const hit = pointerTargetAt(this.core, at.x, at.y);
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

/**
 * Node has no document: a minimal stand-in for the hidden `<input>` the DOM text entry adapter (ADR 0449, the core's
 * default) makes, so tests drive that adapter itself. Tests of typing that don't need the DOM give the core a
 * `MemoryTextEntry` (`memoryTextEntry.ts`) instead.
 */
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
