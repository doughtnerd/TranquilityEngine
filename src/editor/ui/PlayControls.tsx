import { playPaused, stepFrame, togglePause } from "../playDebug";
import { playState } from "../state";
import "./playdebug.css";

/** Pause and Step for the play session, beside Play/Stop in the toolbar. Disabled while editing. */
export function PlayControls() {
  const playing = playState.value === "playing";
  const paused = playing && playPaused.value;
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
    </div>
  );
}
