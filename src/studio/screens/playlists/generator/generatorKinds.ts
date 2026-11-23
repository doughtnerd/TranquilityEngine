// How the Studio shows a generator's kind (ADR 0360 §9): a short badge code in a series colour beside the generator
// icon (a square wave over a sine, the asset kind's), the kind's name, and the kind of a voice from its reserved clip
// id (`GEN_CLIP_ID_FIRST` + 1 oscillator … 4 silence; the Profiler's voice rows). Pure.
import { generatorSpec, isGeneratorKind } from "../../../../engine/audio/generators/catalogue";
import { GENERATOR_KINDS, type GeneratorKind } from "../../../../engine/audio/generators/types";
import { GEN_CLIP_ID_FIRST } from "../../../../plugins/audio/runtime/wire.generated";

export interface GeneratorBadgeInfo {
  readonly code: string;
  /** The tooltip and accessible name ("Blip generator"). */
  readonly name: string;
  readonly series: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
}

const BADGES: Readonly<Record<GeneratorKind, GeneratorBadgeInfo>> = {
  oscillator: { code: "OSC", name: "Oscillator generator", series: 3 },
  synth: { code: "SYN", name: "Synth generator", series: 4 },
  blip: { code: "BLP", name: "Blip generator", series: 5 },
  silence: { code: "SIL", name: "Silence generator", series: 7 },
};

export const generatorBadge = (kind: GeneratorKind): GeneratorBadgeInfo => BADGES[kind];

/** The generator icon's path (24 × 24): a square wave over a sine, as the asset kind registers it. */
export const GENERATOR_ICON_PATH = "M2 8h4v8h4V8h4v8h4V8h4M2 19c3-3 5-3 8 0s5 3 8 0";

/** The kinds as the New menu lists them. */
export const KIND_CHOICES: readonly { readonly kind: GeneratorKind; readonly label: string }[] = GENERATOR_KINDS.map((kind) => ({ kind, label: generatorSpec(kind).label }));

/** The generator kind of a voice's clip id, or null for a clip or stream voice. */
export function generatorKindOfClip(clip: number): GeneratorKind | null {
  const k = clip - GEN_CLIP_ID_FIRST;
  return Number.isInteger(k) && k >= 1 && k <= GENERATOR_KINDS.length ? GENERATOR_KINDS[k - 1]! : null;
}

/** A kind named by text (the runtime's debug `generator` field), or null. */
export const generatorKindOf = (text: unknown): GeneratorKind | null => (isGeneratorKind(text) ? text : null);
