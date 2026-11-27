// The node Create tree (ADR 0383): the one arrangement of the kinds `newNodeKinds()` offers that the Hierarchy's "+"
// and right-click menus and the menu bar's Create menu all draw. Empty and Camera at the top, then a submenu per
// category (2D, 3D Object, Effects, Light, UI, and any a plugin names, Other last), each sorted by label.
import type { MenuEntry } from "./menuBar";
import { categorise } from "./menuCategories";
import { newNodeKinds, type CreatableKind } from "./nodeKinds";

const SEPARATOR: MenuEntry = { label: "", separator: true };

/**
 * The Create tree as menu entries; `item` makes a kind's entry, given the label the tree shows for it. Reads the plugin registry (through `newNodeKinds`), so menus follow plugins.
 */
export function nodeCreateTree(item: (kind: CreatableKind, label: string) => MenuEntry): MenuEntry[] {
  const kinds = newNodeKinds().map((kind) => ({ kind, label: kind.label, category: kind.category }));
  return categorise(kinds).map((e) => {
    if (e.type === "separator") return SEPARATOR;
    if (e.type === "item") return item(e.item.kind, e.item.label);
    return { label: e.label, submenu: e.items.map((k) => item(k.kind, k.label)) };
  });
}
