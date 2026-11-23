import { playPaused, stepFrame, togglePause } from "../playDebug";
import { choosePlayLanguage, playLanguageChoices, playLanguageOf, previewLanguage, projectLanguages, subtitlesOverlay } from "../playLanguage";
import { useEffect } from "preact/hooks";
import { subtitlesOverlayUnavailable, syncSubtitlesOverlay } from "../playSubtitles";
import { currentProject, docVersion, playing, playState } from "../state";
import { PlayLanguageMenu, SubtitlesOverlayToggle } from "./PlayLanguageMenu";
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
  useSubtitlesOverlay();
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
      <PlayLanguage playing={playing} />
      <SubtitlesOverlayToggle on={subtitlesOverlay.value} unavailable={subtitlesOverlayUnavailable()} onToggle={(on) => (subtitlesOverlay.value = on)} />
      {playToolbarItems.list().map((item) => <span key={item.id} class="play-toolbar-item">{lazyItem(item)()}</span>)}
    </div>
  );
}

/**
 * The subtitle overlay (ADR 0343 §6): while the toggle is on, the play session gets the subtitles plugin's
 * `SubtitleDisplay` (editor-only, never saved), which stands aside while the scene has a display of its own.
 */
function useSubtitlesOverlay(): void {
  const session = playing.value;
  const on = subtitlesOverlay.value;
  useEffect(() => syncSubtitlesOverlay(session?.engine ?? null, on), [session, on]);
}

/** The preview language menu (ADR 0340 §1, 0342 §9): shipped languages and pseudo-languages; a pick while playing switches the game. */
function PlayLanguage(props: { playing: boolean }) {
  const project = currentProject.value;
  docVersion.value; // project.json's languages may change
  if (!project) return null;
  const languages = projectLanguages(project.settings);
  const choices = playLanguageChoices(languages);
  if (choices.filter((c) => !c.pseudo).length === 0) return null;
  return <PlayLanguageMenu choices={choices} value={playLanguageOf(previewLanguage.value, languages)} onChange={(code) => void choosePlayLanguage(code, languages, props.playing)} />;
}
