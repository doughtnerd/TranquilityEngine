// The status bar over the page's state (spec §3.6): the runtime's figures, the screen's playhead (its player bar slot)
// or else the game session's clock, the output's calibration, and whether the document in hand is saved, from the
// active history (ADR 0145): its tree's state matches the file as last written, or it holds edits not written yet. Its
// own component, so the clocks re-render only the bar.
import { activeHistory } from "../../editor/activeHistory";
import { currentProject, docVersion, status } from "../../editor/state";
import { StudioBuildsMenu, StudioDebugLinkPrompt } from "../debugLink/StudioDebugLink";
import { StudioStatusBar } from "../components/StudioStatusBar";
import type { StatusContext } from "../components/statusBarModel";
import { replayStore } from "./replay";
import { audioRuntime, playerSlots } from "./studioServices";
import type { ScreenId } from "./screens";

function documentState(canSave: boolean): StatusContext["document"] {
  void docVersion.value; // follow every history change
  if (!canSave) return "readOnly";
  const tree = activeHistory.value?.history.tree;
  void tree?.version?.value;
  if (!tree) return "saved";
  return tree.saved === tree.current ? "saved" : "unsaved";
}

export function StatusBarSlot(props: { readonly screen: ScreenId }) {
  const host = audioRuntime();
  const playhead = playerSlots.value[props.screen]?.playhead;
  let stale = false;
  try {
    stale = host.playable.value && host.audio.calibrationStale;
  } catch {
    stale = false;
  }
  const clock: StatusContext["clock"] = playhead ? { label: "Playhead", seconds: playhead.value } : { label: "Session", seconds: replayStore().time.value };
  return (
    <div class="studio-status-slot">
      <StudioStatusBar state={host.state.value} stats={host.stats.value} message={status.value} clock={clock} document={documentState(currentProject.value?.canSave ?? false)} stale={stale} />
      <div class="studio-status-link">
        <StudioBuildsMenu />
      </div>
      <StudioDebugLinkPrompt />
    </div>
  );
}
