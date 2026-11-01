import { DockLayout } from "../layout/DockLayout";
import { resetLayout } from "../layout/store";
import { openProjectFolder, reloadScripts, save, togglePlaying } from "../session";
import { currentProject, docVersion, openScene, pickTool, playState, sceneCamera, scriptProblems, setViewMode, snapping, status, tool, viewMode, type Tool } from "../state";
import { AssetsPanel } from "./Assets";
import { AssetDragGhost, ViewportDropHighlight } from "./AssetDragOverlay";
import { ConfirmDialog } from "./ConfirmDialog";
import { HistoryPanel } from "./HistoryPanel";
import { RefineList } from "./RefineList";
import { SettingsDialog, settingsOpen } from "./SettingsDialog";
import { Hierarchy } from "./Hierarchy";
import { Inspector } from "./Inspector";

const PANELS = { hierarchy: () => <Hierarchy />, inspector: () => <Inspector />, assets: () => <AssetsPanel />, history: () => <HistoryPanel /> };

/** Editor window (ADR 0025): toolbar, dockable panels around the viewport, status bar. */
export function App() {
  return (
    <div class={`editor${playState.value !== "edit" ? " playing" : ""}`}>
      <Toolbar />
      <DockLayout
        panels={PANELS}
        viewport={
          <>
            <div id="viewport" class="viewport" />
            <ViewportHint />
            <ViewportDropHighlight />
            {/* The Runtime World's canvas goes here during play mode (ADR 0022). */}
            <div id="game-view" class="game-view" hidden={playState.value === "edit"} />
          </>
        }
      />
      <StatusBar />
      <AssetDragGhost />
      <ConfirmDialog />
      <SettingsDialog />
      <RefineList />
    </div>
  );
}

function Toolbar() {
  const mode = viewMode.value;
  return (
    <header class="toolbar">
      <span class="brand">TranquilityEngine Editor</span>
      <ProjectControls />
      <PlayButton />
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
      <button title="Put the panels back where they started" onClick={resetLayout}>
        Reset Layout
      </button>
      <button title="Editor settings" onClick={() => (settingsOpen.value = true)}>
        Settings
      </button>
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
          onClick={() => pickTool(t.tool)}
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
      {project?.root != null && (
        <button title="Read the scripts under scripts/ again and reload them (ADR 0030)" onClick={() => void reloadScripts()}>
          Reload Scripts
        </button>
      )}
      <span class="project-name" title={project?.root ?? "Bundled with the editor"}>
        {project?.name ?? "No project"}
      </span>
    </div>
  );
}

function PlayButton() {
  const state = playState.value;
  const canPlay = !!openScene.value;
  return (
    <button
      class={`play-button${state !== "edit" ? " active" : ""}`}
      disabled={state === "starting" || (state === "edit" && !canPlay)}
      aria-pressed={state !== "edit"}
      title={state === "edit" ? "Play the open scene (Ctrl+P)" : "Stop playing (Ctrl+P)"}
      onClick={togglePlaying}
    >
      {state === "edit" ? "▶ Play" : state === "starting" ? "Starting…" : "■ Stop"}
    </button>
  );
}

function StatusBar() {
  const s = status.value;
  return (
    <footer class={`status-bar${s?.kind === "error" ? " error" : ""}`} aria-live="polite">
      <span class="status-text">{s?.text ?? ""}</span>
      {s?.action && (
        <button
          class="status-action"
          onClick={() => {
            s.action!.run();
            status.value = { kind: "info", text: s.action!.done ?? "Done." };
          }}
        >
          {s.action.label}
        </button>
      )}
      <ScriptProblems />
    </footer>
  );
}

/**
 * Project scripts that didn't load (ADR 0030): a lasting marker in the status bar, since other
 * messages replace the status text. Clicking it puts the details in the status text.
 */
function ScriptProblems() {
  const problems = scriptProblems.value;
  if (problems.length === 0) return null;
  const lines = problems.map((p) => `${p.path}: ${p.message}`);
  return (
    <button
      class="script-problems"
      title={lines.join("\n")}
      onClick={() => (status.value = { kind: "error", text: lines.join("; ") })}
    >
      ⚠ {problems.length === 1 ? "1 script didn't load" : `${problems.length} scripts didn't load`}
    </button>
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

