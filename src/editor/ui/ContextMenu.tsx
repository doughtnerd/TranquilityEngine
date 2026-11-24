// A context menu (ADR 0349; owner's prototype `.cmenu`/`.tci`, spec §3.11 "menus share one look"): placed and
// dismissed by `usePopover` (a press outside, Escape, the window losing focus), its first item focused, and the keys a
// menu has: Up and Down (wrapping, skipping separators, group headings and disabled items), Home and End, a letter to
// jump to the next item starting with it, Enter or Space to run. Running an item closes the menu first.
//
// Each row: a check column (✓ on the current choice, when any item of the menu can be checked), the label left-aligned,
// and a right column with the item's shortcut, a muted note ("no loops"), or › for a submenu. A submenu opens beside its
// item on hover, →, Enter or Space; ← or Escape goes back to the item. Separators run full width; group headings are
// caps. The rules are `contextMenuModel.ts`'s.
import { useRef, useState } from "preact/hooks";
import { edgeIndex, hasCheckColumn, isGroup, isItem, stepIndex, typeaheadIndex, type MenuEntry, type MenuItem } from "./contextMenuModel";
import { FloatingPortal } from "./FloatingPortal";
import { usePopover, type PopoverPoint } from "./popover";
import "./assets.css";
import "./kit.css";

export { SEPARATOR, tidyEntries, type MenuEntry, type MenuGroup, type MenuItem } from "./contextMenuModel";

export interface ContextMenuProps {
  readonly entries: readonly MenuEntry[];
  /** A point (a right-click) or the element it opens beside (a "…" button). */
  readonly at: PopoverPoint | Element;
  /** The menu's accessible name ("Sample menu"). */
  readonly label: string;
  /** It closed: an item ran, or the user dismissed it. */
  onClose(): void;
  /**
   * Draw it where it is rendered instead of at the main page's floating root: for a panel that may sit in a detached
   * window (ADR 0174), whose menu must open in that window. Default false.
   */
  readonly inline?: boolean;
  /** An extra class on the menu's element (the Hierarchy's `hierarchy-menu`). */
  readonly class?: string;
}

export function ContextMenu(props: ContextMenuProps) {
  const list = <MenuList entries={props.entries} at={props.at} label={props.label} onClose={props.onClose} class={props.class} />;
  if (props.inline) return list;
  // Drawn at the page's floating root, so a toolbar with container queries doesn't trap it (`FloatingPortal`).
  return <FloatingPortal>{list}</FloatingPortal>;
}

interface MenuListProps extends Omit<ContextMenuProps, "inline"> {
  /** A submenu: ← and Escape call this (back to its item) instead of closing everything. */
  onBack?(): void;
  /** Focus its first item when it opens (default true; a submenu opened by hover leaves focus where it is). */
  readonly focusFirst?: boolean;
  /** A submenu: where its right edge goes if it doesn't fit to the right of its item (its parent menu's left edge). */
  readonly flipX?: number;
}

function MenuList(props: MenuListProps) {
  const { entries, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [sub, setSub] = useState<{ index: number; at: PopoverPoint; flipX: number; focus: boolean } | null>(null);
  const sub_ = props.onBack !== undefined;
  usePopover(ref, true, {
    anchor: props.at,
    flipX: props.flipX,
    focusFirst: props.focusFirst ?? true,
    // A submenu handles Escape itself (back to its item); its parent leaves Escape to it while it is open.
    escape: !sub_ && sub === null,
    onDismiss: sub_ ? props.onBack! : onClose,
    inside: props.at instanceof Element ? [props.at] : undefined,
  });
  const buttons = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>(":scope > [data-entry]") ?? [])];
  const focusEntry = (i: number) => buttons().find((b) => b.dataset.entry === String(i))?.focus();
  const focused = () => Number((ref.current?.ownerDocument.activeElement as HTMLElement | null)?.dataset?.entry ?? -1);
  const openSub = (i: number, el: HTMLElement, focus: boolean) => {
    const r = el.getBoundingClientRect();
    const menuLeft = ref.current?.getBoundingClientRect().left ?? r.left;
    setSub({ index: i, at: { x: Math.round(r.right + 2), y: Math.round(r.top - 5) }, flipX: Math.round(menuLeft - 2), focus });
  };
  const check = hasCheckColumn(entries);
  const onKeyDown = (e: KeyboardEvent) => {
    // A key from inside a submenu bubbles here too: the submenu has handled it.
    if ((e.target as HTMLElement).closest?.(".kit-menu") !== ref.current) return;
    let next = -1;
    if (sub_ && (e.key === "ArrowLeft" || e.key === "Escape")) {
      e.preventDefault();
      e.stopPropagation();
      props.onBack!();
      return;
    }
    if (e.key === "ArrowRight") {
      const i = focused();
      const entry = entries[i];
      if (entry && isItem(entry) && entry.submenu && !entry.disabled) {
        e.preventDefault();
        openSub(i, e.target as HTMLElement, true);
      }
      return;
    }
    if (e.key === "ArrowDown") next = stepIndex(entries, focused(), 1);
    else if (e.key === "ArrowUp") next = stepIndex(entries, focused(), -1);
    else if (e.key === "Home") next = edgeIndex(entries, "first");
    else if (e.key === "End") next = edgeIndex(entries, "last");
    else if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) next = typeaheadIndex(entries, focused(), e.key);
    else return;
    e.preventDefault();
    if (next >= 0) {
      setSub(null);
      focusEntry(next);
    }
  };
  const subEntry = sub ? (entries[sub.index] as MenuItem | undefined) : undefined;
  return (
    <div ref={ref} class={`context-menu kit-menu${check ? " has-check" : ""}${props.class ? ` ${props.class}` : ""}`} role="menu" aria-label={props.label} onKeyDown={onKeyDown}>
      {entries.map((entry, i) => {
        if (isGroup(entry))
          return (
            <div key={`group${i}`} class="kit-menu-group" role="presentation">
              {entry.label}
            </div>
          );
        if (!isItem(entry)) return <div key={`sep${i}`} class="context-sep" role="separator" />;
        const right = entry.submenu ? "›" : (entry.hint ?? entry.note);
        return (
          <button
            key={entry.id}
            type="button"
            role={entry.checked !== undefined ? "menuitemradio" : "menuitem"}
            aria-checked={entry.checked !== undefined ? entry.checked : undefined}
            aria-haspopup={entry.submenu ? "menu" : undefined}
            aria-expanded={entry.submenu ? sub?.index === i : undefined}
            data-entry={i}
            class={`${entry.danger ? "kit-menu-danger" : ""}${sub?.index === i ? " open" : ""}${entry.detail ? " kit-menu-two" : ""}`.trim() || undefined}
            disabled={entry.disabled}
            title={entry.title}
            onPointerEnter={(e) => {
              entry.hover?.(true);
              if (entry.submenu && !entry.disabled) openSub(i, e.currentTarget as HTMLElement, false);
              else if (sub) setSub(null);
            }}
            onPointerLeave={entry.hover ? () => entry.hover!(false) : undefined}
            onFocus={entry.hover ? () => entry.hover!(true) : undefined}
            onBlur={entry.hover ? () => entry.hover!(false) : undefined}
            onClick={(e) => {
              if (entry.submenu) {
                openSub(i, e.currentTarget as HTMLElement, true);
                return;
              }
              onClose();
              entry.run();
            }}
          >
            {check && (
              <span class="kit-menu-check" aria-hidden="true">
                {entry.checked ? "✓" : ""}
              </span>
            )}
            {entry.icon !== undefined && (
              <span class="kit-menu-icon" aria-hidden="true">
                {entry.icon}
              </span>
            )}
            {entry.detail ? (
              <span class="kit-menu-label">
                <span class="kit-menu-title">{entry.label}</span>
                <span class="kit-menu-detail">{entry.detail}</span>
              </span>
            ) : (
              <span class="kit-menu-label">{entry.label}</span>
            )}
            {right && (
              <span class={entry.hint && !entry.submenu ? "context-key" : "kit-menu-note"} aria-hidden={entry.submenu ? "true" : undefined}>
                {right}
              </span>
            )}
          </button>
        );
      })}
      {sub && subEntry?.submenu && (
        <MenuList
          key={sub.index}
          focusFirst={sub.focus}
          entries={subEntry.submenu}
          at={sub.at}
          flipX={sub.flipX}
          label={subEntry.label}
          onClose={onClose}
          onBack={() => {
            setSub(null);
            focusEntry(sub.index);
          }}
        />
      )}
    </div>
  );
}
