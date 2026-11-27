// A list the user reorders (ADR 0417): drag a row by its handle (an accent line shows where it will land), or focus a
// handle and press Space to lift the row, ↑ ↓ to move it, Space to drop it, Escape to put it back. A live region says
// each step. The logic is sortableListLogic.ts; the list reports one `onMove(from, to)` and the caller owns the order.
import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import { dropSlot, dropTarget, liftKey, moveItem, type LiftState } from "./sortableListLogic";
import "./sortableList.css";

export interface SortableListProps<T> {
  items: readonly T[];
  /** A stable key for each item (rows keep their DOM, and the handle its focus, while the order previews). */
  itemKey(item: T, index: number): string;
  /** What the item is called to a screen reader: the handle's label and the announcements. */
  itemLabel(item: T, index: number): string;
  /** The row's contents, after the handle. */
  renderItem(item: T, index: number): ComponentChildren;
  /** The item at `from` was dropped at index `to` (never equal). */
  onMove(from: number, to: number): void;
  /** The list's accessible name. */
  label: string;
  /** No handles; the rows only show. */
  disabled?: boolean;
  class?: string;
  /** Extra classes for a row, by item (an invalid one, say). */
  rowClass?(item: T, index: number): string | undefined;
}

export function SortableList<T>(props: SortableListProps<T>) {
  const { items, disabled } = props;
  const list = useRef<HTMLOListElement>(null);
  const [drag, setDrag] = useState<{ from: number; slot: number } | null>(null);
  const [lift, setLift] = useState<LiftState>(null);
  const [said, setSaid] = useState("");

  // While a row is lifted the list shows the order a drop would make.
  const order = items.map((_, i) => i);
  const shown = lift ? moveItem(order, lift.from, lift.at) : order;

  const startDrag = (e: PointerEvent, from: number) => {
    if (e.button !== 0 || disabled) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    let slot = from;
    const rows = () => [...(list.current?.querySelectorAll<HTMLElement>(":scope > .sortable-row") ?? [])].map((r) => r.getBoundingClientRect());
    const move = (m: PointerEvent) => {
      slot = dropSlot(rows(), m.clientY);
      setDrag({ from, slot });
    };
    const end = (commit: boolean) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", cancel);
      setDrag(null);
      const to = dropTarget(from, slot);
      if (commit && to !== null) props.onMove(from, to);
    };
    const up = () => end(true);
    const cancel = () => end(false);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", cancel);
    setDrag({ from, slot });
  };

  const onKey = (e: KeyboardEvent, index: number) => {
    const at = lift ? lift.from : index;
    const step = liftKey(lift, e.key, at, items.length, props.itemLabel(items[at], at));
    if (!step.handled) return;
    e.preventDefault();
    setLift(step.state);
    setSaid(step.announce);
    if (step.effect.type === "drop") props.onMove(step.effect.from, step.effect.to);
  };

  const line = drag && dropTarget(drag.from, drag.slot) !== null ? drag.slot : null;

  return (
    <>
      <ol ref={list} class={`sortable-list${props.class ? ` ${props.class}` : ""}${drag ? " dragging" : ""}`} aria-label={props.label}>
        {shown.map((i, position) => {
          const item = items[i];
          const classes = ["sortable-row", props.rowClass?.(item, i)];
          if (lift?.from === i) classes.push("lifted");
          if (drag?.from === i) classes.push("dragged");
          if (line !== null && line === i) classes.push("drop-before");
          if (line !== null && line === items.length && i === items.length - 1) classes.push("drop-after");
          return (
            <li key={props.itemKey(item, i)} class={classes.filter(Boolean).join(" ")} data-position={position}>
              {!disabled && (
                <button
                  type="button"
                  class="sortable-handle"
                  aria-label={`Reorder ${props.itemLabel(item, i)}`}
                  aria-pressed={lift?.from === i}
                  title="Drag to reorder, or press Space and use the arrow keys"
                  onPointerDown={(e) => startDrag(e, i)}
                  onKeyDown={(e) => onKey(e, i)}
                  onBlur={() => {
                    if (lift?.from === i) {
                      setLift(null);
                      setSaid(`Move cancelled. ${props.itemLabel(item, i)} is back at position ${i + 1} of ${items.length}.`);
                    }
                  }}
                >
                  ⠿
                </button>
              )}
              {props.renderItem(item, i)}
            </li>
          );
        })}
      </ol>
      <div class="kit-sr-only" role="status" aria-live="polite">
        {said}
      </div>
    </>
  );
}
