/**
 * Note names and MIDI note numbers, for a sample's root note (ADR 0342). Scientific pitch notation: MIDI 60 is `C4`
 * (middle C), 69 is `A4`. Names are a letter, an optional `#` or `b` (`♯` and `♭` are read too), and an octave from -1
 * to 9 (MIDI 0 is `C-1`, 127 is `G9`).
 *
 * Pure; no plugin, no DOM.
 */

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** `^[A-G][#b♯♭]?-?\d$`: what the sample block accepts as a root note. */
export const NOTE_NAME_PATTERN = /^([A-G])([#b♯♭]?)(-?\d)$/;

/** The name of a MIDI note number (sharps), or null outside 0..127. */
export function midiToNoteName(midi: number): string | null {
  if (!Number.isInteger(midi) || midi < 0 || midi > 127) return null;
  return `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

/** The MIDI note number of a name, or null when it isn't a note name or falls outside 0..127. */
export function noteNameToMidi(name: string): number | null {
  const m = NOTE_NAME_PATTERN.exec(name);
  if (!m) return null;
  const accidental = m[2] === "#" || m[2] === "♯" ? 1 : m[2] === "b" || m[2] === "♭" ? -1 : 0;
  const midi = (Number(m[3]) + 1) * 12 + LETTER[m[1]] + accidental;
  return midi >= 0 && midi <= 127 ? midi : null;
}
