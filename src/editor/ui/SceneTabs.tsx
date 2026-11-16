// Open scene tabs (ADR 0026) along the top of the Scene panel: click to switch, × or middle-click
// to close, a context menu with Close Others/All/Right/Left/Saved, Ctrl/Cmd+W (asking first if it has unsaved changes). The active tab is `openScene`.
import { signal } from "@preact/signals";
import { useRef } from "preact/hooks";
import { tabsToClose, type CloseMode } from "../sceneTabs";
import { activateScene, closeScene, closeScenes } from "../session";
import { docVersion, openScene, openScenes, type OpenScene } from "../state";
import "./assets.css";
import "./hierarchy.css";
import { usePopover } from "./popover";

/** The tab context menu: where, and which tab it was opened on. */
const tabMenu = signal<{ x: number; y: number; scene: OpenScene } | null>(null);

const MENU: readonly { mode: CloseMode; label: string }[] = [
  { mode: "this", label: "Close" },
  { mode: "others", label: "Close Others" },
  { mode: "all", label: "Close All" },
  { mode: "right", label: "Close to the Right" },
  { mode: "left", label: "Close to the Left" },
  { mode: "saved", label: "Close Saved" },
];

function TabMenu() {
  const m = tabMenu.value;
  const el = useRef<HTMLDivElement>(null);
  // In its own window (a detached panel window, ADR 0174), measured to stay on screen.
  usePopover(el, !!m, { anchor: m, key: m, focusFirst: true, onDismiss: () => (tabMenu.value = null) });
  if (!m) return null;
  const tabs = openScenes.value;
  return (
    <div ref={el} class="context-menu" role="menu">
      {MENU.map(({ mode, label }) => {
        const targets = tabsToClose(tabs, m.scene, mode, (t) => t.stack.dirty);
        return (
          <button
            key={mode}
            role="menuitem"
            disabled={targets.length === 0}
            onClick={() => {
              tabMenu.value = null;
              void closeScenes(targets);
            }}
          >
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

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
            onContextMenu={(e) => {
              e.preventDefault();
              tabMenu.value = { x: e.clientX, y: e.clientY, scene };
            }}
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
      <TabMenu />
    </div>
  );
}
