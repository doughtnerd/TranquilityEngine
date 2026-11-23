// The Samples screen's own stroke icons (the owner's prototype `File.dc.html`): the timeline toolbar (add marker, add
// loop, razor, snap, root note, normalize, source version, tempo), the audio lane's view toggles, the Edits panel's
// Freeze and Flatten, the loop option segments, the readout strip and a few inspector actions. Drawn in `currentColor`
// like the kit's `Icon` (the `studio-glyph` class), each on its own small grid. Decoration: the button carries the name.
import "../../components/studioIcons.css";

interface Glyph {
  /** The viewBox's width and height. */
  readonly w: number;
  readonly h: number;
  readonly d: string;
}

const G = (w: number, h: number, d: string): Glyph => ({ w, h, d });

const GLYPHS = {
  addMarker: G(14, 14, "M2.5 13V1.5h6l-1.4 2.2 1.4 2.3h-6M10.5 8.5v4M8.5 10.5h4"),
  addLoop: G(15, 14, "M2.5 8.5a4 4 0 0 1 4-4h3.5M8.3 2.8 10 4.5 8.3 6.2M11.5 9v4M9.5 11h4M2.5 8.5a3 3 0 0 0 3 3H8"),
  razor: G(15, 14, "M1 3.6h8.4l1.1 1.6H3.4zM1.8 5.2h1.6M11.9 4.4a1 1 0 1 1-2 0a1 1 0 1 1 2 0M11.4 5.5 13.6 12"),
  snap: G(13, 13, "M2.5 1.5v5a4 4 0 0 0 8 0v-5M2.5 3.8h2.4M8.1 3.8h2.4M4.9 1.5v5a1.6 1.6 0 0 0 3.2 0v-5"),
  note: G(13, 14, "M8 2v7.5M8.2 10a2.4 1.8 0 1 1-4.8 0a2.4 1.8 0 1 1 4.8 0M8 2c1.5.4 2.6 1.4 3 3"),
  normalize: G(15, 14, "M1 7h1.5M3.5 4.5v5M5.5 3v8M7.5 5v4M9.5 2v10M11.5 4v6M13.5 7H14M1 1.2h13"),
  layers: G(14, 14, "M7 1.5 12.5 4 7 6.5 1.5 4zM1.5 7 7 9.5 12.5 7M1.5 10 7 12.5 12.5 10"),
  tempo: G(13, 14, "M4.5 1.5h4l3 11h-10zM6.5 9.5 10 3.5M2.3 9.5h8.4"),
  caret: G(10, 10, "M2 3.5l3 3 3-3"),
  waveform: G(14, 12, "M1 6h1M3 3.5v5M5 1.5v9M7 4v4M9 2v8M11 3.5v5M13 6h0"),
  spectrogram: G(14, 12, "M2 1h10a1.1 1.1 0 0 1 0 2.2H2a1.1 1.1 0 0 1 0-2.2zM2 4.6h10a1.1 1.1 0 0 1 0 2.2H2a1.1 1.1 0 0 1 0-2.2zM2 8.2h10a1.1 1.1 0 0 1 0 2.2H2a1.1 1.1 0 0 1 0-2.2z"),
  tape: G(12, 10, "M2.5 2.5h7a1.5 1.5 0 0 1 1.5 1.5v2a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 1 6V4a1.5 1.5 0 0 1 1.5-1.5zM4 2.5v5M8 2.5v5"),
  zoomSelection: G(13, 13, "M3.5 2H1.5v9h2M9.5 2h2v9h-2M4.5 6.5h4"),
  freeze: G(14, 14, "M7 1v12M1.8 4l10.4 6M1.8 10l10.4-6M5.5 1.8 7 3.2l1.5-1.4M5.5 12.2 7 10.8l1.5 1.4"),
  flatten: G(14, 14, "M2 2.5h10M2 5h10M4 7.5 7 10l3-2.5M2 12h10"),
  repeat: G(14, 12, "M2 6.5V5a2.5 2.5 0 0 1 2.5-2.5H11M9.5 1 11 2.5 9.5 4M12 5.5V7a2.5 2.5 0 0 1-2.5 2.5H3M4.5 11 3 9.5 4.5 8"),
  collapseAll: G(14, 14, "M4 1.5 7 4.5l3-3M4 12.5l3-3 3 3M2 7h10"),
  detach: G(14, 14, "M5.6 8.4 8.4 5.6M4.2 6.4 2.8 7.8a2.3 2.3 0 0 0 3.3 3.3l1.4-1.4M9.8 7.6l1.4-1.4a2.3 2.3 0 0 0-3.3-3.3L6.5 4.3M1.5 1.5l11 11"),
  revert: G(14, 14, "M4.5 3 1.8 5.7l2.7 2.7M2 5.7h6.5a3.5 3.5 0 0 1 0 7H6"),
  reset: G(12, 12, "M2.2 4.2A4 4 0 1 1 2 7.4M1.8 1.6v2.8h2.8"),
  trash: G(13, 14, "M1 3.5h11M4.5 3.5V2h4v1.5M2.5 3.5l.7 9h6.6l.7-9"),
  lock: G(12, 12, "M3 5.5V4a3 3 0 0 1 6 0v1.5M2 5.5h8v5H2z"),
  convertRange: G(14, 12, "M1.5 2.5v7M12.5 2.5v7M1.5 6h11"),
  convertPoint: G(14, 12, "M7 1.5v9M4 3.5h6"),
  // Readout strip (16 grid).
  play: G(16, 16, "M5 3.5l7 4.5-7 4.5z"),
  region: G(16, 16, "M4 3H2.5v10H4M12 3h1.5v10H12M6 8h4"),
  level: G(16, 16, "M3 13V9M6.5 13V6M10 13V8M13.5 13V3"),
  nextMarker: G(16, 16, "M4 14V2.5h7.5l-1.8 2.5 1.8 2.5H4"),
  // Loop option segments (the prototype's SEGIC).
  endless: G(14, 12, "M7 6C5.6 4.2 4.6 3.6 3.5 3.6a2.4 2.4 0 0 0 0 4.8c1.1 0 2.1-.6 3.5-2.4s2.4-2.4 3.5-2.4a2.4 2.4 0 0 1 0 4.8c-1.1 0-2.1-.6-3.5-2.4z"),
  count: G(14, 12, "M2.5 3.5h1.5v5M2 8.5h3.5M8 4.5l3.5 3.5M11.5 4.5 8 8"),
  held: G(14, 12, "M5.2 6.6V2.6a.75.75 0 0 1 1.5 0v3.2M6.7 5.6V1.8a.75.75 0 0 1 1.5 0v3.8M8.2 5.6V2.4a.75.75 0 0 1 1.5 0v3.6M9.7 5.2a.75.75 0 0 1 1.5 0v2.2c0 2.1-1.4 3.6-3.4 3.6h-.6c-1.1 0-1.9-.5-2.6-1.5L3 7.2a.75.75 0 0 1 1.2-.9l1 1.1"),
  parameter: G(14, 12, "M2.5 1.5h9v9h-9zM5.8 8.6V3.4h1.7a1.5 1.5 0 0 1 0 3H5.8"),
  jump: G(14, 12, "M1.5 6h8M7 3l3 3-3 3M12.5 2v8"),
  finish: G(14, 12, "M2.5 7.5a3 3 0 0 1 3-3h4M8 2.8 9.7 4.5 8 6.2M1.5 10.5h11"),
  crossfade: G(14, 12, "M1.5 3 12.5 9M1.5 9 12.5 3"),
  ignore: G(14, 12, "M2 6h9M8 3l3 3-3 3"),
  reenter: G(14, 12, "M11.5 9.5V6.5a3 3 0 0 0-3-3H3M5 1.5l-2 2 2 2"),
  forward: G(14, 12, "M1.5 6h11M9.5 3l3 3-3 3"),
  pingPong: G(14, 12, "M2 6h10M4.8 3 2 6l2.8 3M9.2 3 12 6l-2.8 3"),
  backward: G(14, 12, "M12.5 6h-11M4.5 3 1.5 6l3 3"),
} as const;

export type SampleIconName = keyof typeof GLYPHS;

/** One of the screen's icons, `size` px tall (its width follows its grid). */
export function SampleIcon(props: { name: SampleIconName; size?: number; class?: string }) {
  const g = GLYPHS[props.name];
  const h = props.size ?? 14;
  const w = Math.round((h * g.w) / g.h);
  return (
    <svg class={`studio-glyph smp-glyph${props.class ? ` ${props.class}` : ""}`} style={{ "--icon-size": `${h}px`, width: `${w}px`, height: `${h}px` } as Record<string, string>} viewBox={`0 0 ${g.w} ${g.h}`} aria-hidden="true" focusable="false">
      <path d={g.d} />
    </svg>
  );
}
