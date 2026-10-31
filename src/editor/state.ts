// Shared editor UI state (ADR 0025). Signals so Preact panels re-render when it changes.
import { signal } from "@preact/signals";
import type { OrbitCamera, ViewMode } from "./OrbitCamera";

/** The scene view camera, set once the Editor World is running. */
export const sceneCamera = signal<OrbitCamera | null>(null);

/** 3D orbit view or flat 2D view. Kept in sync with `sceneCamera.mode`. */
export const viewMode = signal<ViewMode>("3d");

export function setViewMode(mode: ViewMode): void {
  viewMode.value = mode;
  if (sceneCamera.value) sceneCamera.value.mode = mode;
}
