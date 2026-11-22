// A parameter row (ADR 0335 `ParameterRow`): label | slider | number and unit, for an effect parameter, a send level, a
// ducking time or a game parameter's test value. Log parameters (frequencies) slide in log scale. Dragging the label
// scrubs the value as the Inspector's labels do (Shift ×10, Alt fine; Escape puts it back); the number box takes typed
// values ("2.4k") and arrow keys (Shift ×10, Alt fine).
//
// Values are reported as `onValue(value, drag)` (ADR 0282's rule, which `fieldDrag.ts` follows): `drag` true while the
// slider or the label moves, then the last value with false on release; a typed value or a key step reports once with
// false. The owner makes a drag one undo step (`doc.edit(next, drag ? { coalesce: true } : undefined)`).
import { useRef } from "preact/hooks";
import type { ValueReport } from "../../editor/ui/valueControls";
import { SLIDER_STEPS, formatParam, paramBoxText, paramKey, paramToSlider, parseParam, scrubParam, sliderToParam, type ParamSpec } from "./parameterRowModel";
import "./audioParts.css";

export interface ParameterRowProps {
  readonly spec: ParamSpec;
  readonly value: number;
  /** Disabled (automated, or read-only), with why as the tooltip. */
  readonly disabled?: boolean;
  readonly title?: string;
  /** Shown instead of the number while disabled ("auto · 800 Hz"). */
  readonly note?: string;
  /** Ids prefix, so the label can name the number box. */
  readonly id?: string;
  onValue: ValueReport<number>;
}

let rowSeq = 0;

export function ParameterRow(props: ParameterRowProps) {
  const { spec, value, disabled, onValue } = props;
  const idRef = useRef(props.id ?? `studio-param-${++rowSeq}`);
  const scrub = useRef<{ x: number; dx: number; start: number; last: number; moved: boolean; stop: () => void } | null>(null);
  const finish = (keep: boolean) => {
    const s = scrub.current;
    if (!s) return;
    scrub.current = null;
    s.stop();
    if (s.moved) onValue(keep ? s.last : s.start, false);
  };
  const box = `${idRef.current}-value`;
  return (
    <div class={`studio-param${disabled ? " disabled" : ""}`} title={props.title}>
      <label
        class={disabled ? undefined : "scrub"}
        for={box}
        title={disabled ? props.title : `${spec.label}: drag to change (Shift ×10, Alt fine)`}
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) return;
          e.preventDefault();
          const label = e.currentTarget as HTMLElement;
          label.setPointerCapture(e.pointerId);
          const view = label.ownerDocument.defaultView ?? window;
          const onKey = (k: KeyboardEvent) => {
            if (k.key !== "Escape") return;
            k.preventDefault();
            k.stopImmediatePropagation();
            finish(false);
          };
          view.addEventListener("keydown", onKey, true);
          scrub.current = { x: e.clientX, dx: 0, start: value, last: value, moved: false, stop: () => view.removeEventListener("keydown", onKey, true) };
        }}
        onPointerMove={(e) => {
          const s = scrub.current;
          if (!s) return;
          s.dx += e.clientX - s.x;
          s.x = e.clientX;
          const v = scrubParam(spec, s.start, s.dx, { shift: e.shiftKey, alt: e.altKey });
          if (v === s.last) return;
          s.last = v;
          s.moved = true;
          onValue(v, true);
        }}
        onPointerUp={() => finish(true)}
        onPointerCancel={() => finish(true)}
      >
        {spec.label}
      </label>
      <input
        type="range"
        min={0}
        max={SLIDER_STEPS}
        step={1}
        value={paramToSlider(spec, value)}
        disabled={disabled}
        aria-label={spec.label}
        aria-valuetext={formatParam(spec, value)}
        onInput={(e) => onValue(sliderToParam(spec, Number((e.currentTarget as HTMLInputElement).value)), true)}
        onChange={(e) => onValue(sliderToParam(spec, Number((e.currentTarget as HTMLInputElement).value)), false)}
      />
      <span class="studio-param-value">
        {disabled && props.note ? (
          <span class="studio-param-note">{props.note}</span>
        ) : (
          <input
            id={box}
            class="studio-param-box"
            type="text"
            inputMode="decimal"
            value={paramBoxText(spec, value)}
            disabled={disabled}
            aria-label={`${spec.label} value`}
            onKeyDown={(e) => {
              const next = paramKey(spec, value, e.key, { shift: e.shiftKey, alt: e.altKey });
              if (next === null || e.key === "Home" || e.key === "End") return;
              e.preventDefault();
              if (next !== value) onValue(next, false);
            }}
            onChange={(e) => {
              const input = e.currentTarget as HTMLInputElement;
              const next = parseParam(spec, input.value);
              if (next === null) input.value = paramBoxText(spec, value);
              else if (next !== value) onValue(next, false);
              else input.value = paramBoxText(spec, value);
            }}
          />
        )}
        {spec.unit && <span class="studio-param-unit">{spec.unit}</span>}
      </span>
    </div>
  );
}
