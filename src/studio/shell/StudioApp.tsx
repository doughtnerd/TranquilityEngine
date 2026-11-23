// The Studio's page (ADR 0341 "The shell"): the start screen with no project open, else the shell: header, the
// screen's dock (the engine's `DockLayout` over the screen's own layout store), the player bar with the screen's
// slots, the Hear as control (ADR 0351 §6) and the game session (driving take replay, UI pass #1), the status bar, toasts and the shortcut list. A banner says why when the audio core can't run, and one over
// the Playlists screen offers to migrate a read-only project's old audio events (ADR 0343).
import { ConfirmDialog } from "../../editor/ui/ConfirmDialog";
import { KeyboardShortcutsDialog } from "../../editor/ui/KeyboardShortcutsDialog";
import { UndoToasts } from "../../editor/ui/UndoToast";
import { AboutDialog } from "../../editor/ui/AboutDialog";
import { NewProjectDialog } from "../../editor/ui/NewProjectDialog";
import { BiosonicProjectsScreen } from "../start/BiosonicProjectsScreen";
import type { RecentTake } from "../start/recentTakes";
import { HistoryIcons, type HistoryIconSet } from "../../editor/ui/HistoryPopover";
import { currentProject } from "../../editor/state";
import { useEffect, useRef } from "preact/hooks";
import { Icon } from "../components/Icon";
import { PlayerBar } from "../components/PlayerBar";
import { HearAsSlot } from "./HearAsSlot";
import { GameSessionSlot, sessionSlots } from "./GameSessionSlot";
import { StatusBarSlot } from "./StatusBarSlot";
import { screenById } from "./screens";
import { ScreenDock } from "./ScreenDock";
import { pendingAudioMigration } from "./audioMigration";
import { MigrationBanner } from "./MigrationBanner";
import { StudioHeader } from "./StudioHeader";
import { audioRuntime, keymap, playerSlots, shortcutsOpen, singleKeyShortcuts, studioRouter, toasts } from "./studioServices";

export interface StudioAppProps {
  /** Close the open project (back to the start screen). */
  onCloseProject(): void;
  /** Open a recorded take from the start screen (its project, on the Take screen). */
  onOpenTake(take: RecentTake): Promise<void>;
}

/** The Studio's glyphs for every Undo / Redo / History cluster (header, toolbars). */
const HISTORY_ICONS: HistoryIconSet = { undo: <Icon name="undo" />, redo: <Icon name="redo" />, history: <Icon name="history" /> };

/** Screens whose transport is the game session (the prototype's Mixer: no transport of its own). */
const SESSION_SCREENS: ReadonlySet<string> = new Set(["mixer"]);

/**
 * Keep `--studio-footer-h` on the page at the player and status bars' height, so toasts sit just above the player bar
 * (whose height changes on a phone, where it stacks).
 */
function useFooterHeight(root: { readonly current: HTMLElement | null }): void {
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const h = [".studio-player", ".studio-status"].reduce((sum, sel) => sum + (el.querySelector<HTMLElement>(sel)?.offsetHeight ?? 0), 0);
      el.style.setProperty("--studio-footer-h", `${h}px`);
    };
    const observer = new ResizeObserver(measure);
    for (const sel of [".studio-player", ".studio-status"]) {
      const part = el.querySelector(sel);
      if (part) observer.observe(part);
    }
    measure();
    return () => observer.disconnect();
  });
}

export function StudioApp(props: StudioAppProps) {
  const root = useRef<HTMLDivElement>(null);
  useFooterHeight(root);
  const project = currentProject.value;
  if (!project) {
    return (
      <div class="studio studio-starting" data-floating-root="">
        <BiosonicProjectsScreen onOpenTake={props.onOpenTake} />
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
  const own = playerSlots.value[route.screen] ?? {};
  const slots = SESSION_SCREENS.has(route.screen) && !own.transport ? { ...sessionSlots(screen.art), ...own } : own;
  return (
    <HistoryIcons.Provider value={HISTORY_ICONS}>
    <div ref={root} class="studio" data-floating-root="">
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
      <PlayerBar idleArt={screen.art} {...slots} hearAs={<HearAsSlot />} session={<GameSessionSlot readOnly={SESSION_SCREENS.has(route.screen) && !own.transport} />} label={`${screen.title} player`} />
      <StatusBarSlot screen={route.screen} />
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
    </HistoryIcons.Provider>
  );
}
