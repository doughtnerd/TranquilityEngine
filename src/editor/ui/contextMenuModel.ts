// The rules of a context menu (ADR 0335): which item the arrow keys, Home, End and typing a letter move to, and how
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
  run(): void;
}

export interface MenuSeparator {
  readonly kind: "separator";
}

export type MenuEntry = MenuItem | MenuSeparator;

export const SEPARATOR: MenuSeparator = { kind: "separator" };

export const isItem = (e: MenuEntry): e is MenuItem => e.kind !== "separator";
const usable = (e: MenuEntry | undefined): boolean => !!e && isItem(e) && !e.disabled;

/** `entries` without separators at the start, the end, or next to another separator. */
export function tidyEntries(entries: readonly (MenuEntry | null | false | undefined)[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (!e) continue;
    if (!isItem(e) && (out.length === 0 || !isItem(out[out.length - 1]))) continue;
    out.push(e);
  }
  while (out.length > 0 && !isItem(out[out.length - 1])) out.pop();
  return out;
}

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
