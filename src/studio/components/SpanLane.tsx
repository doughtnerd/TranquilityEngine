// A span lane (ADR 0349 `SpanLane`): one lane of instances or voices over time (a take's playlist instances, a
// capture's voices), each a bar coloured by status with its held part (sustain, held loop) drawn inside, overlapping
// bars stacked in rows (or, `collapsed`, drawn over each other on one row, the selected one on top). Click a bar to
// select it; with the lane focused, Left and Right move the selection, Home and End jump to the ends, Enter opens it.
// A "problems only" filter dims the ones that played fine. The lane takes a time → x function, so it lines up with the
// ruler above it.
import { formatTime, type TimeToX } from "./timeAxis";
import { heatText, type Heat } from "./heatmapModel";
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
  /** Experimental heatmap: each span's play-count heat, which recolours it from cold to hot (null: drawn by status). */
  readonly heat?: (span: Span) => Heat | null;
  /** Every bar on one row, overlapping ones drawn over each other (later on top), instead of stacked in rows. */
  readonly collapsed?: boolean;
  onSelect?(id: string): void;
  /** Enter or a double-click on a span. */
  onOpen?(id: string): void;
}

export function SpanLane(props: SpanLaneProps) {
  const { spans, toX, now } = props;
  const rowHeight = props.rowHeight ?? 18;
  const packed = packSpans(spans, now);
  const rows = props.collapsed ? new Map<string, number>() : packed.rows;
  const count = props.collapsed ? Math.min(1, packed.count) : packed.count;
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
        const heat = props.heat?.(s) ?? null;
        return (
          <div
            key={s.id}
            id={`studio-span-${s.id}`}
            role="option"
            aria-selected={selected}
            class={`studio-span ${s.status}${heat ? " heat" : ""}${selected ? " selected" : ""}${isDimmed(s, filter) ? " dim" : ""}${s.end === null ? " live" : ""}`}
            style={{ left: `${box.x}px`, width: `${box.width}px`, top: `${row * rowHeight + 1}px`, height: `${rowHeight - 2}px`, ...(props.collapsed && selected ? { zIndex: 1 } : {}), ...(heat ? { "--heat": heat.heat } : {}) }}
            title={`${s.label} · ${STATUS_TEXT[s.status]}${heat ? ` · ${heatText(heat)}` : ""} · ${formatTime(s.start)} – ${s.end === null ? "playing" : formatTime(spanEnd(s, now))}`}
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
