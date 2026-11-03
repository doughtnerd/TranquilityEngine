import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { combineSelection, rangeBetween } from "../selectionModel";
import { isSelected, refineList, select, selectedKeys } from "../state";

/**
 * The Alt+click list (ADR 0022): every node near the click, occluded ones and children included,
 * with the usual multi-select list controls. Click selects one row, Ctrl/Cmd+click toggles,
 * Shift+click selects a range (Ctrl+Shift adds it); arrows move, Space toggles, Ctrl/Cmd+A takes
 * all. The selection follows live; Enter or clicking elsewhere keeps it, Escape puts it back.
 */
export function RefineList() {
  const list = refineList.value;
  return list ? <Popup key={`${list.x},${list.y}`} {...list} /> : null;
}

function Popup(props: NonNullable<typeof refineList.value>) {
  const { entries, before } = props;
  const keys = entries.map((e) => e.key);
  const minDepth = Math.min(...entries.map((e) => e.depth));
  const [focus, setFocus] = useState(0);
  const anchor = useRef<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: props.x, top: props.y });

  useLayoutEffect(() => {
    // Keep the popup on screen.
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    setPlace({ left: Math.max(4, Math.min(props.x, innerWidth - r.width - 4)), top: Math.max(4, Math.min(props.y, innerHeight - r.height - 4)) });
    el.focus();
  }, []);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(`[data-index="${focus}"]`)?.scrollIntoView({ block: "nearest" });
  }, [focus]);

  const close = (restore: boolean) => {
    if (restore) select(before);
    refineList.value = null;
  };
  /** Act on row `i` the way a click with these modifiers would. */
  const choose = (i: number, mods: { ctrl: boolean; shift: boolean }) => {
    const key = keys[i];
    setFocus(i);
    if (mods.shift) {
      const range = rangeBetween(keys, anchor.current ?? key, key);
      select(mods.ctrl ? combineSelection(selectedKeys.peek(), range, "add") : range, key);
      return;
    }
    anchor.current = key;
    select(mods.ctrl ? combineSelection(selectedKeys.peek(), [key], "toggle") : [key], key);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const move = (to: number) => {
      e.preventDefault();
      const i = Math.max(0, Math.min(keys.length - 1, to));
      if (e.shiftKey) choose(i, { ctrl: false, shift: true });
      else if (ctrl) setFocus(i); // move without changing the selection, like a file list
      else choose(i, { ctrl: false, shift: false });
    };
    if (e.key === "ArrowDown") move(focus + 1);
    else if (e.key === "ArrowUp") move(focus - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(keys.length - 1);
    else if (e.key === " ") {
      e.preventDefault();
      choose(focus, { ctrl: true, shift: false });
    } else if (ctrl && e.key.toLowerCase() === "a") {
      e.preventDefault();
      select(keys, keys[focus]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      close(false);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else return;
    e.stopPropagation(); // keep editor shortcuts (Delete, W/E/R…) out of it while the list is open
  };

  return (
    <div class="refine-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close(false)}>
      <div
        ref={ref}
        class="refine-list"
        role="listbox"
        aria-multiselectable="true"
        aria-label="Nodes near the click"
        aria-activedescendant={`refine-${focus}`}
        tabIndex={0}
        style={{ left: `${place.left}px`, top: `${place.top}px` }}
        onKeyDown={onKeyDown}
      >
        <div class="refine-title">
          {entries.length} node{entries.length === 1 ? "" : "s"} here
        </div>
        <ul>
          {entries.map((entry, i) => (
            <li
              key={entry.key}
              id={`refine-${i}`}
              data-index={i}
              data-key={entry.key}
              role="option"
              aria-selected={isSelected(entry.key)}
              class={`${isSelected(entry.key) ? "selected" : ""}${i === focus ? " focused" : ""}${entry.inner ? " inner" : ""}`}
              style={{ paddingLeft: `${(entry.depth - minDepth) * 14 + 8}px` }}
              title={entry.inner ? `${entry.key} (inside a prefab instance)` : entry.key}
              onPointerDown={(e) => e.preventDefault() /* keep focus on the list */}
              onClick={(e) => choose(i, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
            >
              {entry.name}
            </li>
          ))}
        </ul>
        <div class="refine-hint">Ctrl+click toggles · Shift+click selects a range · Enter keeps · Esc cancels</div>
      </div>
    </div>
  );
}
