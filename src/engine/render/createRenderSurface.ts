/**
 * Makes a World's drawing surface: Babylon.js, the only renderer (ADR 0075, 0081). Babylon's code loads
 * on demand inside `BabylonSurface`, so a page downloads it only when it draws.
 */
import type { ProjectSettings } from "../core/settings";
import type { WorldKind } from "../core/World";
import { BabylonSurface } from "./babylon/BabylonSurface";
import type { RenderSurface } from "./RenderSurface";

/** @internal A drawing surface for one World in `container`. */
export function createRenderSurface(container: HTMLElement, settings: ProjectSettings, kind: WorldKind = "runtime"): RenderSurface {
  return new BabylonSurface(container, settings, kind);
}
