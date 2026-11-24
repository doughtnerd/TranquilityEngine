// A panel's right-click menu (the Hierarchy's, the Assets panel's; ADR 0383): its items in the menu bar's shape
// (`menuBar.ts`'s `MenuEntry`: a label, a shortcut, why it's unavailable, a submenu), drawn as the shared context menu
// (`ContextMenu`, ADR 0349) in the panel's own window, so submenus open beside their item with the keys a menu has
// (→ opens one, ← or Escape goes back).
import type { MenuEntry as ActionEntry } from "../menuBar";
import { ContextMenu, SEPARATOR, type MenuEntry } from "./ContextMenu";

/** An open panel menu: where it opened, and its items. */
export interface PanelMenuState {
  readonly x: number;
  readonly y: number;
  readonly items: readonly ActionEntry[];
}

/** `items` as the context menu's entries; `path` keeps ids unique across submenus. */
function entriesOf(items: readonly ActionEntry[], path = ""): MenuEntry[] {
  return items.map((item, i) => {
    if (item.separator) return SEPARATOR;
    const id = `${path}${i}`;
    const why = item.disabled || undefined;
    return {
      id,
      label: item.label,
      disabled: !!why,
      title: why ?? item.title,
      hint: item.shortcut,
      checked: item.checked,
      submenu: item.submenu && entriesOf(item.submenu, `${id}.`),
      run: () => item.run?.(),
    };
  });
}

/** Each opening gets its own number, so a menu reopened elsewhere is a new menu (placed and focused afresh). */
const openings = new WeakMap<PanelMenuState, number>();
let nextOpening = 0;
const openingOf = (m: PanelMenuState) => openings.get(m) ?? (openings.set(m, ++nextOpening), nextOpening);

export function PanelMenu(props: { readonly menu: PanelMenuState | null; readonly label: string; readonly class?: string; onClose(): void }) {
  const m = props.menu;
  if (!m) return null;
  return <ContextMenu key={openingOf(m)} inline entries={entriesOf(m.items)} at={{ x: m.x, y: m.y }} label={props.label} class={props.class} onClose={props.onClose} />;
}
