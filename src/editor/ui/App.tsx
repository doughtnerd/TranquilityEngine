import type { ComponentChildren } from "preact";
import { openProjectFolder, save } from "../session";
import { currentProject, docVersion, openScene, sceneCamera, setViewMode, snapping, status, tool, viewMode, type Tool } from "../state";
import { AssetsPanel } from "./Assets";
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
        <AssetsPanel />
      </Panel>
      <StatusBar />
    </div>
  );
}

function Toolbar() {
  const mode = viewMode.value;
  return (
    <header class="toolbar">
      <span class="brand">TranquilityEngine Editor</span>
      <ProjectControls />
      <Tools />
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
      <UndoRedo />
    </header>
  );
}

const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: "select", label: "Select", key: "Q" },
  { tool: "move", label: "Move", key: "W" },
  { tool: "rotate", label: "Rotate", key: "E" },
  { tool: "scale", label: "Scale", key: "R" },
];

function Tools() {
  const current = tool.value;
  return (
    <div class="group" role="group" aria-label="Tool">
      {TOOLS.map((t) => (
        <button
          key={t.tool}
          class={current === t.tool ? "active" : ""}
          aria-pressed={current === t.tool}
          title={`${t.label} (${t.key})`}
          onClick={() => (tool.value = t.tool)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function ProjectControls() {
  docVersion.value; // the Save button follows unsaved changes
  const project = currentProject.value;
  const scene = openScene.value;
  const canSave = !!project?.canSave && !!scene?.stack.dirty;
  const saveTitle = !project?.canSave ? "This project is read-only. Open a project folder to save." : `Save ${scene?.path ?? ""} (Ctrl+S)`;
  return (
    <div class="group" role="group" aria-label="Project">
      <button title="Open a project folder (desktop editor)" onClick={() => void openProjectFolder()}>
        Open Project…
      </button>
      <button disabled={!canSave} title={saveTitle} onClick={() => void save()}>
        Save
      </button>
      <span class="project-name" title={project?.root ?? "Bundled with the editor"}>
        {project?.name ?? "No project"}
      </span>
    </div>
  );
}

function StatusBar() {
  const s = status.value;
  return (
    <footer class={`status-bar${s?.kind === "error" ? " error" : ""}`} aria-live="polite">
      {s?.text ?? ""}
    </footer>
  );
}

function UndoRedo() {
  docVersion.value; // re-render when the undo stack changes
  const stack = openScene.value?.stack;
  const undo = stack?.undoLabel ?? null;
  const redo = stack?.redoLabel ?? null;
  return (
    <div class="group" role="group" aria-label="History">
      <button disabled={!stack?.canUndo} title={undo ? `Undo ${undo} (Ctrl+Z)` : "Nothing to undo"} onClick={() => stack?.undo()}>
        Undo
      </button>
      <button disabled={!stack?.canRedo} title={redo ? `Redo ${redo} (Ctrl+Shift+Z)` : "Nothing to redo"} onClick={() => stack?.redo()}>
        Redo
      </button>
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

function Panel(props: { class: string; title: string; children: ComponentChildren }) {
  return (
    <section class={`panel ${props.class}`}>
      <h2>{props.title}</h2>
      <div class="panel-body">{props.children}</div>
    </section>
  );
}
