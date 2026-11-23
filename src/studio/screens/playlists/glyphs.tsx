// The Playlists screen's own small glyphs (the owner's prototype, Playlists.dc.html: the mode, pick, change, blend and
// loop icon segments, the Voice button's curve, the Variation zigzag): 16-unit strokes in the text colour, a filled
// part where the prototype has one. Beside them, the icon segmented control those toolbars use (`.seg.mseg`: joined
// 16px icon buttons, the chosen one filled with the accent), with the kit's radio-group keys (`segmentedModel.ts`).
import { useRef } from "preact/hooks";
import { segmentForKey } from "../../../editor/ui/segmentedModel";

/** A glyph: its stroke path and, optionally, a filled path (16-unit grid). */
export interface GlyphPaths {
  readonly stroke: string;
  readonly fill?: string;
}

export function Glyph(props: { readonly paths: GlyphPaths; readonly size?: number; readonly width?: number }) {
  const s = props.size ?? 16;
  return (
    <svg class="pl-glyph" width={s} height={s} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={props.paths.stroke} fill="none" stroke="currentColor" stroke-width={props.width ?? 1.3} stroke-linecap="round" stroke-linejoin="round" />
      {props.paths.fill && <path d={props.paths.fill} fill="currentColor" stroke="none" />}
    </svg>
  );
}

/** The Voice button's curve (24-unit, as the prototype's `.cvw`). */
export function CurveGlyph() {
  return (
    <svg class="pl-glyph" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 19C8 19 9 5 14 5S19 12 21 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
    </svg>
  );
}

export const MODE_GLYPHS = {
  clip: { stroke: "M1.5 8h2.5l1.5-4.5 2.5 9 2-6.5 1.5 2h3" },
  queue: { stroke: "M1.5 5h3.5v6H1.5zM6.25 5h3.5v6h-3.5zM11 5h3.5v6H11z" },
  switch: { stroke: "M1.5 8h4.5l3.5-4.5h5M6 8l3.5 4.5h5", fill: "M4.7 8a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0 -2.6 0z" },
  blend: { stroke: "M1.5 4C6 4 10 12 14.5 12M1.5 12C6 12 10 4 14.5 4" },
  layer: { stroke: "M8 2 14.5 5 8 8 1.5 5zM1.5 8.2 8 11.2l6.5-3M1.5 11.2 8 14.2l6.5-3" },
  sequence: { stroke: "M1.5 4h6M4.5 8h10M1.5 12h7" },
} as const satisfies Record<string, GlyphPaths>;

export const PICK_GLYPHS = {
  random: { stroke: "M2.5 2.5h11v11h-11z", fill: "M4.5 5.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0zM7 8a1 1 0 1 0 2 0a1 1 0 1 0 -2 0zM9.5 10.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0z" },
  shuffle: { stroke: "M2 4.5h3l6 7h3M2 11.5h3l1.8-2.1M9.2 6.6 11 4.5h3M12.5 3l1.5 1.5-1.5 1.5M12.5 10l1.5 1.5-1.5 1.5" },
  roundRobin: { stroke: "M13 8a5 5 0 1 1-1.5-3.6M11.5 1.6v2.8H8.7" },
} as const satisfies Record<string, GlyphPaths>;

/** A Switch change's How (crossfade, cut, a transition playlist). */
export const HOW_GLYPHS = {
  crossfade: { stroke: "M2 4l12 8M2 12l12-8" },
  cut: { stroke: "M1.5 11.5H8v-7h6.5" },
  transition: { stroke: "M1.5 11.5h3l2-7h3l2 7h3" },
} as const satisfies Record<string, GlyphPaths>;

/** A Switch change's When. */
export const WHEN_GLYPHS = {
  now: { stroke: "M8 2.5v11M4 6l4-3.5L12 6" },
  beat: { stroke: "M2.5 3v10M5.5 8h7.5M10 5l3 3-3 3" },
  bar: { stroke: "M2.5 3v10M13.5 3v10M5 8h5.5M8.5 6l2 2-2 2" },
  exit: { stroke: "M2.5 3v10M6 8h7.5M10.5 5l3 3-3 3", fill: "M2.5 3h3v3h-3z" },
  nextTrigger: { stroke: "M2.5 3v10M5.5 8h7.5M10 5l3 3-3 3", fill: "M12.5 1.5 14.5 3.5 12.5 5.5 10.5 3.5z" },
} as const satisfies Record<string, GlyphPaths>;

export const DIM_GLYPHS = {
  "1": { stroke: "M2 8h12", fill: "M2.8 8a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0 -2.4 0zM6.8 8a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0 -2.4 0zM10.8 8a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0 -2.4 0z" },
  "2": { stroke: "M2.5 2.5h11v11h-11z", fill: "M4.4 5.5a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0 -2.2 0zM9.4 5.5a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0 -2.2 0zM4.4 10.5a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0 -2.2 0zM9.4 10.5a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0 -2.2 0z" },
} as const satisfies Record<string, GlyphPaths>;

export const FADE_GLYPHS = {
  crossfade: { stroke: "M2 4l12 8M2 12l12-8" },
  layer: { stroke: "M2 13h12M2 13l4-5h8M2 13l7-9h5" },
} as const satisfies Record<string, GlyphPaths>;

export const CURVE_GLYPHS = {
  linear: { stroke: "M2 13 14 3" },
  equalPower: { stroke: "M2 13Q3 3 14 3" },
} as const satisfies Record<string, GlyphPaths>;

export const FOLLOW_GLYPHS = {
  follow: { stroke: "M1.5 11c2.5 0 3-6 6.5-6s4 6 6.5 6" },
  hold: { stroke: "M2 5h12M5 2.5v5M11 2.5v5M2 11h12" },
} as const satisfies Record<string, GlyphPaths>;

export const LOOP_GLYPHS = {
  inherit: { stroke: "M1.5 8h2l1.5-3 2 6 2-8 2 7 1.5-2h2" },
  off: { stroke: "M2 8h8.5M7.5 5l3 3-3 3M13.5 4v8" },
  on: { stroke: "M3 7.5a4.5 4.5 0 0 1 7.8-3M13 8.5a4.5 4.5 0 0 1-7.8 3M11 1.8v2.9h-2.9M5 14.2v-2.9h2.9" },
} as const satisfies Record<string, GlyphPaths>;

export const AT_ZERO_GLYPHS = {
  stop: { stroke: "M4 4h8v8H4z" },
  continue: { stroke: "M2 8h9M8 5l3 3-3 3M13.5 4v8" },
} as const satisfies Record<string, GlyphPaths>;

export const VARIATION_GLYPH: GlyphPaths = { stroke: "M1.5 10l2.5-4 2.5 5 2.5-7 2.5 6 3-3" };
export const COLLAPSE_GLYPH: GlyphPaths = { stroke: "M4 2.5 8 6.5l4-4M4 13.5l4-4 4 4M2 8h12" };
export const LINK_GLYPH: GlyphPaths = { stroke: "M6.5 9.5l3-3M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8" };

export interface IconOption<T extends string> {
  readonly value: T;
  /** Its name (the button's accessible name). */
  readonly label: string;
  /** "<Name>: <what it does>" (the tooltip). */
  readonly title: string;
  readonly glyph: GlyphPaths;
  readonly disabled?: boolean;
}

/** Joined icon buttons, one chosen (the prototype's `.seg.mseg`): a radio group with the kit's keys. */
export function IconSegments<T extends string>(props: { readonly label: string; readonly value: T; readonly options: readonly IconOption<NoInfer<T>>[]; readonly disabled?: boolean; onChange(v: NoInfer<T>): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const opts = props.options.map((o) => ({ ...o, disabled: o.disabled || props.disabled }));
  return (
    <div
      ref={ref}
      class="pl-mseg"
      role="radiogroup"
      aria-label={props.label}
      onKeyDown={(e) => {
        const next = segmentForKey(opts, props.value, e.key);
        if (next === null) return;
        e.preventDefault();
        props.onChange(next);
        queueMicrotask(() => ref.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next)}"]`)?.focus());
      }}
    >
      {opts.map((o) => {
        const on = o.value === props.value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} aria-label={o.label} data-value={o.value} class={on ? "on" : undefined} tabIndex={on ? 0 : -1} title={o.title} disabled={o.disabled}
            onClick={() => !on && props.onChange(o.value)}>
            <Glyph paths={o.glyph} />
          </button>
        );
      })}
    </div>
  );
}
