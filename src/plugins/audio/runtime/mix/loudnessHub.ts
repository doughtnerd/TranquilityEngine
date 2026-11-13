// ADR 0171 amended by 0172 (M5, contract K0; api-and-models §1.1, §3.2, architecture §4.4): the loudness hub. Ld4 fills
// it: `feed(status)` runs in the STATUS handler after the mirror and the recorder and writes each bus's stable
// `BusLoudness` in place (through Ld3's `LoudnessStats`, `mix/loudnessStats.ts`), the hub registers on the mixer as its
// `LoudnessSource` (Mx1's H2, `engine/audio/loudnessTypes.ts`), and `Audio.loudnessTarget` names the target in force.
// K0 declares the surface with stubs (tag Ld4).
import type { StatusBlock } from "../wire.generated";

export class LoudnessHub {
  /** Ld4: one STATUS block's loudness sections (no allocation per block). */
  feed(_status: StatusBlock): void {}

  /** Ld4: the entry of `audio.loudnessTargets` in force (default the first); null when the project has none. */
  get target(): string | null {
    return null;
  }

  /** Ld4: an unknown name is ignored with one warning; a change re-sends `LOUD_CONFIG`'s gate and is not a reset. */
  set target(_name: string | null) {}
}

/** The page's hub (Ld4 wires it to the core backend's STATUS and to the mixer). */
export const loudnessHub = new LoudnessHub();

/** `Audio.loudnessTarget` (§1.1). */
export function loudnessTarget(): string | null {
  return loudnessHub.target;
}

/** `Audio.loudnessTarget = name` (§1.1). */
export function setLoudnessTarget(name: string | null): void {
  loudnessHub.target = name;
}
