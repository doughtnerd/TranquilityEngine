// The rules of a context menu (ADR 0349): which item the arrow keys, Home, End and typing a letter move to, and how
// a menu built from conditional parts drops its stray separators. `ContextMenu.tsx` draws it.

/** One action in a menu. */
export interface MenuItem {
  readonly kind?: "item";
  /** Unique in the menu. */
  readonly id: string;
  readonly label: string;
  readonly disabled?: boolean;
  /** Why it is disabled, or what it does, as its tooltip. */
  readonly title?: string;
  /** Its shortcut, shown at the right ("F2", "Del"). */
  readonly hint?: string;
  /** Destructive (Delete): drawn in the danger colour. */
  readonly danger?: boolean;
  /** The current choice of a set (a play mode): ✓ in the check column, which the menu keeps when any item says it. */
  readonly checked?: boolean;
  /** A muted note in the right column instead of a shortcut ("no loops", why it can't run). */
  readonly note?: string;
  /** Its own menu, opened beside it (hover, →, Enter or Space); `run` is then not called. */
  readonly submenu?: readonly MenuEntry[];
  run(): void;
}

export interface MenuSeparator {
  readonly kind: "separator";
}

/** A caps heading over a group of items ("Play mode"); not focusable. */
export interface MenuGroup {
  readonly kind: "group";
  readonly label: string;
}

export type MenuEntry = MenuItem | MenuSeparator | MenuGroup;

export const SEPARATOR: MenuSeparator = { kind: "separator" };

export const isItem = (e: MenuEntry): e is MenuItem => e.kind !== "separator" && e.kind !== "group";
/** A group heading. */
export const isGroup = (e: MenuEntry): e is MenuGroup => e.kind === "group";
const usable = (e: MenuEntry | undefined): boolean => !!e && isItem(e) && !e.disabled;

/**
 * `entries` without separators at the start, the end, or next to another separator, and without a group heading that
 * has no items under it.
 */
export function tidyEntries(entries: readonly (MenuEntry | null | false | undefined)[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  const last = () => out[out.length - 1];
  for (const e of entries) {
    if (!e) continue;
    if (!isItem(e)) while (out.length > 0 && isGroup(last()!)) out.pop();
    if (e.kind === "separator" && (out.length === 0 || !isItem(last()!))) continue;
    out.push(e);
  }
  while (out.length > 0 && !isItem(last()!)) out.pop();
  return out;
}

/** The menu draws a check column: one of its items has `checked` set (true or false). */
export const hasCheckColumn = (entries: readonly MenuEntry[]): boolean => entries.some((e) => isItem(e) && e.checked !== undefined);

/** The next usable item from `from` in direction `step` (wrapping), or -1 when none is usable. From -1, the first (or last). */
export function stepIndex(entries: readonly MenuEntry[], from: number, step: 1 | -1): number {
  const n = entries.length;
  if (n === 0) return -1;
  let i = from < 0 ? (step === 1 ? -1 : n) : from;
  for (let k = 0; k < n; k++) {
    i = (i + step + n) % n;
    if (usable(entries[i])) return i;
  }
  return -1;
}

/** The first or last usable item, or -1. */
export function edgeIndex(entries: readonly MenuEntry[], edge: "first" | "last"): number {
  return stepIndex(entries, -1, edge === "first" ? 1 : -1);
}

/** The next usable item after `from` whose label starts with `char` (any case, wrapping), or -1. */
export function typeaheadIndex(entries: readonly MenuEntry[], from: number, char: string): number {
  const c = char.toLowerCase();
  if (c.length !== 1 || c === " ") return -1;
  const n = entries.length;
  for (let k = 1; k <= n; k++) {
    const i = (Math.max(from, -1) + k + n) % n;
    const e = entries[i];
    if (usable(e) && (e as MenuItem).label.toLowerCase().startsWith(c)) return i;
  }
  return -1;
}
