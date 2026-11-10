// Audition (ADR 0158 §7): plays the open event through the running audio host with live parameter sliders and a
// per-instance voice list. A stub until E6.4 fills it; the props are contract C4.

export interface AuditionProps {
  /** The event asset to play (`*.audioevent.json`). */
  path: string;
  /** The parameter values to apply while it plays: numbers, or a label for a labelled parameter. */
  parameters: Record<string, number | string>;
  /** Called with the audition's playing voice count, for the panel's status line. */
  onVoices?(count: number): void;
}

export function Audition(_props: AuditionProps) {
  return null; // E6.4
}
