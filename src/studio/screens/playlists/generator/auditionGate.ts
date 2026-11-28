// The Generator editor's audition gate (ADR 0360 §9): Space, the Play button, a key of the on-screen keyboard or a
// computer-keyboard key starts a voice while held and keys it off when let go (a blip plays out its envelope; an
// endless oscillator or synth releases). Each source holds at most one voice: a key's auto-repeat starts nothing, a
// release of a source that holds nothing does nothing, and several keys at once play several notes. The on-screen
// keyboard is one octave from the generator's pitch; the computer keys follow the common DAW layout (A W S E D F T G
// Y H U J K for C up to the next C). The gate only says what to do; the screen does it through the Studio's runtime.
// Pure.
import { semitonesToRatio } from "../../../../engine/audio/decibels";

/** What holds a voice: Space, the Play button, an on-screen key (`note:<st>`) or a computer key (`key:<letter>`). */
export type GateSource = string;

export interface GateState {
  /** Held sources and the semitones each plays at. */
  readonly held: ReadonlyMap<GateSource, number>;
}

export type GateCommand =
  | { readonly kind: "start"; readonly source: GateSource; readonly semitones: number; readonly pitch: number }
  | { readonly kind: "release"; readonly source: GateSource };

export interface GateStep {
  readonly state: GateState;
  readonly commands: readonly GateCommand[];
}

export const EMPTY_GATE: GateState = { held: new Map() };

/** `source` pressed, playing at `semitones` above the generator's pitch: a voice starts unless it holds one already. */
export function gatePress(s: GateState, source: GateSource, semitones = 0): GateStep {
  if (s.held.has(source)) return { state: s, commands: [] };
  const held = new Map(s.held).set(source, semitones);
  return { state: { held }, commands: [{ kind: "start", source, semitones, pitch: semitonesToRatio(semitones) }] };
}

/** `source` let go: its voice keys off. */
export function gateRelease(s: GateState, source: GateSource): GateStep {
  if (!s.held.has(source)) return { state: s, commands: [] };
  const held = new Map(s.held);
  held.delete(source);
  return { state: { held }, commands: [{ kind: "release", source }] };
}

/** Everything let go (the window lost focus, the editor closed). */
export function gateReleaseAll(s: GateState): GateStep {
  return { state: EMPTY_GATE, commands: [...s.held.keys()].map((source) => ({ kind: "release" as const, source })) };
}

/** True while anything is held. */
export const gateOpen = (s: GateState): boolean => s.held.size > 0;

/** The computer keys of one octave, the common DAW layout: white keys on the home row, black keys above. */
export const NOTE_KEYS: readonly (readonly [string, number])[] = [
  ["A", 0], ["W", 1], ["S", 2], ["E", 3], ["D", 4], ["F", 5], ["T", 6], ["G", 7], ["Y", 8], ["H", 9], ["U", 10], ["J", 11], ["K", 12],
];

/** The semitone a computer key plays (its letter, either case), or null. */
export function noteOfKey(key: string): number | null {
  const k = key.length === 1 ? key.toUpperCase() : "";
  return NOTE_KEYS.find(([letter]) => letter === k)?.[1] ?? null;
}

/** The gate source of a computer key. */
export const keySource = (key: string): GateSource => `key:${key.toUpperCase()}`;
/** The gate source of an on-screen key. */
export const noteSource = (semitones: number): GateSource => `note:${semitones}`;

const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

/** The on-screen keyboard: 13 keys, C to C, each with its semitone, whether it is black, and its computer key. */
export function octaveKeys(): readonly { readonly semitones: number; readonly name: string; readonly black: boolean; readonly key: string }[] {
  return NOTE_KEYS.map(([key, st]) => ({ semitones: st, name: st === 12 ? "C′" : NAMES[st]!, black: NAMES[st % 12]!.includes("♯"), key }));
}

/** The frequency a key plays from a generator's `hz` ("+7 st · 659 Hz"), for its tooltip. */
export function keyPitchText(semitones: number, hz: number | null): string {
  const st = semitones === 0 ? "root" : `+${semitones} st`;
  return hz === null ? st : `${st} · ${Math.round(hz * semitonesToRatio(semitones))} Hz`;
}
