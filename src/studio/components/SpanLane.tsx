// A span lane (ADR 0335 `SpanLane`): one lane of instances or voices over time (a take's playlist instances, a
// capture's voices), each a bar coloured by status with its held part (sustain, held loop) drawn inside, overlapping
// bars stacked in rows. Click a bar to select it; with the lane focused, Left and Right move the selection, Home and
// End jump to the ends, Enter opens it. A "problems only" filter dims the ones that played fine. The lane takes a
// time → x function, so it lines up with the ruler above it.
import { formatTime, type TimeToX } from "./timeAxis";
import { STATUS_TEXT, isDimmed, packSpans, spanBoxes, spanEnd, stepSpan, type Span } from "./spanLaneModel";
import "./audioParts.css";

export interface SpanLaneProps {
  readonly spans: readonly Span[];
  readonly toX: TimeToX;
  /** The lane's width in px (bars past it are clipped). */
  readonly width: number;
  /** Now, seconds: where spans still playing end. */
  readonly now: number;
  /** The lane's name ("Impacts"). */
  readonly label: string;
  readonly selected?: string | null;
  readonly filter?: "all" | "problems";
  /** Each row's height, px (default 18). */
  readonly rowHeight?: number;
  onSelect?(id: string): void;
  /** Enter or a double-click on a span. */
  onOpen?(id: string): void;
}

export function SpanLane(props: SpanLaneProps) {
  const { spans, toX, now } = props;
  const rowHeight = props.rowHeight ?? 18;
  const { rows, count } = packSpans(spans, now);
  const filter = props.filter ?? "all";
  return (
    <div
      class="studio-spanlane"
      role="listbox"
      aria-label={props.label}
      tabIndex={0}
      aria-activedescendant={props.selected ? `studio-span-${props.selected}` : undefined}
      style={{ width: `${props.width}px`, height: `${count * rowHeight + 2}px` }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && props.selected) {
          e.preventDefault();
          props.onOpen?.(props.selected);
          return;
        }
        const next = stepSpan(spans, props.selected ?? null, e.key);
        if (next === null) return;
        e.preventDefault();
        props.onSelect?.(next);
      }}
    >
      {spans.map((s) => {
        const box = spanBoxes(s, toX, now);
        const row = rows.get(s.id) ?? 0;
        const selected = s.id === props.selected;
        return (
          <div
            key={s.id}
            id={`studio-span-${s.id}`}
            role="option"
            aria-selected={selected}
            class={`studio-span ${s.status}${selected ? " selected" : ""}${isDimmed(s, filter) ? " dim" : ""}${s.end === null ? " live" : ""}`}
            style={{ left: `${box.x}px`, width: `${box.width}px`, top: `${row * rowHeight + 1}px`, height: `${rowHeight - 2}px` }}
            title={`${s.label} · ${STATUS_TEXT[s.status]} · ${formatTime(s.start)} – ${s.end === null ? "playing" : formatTime(spanEnd(s, now))}`}
            onClick={() => props.onSelect?.(s.id)}
            onDblClick={() => props.onOpen?.(s.id)}
          >
            {box.held && <span class="studio-span-held" style={{ left: `${box.held.x - box.x}px`, width: `${box.held.width}px` }} />}
            <span class="studio-span-label">{s.label}</span>
          </div>
        );
      })}
    </div>
  );
}
