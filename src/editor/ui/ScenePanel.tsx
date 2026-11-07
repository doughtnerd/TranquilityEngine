import { backFromPrefab, prefabOrigin } from "../prefabTabs";
import { effect } from "@preact/signals";
import { useLayoutEffect, useRef } from "preact/hooks";
import { cleanSnap, snapSettings } from "../sceneTools";
import { openScene, pickTool, playState, sceneCamera, setViewMode, snapping, tool, viewMode, type Tool } from "../state";
import { ViewportDropHighlight } from "./AssetDragOverlay";
import { CameraPreviewFrame, SceneToolButtons } from "./SceneTools";
import { ParticlePreviewOverlay } from "./ParticlePreviewOverlay";
import { SceneTabs } from "./SceneTabs";

/** The elements the engines render into: kept for the whole session, whichever dock shows the scene. */
let elements: { viewport: HTMLDivElement; gameView: HTMLDivElement } | null = null;

/**
 * The Editor World's container (`#viewport`) and the game view during play mode
 * (`#game-view`, ADR 0022, tiled when several Worlds render). They outlive the Scene panel: when it moves to another dock, or
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

/** While editing a prefab opened from an instance (ADR 0122): which prefab, from where, and Back. */
function PrefabBar() {
  const from = prefabOrigin();
  const scene = openScene.value;
  if (!from || !scene) return null;
  const name = from.split("/").pop()!.replace(/\.(scene|prefab)\.json$/i, "");
  return (
    <div class="prefab-bar" role="status">
      <button class="prefab-back" onClick={() => void backFromPrefab()} title={`Back to ${from}`}>
        ← Back to {name}
      </button>
      <span>
        Editing prefab <code>{scene.path}</code> from {name}
      </span>
    </div>
  );
}

/**
 * The Scene panel: a toolbar (tools, 3D/2D, Focus) over the scene view (and the game, while
 * playing), a movable panel like any other.
 */
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
    <div class="scene-panel">
      <SceneTabs />
      <PrefabBar />
      <SceneToolbar />
      <div class="viewport-panel">
        <div ref={host} class="viewport-host" />
        <ViewportHint />
        <CameraPreviewFrame />
        <ParticlePreviewOverlay />
        <ViewportDropHighlight />
      </div>
    </div>
  );
}

const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: "select", label: "Select", key: "Q" },
  { tool: "move", label: "Move", key: "W" },
  { tool: "rotate", label: "Rotate", key: "E" },
  { tool: "scale", label: "Scale", key: "R" },
];

function SceneToolbar() {
  const current = tool.value;
  const mode = viewMode.value;
  return (
    <div class="scene-toolbar" role="toolbar" aria-label="Scene tools">
      <div class="group" role="group" aria-label="Tool">
        {TOOLS.map((t) => (
          <button
            key={t.tool}
            class={current === t.tool ? "active" : ""}
            aria-pressed={current === t.tool}
            title={`${t.label} (${t.key})`}
            onClick={() => pickTool(t.tool)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div class="group" role="group" aria-label="View mode">
        <button class={mode === "3d" ? "active" : ""} aria-pressed={mode === "3d"} onClick={() => setViewMode("3d")}>
          3D
        </button>
        <button class={mode === "2d" ? "active" : ""} aria-pressed={mode === "2d"} onClick={() => setViewMode("2d")}>
          2D
        </button>
      </div>
      <button title="Frame the selection, or the origin (F)" onClick={() => sceneCamera.value?.focus()}>
        Focus
      </button>
      <SceneToolButtons />
    </div>
  );
}

function ViewportHint() {
  const text =
    viewMode.value === "3d"
      ? "Orbit: right-drag or Alt + left-drag · Pan: middle-drag or Shift + right-drag · Zoom: wheel · Focus: F"
      : "Pan: right- or middle-drag · Zoom: wheel · Focus: F";
  const always = cleanSnap(snapSettings.value).always;
  const gizmo = tool.value === "select" ? "" : always ? " · Snapping" : ` · Hold Ctrl to snap${snapping.value ? " (on)" : ""}`;
  return <div class="viewport-hint">{text + gizmo}</div>;
}
