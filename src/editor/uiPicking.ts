// UI picking in the scene view (ADR 0069, 0077, 0117). The UI core's `pickAll` already lists every
// drawn element under the pointer, topmost first (screen canvases by `sortOrder`, world canvases
// nearest first; `display: none` and `visible: false` elements aren't drawn, so aren't listed).
// An element with nothing to draw (a transparent layout container) mustn't swallow a click meant for
// the scene behind it, so hits split into painted ones, which win over meshes and sprites, and bare
// ones, which only count when nothing else is under the pointer. Canvases (`pickCanvases`, ADR 0117)
// join the bare tier last: a world canvas by its rectangle, a screen canvas only by its frame's edge strip,
// so a click on bare empty view still deselects. What counts as painted is each element kind's own
// rule (`isPaintedUI`, ADR 0271). Pure: no engine state is read.
import type { UIComponentType } from "../engine/ui/components";
import { isPaintedUI } from "../engine/ui/elementKinds";

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
