// The take strip of the clip import settings (ADR 0373 "split takes on a timeline strip"; T54): one take drawn as a
// time line, its clips as ranges on it (the selected one marked), the playhead as a line. Clicking a range selects its
// clip; clicking the empty line moves the playhead there. The ranges are the clips' `from`/`to` seconds (D111), and a
// range's edges are edited as numbers beside the strip (`ClipImportSettings.tsx`), so the strip itself only selects and seeks.
import type { ClipImportSettings } from "../../../../engine/animation/import/clips";

export interface TakeStripProps {
  /** The take's length, seconds. */
  readonly duration: number;
  readonly clips: readonly ClipImportSettings[];
  readonly selected: string | null;
  /** The playhead, seconds into the take. */
  readonly playhead: number;
  onSelect(clip: string): void;
  onSeek(seconds: number): void;
}

const pct = (seconds: number, duration: number): string => `${Math.min(100, Math.max(0, (seconds / duration) * 100))}%`;

/** A take as a strip of its clips (see the file comment). */
export function TakeStrip(props: TakeStripProps) {
  const { duration, clips, selected, playhead } = props;
  const span = duration > 0 ? duration : 1;
  return (
    <div
      class="take-strip"
      role="group"
      aria-label="Take strip"
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const box = e.currentTarget.getBoundingClientRect();
        if (box.width > 0) props.onSeek(((e.clientX - box.left) / box.width) * span);
      }}
    >
      {clips.map((c) => {
        const to = c.to ?? span;
        return (
          <button
            key={c.name}
            type="button"
            class={`take-strip-clip${c.name === selected ? " on" : ""}`}
            style={{ left: pct(c.from, span), width: pct(to - c.from, span) }}
            aria-pressed={c.name === selected}
            title={`${c.name}: ${c.from.toFixed(2)} to ${to.toFixed(2)} s`}
            onClick={() => props.onSelect(c.name)}
          >
            {c.name}
          </button>
        );
      })}
      <div class="take-strip-playhead" style={{ left: pct(playhead, span) }} aria-hidden="true" />
    </div>
  );
}
