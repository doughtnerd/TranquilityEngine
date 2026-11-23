/**
 * Where a playlist level's effect chain runs on the audio core and what it costs (ADR 0345 levels, ABI 4.9), as the
 * note under a Playlists or Sequence effect chain: every level's chain (a playlist's, a nested playlist's, a sequence
 * track's or clip's) runs on a submix of its own, once per playing instance, fed by the level's voices; a delay's,
 * reverb's or chorus's tail rings on after the voices end. The cost is the catalogue's cost class per enabled effect
 * (the profiler's effects-cost track uses the same classes).
 *
 * Pure; no DOM.
 */
import { effectSpec } from "../../../engine/audio/effects/catalogue";
import type { Effect } from "../../../engine/audio/effects/types";

/** A level of the playlist tree whose chain this describes. */
export type ChainLevel = "playlist" | "track" | "clip";

const WHERE: Record<ChainLevel, string> = {
  playlist: "Runs on this playlist's submix, once per playing instance, on its own voices after they are mixed (nested in another playlist, then through that one's effects), before the Mixer bus.",
  track: "Runs on the track's submix, once per playing sequence, then through the sequence's effects.",
  clip: "Runs on the clip's submix, once per playing sequence, then through its track's effects; a delay or reverb rings on after the clip ends.",
};

/** The cost of `effects`' enabled effects by class: "Cost: 1 heavy, 2 light", or "Cost: none" with none on. */
export function chainCostText(effects: readonly Effect[]): string {
  const counts = { heavy: 0, medium: 0, light: 0 };
  for (const e of effects) {
    if (!e.on) continue;
    const c = effectSpec(e.type)?.cost;
    if (c === "heavy" || c === "medium" || c === "light") counts[c]++;
  }
  const parts = (["heavy", "medium", "light"] as const).filter((k) => counts[k] > 0).map((k) => `${counts[k]} ${k}`);
  return `Cost: ${parts.length > 0 ? parts.join(", ") : "none"}.`;
}

/** The note under a level's effect chain: where it runs, then its cost. */
export function chainNote(level: ChainLevel, effects: readonly Effect[]): string {
  return `${WHERE[level]} ${chainCostText(effects)}`;
}
