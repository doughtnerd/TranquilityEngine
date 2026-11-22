import { playPaused, stepFrame, togglePause } from "../playDebug";
import { choosePlayLanguage, playLanguageChoices, playLanguageOf, previewLanguage, projectLanguages, subtitlesOverlay } from "../playLanguage";
import { currentProject, docVersion, playState } from "../state";
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
      <SubtitlesOverlayToggle on={subtitlesOverlay.value} unavailable={SUBTITLES_UNAVAILABLE} onToggle={(on) => (subtitlesOverlay.value = on)} />
      {playToolbarItems.list().map((item) => <span key={item.id} class="play-toolbar-item">{lazyItem(item)()}</span>)}
    </div>
  );
}

/**
 * The subtitle overlay (ADR 0343 §6) overlays the subtitles plugin's display (0343 S3), built on `Audio.onLine` and
 * `Audio.onCaption`. Neither exists yet, so the toggle only keeps the preference and says why it shows nothing.
 * TODO(0343 S3/S5): when `myco.subtitles` lands, mount its `SubtitleDisplay` (editor-only, never saved) on the play
 * session while this is on and the scene has no display.
 */
const SUBTITLES_UNAVAILABLE = "Subtitle overlay: not available yet. It needs the subtitles display (ADR 0343), which isn't built; the setting is kept for when it is.";

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
