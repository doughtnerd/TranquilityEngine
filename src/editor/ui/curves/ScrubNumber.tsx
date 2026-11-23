// A number field with a scrub label (the curve editor's key fields, ADR 0346): dragging the label left or right changes
// the value (Shift 10× faster, Alt 10× slower) as one edit, Escape during the drag puts it back; typing commits on
// Enter or blur, Escape restores the shown value.
import { useEffect, useRef, useState } from "preact/hooks";

export interface ScrubNumberProps {
  readonly label: string;
  /** The input's accessible name, when it differs from the label ("Key value in dB"). */
  readonly ariaLabel?: string;
  readonly value: number | null;
  readonly step: number;
  readonly unit?: string;
  readonly disabled?: boolean;
  readonly title?: string;
  /** A value during a scrub (not yet an edit). */
  onPreview(value: number): void;
  /** The value typed, or where a scrub ended. */
  onCommit(value: number): void;
  /** A scrub was cancelled (Escape): drop the previews. */
  onCancel(): void;
}

const shownOf = (v: number | null, step: number) => (v === null ? "" : String(Number(v.toFixed(Math.max(0, Math.min(6, Math.ceil(-Math.log10(step) - 1e-9)))))));

export function ScrubNumber(props: ScrubNumberProps) {
  const { value, step, disabled } = props;
  const shown = shownOf(value, step);
  const [draft, setDraft] = useState(shown);
  const focused = useRef(false);
  const scrub = useRef<{ x: number; start: number; total: number; last: number; stop: () => void } | null>(null);
  useEffect(() => {
    if (!focused.current) setDraft(shown);
  }, [shown]);
  const finish = (keep: boolean) => {
    const s = scrub.current;
    if (!s) return;
    scrub.current = null;
    s.stop();
    if (keep && s.total !== 0) props.onCommit(s.last);
    else props.onCancel();
  };
  useEffect(() => () => finish(false), []);
  const commitText = (text: string) => {
    const n = text.trim() === "" ? NaN : Number(text);
    if (Number.isFinite(n) && n !== value) props.onCommit(n);
    else setDraft(shown);
  };
  return (
    <span class="ce-field">
      <label
        class={disabled || value === null ? "ce-field-label" : "ce-field-label scrub"}
        title={props.title ?? `Drag to change ${props.label.toLowerCase()} (Shift faster, Alt finer)`}
        onPointerDown={(e) => {
          if (disabled || value === null || e.button !== 0) return;
          e.preventDefault();
          const el = e.currentTarget as HTMLElement;
          el.setPointerCapture(e.pointerId);
          const view = el.ownerDocument.defaultView ?? window;
          const onKey = (k: KeyboardEvent) => {
            if (k.key !== "Escape") return;
            k.preventDefault();
            k.stopImmediatePropagation();
            finish(false);
          };
          view.addEventListener("keydown", onKey, true);
          scrub.current = { x: e.clientX, start: value, total: 0, last: value, stop: () => view.removeEventListener("keydown", onKey, true) };
        }}
        onPointerMove={(e) => {
          const s = scrub.current;
          if (!s) return;
          const dx = e.clientX - s.x;
          if (dx === 0) return;
          s.x = e.clientX;
          s.total += dx * step * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
          s.last = Number((s.start + s.total).toFixed(6));
          props.onPreview(s.last);
        }}
        onPointerUp={() => finish(true)}
        onPointerCancel={() => finish(true)}
      >
        {props.label}
      </label>
      <input
        type="text"
        inputMode="decimal"
        class="ce-in"
        aria-label={props.ariaLabel ?? props.label}
        disabled={disabled || value === null}
        value={draft}
        onFocus={() => (focused.current = true)}
        onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
        onBlur={(e) => {
          focused.current = false;
          commitText((e.currentTarget as HTMLInputElement).value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          else if (e.key === "Escape") {
            e.stopPropagation(); // restores the field, not the dialog's Cancel
            setDraft(shown);
            focused.current = false;
            (e.currentTarget as HTMLInputElement).value = shown;
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
      />
      {props.unit && <span class="ce-unit">{props.unit}</span>}
    </span>
  );
}
