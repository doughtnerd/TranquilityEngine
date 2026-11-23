// A segmented control (ADR 0349): one choice of a few, drawn as joined buttons, with the ARIA radio group pattern
// (one tab stop on the chosen option; arrows move and pick, `segmentedModel.ts`). As wide as its options (never
// stretched across its row), wrapping onto another line rather than clipping an option in a narrow panel; or, with
// `fit="menu"`, one row always: when its options don't fit the room it has, it becomes a menu (a select) of the same
// options (an inspector at the dock's default width: Kind, marker Type).
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { segmentForKey, type SegmentOption } from "./segmentedModel";
import "./kit.css";

export type { SegmentOption } from "./segmentedModel";

export interface SegmentedControlProps<T extends string> {
  readonly options: readonly SegmentOption<NoInfer<T>>[];
  readonly value: T;
  /** The group's accessible name. */
  readonly label: string;
  readonly size?: "small" | "normal";
  /**
   * Its look (owner's prototype): "underline" (default, `.sg`: the chosen segment on --active with a 2 px accent
   * underline) or "fill" (`.seg`: the chosen segment filled with the accent).
   */
  readonly look?: "underline" | "fill";
  /** "wrap" (default): wrap onto more rows when narrow. "menu": stay one row, and become a menu when that doesn't fit. */
  readonly fit?: "wrap" | "menu";
  onChange(value: NoInfer<T>): void;
}

export function SegmentedControl<T extends string>(props: SegmentedControlProps<T>) {
  return props.fit === "menu" ? <FittedSegments {...props} /> : <Segments {...props} />;
}

/** One row of segments while they fit the room they have (measured on a hidden copy), else a menu of the same options. */
function FittedSegments<T extends string>(props: SegmentedControlProps<T>) {
  const box = useRef<HTMLSpanElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [menu, setMenu] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    const p = probe.current;
    if (!el || !p) return;
    const check = () => {
      const need = p.firstElementChild instanceof HTMLElement ? p.firstElementChild.offsetWidth : 0;
      setMenu(need > 0 && el.clientWidth > 0 && need > el.clientWidth + 0.5);
    };
    check();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [props.options.map((o) => o.label).join("|"), props.size, props.look]);
  const { options, value, onChange } = props;
  return (
    <span ref={box} class="kit-segmented-fit">
      <span ref={probe} class="kit-segmented-probe" aria-hidden="true" inert>
        <Segments {...props} probe />
      </span>
      {menu ? (
        <select class="kit-segmented-menu" aria-label={props.label} value={value} title={options.find((o) => o.value === value)?.title} onChange={(e) => onChange((e.currentTarget as HTMLSelectElement).value as T)}>
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled} title={o.title}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <Segments {...props} />
      )}
    </span>
  );
}

function Segments<T extends string>(props: SegmentedControlProps<T> & { readonly probe?: boolean }) {
  const { options, value, onChange } = props;
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      class={`kit-segmented${props.size === "small" ? " small" : ""}${props.look === "fill" ? " fill" : ""}${props.fit === "menu" ? " one-row" : ""}`}
      role={props.probe ? undefined : "radiogroup"}
      aria-label={props.label}
      onKeyDown={(e) => {
        const next = segmentForKey(options, value, e.key);
        if (next === null) return;
        e.preventDefault();
        onChange(next);
        queueMicrotask(() => ref.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next)}"]`)?.focus());
      }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" role={props.probe ? undefined : "radio"} aria-checked={props.probe ? undefined : on} data-value={o.value} class={on ? "on" : undefined} tabIndex={on ? 0 : -1} disabled={o.disabled} title={o.title} onClick={() => !on && onChange(o.value)}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
