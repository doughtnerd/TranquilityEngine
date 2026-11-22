// The Studio's page (ADR 0327 "The shell"): the start screen with no project open, else the shell: header, the
// screen's dock (the engine's `DockLayout` over the screen's own layout store), the player bar with the screen's
// slots, the status bar, toasts and the shortcut list. A banner says why when the audio core can't run, and one over
// the Playlists screen offers to migrate a read-only project's old audio events (ADR 0329).
import { ConfirmDialog } from "../../editor/ui/ConfirmDialog";
import { KeyboardShortcutsDialog } from "../../editor/ui/KeyboardShortcutsDialog";
import { UndoToasts } from "../../editor/ui/UndoToast";
import { AboutDialog } from "../../editor/ui/AboutDialog";
import { NewProjectDialog } from "../../editor/ui/NewProjectDialog";
import { StartScreen } from "../../editor/ui/StartScreen";
import { currentProject, status } from "../../editor/state";
import { PlayerBar } from "../components/PlayerBar";
import { StudioStatusBar } from "../components/StudioStatusBar";
import { outputDevice } from "./outputDevice";
import { ReplaySlot, replaySlotShown } from "./ReplaySlot";
import { screenById } from "./screens";
import { ScreenDock } from "./ScreenDock";
import { pendingAudioMigration } from "./audioMigration";
import { MigrationBanner } from "./MigrationBanner";
import { StudioHeader } from "./StudioHeader";
import { audioRuntime, keymap, playerSlots, shortcutsOpen, singleKeyShortcuts, studioRouter, toasts } from "./studioServices";

export interface StudioAppProps {
  /** Close the open project (back to the start screen). */
  onCloseProject(): void;
}

export function StudioApp(props: StudioAppProps) {
  const project = currentProject.value;
  if (!project) {
    return (
      <div class="studio studio-starting">
        <StartScreen
          chrome={
            <p class="studio-start-title" aria-hidden="true">
              Audio Studio
            </p>
          }
        />
        <NewProjectDialog />
        <AboutDialog />
        <UndoToasts queue={toasts} />
        <ConfirmDialog />
      </div>
    );
  }
  const route = studioRouter().route.value;
  const screen = screenById(route.screen)!;
  const host = audioRuntime();
  const state = host.state.value;
  const slots = playerSlots.value[route.screen] ?? {};
  return (
    <div class="studio">
      <StudioHeader screen={route.screen} projectName={project.name} readOnly={!project.canSave} onScreen={(s) => studioRouter().open({ screen: s })} onCloseProject={props.onCloseProject} />
      <div class="studio-banners">
        {state.kind === "failed" && (
          <div class="studio-banner" role="alert">
            <strong>Audio core unavailable.</strong> {state.reason}
          </div>
        )}
        {route.screen === "playlists" && pendingAudioMigration.value && <MigrationBanner pending={pendingAudioMigration.value} />}
      </div>
      <ScreenDock screen={route.screen} />
      <PlayerBar idleArt={screen.art} {...slots} replay={"replay" in slots ? slots.replay : replaySlotShown() ? <ReplaySlot /> : undefined} label={`${screen.title} player`} />
      <StudioStatusBar state={state} stats={host.stats.value} message={status.value} device={outputDevice().value.name} />
      <UndoToasts queue={toasts} />
      <ConfirmDialog />
      {shortcutsOpen.value && (
        <KeyboardShortcutsDialog
          groups={keymap.list(route.screen, singleKeyShortcuts.value, (id) => screenById(id)?.title ?? id)}
          singleKeys={{ on: singleKeyShortcuts.value, set: (on) => (singleKeyShortcuts.value = on) }}
          onClose={() => (shortcutsOpen.value = false)}
        />
      )}
    </div>
  );
}
