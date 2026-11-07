// UI picking in the scene view (ADR 0069, 0077, 0117). The UI core's `pickAll` already lists every
// drawn element under the pointer, topmost first (screen canvases by `sortOrder`, world canvases
// nearest first; `display: none` and `visible: false` elements aren't drawn, so aren't listed).
// An element with nothing to draw (a transparent layout container) mustn't swallow a click meant for
// the scene behind it, so hits split into painted ones, which win over meshes and sprites, and bare
// ones, which only count when nothing else is under the pointer. Canvases (`pickCanvases`, ADR 0117)
// join the bare tier last: a world canvas by its rectangle, a screen canvas only by its frame's edge strip,
// so a click on bare empty view still deselects. Pure: no engine state is read.
import type { Color } from "../engine";
import { UIImage, UIInputField, UIPanel, UIText } from "../engine";
import type { UIComponentType } from "../engine/ui/components";

const visibleColor = (c: Color | null | undefined): boolean => !!c && c.a > 0;

/** True when the element draws something under the pointer: a fill, border, text or image (nothing at zero opacity). */
export function isPaintedUI(c: UIComponentType): boolean {
  if (!(c instanceof UIPanel || c instanceof UIText || c instanceof UIImage)) return false; // a canvas draws nothing itself
  if (c.opacity <= 0) return false;
  if (c instanceof UIText) return c.text.trim() !== "";
  if (c instanceof UIImage) return c.image !== "";
  if (visibleColor(c.backgroundColor) || (c.borderWidth > 0 && visibleColor(c.borderColor))) return true;
  return c instanceof UIInputField && (c.value !== "" || c.placeholder !== "");
}

/** Split picked elements (topmost first) into painted and bare ones, each keeping its order. */
export function partitionUIHits<T extends UIComponentType>(comps: readonly T[]): { painted: T[]; bare: T[] } {
  const painted: T[] = [], bare: T[] = [];
  for (const c of comps) (isPaintedUI(c) ? painted : bare).push(c);
  return { painted, bare };
}

/**
 * The click's candidates, first choice first: painted UI, then the scene's hits, then bare UI
 * (duplicates dropped, first occurrence kept). Repeated clicks cycle through this list.
 */
export function orderClickHits(painted: readonly string[], scene: readonly string[], bare: readonly string[]): string[] {
  return [...new Set([...painted, ...scene, ...bare])];
}
