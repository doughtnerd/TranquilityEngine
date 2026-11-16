// The occlusion overlay's drawing (ADR 0162 E4, api-and-models §7): from `Audio.debug()`'s voices and what the play World
// says about them, a line from each occluded source to the listener with a cross where it meets a wall, coloured on a
// three-stop gradient from the theme's success (open) through warning (half) to danger (silent). Pure: the World side
// is `OcclusionOverlay.ts`.
import type { EditorOverlay } from "../../../engine/editor";
import type { AudioDebugInfo } from "../runtime/backend";
import { mix, parseHex, type ThemeTokens } from "../../../editor/sdk";

type Vec = readonly [number, number, number];
type DebugVoice = AudioDebugInfo["voices"][number];

/** A voice is "occluded" when walls took more than this much of its gain (about 0.01 dB). */
const OPEN_GAIN = 0.9995;

/** At most this many rays are drawn per World (the voices with the lowest occlusion gain first). */
const MAX_RAYS = 48;

/** The three colours of the gradient, 0xRRGGBB. */
export interface OcclusionColors {
  open: number;
  half: number;
  closed: number;
}

const hexOf = (c: string): number => {
  const rgb = parseHex(c) ?? [255, 0, 255];
  return (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
};

/** The overlay's colours from the theme's tokens (so it follows Settings > Appearance). */
export const occlusionColors = (t: ThemeTokens): OcclusionColors => ({ open: hexOf(t.success), half: hexOf(t.warning), closed: hexOf(t.danger) });

/** The colour for an occlusion gain: open (1) to half (0.5) to closed (0). */
export function gainColor(gain: number, colors: OcclusionColors): number {
  const g = Number.isFinite(gain) ? Math.min(1, Math.max(0, gain)) : 1;
  const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
  const t = 1 - g;
  const c = t < 0.5 ? mix(hex(colors.open), hex(colors.half), t * 2) : mix(hex(colors.half), hex(colors.closed), (t - 0.5) * 2);
  return hexOf(c);
}

/** What the drawing needs from the play World (`OcclusionOverlay.ts` reads it from the World and the physics query). */
export interface OcclusionScene {
  /** The World's key as the audio core knows it (`AudioDebugInfo.voices[].world` is its decimal string). */
  worldKey: number;
  /** Where the voice's source is, or null when it has none (a one-shot, an event voice, a source that has gone). */
  sourceOf(voiceId: number): Vec | null;
  /** The listener's position. */
  listener: Vec;
  /** Where a ray from `from` to `to` first meets a wall, or null. */
  hitOf(voiceId: number, from: Vec, to: Vec): Vec | null;
}

/** Half the length of a hit marker's arms, world units. */
const HIT_ARM = 0.15;

/** The voices the overlay draws: in this World, with an occlusion row that muffles or hit something, most muffled first. */
export function occludedVoices(voices: readonly DebugVoice[], worldKey: number): DebugVoice[] {
  const key = String(worldKey);
  return voices
    .filter((v) => v.world === key && v.occlusion !== undefined && (v.occlusion.gain < OPEN_GAIN || v.occlusion.hits > 0))
    .sort((a, b) => a.occlusion!.gain - b.occlusion!.gain || a.id - b.id)
    .slice(0, MAX_RAYS);
}

/** What to draw: each occluded voice's ray from its source to the listener, and a cross at the hit point. */
export function occlusionOverlay(voices: readonly DebugVoice[], scene: OcclusionScene, colors: OcclusionColors): EditorOverlay {
  const overlay: EditorOverlay = { lines: [], handles: [] };
  for (const v of occludedVoices(voices, scene.worldKey)) {
    const from = scene.sourceOf(v.id);
    if (!from) continue;
    const color = gainColor(v.occlusion!.gain, colors);
    overlay.lines.push({ points: [[from[0], from[1], from[2]], [scene.listener[0], scene.listener[1], scene.listener[2]]], closed: false, color });
    const hit = scene.hitOf(v.id, from, scene.listener);
    if (!hit) continue;
    for (let a = 0; a < 3; a++) {
      const lo: [number, number, number] = [hit[0], hit[1], hit[2]];
      const hi: [number, number, number] = [hit[0], hit[1], hit[2]];
      lo[a] -= HIT_ARM;
      hi[a] += HIT_ARM;
      overlay.lines.push({ points: [lo, hi], closed: false, color });
    }
  }
  return overlay;
}
