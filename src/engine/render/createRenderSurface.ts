/**
 * Picks the render backend (ADR 0075, 0078). Babylon.js is the default; three.js stays available as a
 * toggle: `?renderer=three` in the URL, or `localStorage["myco.renderer"] = "three"` (the editor's
 * Settings > General > Renderer writes it). The URL beats storage.
 */
import type { ProjectSettings } from "../core/settings";
import type { WorldKind } from "../core/World";
import { BabylonSurface } from "./babylon/BabylonSurface";
import { RenderBackend } from "./RenderBackend";
import type { RenderSurface } from "./RenderSurface";

/** @internal The two render backends (ADR 0078). */
export type RendererName = "three" | "babylon";

/** @internal The renderer the toggle asks for; Babylon.js when it's unset or unknown. */
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
    if (typeof localStorage !== "undefined") return named(localStorage.getItem("myco.renderer")) ?? "babylon";
  } catch {
    /* storage blocked */
  }
  return "babylon";
}

/** @internal The renderer stored for this browser or desktop app (no URL override), and setting it; it applies on the next load. */
export function storedRendererChoice(): RendererName {
  try {
    return localStorage.getItem("myco.renderer") === "three" ? "three" : "babylon";
  } catch {
    return "babylon";
  }
}

/** @internal */
export function setStoredRendererChoice(name: RendererName): void {
  try {
    if (name === "babylon") localStorage.removeItem("myco.renderer");
    else localStorage.setItem("myco.renderer", name);
  } catch {
    /* storage blocked: the default stays */
  }
}

/** @internal A drawing surface for one World in `container`, on the renderer the toggle picks. */
export function createRenderSurface(container: HTMLElement, settings: ProjectSettings, kind: WorldKind = "runtime"): RenderSurface {
  return rendererChoice() === "babylon" ? new BabylonSurface(container, settings, kind) : new RenderBackend(container, settings, kind);
}
