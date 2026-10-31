import type { ComponentChildren } from "preact";
import { sceneCamera, setViewMode, viewMode } from "../state";
import { Hierarchy } from "./Hierarchy";
import { Inspector } from "./Inspector";

/** Fixed editor layout (ADR 0025): toolbar, hierarchy | viewport | inspector, assets. */
export function App() {
  return (
    <div class="editor">
      <Toolbar />
      <Panel class="hierarchy" title="Hierarchy">
        <Hierarchy />
      </Panel>
      <section class="viewport-panel">
        <div id="viewport" class="viewport" />
        <ViewportHint />
      </section>
      <Panel class="inspector" title="Inspector">
        <Inspector />
      </Panel>
      <Panel class="assets" title="Assets">
        <p class="empty">Asset browser coming later. The Flappy demo is open as the project.</p>
      </Panel>
    </div>
  );
}

function Toolbar() {
  const mode = viewMode.value;
  return (
    <header class="toolbar">
      <span class="brand">TranquilityEngine Editor</span>
      <div class="group" role="group" aria-label="View mode">
        <button class={mode === "3d" ? "active" : ""} aria-pressed={mode === "3d"} onClick={() => setViewMode("3d")}>
          3D
        </button>
        <button class={mode === "2d" ? "active" : ""} aria-pressed={mode === "2d"} onClick={() => setViewMode("2d")}>
          2D
        </button>
      </div>
      <button title="Focus the origin (F)" onClick={() => sceneCamera.value?.focus()}>
        Focus
      </button>
    </header>
  );
}

function ViewportHint() {
  const text =
    viewMode.value === "3d"
      ? "Orbit: right-drag or Alt + left-drag · Pan: middle-drag or Shift + right-drag · Zoom: wheel · Focus: F"
      : "Pan: right- or middle-drag · Zoom: wheel · Focus: F";
  return <div class="viewport-hint">{text}</div>;
}

function Panel(props: { class: string; title: string; children: ComponentChildren }) {
  return (
    <section class={`panel ${props.class}`}>
      <h2>{props.title}</h2>
      <div class="panel-body">{props.children}</div>
    </section>
  );
}
