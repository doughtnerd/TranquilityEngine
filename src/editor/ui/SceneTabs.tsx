// Open scene tabs (ADR 0026) along the top of the Scene panel: click to switch, × or middle-click
// to close, a context menu with Close Others/All/Right/Left/Saved, Ctrl/Cmd+W (asking first if it has unsaved changes). The active tab is `openScene`.
import { signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { tabsToClose, type CloseMode } from "../sceneTabs";
import { activateScene, closeScene, closeScenes } from "../session";
import { docVersion, openScene, openScenes, type OpenScene } from "../state";
import "./assets.css";
import "./hierarchy.css";
import { isKeyboardEvent, ownerWindowOf, viewportOf } from "../windows/dom";

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
  useEffect(() => {
    if (!m) return;
    const close = (e: Event) => {
      if (isKeyboardEvent(e) && e.key !== "Escape") return;
      if (e.type === "pointerdown" && el.current?.contains(e.target as Node)) return;
      tabMenu.value = null;
    };
    const win = ownerWindowOf(el.current); // the window it's in (a detached panel window, ADR 0174)
    win.addEventListener("pointerdown", close, true);
    win.addEventListener("keydown", close, true);
    win.addEventListener("blur", close);
    el.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => {
      win.removeEventListener("pointerdown", close, true);
      win.removeEventListener("keydown", close, true);
      win.removeEventListener("blur", close);
    };
  }, [m]);
  if (!m) return null;
  const tabs = openScenes.value;
  const view = viewportOf(el.current);
  const x = Math.min(m.x, view.width - 220);
  const y = Math.min(m.y, view.height - MENU.length * 26 - 10);
  return (
    <div ref={el} class="context-menu" role="menu" style={{ left: `${Math.max(0, x)}px`, top: `${Math.max(0, y)}px` }}>
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
      <TabMenu />
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
