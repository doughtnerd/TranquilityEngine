import { DockLayout } from "../layout/DockLayout";
import { resetLayout } from "../layout/store";
import { closeProject, openProjectFolder, reloadScripts, save, togglePlaying } from "../session";
import { currentProject, docVersion, openScene, playState, scriptProblems, snapping, status } from "../state";
import { art, PRODUCT_NAME } from "../brand";
import { AboutDialog, aboutOpen } from "./AboutDialog";
import { AssetsPanel } from "./Assets";
import { CodePanel } from "./CodePanel";
import { AssetDragGhost } from "./AssetDragOverlay";
import { ConfirmDialog } from "./ConfirmDialog";
import { StatusBar } from "./StatusBar";
import { NetworkPanel } from "./NetworkPanel";
import { NewScriptDialog } from "./NewScriptDialog";
import { HistoryPanel } from "./HistoryPanel";
import { RefineList } from "./RefineList";
import { SettingsDialog, settingsOpen } from "./SettingsDialog";
import { Hierarchy } from "./Hierarchy";
import { Inspector } from "./Inspector";
import { ScenePanel } from "./ScenePanel";
import { StartScreen } from "./StartScreen";
import { WorldsPanel } from "./WorldsPanel";

const PANELS = { scene: () => <ScenePanel />, hierarchy: () => <Hierarchy />, inspector: () => <Inspector />, assets: () => <AssetsPanel />, history: () => <HistoryPanel />, code: () => <CodePanel />, worlds: () => <WorldsPanel />, network: () => <NetworkPanel /> };

/** Editor window (ADR 0025): toolbar, dockable panels around the viewport, status bar. */
export function App() {
  return (
    <div class={`editor${playState.value !== "edit" ? " playing" : ""}`}>
      <Toolbar />
      <DockLayout panels={PANELS} />
      {!currentProject.value && <StartScreen />}
      <StatusBar />
      <AssetDragGhost />
      <ConfirmDialog />
      <NewScriptDialog />
      <SettingsDialog />
      <AboutDialog />
      <RefineList />
    </div>
  );
}

function Toolbar() {
  return (
    <header class="toolbar">
      <button class="brand" title={`About ${PRODUCT_NAME}`} aria-label={`About ${PRODUCT_NAME}`} onClick={() => (aboutOpen.value = true)}>
        <img src={art.mycoIcon} alt="" width={22} height={22} />
        <span>{PRODUCT_NAME}</span>
      </button>
      <ProjectControls />
      <PlayButton />
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
      {project && (
        <button title="Close the project and go back to the start screen" onClick={() => void closeProject()}>
          Close
        </button>
      )}
      <span class="project-name" title={project?.root ?? "A sample served beside the editor"}>
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


