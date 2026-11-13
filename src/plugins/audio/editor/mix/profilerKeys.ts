// ADR 0171 amended by 0172 (M5a, task Pf8; api-and-models §7): the Profiler panel's keyboard. Every key is scoped to the
// panel (a `keydown` listener on the panel's own element, which acts only while focus is inside it; nothing is registered
// globally, per the design's "no global shortcut") and maps to one `CursorModel` action:
//   Left / Right   step one STATUS block back / forward      U / Shift+U   previous / next underrun
//   L / Shift+L    previous / next late command              D / Shift+D   previous / next ladder step
//   M / Shift+M    previous / next marker                    Space         play/pause the live view
// Keys do nothing in an editable control (the name filter) and with Ctrl, Alt or Meta held, so no editor shortcut is
// shadowed. After every move that changed the cursor the controller's `cursorMoved` reads the state there.
import type { ProfilerController } from "./ProfilerPanel";
import type { JumpDirection, JumpKind } from "./cursorModel";

export type ProfilerKeyAction =
  | { readonly type: "step"; readonly direction: JumpDirection }
  | { readonly type: "jump"; readonly kind: JumpKind; readonly direction: JumpDirection }
  | { readonly type: "toggleLive" };

/** One row of the legend: the visible label, the words for a screen reader, and the ARIA `aria-keyshortcuts` value. */
export interface KeyBinding {
  readonly id: string;
  readonly keys: string;
  readonly label: string;
  readonly shortcuts: string;
  readonly action: ProfilerKeyAction;
}

const jump = (kind: JumpKind, direction: JumpDirection): ProfilerKeyAction => ({ type: "jump", kind, direction });

/** The panel's keys, in legend order. `keyActionOf` reads this table, so the legend and the behaviour can't drift. */
export const KEY_BINDINGS: readonly KeyBinding[] = [
  { id: "stepBack", keys: "Left", label: "Step back one STATUS block", shortcuts: "ArrowLeft", action: { type: "step", direction: "previous" } },
  { id: "stepForward", keys: "Right", label: "Step forward one STATUS block", shortcuts: "ArrowRight", action: { type: "step", direction: "next" } },
  { id: "underrunPrev", keys: "U", label: "Previous underrun", shortcuts: "U", action: jump("underrun", "previous") },
  { id: "underrunNext", keys: "Shift+U", label: "Next underrun", shortcuts: "Shift+U", action: jump("underrun", "next") },
  { id: "lateCommandPrev", keys: "L", label: "Previous late command", shortcuts: "L", action: jump("lateCommand", "previous") },
  { id: "lateCommandNext", keys: "Shift+L", label: "Next late command", shortcuts: "Shift+L", action: jump("lateCommand", "next") },
  { id: "ladderPrev", keys: "D", label: "Previous ladder step", shortcuts: "D", action: jump("ladder", "previous") },
  { id: "ladderNext", keys: "Shift+D", label: "Next ladder step", shortcuts: "Shift+D", action: jump("ladder", "next") },
  { id: "markerPrev", keys: "M", label: "Previous marker", shortcuts: "M", action: jump("marker", "previous") },
  { id: "markerNext", keys: "Shift+M", label: "Next marker", shortcuts: "Shift+M", action: jump("marker", "next") },
  { id: "toggleLive", keys: "Space", label: "Play or pause the live view", shortcuts: "Space", action: { type: "toggleLive" } },
];

/** The `aria-keyshortcuts` of the whole panel. */
export const PANEL_KEYSHORTCUTS = KEY_BINDINGS.map((b) => b.shortcuts).join(" ");

/** What the handler reads of a `KeyboardEvent`. */
export interface KeyEventLike {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly target?: unknown;
  preventDefault?(): void;
  stopPropagation?(): void;
}

interface TargetLike {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
}

const tagOf = (t: unknown): string => ((t as TargetLike | null)?.tagName ?? "").toUpperCase();

/** A control that takes typing (or the Space it needs itself): the panel's keys leave it alone. */
export function isEditableTarget(target: unknown): boolean {
  const tag = tagOf(target);
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (target as TargetLike | null)?.isContentEditable === true;
}

/** The action a key stands for, or null (no binding, a modifier held, or an editable control has the event). */
export function keyActionOf(e: KeyEventLike): ProfilerKeyAction | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (isEditableTarget(e.target)) return null;
  const shift = e.shiftKey === true;
  let name: string;
  if (e.key === " " || e.key === "Spacebar") {
    // A focused button or link takes Space as its own click.
    const tag = tagOf(e.target);
    if (tag === "BUTTON" || tag === "A") return null;
    if (shift) return null;
    name = "Space";
  } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    if (shift) return null;
    name = e.key;
  } else if (e.key.length === 1) {
    name = `${shift ? "Shift+" : ""}${e.key.toUpperCase()}`;
  } else {
    return null;
  }
  return KEY_BINDINGS.find((b) => b.keys === name || b.shortcuts === name)?.action ?? null;
}

/** What the actions act on (`ProfilerController` satisfies it). */
export type KeyController = Pick<ProfilerController, "cursor" | "cursorMoved">;

/**
 * Applies an action through `CursorModel`. True when the cursor moved or changed mode (and the controller was told); false
 * when there was nowhere to go (the end of that kind), which leaves everything unchanged.
 */
export function runKeyAction(action: ProfilerKeyAction, controller: KeyController): boolean {
  const c = controller.cursor;
  let changed: boolean;
  switch (action.type) {
    case "step":
      changed = action.direction === "next" ? c.stepForward() : c.stepBack();
      break;
    case "jump":
      changed = c.jump(action.kind, action.direction);
      break;
    case "toggleLive":
      if (c.mode === "live") {
        c.pause();
        changed = true;
      } else {
        changed = c.goLive();
      }
      break;
  }
  if (changed) void controller.cursorMoved();
  return changed;
}

/**
 * The panel's `keydown`. `focused` says whether focus is inside the panel: false, and the key is not ours (nothing runs,
 * the event is left alone). Returns true when the key was handled.
 */
export function handleProfilerKey(e: KeyEventLike, controller: KeyController, focused: () => boolean): boolean {
  if (!focused()) return false;
  const action = keyActionOf(e);
  if (!action) return false;
  runKeyAction(action, controller);
  e.preventDefault?.();
  e.stopPropagation?.();
  return true;
}

/** The part of an element `attachProfilerKeys` uses. */
export interface KeyScopeElement {
  addEventListener(type: "keydown", listener: (e: KeyEventLike) => void): void;
  removeEventListener(type: "keydown", listener: (e: KeyEventLike) => void): void;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  contains(other: unknown): boolean;
  readonly ownerDocument?: { readonly activeElement: unknown } | null;
}

/**
 * Scopes the keys to `root` (the panel's element): focusable (`tabindex=0`, so Tab reaches the panel and the keys work
 * once focus is in it), `aria-keyshortcuts` set, and a `keydown` listener that checks focus is inside. Returns the undo.
 */
export function attachProfilerKeys(root: KeyScopeElement, controller: KeyController): () => void {
  const addedTabIndex = !root.hasAttribute("tabindex");
  if (addedTabIndex) root.setAttribute("tabindex", "0");
  root.setAttribute("aria-keyshortcuts", PANEL_KEYSHORTCUTS);
  const listener = (e: KeyEventLike) => {
    handleProfilerKey(e, controller, () => {
      const active = root.ownerDocument?.activeElement;
      return active !== undefined && active !== null && root.contains(active);
    });
  };
  root.addEventListener("keydown", listener);
  return () => {
    root.removeEventListener("keydown", listener);
    root.removeAttribute("aria-keyshortcuts");
    if (addedTabIndex) root.removeAttribute("tabindex");
  };
}
