/**
 * Adaptive trigger effects (DualSense): what a trigger feels like as it's pulled. Positions are
 * fractions of the trigger's travel (0 released, 1 fully pulled), strengths 0..1. Devices without
 * adaptive triggers ignore them.
 */
export type TriggerEffect =
  /** No effect: the trigger moves freely. */
  | { readonly mode: "off" }
  /** Constant resistance from `start` to the end of travel. */
  | { readonly mode: "resistance"; readonly start?: number; readonly strength?: number }
  /** A weapon's trigger: resistance from `start` that gives way with a click at `end`. */
  | { readonly mode: "weapon"; readonly start?: number; readonly end?: number; readonly strength?: number }
  /** Vibration from `start` to the end of travel, `frequency` in Hz (1..255). */
  | { readonly mode: "vibration"; readonly start?: number; readonly amplitude?: number; readonly frequency?: number };
