import { playPaused, stepFrame, togglePause } from "../playDebug";
import { playState } from "../state";
import { playToolbarItems, type PlayToolbarItemContribution } from "../sdk/contributions";
import { lazyComponent, type LazyComponent } from "./lazy";
import "./playdebug.css";

// One lazy wrapper per contribution (ADR 0334): the plugins' Play toolbar controls, loaded with the toolbar.
const itemViews = new WeakMap<PlayToolbarItemContribution, LazyComponent>();
const lazyItem = (item: PlayToolbarItemContribution): LazyComponent => {
  let lazy = itemViews.get(item);
  if (!lazy) itemViews.set(item, (lazy = lazyComponent(item.view, null)));
  return lazy;
};

/** Pause and Step for the play session, beside Play/Stop in the toolbar. Disabled while editing. */
export function PlayControls() {
  const playing = playState.value === "playing";
  const paused = playing && playPaused.value;
  playToolbarItems.version.value; // re-render when a plugin registers a control
  return (
    <div class="group play-controls" role="group" aria-label="Play controls">
      <button
        class={`pause-button${paused ? " active" : ""}`}
        disabled={!playing}
        aria-pressed={paused}
        title={paused ? "Resume the game (Ctrl+Shift+P)" : "Pause the game: every World holds still (Ctrl+Shift+P)"}
        onClick={togglePause}
      >
        {paused ? "▶ Resume" : "❚❚ Pause"}
      </button>
      <button disabled={!playing} title="Advance every World one frame, with a fixed step when one is due (F10 or Ctrl+Alt+P)" onClick={stepFrame}>
        Step
      </button>
      {playToolbarItems.list().map((item) => <span key={item.id} class="play-toolbar-item">{lazyItem(item)()}</span>)}
    </div>
  );
}
