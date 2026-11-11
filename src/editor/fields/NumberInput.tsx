// The Inspector's number box: commits on Enter or blur, reverts on Escape, accepts simple arithmetic.
import { useLayoutEffect, useState } from "preact/hooks";
import { parseNumber } from "../fieldValues";

/** Shown for values that differ between the selected nodes. */
export const MIXED = "—";

/** `n` for display, rounded to `decimals` places (integers as they are). */
export function formatNumber(n: number, decimals = 3): string {
  if (Number.isInteger(n)) return String(n);
  const f = 10 ** decimals;
  return String(Math.round(n * f) / f + 0);
}

/**
 * A number that commits on Enter or blur. Accepts simple arithmetic (`2*3`, `pi/2`); invalid text reverts.
 * A null value (differs between the selected nodes) shows a dash until a number is typed. Leaving the
 * box without changing its text commits nothing, so a rounded display never rewrites the value.
 */
export function NumberInput(props: { value: number | null; integer?: boolean; decimals?: number; label: string; onCommit: (v: number) => void }) {
  const shown = props.value === null ? MIXED : formatNumber(props.value, props.decimals);
  const [draft, setDraft] = useState(shown);
  useLayoutEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    if (draft === shown) return;
    const n = parseNumber(draft);
    if (n === null) return setDraft(shown);
    const value = props.integer ? Math.round(n) : n;
    if (value !== props.value) props.onCommit(value);
    else setDraft(shown);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      class="num-input"
      aria-label={props.label}
      value={draft}
      onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(shown);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}
