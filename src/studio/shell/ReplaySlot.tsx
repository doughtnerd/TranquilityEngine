// The player bar's replay slot over the page's replay store (ADR 0334; replay stands in for the game session in v1):
// while a take is open it shows on every screen, so an edit anywhere is heard against the take. A screen that draws its
// own replay controls (the Take screen) sets its `replay` slot to null.
import { ReplayControls } from "../components/ReplayControls";
import { replayStore } from "./replay";
import { studioRouter } from "./studioServices";

export function ReplaySlot() {
  const store = replayStore();
  const open = store.open.value;
  if (!open) return null;
  const onTake = studioRouter().route.value.screen === "take";
  return (
    <ReplayControls
      title={open.title}
      time={store.time.value}
      duration={open.take.duration}
      playing={store.playing.value}
      onToggle={() => store.toggle()}
      onSeek={(t) => store.seek(t)}
      onShow={onTake ? undefined : () => studioRouter().open({ screen: "take", asset: open.path })}
      onClose={() => store.close()}
    />
  );
}

/** Whether the replay slot has anything to show (a take is open). */
export const replaySlotShown = (): boolean => replayStore().open.value !== null;
