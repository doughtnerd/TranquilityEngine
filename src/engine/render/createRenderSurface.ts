/**
 * Picks the render backend while the renderer migrates to Babylon.js (ADR 0075). three.js stays the
 * default until the Babylon backend reaches parity; a dev flag switches a page to Babylon:
 * `?renderer=babylon` in the URL, or `localStorage["myco.renderer"] = "babylon"`.
 */
import type { ProjectSettings } from "../core/settings";
import type { WorldKind } from "../core/World";
import { BabylonSurface } from "./babylon/BabylonSurface";
import { RenderBackend } from "./RenderBackend";
import type { RenderSurface } from "./RenderSurface";

/** @internal The two render backends during the migration (ADR 0075). */
export type RendererName = "three" | "babylon";

/** @internal The renderer the dev flag asks for; three.js when it's unset or unknown. */
export function rendererChoice(): RendererName {
  const named = (v: string | null | undefined): RendererName | null => (v === "babylon" || v === "three" ? v : null);
  try {
    if (typeof location !== "undefined") {
      const fromUrl = named(new URLSearchParams(location.search).get("renderer"));
      if (fromUrl) return fromUrl;
    }
  } catch {
    /* no location (workers, tests) */
  }
  try {
    if (typeof localStorage !== "undefined") return named(localStorage.getItem("myco.renderer")) ?? "three";
  } catch {
    /* storage blocked */
  }
  return "three";
}

/** @internal A drawing surface for one World in `container`, on the renderer the dev flag picks. */
export function createRenderSurface(container: HTMLElement, settings: ProjectSettings, kind: WorldKind = "runtime"): RenderSurface {
  return rendererChoice() === "babylon" ? new BabylonSurface(container, settings, kind) : new RenderBackend(container, settings, kind);
}
