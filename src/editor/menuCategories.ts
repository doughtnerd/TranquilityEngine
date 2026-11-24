// Arranging a flat list of menu items into categories (ADR 0383): the Create menus (the Hierarchy's, the menu bar's,
// the Assets panel's) list what they can make as a short top level and one submenu per category, Unity-style.
// Pure: callers turn the result into their own menu entries.

/** An item to arrange: its label and the category it goes under (none: the top level). */
export interface Categorised {
  readonly label: string;
  /** The submenu it goes in ("3D Object", "Light"); undefined or "": the top level. */
  readonly category?: string;
}

/** The catch-all category, drawn last, for items whose category no other item shares and that asked for none. */
export const OTHER_CATEGORY = "Other";

export type CategorisedEntry<T> =
  | { readonly type: "item"; readonly item: T }
  | { readonly type: "category"; readonly label: string; readonly items: readonly T[] }
  | { readonly type: "separator" };

const byLabel = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/**
 * `items` as a menu: the top-level items first, in the order given (the caller puts the common ones first: Empty,
 * Camera), then a separator and one category per distinct `category`, sorted by name with `OTHER_CATEGORY` last, each
 * with its items sorted by label. No empty categories, and no separator when either part is empty.
 */
export function categorise<T extends Categorised>(items: readonly T[]): CategorisedEntry<T>[] {
  const top: CategorisedEntry<T>[] = [];
  const groups = new Map<string, T[]>();
  for (const item of items) {
    if (!item.category) top.push({ type: "item", item });
    else groups.set(item.category, [...(groups.get(item.category) ?? []), item]);
  }
  const names = [...groups.keys()].sort((a, b) => (a === OTHER_CATEGORY ? 1 : b === OTHER_CATEGORY ? -1 : byLabel(a, b)));
  const categories: CategorisedEntry<T>[] = names.map((label) => ({ type: "category", label, items: [...groups.get(label)!].sort((a, b) => byLabel(a.label, b.label)) }));
  return top.length > 0 && categories.length > 0 ? [...top, { type: "separator" }, ...categories] : [...top, ...categories];
}
