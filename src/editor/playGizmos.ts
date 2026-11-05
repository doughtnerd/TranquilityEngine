// Play mode's Gizmos toggle (like Unity's Game view "Gizmos" button): whether the game view shows
// the editor's debug drawing on the play session's Worlds, and which kinds. Edit mode is unaffected.
//
// What a play World can show: editor overlays added to it (navigation's runtime drawing, and a
// game's own `addEditorOverlay` drawing, kind "other") and the live Inspector's selection outline.
// Play Worlds have no grid, axes, camera or light icons (only the editor's World draws those), and
// collider gizmos are drawn only on the editor's World, so those kinds aren't listed.
//
// The filtering is done where the drawing is installed: a per-World overlay filter by kind
// (`setEditorOverlayFilter`) and the render backend's outline flag (`setSelectionOutlineShown`).
// Worlds created while playing are picked up by a light poll.
import { effect, type ReadonlySignal } from "@preact/signals";
import type { World } from "../engine/core/World";
import { editorDrawingShown, setEditorOverlayFilter, setSelectionOutlineShown, shownEditorOverlays, type EditorOverlayKind } from "../engine/editor";
import type { PlaySession } from "./playMode";
import { persisted } from "./preferences";

export interface PlayGizmoSettings {
  /** The master toggle: off hides every gizmo and debug drawing in the play view. */
  enabled: boolean;
  /** Navigation's runtime drawing (navmesh, links, seams, paths; ADR 0065). */
  navigation: boolean;
  /** The live Inspector's selection outline. */
  outline: boolean;
  /** Any other overlay: a game's own debug drawing through `addEditorOverlay`. */
  other: boolean;
}

export const DEFAULT_PLAY_GIZMOS: PlayGizmoSettings = { enabled: true, navigation: true, outline: true, other: true };

/** The kinds the Gizmos menu lists, in order. */
export const PLAY_GIZMO_KINDS: readonly { key: Exclude<keyof PlayGizmoSettings, "enabled">; label: string; title: string }[] = [
  { key: "navigation", label: "Navigation", title: "The navmesh, links, seams and agents' paths, as the Navigation panel's toggles choose" },
  { key: "outline", label: "Selection outline", title: "The outline around the node selected in the live Hierarchy" },
  { key: "other", label: "Game overlays", title: "Debug drawing the game adds itself" },
];

export const playGizmos = persisted<PlayGizmoSettings>("myco.editor.playGizmos", DEFAULT_PLAY_GIZMOS);

/** The settings with anything unusable (older or hand-edited storage) replaced by its default. */
export function cleanPlayGizmos(s: Partial<PlayGizmoSettings> | null | undefined): PlayGizmoSettings {
  const out = { ...DEFAULT_PLAY_GIZMOS };
  for (const key of Object.keys(out) as (keyof PlayGizmoSettings)[]) {
    const v = s?.[key];
    if (typeof v === "boolean") out[key] = v;
  }
  return out;
}

export function updatePlayGizmos(patch: Partial<PlayGizmoSettings>): void {
  playGizmos.value = { ...cleanPlayGizmos(playGizmos.peek()), ...patch };
}

/** Whether overlays of `kind` draw in the play view under `s`. Colliders (edit-mode only today) follow the master toggle. */
export function overlayKindShown(s: PlayGizmoSettings, kind: EditorOverlayKind): boolean {
  if (!s.enabled) return false;
  if (kind === "navigation") return s.navigation;
  if (kind === "other") return s.other;
  return true;
}

/** Whether the selection outline draws in the play view under `s`. */
export const outlineShown = (s: PlayGizmoSettings) => s.enabled && s.outline;

/** How often Worlds created while playing are looked for. */
const NEW_WORLDS_MS = 300;

/** Apply the Gizmos settings to every World of each play session. Returns a function that stops. */
export function installPlayGizmos(playing: ReadonlySignal<PlaySession | null>): () => void {
  /** The settings each World has now (by identity), so a poll only touches new Worlds or changed settings. */
  let applied = new WeakMap<World, PlayGizmoSettings>();
  let timer: ReturnType<typeof setInterval> | null = null;
  const apply = (session: PlaySession) => {
    const s = cleanPlayGizmos(playGizmos.peek());
    for (const h of session.engine.worlds()) {
      const world = session.engine._world(h.name);
      if (!world || applied.get(world) === playGizmos.peek()) continue;
      applied.set(world, playGizmos.peek());
      setEditorOverlayFilter(world, (kind) => overlayKindShown(s, kind));
      setSelectionOutlineShown(world, outlineShown(s));
    }
  };
  const stop = effect(() => {
    void playGizmos.value;
    const session = playing.value;
    if (timer) clearInterval(timer);
    timer = null;
    if (!session) return;
    applied = new WeakMap(); // settings changed or a new session: apply to every World again
    try {
      apply(session);
    } catch (err) {
      console.warn("[myco] Couldn't apply the play view's Gizmos settings:", err);
    }
    timer = setInterval(() => {
      if (playing.peek() !== session) return;
      try {
        apply(session);
      } catch {
        // a World torn down meanwhile: the next poll sees the new list
      }
    }, NEW_WORLDS_MS);
  });
  // End-to-end test hook: what each play World's view draws of the editor's drawing now, and which overlays it shows.
  if (typeof window !== "undefined") {
    Object.assign(window, {
      playEditorDrawing: () => {
        const session = playing.peek();
        if (!session) return [];
        return session.engine.worlds().flatMap((h) => {
          const world = session.engine._world(h.name);
          return world ? [{ world: h.name, overlays: shownEditorOverlays(world), drawn: editorDrawingShown(world) }] : [];
        });
      },
    });
  }
  return () => {
    stop();
    if (timer) clearInterval(timer);
  };
}
