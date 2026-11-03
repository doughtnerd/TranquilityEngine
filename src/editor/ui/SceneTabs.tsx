// Open scene tabs (ADR 0026) along the top of the Scene panel: click to switch, × or middle-click
// to close (asking first if it has unsaved changes). The active tab is `openScene`.
import { activateScene, closeScene } from "../session";
import { docVersion, openScene, openScenes } from "../state";
import "./hierarchy.css";

export function SceneTabs() {
  docVersion.value; // dirty markers follow edits
  const scenes = openScenes.value;
  const active = openScene.value;
  if (scenes.length === 0) return null;
  return (
    <div class="scene-tabs" role="tablist" aria-label="Open scenes">
      {scenes.map((scene) => {
        const name = scene.path.split("/").pop()!;
        const selected = scene === active;
        return (
          <div
            key={scene.path}
            class={`scene-tab${selected ? " active" : ""}`}
            role="tab"
            aria-selected={selected}
            data-path={scene.path}
            title={scene.path}
            onClick={() => activateScene(scene)}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              void closeScene(scene);
            }}
          >
            <span class="scene-tab-name">
              {name}
              {scene.stack.dirty && " •"}
            </span>
            <button
              class="scene-tab-close"
              aria-label={`Close ${name}`}
              title="Close"
              onClick={(e) => {
                e.stopPropagation();
                void closeScene(scene);
              }}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
