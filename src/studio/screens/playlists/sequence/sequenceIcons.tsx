// The Sequence view's own glyphs (owner's prototype `Sequencer.dc.html`): the toolbar's add-track, add-loop, add-hold,
// spectrogram, tempo, snap and Playlists-link icons, the loop Active icons (∞ always, ✋ while held, P parameter), the
// track header's power and trash, and zoom to selection. Drawn like the Studio's `Icon` set (stroke in the text colour,
// sized with the UI scale, decoration only: the button carries the name).
import type { LoopBehaviour } from "../../../../engine/audio/playlist/types";

interface Shape {
  readonly box: string;
  readonly stroke?: string;
  readonly fill?: string;
  readonly width?: number;
}

const SHAPES = {
  addTrack: { box: "0 0 15 14", stroke: "M1 3.5h8M1 7h6M1 10.5h5M11.5 7v6M8.5 10h6" },
  addLoop: { box: "0 0 15 14", stroke: "M2.5 8.5a4 4 0 0 1 4-4h3.5M8.3 2.8 10 4.5 8.3 6.2M11.5 9v4M9.5 11h4M2.5 8.5a3 3 0 0 0 3 3H8" },
  addHold: { box: "0 0 14 14", stroke: "M5 1.5v11M7.5 3.5h3v3h-3zM11 9.5v4M9 11.5h4" },
  wave: { box: "0 0 14 12", stroke: "M1 6h1M3 3.5v5M5 1.5v9M7 4v4M9 2v8M11 3.5v5M13 6h0" },
  tempo: { box: "0 0 13 14", stroke: "M4.5 1.5h4l3 11h-10zM6.5 9.5 10 3.5M2.3 9.5h8.4", width: 1.1 },
  snap: { box: "0 0 13 13", stroke: "M2.5 1.5v5a4 4 0 0 0 8 0v-5M2.5 3.8h2.4M8.1 3.8h2.4M4.9 1.5v5a1.6 1.6 0 0 0 3.2 0v-5" },
  link: { box: "0 0 15 14", stroke: "M1.5 4h9M8 1.5 10.5 4 8 6.5M13.5 10h-9M7 7.5 4.5 10 7 12.5" },
  power: { box: "0 0 12 12", stroke: "M6 1.5v4M3.4 3.2a4 4 0 1 0 5.2 0" },
  trash: { box: "0 0 12 12", stroke: "M2 3.5h8M4.5 3.5V2h3v1.5M3 3.5l.6 7h4.8l.6-7" },
  zoomSel: { box: "0 0 14 14", stroke: "M3.5 3v8M10.5 3v8M5.5 7h3", width: 1.3 },
  caret: { box: "0 0 10 10", stroke: "M2 3.5l3 3 3-3", width: 1.5 },
  always: { box: "0 0 13 12", stroke: "M6.5 6C5.2 4.3 4.3 3.7 3.3 3.7a2.3 2.3 0 0 0 0 4.6c1 0 1.9-.6 3.2-2.3s2.2-2.3 3.2-2.3a2.3 2.3 0 0 1 0 4.6c-1 0-1.9-.6-3.2-2.3z" },
  held: { box: "0 0 12 12", stroke: "M4.2 6.6V2.6a.75.75 0 0 1 1.5 0v3.2M5.7 5.6V1.8a.75.75 0 0 1 1.5 0v3.8M7.2 5.6V2.4a.75.75 0 0 1 1.5 0v3.6M8.7 5.2a.75.75 0 0 1 1.5 0v2.2c0 2.1-1.4 3.6-3.4 3.6h-.6c-1.1 0-1.9-.5-2.6-1.5L2 7.2a.75.75 0 0 1 1.2-.9l1 1.1", width: 1.1 },
  parameter: { box: "0 0 12 12", stroke: "M3 1.5h6a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 9 10.5H3A1.5 1.5 0 0 1 1.5 9V3A1.5 1.5 0 0 1 3 1.5zM4.8 8.5v-5h1.7a1.4 1.4 0 0 1 0 2.8H4.8" },
} satisfies Record<string, Shape>;

export type SeqIconName = keyof typeof SHAPES | "spectrogram";

export function SeqIcon(props: { readonly name: SeqIconName; readonly size?: number; readonly class?: string }) {
  const size = props.size ?? 14;
  const style = { "--icon-size": `${size}px` } as Record<string, string>;
  if (props.name === "spectrogram") {
    return (
      <svg class={`studio-glyph sq-glyph filled${props.class ? ` ${props.class}` : ""}`} style={style} viewBox="0 0 14 12" aria-hidden="true" focusable="false">
        <rect x="1" y="1" width="12" height="2.2" rx="1" opacity=".35" />
        <rect x="1" y="4.6" width="12" height="2.2" rx="1" opacity=".6" />
        <rect x="1" y="8.2" width="12" height="2.2" rx="1" opacity=".9" />
      </svg>
    );
  }
  const s: Shape = SHAPES[props.name];
  return (
    <svg class={`studio-glyph sq-glyph${props.class ? ` ${props.class}` : ""}`} style={{ ...style, "--sq-stroke": String(s.width ?? 1.2) }} viewBox={s.box} aria-hidden="true" focusable="false">
      <path d={s.stroke} />
    </svg>
  );
}

/** The icon of a loop's Active setting (∞ always, ✋ while held, P parameter). */
export const activeIcon = (active: LoopBehaviour["active"]): SeqIconName => active;
