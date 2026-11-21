import { useEffect, useRef, useState } from "preact/hooks";
import "./particles.css";

const formatNumber = (n: number) => String(+n.toFixed(4));

/**
 * A number field that commits as it is typed whenever the text reads as a number (so a half-typed
 * "0." or "-" waits), and shows the committed value again on blur.
 */
export function NumField(props: { value: number; onCommit: (v: number) => void; label: string; integer?: boolean; min?: number; max?: number; disabled?: boolean }) {
  const shown = formatNumber(props.value);
  const [draft, setDraft] = useState(shown);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(shown);
  }, [shown]);
  const clamp = (n: number) => {
    const v = props.integer ? Math.round(n) : n;
    return Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, v));
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      class="num-input pe-num"
      aria-label={props.label}
      disabled={props.disabled}
      value={draft}
      onFocus={() => (focused.current = true)}
      onInput={(e) => {
        const text = (e.currentTarget as HTMLInputElement).value;
        setDraft(text);
        const n = text.trim() === "" ? NaN : Number(text);
        if (Number.isFinite(n) && clamp(n) !== props.value) props.onCommit(clamp(n));
      }}
      onBlur={() => {
        focused.current = false;
        setDraft(shown);
      }}
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
