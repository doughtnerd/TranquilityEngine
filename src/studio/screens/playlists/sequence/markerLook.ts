// How a sequence marker looks (ADR 0362 item 4): its flag colour (its own `colour`, else its type's theme colour) and
// its tooltip (name, time, what the type does, and its note). Pure.
import { markColourCss } from "../../../../engine/audio/markColour";
import type { SequenceMarker } from "../../../../engine/audio/playlist/types";

/** A marker type's theme colour. */
export function markerTypeCss(type: SequenceMarker["type"]): string {
  return type === "exit" || type === "entry" ? "var(--marker-exit)" : type === "cue" ? "var(--marker-cue)" : "var(--marker-note)";
}

/** The flag's colour: the marker's own, else its type's. */
export const markerColourCss = (m: Pick<SequenceMarker, "type" | "colour">): string => (m.colour ? markColourCss(m.colour) : markerTypeCss(m.type));

/** The flag's inline style: the `--mc` colour only when the marker has its own (the type's comes from the CSS class). */
export const markerFlagStyle = (m: Pick<SequenceMarker, "colour">): Record<string, string> => (m.colour ? { "--mc": markColourCss(m.colour) } : {});

const TYPE_TEXT: Readonly<Record<NonNullable<SequenceMarker["type"]>, string>> = {
  note: "Marker",
  exit: "Exit: music may leave here",
  cue: "Cue: the game is told when the playhead passes it",
  entry: "Entry: a Switch lands here on its beat or bar",
};

/** "Drop · 0:04.000 · Exit: music may leave here", then its note on the next line. */
export function markerTitle(m: Pick<SequenceMarker, "name" | "type" | "note">, at: string): string {
  const head = `${m.name} · ${at} · ${TYPE_TEXT[m.type ?? "note"]}`;
  return m.note ? `${head}\n${m.note}` : head;
}
