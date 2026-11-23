/**
 * Internal (ADR 0362 item 4): the `colour` and `note` that sequence markers, a sample's reserved ranges (Trim, Pickup,
 * Tail) and the Studio's folders carry. A colour is a theme token name (`"warning"`, `"series-6"`: drawn as
 * `var(--warning)`, so it follows the editor's theme) or `#rrggbb`; a note is plain text.
 *
 * Pure; no plugin, no DOM.
 */

/** At most this many characters in a note. */
export const MARK_NOTE_MAX = 2000;

const HEX = /^#[0-9a-f]{6}$/i;
const TOKEN = /^[a-z][a-z0-9-]{0,31}$/;

/** Whether `v` is a colour this format keeps: a theme token name or `#rrggbb`. */
export const isMarkColour = (v: unknown): v is string => typeof v === "string" && (HEX.test(v) || TOKEN.test(v));

/** The CSS a colour draws with: `var(--<token>)` for a token name, the hex itself otherwise. */
export function markColourCss(colour: string): string {
  return HEX.test(colour) ? colour.toLowerCase() : `var(--${colour})`;
}

/** The colour a CSS value stores as: `var(--warning)` → `"warning"`, `#RRGGBB` → `"#rrggbb"`; anything else null. */
export function markColourOf(css: string): string | null {
  const t = css.trim();
  const v = /^var\(--([a-z][a-z0-9-]{0,31})\)$/.exec(t);
  if (v) return v[1]!;
  return HEX.test(t) ? t.toLowerCase() : null;
}

/**
 * A `colour` and `note` read leniently from `raw` into `out` (each only when valid and non-empty); a bad value is dropped
 * with a problem under `where`.
 */
export function readColourNote(raw: Record<string, unknown>, where: string, out: { colour?: string; note?: string }, problems: string[]): void {
  if (raw.colour !== undefined) {
    if (isMarkColour(raw.colour)) out.colour = raw.colour.toLowerCase();
    else problems.push(`${where}.colour: must be a theme colour name or #rrggbb; dropped.`);
  }
  if (raw.note !== undefined) {
    if (typeof raw.note !== "string") problems.push(`${where}.note: must be text; dropped.`);
    else if (raw.note.trim() !== "") {
      if (raw.note.length > MARK_NOTE_MAX) problems.push(`${where}.note: at most ${MARK_NOTE_MAX} characters; cut.`);
      out.note = raw.note.slice(0, MARK_NOTE_MAX);
    }
  }
}

/** `{ colour, note }` for a file, each only when set. */
export function colourNoteJson(v: { colour?: string; note?: string }): Record<string, string> {
  return { ...(v.colour ? { colour: v.colour } : {}), ...(v.note ? { note: v.note } : {}) };
}
