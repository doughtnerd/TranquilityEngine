// A context menu (ADR 0349): the editor's menu look (`.context-menu`), placed and dismissed by `usePopover` (a press
// outside, Escape, the window losing focus), its first item focused, and the keys a menu has: Up and Down (wrapping,
// skipping separators and disabled items), Home and End, a letter to jump to the next item starting with it, Enter
// or Space to run. Running an item closes the menu first. The rules are `contextMenuModel.ts`'s.
import { useRef } from "preact/hooks";
import { edgeIndex, isItem, stepIndex, typeaheadIndex, type MenuEntry } from "./contextMenuModel";
import { usePopover, type PopoverPoint } from "./popover";
import "./assets.css";
import "./kit.css";

export { SEPARATOR, tidyEntries, type MenuEntry, type MenuItem } from "./contextMenuModel";

export interface ContextMenuProps {
  readonly entries: readonly MenuEntry[];
  /** A point (a right-click) or the element it opens beside (a "…" button). */
  readonly at: PopoverPoint | Element;
  /** The menu's accessible name ("Sample menu"). */
  readonly label: string;
  /** It closed: an item ran, or the user dismissed it. */
  onClose(): void;
}

export function ContextMenu(props: ContextMenuProps) {
  const { entries, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  usePopover(ref, true, { anchor: props.at, focusFirst: true, onDismiss: onClose, inside: props.at instanceof Element ? [props.at] : undefined });
  const buttons = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>("[data-entry]") ?? [])];
  const focusEntry = (i: number) => buttons().find((b) => b.dataset.entry === String(i))?.focus();
  const focused = () => Number((ref.current?.ownerDocument.activeElement as HTMLElement | null)?.dataset?.entry ?? -1);
  const onKeyDown = (e: KeyboardEvent) => {
    let next = -1;
    if (e.key === "ArrowDown") next = stepIndex(entries, focused(), 1);
    else if (e.key === "ArrowUp") next = stepIndex(entries, focused(), -1);
    else if (e.key === "Home") next = edgeIndex(entries, "first");
    else if (e.key === "End") next = edgeIndex(entries, "last");
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) next = typeaheadIndex(entries, focused(), e.key);
    else return;
    e.preventDefault();
    if (next >= 0) focusEntry(next);
  };
  return (
    <div ref={ref} class="context-menu kit-menu" role="menu" aria-label={props.label} onKeyDown={onKeyDown}>
      {entries.map((entry, i) =>
        isItem(entry) ? (
          <button
            key={entry.id}
            role="menuitem"
            data-entry={i}
            class={entry.danger ? "kit-menu-danger" : undefined}
            disabled={entry.disabled}
            title={entry.title}
            onClick={() => {
              onClose();
              entry.run();
            }}
          >
            <span>{entry.label}</span>
            {entry.hint && <span class="context-key">{entry.hint}</span>}
          </button>
        ) : (
          <div key={`sep${i}`} class="context-sep" role="separator" />
        ),
      )}
    </div>
  );
}
