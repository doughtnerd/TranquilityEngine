import { signal } from "@preact/signals";
import type { ComponentChildren, FunctionComponent } from "preact";
import { isTauri } from "../../engine/platform/FileSystem";
import { DockLayout } from "../layout/DockLayout";
import { resetLayout } from "../layout/store";
import { closeProject, reloadScripts, save, togglePlaying } from "../session";
import { createScene } from "../newScene";
import { currentProject, docVersion, openScene, playState, scriptProblems, snapping, status } from "../state";
import { art, PRODUCT_NAME } from "../brand";
import { AboutDialog, aboutOpen } from "./AboutDialog";
import { AssetsPanel } from "./Assets";
import { CodePanel } from "./CodePanel";
import { AssetDragGhost } from "./AssetDragOverlay";
import { ConfirmDialog } from "./ConfirmDialog";
import { ExportDialog, exportOpen } from "./ExportDialog";
import { StatusBar } from "./StatusBar";
import { NetworkPanel } from "./NetworkPanel";
import { PlayControls } from "./PlayControls";
import { NewScriptDialog } from "./NewScriptDialog";
import { SpriteEditorDialog } from "./SpriteEditor";
import { HistoryPanel } from "./HistoryPanel";
import { RefineList } from "./RefineList";
import { SettingsDialog, settingsOpen } from "./SettingsDialog";
import { Hierarchy } from "./Hierarchy";
import { Inspector } from "./Inspector";
import { ScenePanel } from "./ScenePanel";
import { StartScreen } from "./StartScreen";
import { WorldsPanel } from "./WorldsPanel";
import { NewProjectDialog } from "./NewProjectDialog";
import { ProjectMenu } from "./ProjectMenu";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";

/** A panel whose code loads the first time it shows, so the editor starts without it (the Shader Graph editor and its graph library). */
function lazyPanel(load: () => Promise<FunctionComponent>): () => ComponentChildren {
  const loaded = signal<FunctionComponent | null>(null);
  let loading = false;
  return () => {
    if (!loading) {
      loading = true;
      void load().then(
        (panel) => (loaded.value = panel),
        (err: unknown) => {
          loading = false;
          console.error(err);
        },
      );
    }
    const Panel = loaded.value;
    return Panel ? <Panel /> : <p class="empty">Loading…</p>;
  };
}
const ShaderGraphPanel = lazyPanel(() => import("./ShaderGraphPanel").then((m) => m.ShaderGraphPanel));

const PANELS = { scene: () => <ScenePanel />, hierarchy: () => <Hierarchy />, inspector: () => <Inspector />, assets: () => <AssetsPanel />, history: () => <HistoryPanel />, code: () => <CodePanel />, worlds: () => <WorldsPanel />, network: () => <NetworkPanel />, project: () => <ProjectSettingsPanel />, shadergraph: ShaderGraphPanel };

/** Editor window (ADR 0025): toolbar, dockable panels around the viewport, status bar. */
export function App() {
  return (
    <div class={`editor${playState.value !== "edit" ? " playing" : ""}`}>
      <Toolbar />
      <DockLayout panels={PANELS} />
      {!currentProject.value && !isTauri() && <StartScreen /> /* the desktop editor has a Projects window instead (ADR 0059) */}
      <StatusBar />
      <AssetDragGhost />
      <ConfirmDialog />
      <NewScriptDialog />
      <ExportDialog />
      <NewProjectDialog />
      <SpriteEditorDialog />
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
      <PlayControls />
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
      <ProjectMenu />
      <button disabled={!canSave} title={saveTitle} onClick={() => void save()}>
        Save
      </button>
      {project && (
        <button disabled={!project.canSave} title={project.canSave ? "Create a scene with a camera and open it" : "This project is read-only."} onClick={() => void createScene()}>
          New Scene
        </button>
      )}
      {project?.root != null && (
        <button title="Read the scripts under scripts/ again and reload them (ADR 0030)" onClick={() => void reloadScripts()}>
          Reload Scripts
        </button>
      )}
      {project && (
        <button title="Build / Export: make a playable web build or desktop app of the project (ADR 0041)" onClick={() => (exportOpen.value = true)}>
          Export…
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


