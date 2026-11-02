import { effect } from "@preact/signals";
import { useLayoutEffect, useRef } from "preact/hooks";
import { playState, snapping, tool, viewMode } from "../state";
import { ViewportDropHighlight } from "./AssetDragOverlay";

/** The elements the engines render into: kept for the whole session, whichever dock shows the scene. */
let elements: { viewport: HTMLDivElement; gameView: HTMLDivElement } | null = null;

/**
 * The Editor World's container (`#viewport`) and the Runtime World's during play mode
 * (`#game-view`, ADR 0022). They outlive the Scene panel: when it moves to another dock, or
 * another tab hides it, they're detached and re-attached rather than recreated, so the engine
 * keeps its canvas and WebGL context.
 */
export function viewportElements(): { viewport: HTMLDivElement; gameView: HTMLDivElement } {
  if (elements) return elements;
  const make = (id: string) => Object.assign(document.createElement("div"), { id, className: id });
  elements = { viewport: make("viewport"), gameView: make("game-view") };
  const gameView = elements.gameView;
  effect(() => {
    gameView.hidden = playState.value === "edit";
  });
  return elements;
}

/** The Scene panel: the scene view (and the game, while playing), a movable panel like any other. */
export function ScenePanel() {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = host.current!;
    const { viewport, gameView } = viewportElements();
    el.append(viewport, gameView);
    return () => {
      // Only if still ours: a new Scene panel may have taken them already.
      if (viewport.parentElement === el) viewport.remove();
      if (gameView.parentElement === el) gameView.remove();
    };
  }, []);
  return (
    <div class="scene-panel viewport-panel">
      <div ref={host} class="viewport-host" />
      <ViewportHint />
      <ViewportDropHighlight />
    </div>
  );
}

function ViewportHint() {
  const text =
    viewMode.value === "3d"
      ? "Orbit: right-drag or Alt + left-drag · Pan: middle-drag or Shift + right-drag · Zoom: wheel · Focus: F"
      : "Pan: right- or middle-drag · Zoom: wheel · Focus: F";
  const gizmo = tool.value === "select" ? "" : ` · Hold Ctrl to snap${snapping.value ? " (on)" : ""}`;
  return <div class="viewport-hint">{text + gizmo}</div>;
}
