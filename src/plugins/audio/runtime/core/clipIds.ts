// The core's clip id layout (ADR 0157): a slot index in the low 24 bits and an 8-bit generation above it, so a reused slot
// gets a new id and a stale id is told apart. The clip registry hands out ids in this form; the HRIR, MagLS and zone
// kernel ids live in the reserved range at the top (`CLIP_ID_RESERVED_FIRST`, wire.generated.ts).

/** Ids: index in the low 24 bits, an 8-bit generation in the high bits. */
const CLIP_INDEX_BITS = 24;
/**
 * Indices stay below this, so no id can fall in the reserved HRIR range 0xFFFF0000..0xFFFF00FF (generation 0xFF with
 * index 0xFF0000..0xFF00FF). 16.7 million live clips is not a limit anyone reaches.
 */
export const CLIP_INDEX_LIMIT = 0xff0000;

/** `id` from a slot index and generation. */
export const makeClipId = (index: number, generation: number): number => (((generation & 0xff) << CLIP_INDEX_BITS) | index) >>> 0;
/** The slot index of `id`. */
export const clipIndex = (id: number): number => id & 0xffffff;
/** The generation of `id`. */
export const clipGeneration = (id: number): number => id >>> CLIP_INDEX_BITS;
