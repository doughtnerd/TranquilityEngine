// A preview of the built-in subtitle display (ADR 0343 §5–§6) for tools without a renderer: the subtitle board's rows
// (`runtime/board.ts`, the model `SubtitleDisplay` draws) drawn as DOM in the built-in look, on a 16:9 frame. The
// editor's Play shows the real display; this one is for previews (stories, an Inspector sample row, a test bench).
import { SUBTITLE_LOOK } from "../runtime/look";
import type { BoardRow } from "../runtime/board";

export interface SubtitlePreviewProps {
  /** The board's rows now, oldest first. */
  readonly rows: readonly BoardRow[];
  /** Whether speech rows show their speaker's name (`showSpeakerNames`). */
  readonly names: boolean;
  /** A speaker's shown name (formatted, `Ava:`) and colour (null: the built-in speaker colour). */
  speaker(id: string): { name: string; color: string | null };
  /** Font size in preview pixels (`fontSizeFor` over the frame's height). */
  readonly fontSize: number;
  /** The box's opacity, 0..1. */
  readonly background: number;
  readonly position: "bottom" | "top";
  /** % of the frame's height from the edge, and % of its width. */
  readonly margin: number;
  readonly maxWidth: number;
  /** The frame's height in pixels (its width follows at 16:9). */
  readonly height: number;
}

export function SubtitlePreview(props: SubtitlePreviewProps) {
  const L = SUBTITLE_LOOK;
  const rows = props.position === "top" ? [...props.rows].reverse() : props.rows;
  return (
    <div
      role="img"
      aria-label="Subtitle preview"
      style={{ position: "relative", height: `${props.height}px`, width: `${(props.height * 16) / 9}px`, background: "var(--bg)", border: "1px solid var(--border)", overflow: "hidden" }}
    >
      <div
        role="list"
        aria-label="Subtitles"
        style={{
          position: "absolute",
          [props.position]: `${props.margin}%`,
          left: `${(100 - props.maxWidth) / 2}%`,
          width: `${props.maxWidth}%`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: `${L.gap}px`,
        }}
      >
        {rows.map((r) => {
          const who = r.kind === "speech" && r.speaker !== null && props.names ? props.speaker(r.speaker) : null;
          return (
            <div key={r.id} role="listitem" class={`subtitle-row ${r.kind}`} style={{ position: "relative", display: "flex", gap: `${L.nameGap}px`, padding: `${L.padding}px`, opacity: r.opacity, fontSize: `${props.fontSize}px`, lineHeight: 1.25 }}>
              <span aria-hidden="true" style={{ position: "absolute", inset: 0, background: L.background, borderRadius: `${L.radius}px`, opacity: props.background }} />
              {who && <b class="speaker" style={{ position: "relative", color: who.color ?? L.speakerColor }}>{who.name}</b>}
              <span class="line" style={{ position: "relative", textAlign: "center", color: r.kind === "caption" ? L.captionColor : L.color }}>{r.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
