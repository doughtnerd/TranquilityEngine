// ADR 0162 C6: reverb zone slots, their memory and the layout notices, from the project's `zones` settings. The zone
// Inspector section's cost line and notices read it (the Audio Studio's Spatial screen edits the settings). Pure.
import type { AudioSettings } from "../../../engine/audio/settings";

/** Core zone slots: `maxActive + standby` (0 when `maxActive` is 0: zones are inert and nothing is reserved). */
export function zoneSlots(zones: Pick<AudioSettings["zones"], "maxActive" | "standby">): number {
  return zones.maxActive <= 0 ? 0 : zones.maxActive + zones.standby;
}

/** What the zone slots cost at 48 kHz (doubles at 96 kHz), in MB: the `Zones` region's state plus the kernels in the arena (outside `clipMemoryMB`). */
export interface ZoneMemory { slots: number; stateMB: number; kernelMB: number; totalMB: number }

/** Per-slot cost at `maxIrSeconds` (architecture section 6, the convolver spike): `[seconds, state MB, kernel MB]`. */
const ZONE_SLOT_COST = [[1, 0.9, 0.8], [2, 1.6, 4.4 / 3], [4, 3.1, 8.8 / 3]] as const;

/** Piecewise-linear in IR length through `ZONE_SLOT_COST`, continuing the first and last slope outside it. */
function slotCost(seconds: number, column: 1 | 2): number {
  const pts = ZONE_SLOT_COST;
  const i = seconds <= pts[1][0] ? 0 : 1;
  const [x0, x1] = [pts[i][0], pts[i + 1][0]];
  const [y0, y1] = [pts[i][column], pts[i + 1][column]];
  return Math.max(0, y0 + ((seconds - x0) / (x1 - x0)) * (y1 - y0));
}

/** The zone memory of a section: low (1 x 1 s) 1.7 MB, default (3 x 2 s) 9.2, high (3 x 4 s) 18.0, as the architecture's table. */
export function zoneMemory(a: Pick<AudioSettings, "zones">): ZoneMemory {
  const slots = zoneSlots(a.zones);
  const stateMB = slots * slotCost(a.zones.maxIrSeconds, 1);
  const kernelMB = slots * slotCost(a.zones.maxIrSeconds, 2);
  return { slots, stateMB, kernelMB, totalMB: stateMB + kernelMB };
}

const ZONE_EVICTION_FADE_MS = 150;

/** A zone-layout notice. */
export type ZoneWarning =
  /** `maxActive` 0: zones are inert; every AudioReverbZone is ignored. */
  | { code: "zonesOff" }
  /** No standby slot: a zone beyond `maxActive` evicts a ringing slot with a 150 ms fade, and the incoming kernel loads 50..200 ms later. */
  | { code: "evictionFade"; maxActive: number; fadeMs: typeof ZONE_EVICTION_FADE_MS };

/** Notices for a zone layout: off, or no standby slot (swaps cut a tail). */
export function zoneWarnings(a: Pick<AudioSettings, "zones">): ZoneWarning[] {
  if (a.zones.maxActive <= 0) return [{ code: "zonesOff" }];
  return a.zones.standby === 0 ? [{ code: "evictionFade", maxActive: a.zones.maxActive, fadeMs: ZONE_EVICTION_FADE_MS }] : [];
}
