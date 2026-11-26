/**
 * The UI interaction log (ADR 0309): what the player did to one World's UI, recorded by the UI core
 * and UI navigation (ADR 0340), and read by the components' getters and the UI host. It also keeps
 * the World's one focused element. Nothing here is public API.
 *
 * Two timing rules:
 * - Events recorded since the last routing (the hidden input's typing and Enter between frames, and
 *   the routing's own hovers, clicks and pointer focus) are published by the next routing, stamped
 *   with the frame the World steps next. Every script phase of that frame sees them; the frame after, none.
 * - Navigation's events (`engine.UINavigation`, in the input phase) are published for the current
 *   frame, which hasn't run a script yet, so the same rule holds for them.
 *
 * ADR 0422: beside the polled state, the log keeps the frame's event records (`events.ts`) in order, published by
 * the same rules: what the routing recorded (pointer and key events, with their default actions), the polled
 * events as they're published, and records a default action adds while the frame's events are dispatched (focus
 * moved by a press). `dispatchUIEvents` takes them with `nextRecord`.
 */
import type { World } from "../core/World";
import type { UIButton, UICanvas, UIFocusableElement, UIForm, UIInputField } from "./components";
import type { UILaidOutCanvas, UILaidOutElement } from "./uiCoreTypes";
import type { UIEventRecord } from "./events";

export type UIInteractionType = "click" | "change" | "submit" | "hover" | "focus" | "blur" | "cancel";

type Target = UIFocusableElement | UICanvas | UIForm;

/**
 * Who moved focus: a script (no events, ADR 0309), the pointer (events next frame), navigation (events this frame), or
 * a press's default action while the frame's events are dispatched (ADR 0422: events this frame, after the press's).
 */
export type UIFocusCause = "script" | "pointer" | "navigation" | "press";

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
  /** ADR 0422: records since the last routing, published by the next one. */
  private pendingRecords: UIEventRecord[] = [];
  /** ADR 0422: the frame's records (the frame `published` is for), and how many were dispatched. */
  private records: UIEventRecord[] = [];
  private cursor = 0;

  /** The last UI input was navigation (a UI action), not the pointer: focus colours show (ADR 0340). */
  navigating = false;
  /** The UI core that routes this World's pointer, while it does: its layout is what navigation searches. */
  layout: UILayoutSource | null = null;

  constructor(private readonly world: World) {}

  // --- Recording: the UI core -------------------------------------------------------------------

  /** The player changed a field's value or pressed Enter in it, between frames. */
  record(type: "change" | "submit", field: UIFocusableElement): void {
    this.pending.push({ type, target: field });
  }

  /** ADR 0422: an event record for the next routing to publish (the frame after: a scroll the last layout saw). */
  queue(record: UIEventRecord): void {
    this.pendingRecords.push(record);
  }

  /** ADR 0422: an event record of the World's current frame (a default action's, while the frame's events are dispatched). */
  emit(record: UIEventRecord): void {
    this.stamp(this.world.time.frameCount);
    this.records.push(record);
  }

  /** ADR 0422: the frame's next record not yet dispatched, or null. */
  nextRecord(): UIEventRecord | null {
    if (this.frame !== this.world.time.frameCount || this.cursor >= this.records.length) return null;
    return this.records[this.cursor++];
  }

  /** ADR 0422: take back a polled event of this frame (a `submit` whose Enter a handler prevented). */
  retract(type: UIInteractionType, target: Target): void {
    if (this.frame === this.world.time.frameCount) this.published.get(target)?.delete(type);
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
  route(pointer: UIPointerState, records: readonly UIEventRecord[] = []): void {
    if (pointer.hovered && pointer.hovered !== this.hoveredButton) this.pending.push({ type: "hover", target: pointer.hovered });
    this.hoveredButton = pointer.hovered;
    this.pressedButton = pointer.pressed;
    this.stamp(this.world.time.frameCount + 1);
    // ADR 0422: the routing's records first (keys and the pointer), then what was recorded since the last routing.
    this.records.push(...records, ...this.pendingRecords);
    this.pendingRecords = [];
    for (const { type, target } of this.pending) {
      if (type === "submit" && target !== this.focusedElement) continue;
      this.add(type, target);
    }
    this.pending = [];
    // A pointer click's record is the routing's own (`click`, on the element the press and release share).
    if (pointer.clicked) this.add("click", pointer.clicked, false);
  }

  /** Navigation: an event of the World's current frame (its input phase, before any script). */
  publishNow(type: UIInteractionType, target: Target, after?: (prevented: boolean) => void, before?: () => void): void {
    this.stamp(this.world.time.frameCount);
    this.add(type, target, true, null, after, before);
  }

  private stamp(frame: number): void {
    if (frame === this.frame) return;
    this.published = new Map();
    this.records = [];
    this.cursor = 0;
    this.frame = frame;
  }

  /** Publish a polled event; with `record`, its event record too (ADR 0422), the type's DOM rules decided by the front ends. */
  private add(type: UIInteractionType, target: Target, record = true, related: Target | null = null, after?: (prevented: boolean) => void, before?: () => void): void {
    const types = this.published.get(target);
    if (types) types.add(type);
    else this.published.set(target, new Set([type]));
    if (!record) return;
    // ADR 0424: a click navigation sends can be cancelled (its default action activates the control).
    const cancelable = type === "click" && !!after;
    this.records.push({ type, target, bubbles: false, cancelable, data: related ? { related } : {}, prevented: false, after, before });
  }

  /** ADR 0424: a polled event of the World's current frame without a record (a control's `change`, a form's `submit`: their records are sent apart). */
  publishPolled(type: UIInteractionType, target: Target): void {
    this.stamp(this.world.time.frameCount);
    this.add(type, target, false);
  }

  /** The World doesn't take the pointer now (not interactive, or no local input): nothing hovered or pressed, nothing recorded. */
  idle(): void {
    this.hoveredButton = null;
    this.pressedButton = null;
    this.pending = [];
    this.pendingRecords = [];
    this.requests = [];
  }

  // --- Focus: the routing, navigation, the hidden input and scripts -----------------------------

  /** Focus `target` (null: none); `typing` makes an input field take the keyboard. One element per World has focus. */
  focus(target: UIFocusableElement | null, cause: UIFocusCause, typing = false): void {
    const previous = this.focusedElement;
    this.focusedElement = target;
    this.typingNow = !!target && typing && isField(target);
    if (previous === target || cause === "script") return;
    const send = (type: UIInteractionType, t: Target, related: Target | null) => {
      if (cause === "pointer") this.pending.push({ type, target: t });
      else {
        this.stamp(this.world.time.frameCount);
        this.add(type, t, true, related);
      }
    };
    if (previous) send("blur", previous, target);
    if (target) send("focus", target, previous);
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

  // --- Reading: component getters, the UI host and the drawing layer ----------------------------

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
