// A typed time field in the timeline's display (proto `.tcin`: 96 px, monospace): it shows the time as the playhead
// readout does (timecode, samples, or bars), takes a timecode, a sample count, bars, or plain seconds, and commits on
// Enter or blur; Escape puts it back; input it can't read is refused with "Not a valid timecode".
import { useState } from "preact/hooks";
import { formatTime, parseTime, type TimeContext, type TimeFormat } from "../../../components/timeRulerModel";

export interface TimecodeFieldProps {
  readonly value: number;
  readonly format: TimeFormat;
  readonly context: TimeContext;
  readonly label: string;
  readonly title?: string;
  readonly disabled?: boolean;
  /** The smallest time it takes (default 0). */
  readonly min?: number;
  onValue(seconds: number): void;
  /** Typed text it couldn't read. */
  onInvalid?(text: string): void;
}

/** Seconds from typed text: the display's own format first, then plain seconds ("1.5", "1.5 s"). */
function readTime(text: string, format: TimeFormat, ctx: TimeContext): number | null {
  const t = text.trim();
  if (!t) return null;
  const own = parseTime(t, format, ctx);
  if (own !== null && Number.isFinite(own)) return own;
  const m = /^(-?\d+(?:[.,]\d+)?)\s*(s|sec|ms)?$/i.exec(t);
  if (!m) return null;
  const n = Number(m[1]!.replace(",", "."));
  return m[2]?.toLowerCase() === "ms" ? n / 1000 : n;
}

export function TimecodeField(props: TimecodeFieldProps) {
  const shown = formatTime(props.value, props.format, props.context);
  const [draft, setDraft] = useState<{ text: string; over: string } | null>(null);
  const text = draft && draft.over === shown ? draft.text : shown;
  const commit = (raw: string) => {
    setDraft(null);
    if (raw === shown) return;
    const v = readTime(raw, props.format, props.context);
    if (v === null || v < (props.min ?? 0)) return props.onInvalid?.(raw);
    if (Math.abs(v - props.value) > 1e-9) props.onValue(v);
  };
  return (
    <input
      type="text"
      class="sq-tcin"
      aria-label={props.label}
      title={props.title ?? `${props.label} · type a timecode or seconds · Enter to apply, Esc to cancel`}
      disabled={props.disabled}
      spellcheck={false}
      autoComplete="off"
      value={text}
      onInput={(e) => setDraft({ text: (e.currentTarget as HTMLInputElement).value, over: shown })}
      onBlur={(e) => commit((e.currentTarget as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit((e.currentTarget as HTMLInputElement).value);
        else if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(null);
          (e.currentTarget as HTMLInputElement).value = shown;
        }
      }}
    />
  );
}
