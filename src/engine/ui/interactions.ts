/**
 * The UI interaction log (ADR 0309): what the player did to one World's UI, recorded by the UI core
 * and UI navigation (ADR 0340), and read by the components' getters and UI documents. It also keeps
 * the World's one focused element. Nothing here is public API.
 *
 * Two timing rules:
 * - Events recorded since the last routing (the hidden input's typing and Enter between frames, and
 *   the routing's own hovers, clicks and pointer focus) are published by the next routing, stamped
 *   with the frame the World steps next. Every script phase of that frame sees them; the frame after, none.
 * - Navigation's events (`engine.UINavigation`, in the input phase) are published for the current
 *   frame, which hasn't run a script yet, so the same rule holds for them.
 */
import type { World } from "../core/World";
import type { UIButton, UICanvas, UIFocusableElement, UIInputField } from "./components";
import type { UILaidOutCanvas, UILaidOutElement } from "./uiCoreTypes";

export type UIInteractionType = "click" | "change" | "submit" | "hover" | "focus" | "blur" | "cancel";

type Target = UIFocusableElement | UICanvas;

/** Who moved focus: a script (no events, ADR 0309), the pointer (events next frame) or navigation (events this frame). */
export type UIFocusCause = "script" | "pointer" | "navigation";

/** What the hidden input asks navigation for while a field is typing: Tab, Shift+Tab, Escape. */
export type UITypingRequest = "next" | "previous" | "cancel";

/** What the routing found this frame (ADR 0069): the button under the pointer, the one a press began on, a finished click. */
export interface UIPointerState {
  readonly hovered: UIButton | null;
  readonly pressed: UIButton | null;
  readonly clicked: UIButton | null;
}

/** The UI core's last layout, which navigation searches (ADR 0340). */
export interface UILayoutSource {
  canvases(): readonly UILaidOutCanvas[];
  elements(): readonly UILaidOutElement[];
  /** The drawing canvas's size in CSS pixels at the last layout (what screen canvases cover). */
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Lay the World's UI out again now, at the last size (ADR 0419: the UI host reading geometry mid-frame). */
  relayout?(): void;
}

export class UIInteractions {
  private hoveredButton: UIButton | null = null;
  private pressedButton: UIButton | null = null;
  private focusedElement: UIFocusableElement | null = null;
  /** The focused element is an input field taking the keyboard. */
  private typingNow = false;
  private pending: { type: UIInteractionType; target: Target }[] = [];
  private requests: UITypingRequest[] = [];
  /** The frame `published` is for. */
  private frame = -1;
  private published = new Map<Target, Set<UIInteractionType>>();

  /** The last UI input was navigation (a UI action), not the pointer: focus colours show (ADR 0340). */
  navigating = false;
  /** The UI core that routes this World's pointer, while it does: its layout is what navigation searches. */
  layout: UILayoutSource | null = null;

  constructor(private readonly world: World) {}

  // --- Recording: the UI core -------------------------------------------------------------------

  /** The player changed a field's value or pressed Enter in it, between frames. */
  record(type: "change" | "submit", field: UIInputField): void {
    this.pending.push({ type, target: field });
  }

  /** The hidden input took Tab, Shift+Tab or Escape while a field was typing: navigation acts on it next. */
  request(kind: UITypingRequest): void {
    this.requests.push(kind);
  }

  /** Navigation: the hidden input's requests since it last asked. */
  takeRequests(): UITypingRequest[] {
    const out = this.requests;
    this.requests = [];
    return out;
  }

  /**
   * The routing (run before the World steps): take what the pointer did, then publish everything
   * recorded since the last routing for the World's next frame. A submit whose field lost focus is dropped.
   */
  route(pointer: UIPointerState): void {
    if (pointer.hovered && pointer.hovered !== this.hoveredButton) this.pending.push({ type: "hover", target: pointer.hovered });
    if (pointer.clicked) this.pending.push({ type: "click", target: pointer.clicked });
    this.hoveredButton = pointer.hovered;
    this.pressedButton = pointer.pressed;
    this.stamp(this.world.time.frameCount + 1);
    for (const { type, target } of this.pending) {
      if (type === "submit" && target !== this.focusedElement) continue;
      this.add(type, target);
    }
    this.pending = [];
  }

  /** Navigation: an event of the World's current frame (its input phase, before any script). */
  publishNow(type: UIInteractionType, target: Target): void {
    this.stamp(this.world.time.frameCount);
    this.add(type, target);
  }

  private stamp(frame: number): void {
    if (frame === this.frame) return;
    this.published = new Map();
    this.frame = frame;
  }

  private add(type: UIInteractionType, target: Target): void {
    const types = this.published.get(target);
    if (types) types.add(type);
    else this.published.set(target, new Set([type]));
  }

  /** The World doesn't take the pointer now (not interactive, or no local input): nothing hovered or pressed, nothing recorded. */
  idle(): void {
    this.hoveredButton = null;
    this.pressedButton = null;
    this.pending = [];
    this.requests = [];
  }

  // --- Focus: the routing, navigation, the hidden input and scripts -----------------------------

  /** Focus `target` (null: none); `typing` makes an input field take the keyboard. One element per World has focus. */
  focus(target: UIFocusableElement | null, cause: UIFocusCause, typing = false): void {
    const previous = this.focusedElement;
    this.focusedElement = target;
    this.typingNow = !!target && typing && isField(target);
    if (previous === target || cause === "script") return;
    const send = (type: UIInteractionType, t: Target) => (cause === "pointer" ? this.pending.push({ type, target: t }) : this.publishNow(type, t));
    if (previous) send("blur", previous);
    if (target) send("focus", target);
  }

  /** Take focus from `target` if it has it. */
  blur(target: UIFocusableElement, cause: UIFocusCause): void {
    if (this.focusedElement === target) this.focus(null, cause);
  }

  /** Start or stop the focused input field's typing (focus stays). */
  setTyping(on: boolean): void {
    this.typingNow = on && !!this.focusedElement && isField(this.focusedElement);
  }

  /** The focused element, whatever its state (navigation checks it's still focusable). */
  get focused(): UIFocusableElement | null {
    return this.focusedElement;
  }

  // --- Reading: component getters, UI documents and the drawing layer ---------------------------

  /** True in the frame the event is for (the World's current frame). */
  happened(target: Target, type: UIInteractionType): boolean {
    return this.frame === this.world.time.frameCount && (this.published.get(target)?.has(type) ?? false);
  }

  isHovered(button: UIButton): boolean {
    return this.hoveredButton === button;
  }

  isPressed(button: UIButton): boolean {
    return this.pressedButton === button;
  }

  isFocused(target: UIFocusableElement): boolean {
    return this.focusedElement === target;
  }

  isTyping(field: UIInputField): boolean {
    return this.typingNow && this.focusedElement === field;
  }

  /** The drawing layer: show `target`'s focus colour (it has focus, and the last UI input was navigation). */
  showsFocus(target: UIFocusableElement): boolean {
    return this.navigating && this.focusedElement === target && target.isActiveAndEnabled;
  }
}

/** An input field (it has a `typing` state); duck-typed to keep this module free of the component classes. */
function isField(t: UIFocusableElement): t is UIInputField {
  return "placeholder" in t;
}

const logs = new WeakMap<World, UIInteractions>();

/** The World's interaction log, made the first time it's asked for. */
export function uiInteractions(world: World): UIInteractions {
  let log = logs.get(world);
  if (!log) logs.set(world, (log = new UIInteractions(world)));
  return log;
}
