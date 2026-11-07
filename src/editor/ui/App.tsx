import { isTauri } from "../../engine/platform/FileSystem";
import { DockLayout } from "../layout/DockLayout";
import { togglePlaying } from "../session";
import { currentProject, docVersion, openScene, playState } from "../state";
import { art, PRODUCT_NAME } from "../brand";
import { AboutDialog, aboutOpen } from "./AboutDialog";
import { AssetDragGhost } from "./AssetDragOverlay";
import { ConfirmDialog } from "./ConfirmDialog";
import { exportOpen, settingsOpen } from "./dialogState";
import { lazyDialog } from "./lazy";
import { StatusBar } from "./StatusBar";
import { PlayControls } from "./PlayControls";
import { NewScriptDialog } from "./NewScriptDialog";
import { RefineList } from "./RefineList";
import { StartScreen } from "./StartScreen";
import { NewProjectDialog } from "./NewProjectDialog";
import { MenuBar } from "./MenuBar";
import { PANEL_VIEWS } from "./panels";
import { spriteEditorImage } from "../assetImport";

// Dialogs that load when first opened (ADR 0083).
const ExportDialog = lazyDialog(() => exportOpen.value, () => import("./ExportDialog").then((m) => m.ExportDialog));
const SettingsDialog = lazyDialog(() => settingsOpen.value, () => import("./SettingsDialog").then((m) => m.SettingsDialog));
const SpriteEditorDialog = lazyDialog(() => spriteEditorImage.value !== null, () => import("./SpriteEditor").then((m) => m.SpriteEditorDialog));

/** Editor window (ADR 0025): toolbar, dockable panels around the viewport, status bar. */
export function App() {
  return (
    <div class={`editor${playState.value !== "edit" ? " playing" : ""}`}>
      <Toolbar />
      <DockLayout panels={PANEL_VIEWS} />
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

/** The menu bar row: logo (About) and menus, Play controls in the middle, the project on the right. */
function Toolbar() {
  docVersion.value; // the unsaved dot follows the open scene's changes
  const project = currentProject.value;
  const dirty = !!openScene.value?.stack.dirty;
  return (
    <header class="toolbar menubar-row">
      <div class="menubar-left">
        <button class="brand" title={`About ${PRODUCT_NAME}`} aria-label={`About ${PRODUCT_NAME}`} onClick={() => (aboutOpen.value = true)}>
          <img src={art.mycoIcon} alt="" width={22} height={22} />
          <span>{PRODUCT_NAME}</span>
        </button>
        <MenuBar />
      </div>
      <div class="menubar-centre">
        <PlayButton />
        <PlayControls />
      </div>
      <div class="menubar-right">
        <span class="project-name" title={project?.root ?? "A sample served beside the editor"}>
          {project?.name ?? "No project"}
        </span>
        {dirty && <span class="unsaved-dot" role="img" aria-label="Unsaved changes" title="Unsaved changes" />}
        {project && !project.canSave && (
          <span class="readonly-badge" title="This project is read-only. Open a project folder to save.">
            Read-only
          </span>
        )}
      </div>
    </header>
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
