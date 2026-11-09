// Voice ids (ADR 0157; api-and-models §3 "Handle encoding"): a voice's id packs its slot index in the voice table
// (low 16 bits) and the slot's generation (high 16 bits). The same id is the `voiceId` in every command and STATUS
// record; the core keeps `slotGen[index]` and drops commands whose generation differs. Generations run 1..65535
// (bumped on free, skipping 0), so a valid id is never 0.

/** @internal §3: 0 is never a voice id (an inert handle holds it). */
export const INVALID_VOICE_ID = 0;
/** @internal §3: the largest slot index an id can carry (`voices.logical` is at most 8,192, so this is never reached). */
export const MAX_VOICE_INDEX = 0xffff;
/** @internal §3: generations run 1..65535; 0 is skipped. */
export const MIN_VOICE_GEN = 1;
/** @internal §3: the largest generation; the next one wraps to `MIN_VOICE_GEN`. */
export const MAX_VOICE_GEN = 0xffff;

/**
 * @internal §3: `id = (gen << 16 | index) >>> 0`. `index` is 0..65535 and `gen` 1..65535 (callers guarantee both;
 * no range check here). The result is an unsigned 32-bit integer, never 0 for a valid `gen`.
 */
export function encodeVoiceId(index: number, gen: number): number {
  throw new Error("not implemented: A1.1-L1");
}

/** @internal §3: the slot index of `id` (its low 16 bits). */
export function voiceIndex(id: number): number {
  throw new Error("not implemented: A1.1-L1");
}

/** @internal §3: the generation of `id` (its high 16 bits, `id >>> 16`). 0 for an invalid id. */
export function voiceGen(id: number): number {
  throw new Error("not implemented: A1.1-L1");
}

/**
 * @internal §3: whether `id` could name a voice at all: an integer in 1..0xFFFFFFFF whose generation is not 0. Says
 * nothing about whether the slot still holds that generation (the table checks `gen[index] === voiceGen(id)`).
 */
export function isVoiceId(id: number): boolean {
  throw new Error("not implemented: A1.1-L1");
}

/** @internal §3 "free pushes and bumps gen, skipping 0": the generation after `gen` (65535 wraps to 1). */
export function nextVoiceGen(gen: number): number {
  throw new Error("not implemented: A1.1-L1");
}
