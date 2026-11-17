// ADR 0230 (amends 0227 and 0171; api-and-models §5.5): what a KEYFRAME row's fields mean, in one place for its writers and
// its reader. The writers are the core's keyframe source (`core/keyframeSource.ts`), the bus lanes both backends share
// (`mix/keyframeBus.ts`) and the Babylon fallback's `keyframe()`; the reader is `readCaptureKeyframe` in `format.ts`, which
// re-exports everything here.
//
// **Chunk boundary.** The recorder (`format.ts` and the codecs) is a lazy chunk (ADR 0171 amended by 0172, Rc4), while the
// writers are in every game that plays sound. So this file holds only the row layout: the section caps, the state codes, the
// flag bits, NO_NAME and the quantising steps. It imports nothing, and a writer value-imports it, never `format.ts`.

// --- caps -------------------------------------------------------------------------------------------------------------

/** The KEYFRAME section caps (§5.5). A writer stops at a cap (the ring's GAP counts the rest); the codec refuses past one. */
export const KEYFRAME_MAX_VOICES = 8_192;
export const KEYFRAME_MAX_BUSES = 32;
export const KEYFRAME_MAX_METERED = 9;
export const KEYFRAME_MAX_EVENTS = 1_024;
export const KEYFRAME_MAX_MUSIC = 16;
/** Floats per bus row: [value, target] x five lanes, then duck and automation (§5.5). */
export const KEYFRAME_BUS_LANES = 10;

/** The id a name field carries for no name (a voice's unknown clip, a music row's segment or pending target, the mix's cleared snapshot, and the EVENT args `capture/events.ts` writes). */
export const NO_NAME = 0xffffffff;

// --- codes ------------------------------------------------------------------------------------------------------------

function codes<T extends readonly string[]>(names: T): { readonly [K in T[number]]: number } {
  const out: Record<string, number> = {};
  names.forEach((n, i) => (out[n] = i));
  return Object.freeze(out) as { readonly [K in T[number]]: number };
}

/** The `voice.state` codes by name, in code order (0 playing … 5 locked). */
export const KEYFRAME_VOICE_STATES = ["playing", "virtual", "stolen", "waitingForData", "busMuted", "locked"] as const;
export type CaptureVoiceState = (typeof KEYFRAME_VOICE_STATES)[number];
export const KEYFRAME_VOICE_STATE_MAX = KEYFRAME_VOICE_STATES.length - 1;
/** A `voice.state` name's code, for the writers. */
export const KeyframeVoiceState = codes(KEYFRAME_VOICE_STATES);

/** The `music.state` codes by name, in code order (`MusicDebugState`'s; `pending` is written as playing). */
export const KEYFRAME_MUSIC_STATES = ["priming", "playing", "transitioning", "recovering", "ending"] as const;
export type CaptureMusicState = (typeof KEYFRAME_MUSIC_STATES)[number];
/** A `music.state` name's code, for the writers. */
export const KeyframeMusicState = codes(KEYFRAME_MUSIC_STATES);

/** The bus row's `flags` bits: the four lane gates (`mix/keyframeBus.ts`), then tombstone and metered. */
export const KeyframeBusFlag = { authoredMute: 1, runtimeMute: 2, monitorMute: 4, monitorSolo: 8, tombstone: 16, metered: 32 } as const;
/** The metered row's `flags` bits. */
export const KeyframeMeteredFlag = { paused: 1, incomplete: 2, tainted: 4, lowerBound: 8 } as const;
/** Every bus flag bit this build knows (a decoded row with another bit set is refused). */
export const KEYFRAME_BUS_FLAGS_KNOWN = 0x3f;
/** Every metered flag bit this build knows. */
export const KEYFRAME_METERED_FLAGS_KNOWN = 0xf;

// --- quantising -------------------------------------------------------------------------------------------------------

/** `voice.pitch` is u4.12: the playback rate times this. */
export const KEYFRAME_PITCH_ONE = 4096;
/** `voice.audibility` is u0.16: the 0..1 audibility times this (clamped to `0xffff`). */
export const KEYFRAME_AUDIBILITY_ONE = 65536;

/** `v` rounded and clamped to a u16 field (a bar, a tempo, a quantised pitch or audibility). */
export function keyframeU16(v: number): number {
  return Math.min(0xffff, Math.max(0, Math.round(v)));
}

/** A playback rate as `voice.pitch` (u4.12). */
export function keyframePitch(rate: number): number {
  return keyframeU16(rate * KEYFRAME_PITCH_ONE);
}

/** A 0..1 audibility as `voice.audibility` (u0.16; outside 0..1 reads as its clamp, a value that isn't finite as 0). */
export function keyframeAudibility(a: number): number {
  const v = Number.isFinite(a) ? (a < 0 ? 0 : a > 1 ? 1 : a) : 0;
  return keyframeU16(v * KEYFRAME_AUDIBILITY_ONE);
}
