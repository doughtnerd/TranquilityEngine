// Scene view tool settings (ADR 0022): gizmo space and pivot, snap steps, the grid, and the camera
// preview. Per-user preferences, remembered in browser storage like the others (preferences.ts).
import { computed } from "@preact/signals";
import { persisted } from "./preferences";
import { snapping } from "./state";

/** Move and rotate along the world's axes, or the node's own (the active node's for several). */
export const gizmoSpace = persisted<"world" | "local">("myco.editor.gizmoSpace", "world");

/** Several selected nodes: the gizmo sits at their centre, or on the active node's origin ("pivot"). */
export const gizmoPivot = persisted<"center" | "pivot">("myco.editor.gizmoPivot", "center");

export interface SnapSettings {
  /** Move step in metres. */
  move: number;
  /** Rotate step in radians (ADR 0164; Scene Tools shows it in the Rotation angles preference's unit). */
  rotate: number;
  /** Storage version: 2 since the rotate step is radians; absent in settings saved before, whose `rotate` is degrees. */
  v?: 2;
  /** Scale step (a factor). */
  scale: number;
  /** Grid cell size in metres. */
  grid: number;
  showGrid: boolean;
  /** Snap every gizmo drag, not only while Ctrl/Cmd is held. */
  always: boolean;
}

export const DEFAULT_SNAP: SnapSettings = { move: 0.25, rotate: Math.PI / 12, scale: 0.1, grid: 1, showGrid: true, always: false, v: 2 };

/** Snap steps, grid and "always snap" (missing or bad values from older storage fall back to the defaults). */
export const snapSettings = persisted<SnapSettings>("myco.editor.snap", DEFAULT_SNAP);

/** The snap settings with any unusable value replaced by its default. Settings saved before version 2 hold the rotate step in degrees: it's converted to radians. */
export function cleanSnap(s: Partial<SnapSettings> | null | undefined): SnapSettings {
  const pos = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    move: pos(s?.move, DEFAULT_SNAP.move),
    rotate: pos(s?.v === 2 || typeof s?.rotate !== "number" ? s?.rotate : (s.rotate * Math.PI) / 180, DEFAULT_SNAP.rotate),
    scale: pos(s?.scale, DEFAULT_SNAP.scale),
    grid: pos(s?.grid, DEFAULT_SNAP.grid),
    showGrid: bool(s?.showGrid, DEFAULT_SNAP.showGrid),
    always: bool(s?.always, DEFAULT_SNAP.always),
    v: 2,
  };
}

/** Change some snap settings, keeping the rest. */
export function updateSnap(patch: Partial<SnapSettings>): void {
  snapSettings.value = cleanSnap({ ...cleanSnap(snapSettings.value), ...patch });
}

/** True while gizmo drags snap: "always snap" is on, or Ctrl/Cmd is held. */
export const snapActive = computed(() => snapping.value || cleanSnap(snapSettings.value).always);

/** Show what a selected Camera sees in a corner of the scene view. */
export const cameraPreviewEnabled = persisted("myco.editor.cameraPreview", true);

/** Round `value` to the nearest multiple of `step` (no step: unchanged), without float noise. */
export function snapTo(value: number, step: number): number {
  if (!(step > 0)) return value;
  const r = Math.round(value / step) * step;
  return Math.round(r * 1e6) / 1e6;
}

export const toggleGizmoSpace = () => (gizmoSpace.value = gizmoSpace.value === "local" ? "world" : "local");
export const toggleGizmoPivot = () => (gizmoPivot.value = gizmoPivot.value === "pivot" ? "center" : "pivot");

/** Scene tool keys: X toggles local/world space, Z toggles pivot/centre (no modifiers; Ctrl+Z stays undo). */
export function sceneToolShortcut(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): "space" | "pivot" | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  const key = (e.key ?? "").toLowerCase();
  return key === "x" ? "space" : key === "z" ? "pivot" : null;
}

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.isContentEditable || el.closest(".monaco-editor")) return true;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return el.tagName === "INPUT" && !["checkbox", "radio", "button", "color", "range"].includes((el as HTMLInputElement).type);
}

/** Listen for the scene tool keys. Returns a function that stops. */
export function installSceneToolKeys(target: Window = window): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const action = sceneToolShortcut(e);
    if (!action || e.repeat || typing(e.target) || document.querySelector(".dialog")) return;
    if (action === "space") toggleGizmoSpace();
    else toggleGizmoPivot();
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}
