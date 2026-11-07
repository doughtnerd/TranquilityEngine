import type { ScaleMode } from "../core/settings";

/**
 * The CSS size of the game canvas inside a `cw` x `ch` container, for the project's reference
 * resolution `refW` x `refH` and scale mode (ADR 0116). Sizes are whole pixels.
 */
export function fitCanvas(mode: ScaleMode, refW: number, refH: number, cw: number, ch: number): { width: number; height: number } {
  if (!(refW > 0) || !(refH > 0) || !(cw > 0) || !(ch > 0)) return { width: Math.max(1, Math.floor(cw || refW || 1)), height: Math.max(1, Math.floor(ch || refH || 1)) };
  if (mode === "stretch") return { width: Math.floor(cw), height: Math.floor(ch) };
  const fit = Math.min(cw / refW, ch / refH);
  if (mode === "pixel-perfect" && fit >= 1) {
    const k = Math.floor(fit);
    return { width: refW * k, height: refH * k };
  }
  return { width: Math.max(1, Math.floor(refW * fit)), height: Math.max(1, Math.floor(refH * fit)) };
}
