/**
 * UI event propagation (ADR 0422): what UI documents and the UI host (Svelte views) share to dispatch UI events through
 * capture, target and bubble phases over an element's ancestors, as DOM events are. Nothing here is public API; the
 * event objects the front ends make from it are.
 *
 * - **Records.** The UI core's routing (and the interaction log, ADR 0309) records what happened to which element as
 *   `UIEventRecord`s: a DOM type, the target component, whether it bubbles and can be cancelled, its pointer or key
 *   data, and an `after` callback, the default action, run once the record has been dispatched, told whether a handler
 *   called `preventDefault`. Records are published with the interaction log's frame rule, so they're dispatched in the
 *   frame the polled state is true in.
 * - **Dispatch.** Once a frame, at the point UI document handlers always ran (`engine.UIDocumentEvents`: right after UI
 *   input routing, before behaviors' `update`), `dispatchUIEvents` hands each record of the frame, in order, to the
 *   front end that owns its target (a document's element, a hosted element), which builds the path from its own tree
 *   and runs its listeners with `propagate`, then runs the record's default action. A default action may record more
 *   (focus moving records `blur`, `focusout`, `focus`, `focusin`): they're dispatched in the same pass, in order.
 * - **Events.** `UIEventBase` is the event object both front ends extend: `type`, `target`, `currentTarget`,
 *   `eventPhase`, `bubbles`, `cancelable`, `stopPropagation`, `stopImmediatePropagation`, `preventDefault` /
 *   `defaultPrevented`, and the DOM's pointer, wheel and keyboard fields. Positions: `clientX`/`clientY` (and `x`, `y`,
 *   `pageX`, `pageY`) in the target canvas's UI pixels, as `getBoundingClientRect` reports boxes; `offsetX`/`offsetY` in
 *   the target's own pixels (from its border box's corner, through its transforms); `canvasX`/`canvasY` in the drawing
 *   canvas's CSS pixels.
 */
import type { World } from "../core/World";
import type { UIComponentType } from "./components";
import { uiInteractions } from "./interactions";

// --- Types and their DOM rules -------------------------------------------------------------------

/** Each UI event type's DOM rules: whether it bubbles and whether `preventDefault` cancels anything. */
const RULES: Readonly<Record<string, readonly [bubbles: boolean, cancelable: boolean]>> = {
  click: [true, true],
  dblclick: [true, true],
  contextmenu: [true, true],
  pointerdown: [true, true],
  pointerup: [true, true],
  pointermove: [true, true],
  pointerover: [true, true],
  pointerout: [true, true],
  pointerenter: [false, false],
  pointerleave: [false, false],
  pointercancel: [true, false],
  wheel: [true, true],
  keydown: [true, true],
  keyup: [true, true],
  input: [true, false],
  change: [true, false],
  submit: [true, true],
  reset: [true, true],
  focus: [false, false],
  blur: [false, false],
  focusin: [true, false],
  focusout: [true, false],
  scroll: [false, false],
  scrollend: [false, false],
  dragstart: [true, true],
  drag: [true, true],
  dragenter: [true, true],
  dragover: [true, true],
  dragleave: [true, false],
  drop: [true, true],
  dragend: [true, false],
};

/** Whether a UI event of `type` bubbles (types outside the table don't: `hover`, `cancel`, `load`, transition and animation events). */
export function uiEventBubbles(type: string): boolean {
  return RULES[type]?.[0] ?? false;
}

/** Whether `preventDefault` on a UI event of `type` cancels something. */
export function uiEventCancelable(type: string): boolean {
  return RULES[type]?.[1] ?? false;
}

/** A UI drag's data (ADR 0422, UI-to-UI drags): the DOM's `DataTransfer`, held in memory for the drag. */
export class UIDataTransfer {
  private readonly data = new Map<string, string>();
  /** What a drop target says it would do (`dragover` handlers set it); `none` refuses. */
  dropEffect: "none" | "copy" | "move" | "link" = "move";
  /** What the source allows (`dragstart` handlers set it). */
  effectAllowed = "all";

  setData(format: string, data: string): void {
    this.data.set(format.toLowerCase() === "text" ? "text/plain" : format.toLowerCase(), String(data));
  }

  getData(format: string): string {
    return this.data.get(format.toLowerCase() === "text" ? "text/plain" : format.toLowerCase()) ?? "";
  }

  clearData(format?: string): void {
    if (format === undefined) this.data.clear();
    else this.data.delete(format.toLowerCase());
  }

  get types(): readonly string[] {
    return [...this.data.keys()];
  }

  /** No files: UI drags carry text only. */
  get files(): readonly never[] {
    return [];
  }
}

/** A UI event's data: pointer, wheel, key and focus fields; each front end's event object exposes them with the DOM's names. */
export interface UIEventData {
  readonly canvasX?: number;
  readonly canvasY?: number;
  readonly clientX?: number;
  readonly clientY?: number;
  readonly offsetX?: number;
  readonly offsetY?: number;
  /** Where the point is in another element's own pixels (an event retargeted from the element it was recorded on). */
  readonly offsetOf?: (comp: UIComponentType) => { readonly x: number; readonly y: number } | null;
  readonly button?: number;
  readonly buttons?: number;
  readonly pointerType?: "mouse" | "touch" | "pen" | "";
  readonly pointerId?: number;
  readonly isPrimary?: boolean;
  /** Clicks: how many in a row (2 for `dblclick`). */
  readonly detail?: number;
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly deltaMode?: number;
  readonly key?: string;
  readonly code?: string;
  readonly repeat?: boolean;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  /** The other element of `pointerover`/`pointerout`/enter/leave, focus changes and `dragenter`/`dragleave` (DOM's `relatedTarget`). */
  readonly related?: UIComponentType | null;
  readonly dataTransfer?: UIDataTransfer;
}

/** One UI event of a frame, before a front end makes its event object from it. */
export interface UIEventRecord {
  readonly type: string;
  /** The element it happened on; null for a default action alone (a press on no UI unfocuses). */
  readonly target: UIComponentType | null;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly data: UIEventData;
  /** A handler called `preventDefault` (on a cancelable event). */
  prevented: boolean;
  /** The default action: run after the record is dispatched, told whether it was prevented. */
  readonly after?: (prevented: boolean) => void;
}

/** A record of `type` on `target` with the type's DOM rules. */
export function uiEventRecord(type: string, target: UIComponentType | null, data: UIEventData = {}, after?: (prevented: boolean) => void): UIEventRecord {
  return { type, target, bubbles: uiEventBubbles(type), cancelable: uiEventCancelable(type), data, prevented: false, after };
}

// --- The event object ----------------------------------------------------------------------------

/** The DOM's event phases. */
export const UI_EVENT_PHASE = { NONE: 0, CAPTURING_PHASE: 1, AT_TARGET: 2, BUBBLING_PHASE: 3 } as const;

/**
 * A UI event as handlers see it (ADR 0422): the DOM `Event`'s propagation and cancellation members, and the pointer,
 * wheel and keyboard fields of `PointerEvent`, `WheelEvent` and `KeyboardEvent` (zero or empty when the event has none).
 * Each front end extends it with its own `target` and `currentTarget` types.
 */
export class UIEventBase {
  static readonly NONE = 0;
  static readonly CAPTURING_PHASE = 1;
  static readonly AT_TARGET = 2;
  static readonly BUBBLING_PHASE = 3;
  readonly NONE = 0;
  readonly CAPTURING_PHASE = 1;
  readonly AT_TARGET = 2;
  readonly BUBBLING_PHASE = 3;

  readonly bubbles: boolean;
  readonly cancelable: boolean;
  /** 1 capturing (an ancestor, root first), 2 at the target, 3 bubbling (an ancestor, nearest first); 0 outside dispatch. */
  eventPhase: number = 0;
  readonly timeStamp: number;
  readonly isTrusted = true;
  readonly composed = false;

  readonly canvasX: number;
  readonly canvasY: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly button: number;
  readonly buttons: number;
  readonly pointerType: string;
  readonly pointerId: number;
  readonly isPrimary: boolean;
  readonly detail: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaZ = 0;
  readonly deltaMode: number;
  readonly key: string;
  readonly code: string;
  readonly repeat: boolean;
  readonly isComposing = false;
  readonly location = 0;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly dataTransfer: UIDataTransfer | null;
  readonly width = 1;
  readonly height = 1;
  readonly pressure: number;

  private prevented = false;
  private stopped = false;
  private stoppedNow = false;
  /** @internal A passive listener is running: `preventDefault` does nothing. */
  _passive = false;

  constructor(
    readonly type: string,
    /** The record it was made from (its `prevented` follows `preventDefault`); null for an event made by a script. */
    private readonly record: UIEventRecord | null = null,
    init: { bubbles?: boolean; cancelable?: boolean; data?: UIEventData; on?: UIComponentType } = {},
  ) {
    const d = record?.data ?? init.data ?? {};
    this.bubbles = init.bubbles ?? record?.bubbles ?? uiEventBubbles(type);
    this.cancelable = init.cancelable ?? record?.cancelable ?? uiEventCancelable(type);
    this.timeStamp = typeof performance !== "undefined" ? performance.now() : 0;
    this.canvasX = d.canvasX ?? 0;
    this.canvasY = d.canvasY ?? 0;
    this.clientX = d.clientX ?? 0;
    this.clientY = d.clientY ?? 0;
    const own = init.on && d.offsetOf ? d.offsetOf(init.on) : null;
    this.offsetX = own?.x ?? d.offsetX ?? 0;
    this.offsetY = own?.y ?? d.offsetY ?? 0;
    this.button = d.button ?? 0;
    this.buttons = d.buttons ?? 0;
    this.pointerType = d.pointerType ?? "";
    this.pointerId = d.pointerId ?? 0;
    this.isPrimary = d.isPrimary ?? false;
    this.detail = d.detail ?? 0;
    this.deltaX = d.deltaX ?? 0;
    this.deltaY = d.deltaY ?? 0;
    this.deltaMode = d.deltaMode ?? 0;
    this.key = d.key ?? "";
    this.code = d.code ?? "";
    this.repeat = d.repeat ?? false;
    this.shiftKey = d.shiftKey ?? false;
    this.ctrlKey = d.ctrlKey ?? false;
    this.altKey = d.altKey ?? false;
    this.metaKey = d.metaKey ?? false;
    this.dataTransfer = d.dataTransfer ?? null;
    this.pressure = this.buttons ? 0.5 : 0;
  }

  /** The DOM's names for the position: the target canvas's UI pixels. */
  get x(): number {
    return this.clientX;
  }
  get y(): number {
    return this.clientY;
  }
  get pageX(): number {
    return this.clientX;
  }
  get pageY(): number {
    return this.clientY;
  }
  get screenX(): number {
    return this.clientX;
  }
  get screenY(): number {
    return this.clientY;
  }
  get movementX(): number {
    return 0;
  }
  get movementY(): number {
    return 0;
  }

  get defaultPrevented(): boolean {
    return this.prevented;
  }

  /** The DOM's legacy name: false once `preventDefault` was called. */
  get returnValue(): boolean {
    return !this.prevented;
  }

  /** Cancels the engine's default action (focus on press, scrolling, a drag, submit on Enter: ADR 0422), when the event is cancelable. */
  preventDefault(): void {
    if (!this.cancelable || this._passive) return;
    this.prevented = true;
    if (this.record) this.record.prevented = true;
  }

  /** No further element hears the event (the rest of the current element's listeners still do). */
  stopPropagation(): void {
    this.stopped = true;
  }

  /** No further listener hears the event, on this element or another. */
  stopImmediatePropagation(): void {
    this.stopped = true;
    this.stoppedNow = true;
  }

  /** The DOM's legacy name for `stopPropagation`. */
  get cancelBubble(): boolean {
    return this.stopped;
  }
  set cancelBubble(v: boolean) {
    if (v) this.stopped = true;
  }

  /** @internal Propagation was stopped. */
  get _stopped(): boolean {
    return this.stopped;
  }

  /** @internal No more listeners at all. */
  get _stoppedNow(): boolean {
    return this.stoppedNow;
  }

  /** The modifier's state (`Shift`, `Control`, `Alt`, `Meta`), as `KeyboardEvent.getModifierState`. */
  getModifierState(key: string): boolean {
    return key === "Shift" ? this.shiftKey : key === "Control" ? this.ctrlKey : key === "Alt" ? this.altKey : key === "Meta" ? this.metaKey : false;
  }
}

/**
 * Dispatch `event` over `path` (the target first, then its ancestors to the root) in the DOM's three phases: capture
 * (root to the target's parent), the target, then bubble (the parent to the root, when the event bubbles). `visit`
 * runs one node's listeners for a phase; propagation stops after the node where a listener stopped it.
 */
export function propagate<N>(event: { eventPhase: number; readonly bubbles: boolean; readonly _stopped: boolean }, path: readonly N[], visit: (node: N, phase: 1 | 2 | 3) => void): void {
  if (!path.length) return;
  for (let i = path.length - 1; i >= 1 && !event._stopped; i--) {
    event.eventPhase = 1;
    visit(path[i], 1);
  }
  if (!event._stopped) {
    event.eventPhase = 2;
    visit(path[0], 2);
  }
  if (event.bubbles) {
    for (let i = 1; i < path.length && !event._stopped; i++) {
      event.eventPhase = 3;
      visit(path[i], 3);
    }
  }
  event.eventPhase = 0;
}

// --- The frame's dispatch ------------------------------------------------------------------------

/** A front end: dispatches a record whose target it owns and returns true, else returns false. */
export type UIEventFrontEnd = (record: UIEventRecord) => boolean;

const frontEnds: UIEventFrontEnd[] = [];

/** Register a front end (UI documents, the UI host). Returns its removal. */
export function addUIEventFrontEnd(frontEnd: UIEventFrontEnd): () => void {
  frontEnds.push(frontEnd);
  return () => {
    const i = frontEnds.indexOf(frontEnd);
    if (i >= 0) frontEnds.splice(i, 1);
  };
}

/** Dispatch `world`'s UI events of this frame not yet dispatched, in order, each followed by its default action. */
export function dispatchUIEvents(world: World): void {
  const log = uiInteractions(world);
  dispatching.add(world);
  try {
    for (let r = log.nextRecord(); r; r = log.nextRecord()) dispatchRecord(r);
  } finally {
    dispatching.delete(world);
    dispatchedFrame.set(world, world.time.frameCount);
  }
}

/** Worlds dispatching their frame's events now, and the frame each last dispatched. */
const dispatching = new Set<World>();
const dispatchedFrame = new WeakMap<World, number>();

/** One record to its front end, then its default action. */
function dispatchRecord(r: UIEventRecord): void {
  if (r.target) {
    for (const fe of frontEnds) {
      try {
        if (fe(r)) break;
      } catch (err) {
        console.error(`[myco] dispatching a UI "${r.type}" event failed:`, err);
      }
    }
  }
  try {
    r.after?.(r.prevented);
  } catch (err) {
    console.error(`[myco] the default action of a UI "${r.type}" event failed:`, err);
  }
}

/**
 * ADR 0424: send an event a default action or a script makes (a checkbox's `change`, a form's `submit`): at once while
 * the frame's events are being dispatched or once they were this frame (a script in `update`, or outside a frame), as
 * the DOM dispatches them; before that (navigation, in the input phase) with the frame's events.
 */
export function fireUIEvent(world: World, record: UIEventRecord): void {
  if (dispatching.has(world) || dispatchedFrame.get(world) === world.time.frameCount) dispatchRecord(record);
  else uiInteractions(world).emit(record);
}

// --- Keys ----------------------------------------------------------------------------------------

/** Key names as `Input` has them (lower-case `KeyboardEvent.key`) back to the DOM's `key`. */
const DOM_KEY_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  [
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape", "Enter", "Tab", "Backspace", "Delete", "Shift", "Control", "Alt", "Meta", "Home", "End", "PageUp", "PageDown",
    "Insert", "CapsLock", "NumLock", "ScrollLock", "ContextMenu", "Pause", "PrintScreen", "AltGraph", "Dead", "Unidentified",
    ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ].map((k) => [k.toLowerCase(), k]),
);

/** The DOM's `key` for an `Input` key name (`arrowup` → `ArrowUp`, `space` → `" "`). */
export function uiDomKey(name: string): string {
  if (name === "space") return " ";
  return DOM_KEY_NAMES[name] ?? name;
}

/** The DOM's `code` for a key, where the key name says it (letters, digits, named keys); "" otherwise. */
export function uiDomCode(name: string): string {
  if (/^[a-z]$/.test(name)) return `Key${name.toUpperCase()}`;
  if (/^[0-9]$/.test(name)) return `Digit${name}`;
  if (name === "space") return "Space";
  if (name === "shift" || name === "control" || name === "alt" || name === "meta") return `${DOM_KEY_NAMES[name]}Left`;
  return DOM_KEY_NAMES[name] ?? "";
}

// --- Listener lists ------------------------------------------------------------------------------

/** A listener as added (`capture`: it runs in the capture phase; `once`: removed when it first runs). */
export interface UIListener<F> {
  readonly fn: F;
  readonly capture: boolean;
  readonly once: boolean;
  /** `passive`: its `preventDefault` does nothing. */
  readonly passive?: boolean;
}

/** `addEventListener`'s options: a boolean is `capture`, as in the DOM. */
export function uiListenerOptions(options: unknown): { capture: boolean; once: boolean; passive: boolean } {
  if (typeof options === "boolean") return { capture: options, once: false, passive: false };
  const o = (typeof options === "object" && options !== null ? options : {}) as { capture?: unknown; once?: unknown; passive?: unknown };
  return { capture: !!o.capture, once: !!o.once, passive: !!o.passive };
}

/** Add a listener unless the same function is there for the same phase (the DOM's rule). */
export function addUIListener<F>(list: UIListener<F>[], fn: F, capture: boolean, once: boolean, passive = false): void {
  if (!list.some((l) => l.fn === fn && l.capture === capture)) list.push({ fn, capture, once, passive });
}

/** Remove the listener added with `fn` for that phase. */
export function removeUIListener<F>(list: UIListener<F>[] | undefined, fn: F, capture: boolean): void {
  const i = list ? list.findIndex((l) => l.fn === fn && l.capture === capture) : -1;
  if (i >= 0) list!.splice(i, 1);
}

/**
 * Run a node's listeners for a phase: capture listeners while capturing, the others while bubbling, and at the target
 * the capture listeners then the others (as browsers do now). A `once` listener is removed before it runs; one removed
 * meanwhile doesn't run; `stopImmediatePropagation` ends the run.
 */
export function runUIListeners<F>(list: UIListener<F>[] | undefined, phase: 1 | 2 | 3, event: { readonly _stoppedNow?: boolean; _passive?: boolean }, call: (fn: F) => void): void {
  if (!list?.length) return;
  const passes = phase === 2 ? [true, false] : [phase === 1];
  for (const capture of passes) {
    for (const l of [...list]) {
      if (l.capture !== capture || !list.includes(l)) continue;
      if (l.once) list.splice(list.indexOf(l), 1);
      const was = event._passive;
      // A passive listener's preventDefault does nothing: the engine's events check `_passive`; another event object
      // (one a script made) gets a preventDefault that does nothing while the listener runs.
      const shadow = l.passive && !(event instanceof UIEventBase) && typeof (event as { preventDefault?: unknown }).preventDefault === "function";
      const own = shadow ? Object.getOwnPropertyDescriptor(event, "preventDefault") : undefined;
      if (l.passive) event._passive = true;
      if (shadow) Object.defineProperty(event, "preventDefault", { value: () => undefined, configurable: true, writable: true });
      try {
        call(l.fn);
      } finally {
        event._passive = was;
        if (shadow) {
          if (own) Object.defineProperty(event, "preventDefault", own);
          else delete (event as { preventDefault?: unknown }).preventDefault;
        }
      }
      if (event._stoppedNow) return;
    }
  }
}
