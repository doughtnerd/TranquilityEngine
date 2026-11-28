// The logic of the sortable list (SortableList.tsx): where a pointer drag would drop, and the keyboard lift/move/drop
// state machine with the announcements a screen reader hears. Pure, so it is tested without a DOM.

/** The vertical extent of one row. */
export interface RowRect {
  readonly top: number;
  readonly height: number;
}

/** The slot a pointer at `y` drops into: 0 is before the first row, `rows.length` after the last (the nearest gap by row midpoints). */
export function dropSlot(rows: readonly RowRect[], y: number): number {
  let slot = 0;
  for (const r of rows) if (y > r.top + r.height / 2) slot++;
  return slot;
}

/** The index the item at `from` ends up at when dropped into `slot`, or null when that leaves it where it is. */
export function dropTarget(from: number, slot: number): number | null {
  const to = slot > from ? slot - 1 : slot;
  return to === from ? null : to;
}

/** `list` with the item at `from` moved to index `to` (a copy). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, item);
  return out;
}

/** What a handle's keyboard state is: nothing lifted, or the item at `from` lifted and now at `at`. */
export type LiftState = null | { readonly from: number; readonly at: number };

/** What a key press does besides changing the state. */
export type LiftEffect = { readonly type: "none" } | { readonly type: "drop"; readonly from: number; readonly to: number } | { readonly type: "cancel" };

/** The result of a key press: the next state, what to do, and the line for the live region ("" says nothing). */
export interface LiftStep {
  readonly state: LiftState;
  readonly effect: LiftEffect;
  readonly announce: string;
}

const NONE: LiftEffect = { type: "none" };

/**
 * One key on a focused handle at `index` of `count` rows, called `label`. Space lifts, ↑ ↓ move the lifted row by one
 * (Home and End to the ends), Space drops it, Escape puts it back. Other keys do nothing (`handled` false for them,
 * so the caller leaves the event alone).
 */
export function liftKey(state: LiftState, key: string, index: number, count: number, label: string): LiftStep & { readonly handled: boolean } {
  const idle = (handled: boolean): LiftStep & { readonly handled: boolean } => ({ state, effect: NONE, announce: "", handled });
  if (state === null) {
    if (key !== " " && key !== "Spacebar") return idle(false);
    return { state: { from: index, at: index }, effect: NONE, announce: `${label} lifted, position ${index + 1} of ${count}. Up and down arrows move it, Space drops it, Escape cancels.`, handled: true };
  }
  const at = key === "ArrowUp" ? state.at - 1 : key === "ArrowDown" ? state.at + 1 : key === "Home" ? 0 : key === "End" ? count - 1 : null;
  if (at !== null) {
    const next = Math.max(0, Math.min(count - 1, at));
    if (next === state.at) return { state, effect: NONE, announce: `${label} is at the ${next === 0 ? "start" : "end"}, position ${next + 1} of ${count}.`, handled: true };
    return { state: { from: state.from, at: next }, effect: NONE, announce: `${label} moved to position ${next + 1} of ${count}.`, handled: true };
  }
  if (key === " " || key === "Spacebar" || key === "Enter") {
    const moved = state.at !== state.from;
    return {
      state: null,
      effect: moved ? { type: "drop", from: state.from, to: state.at } : NONE,
      announce: moved ? `${label} dropped at position ${state.at + 1} of ${count}.` : `${label} dropped where it was, position ${state.at + 1} of ${count}.`,
      handled: true,
    };
  }
  if (key === "Escape") return { state: null, effect: { type: "cancel" }, announce: `Move cancelled. ${label} is back at position ${state.from + 1} of ${count}.`, handled: true };
  return idle(false);
}
