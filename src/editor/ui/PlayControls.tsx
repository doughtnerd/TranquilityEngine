import { playPaused, stepFrame, togglePause } from "../playDebug";
import { choosePlayLanguage, playLanguageChoices, playLanguageOf, previewLanguage, projectLanguages } from "../playLanguage";
import { currentProject, docVersion, playState } from "../state";
import { PlayLanguageMenu } from "./PlayLanguageMenu";
import { playToolbarItems, type PlayToolbarItemContribution } from "../sdk/contributions";
import { lazyComponent, type LazyComponent } from "./lazy";
import { PauseIcon, PlayIcon, StepIcon } from "./toolIcons";
import "./playdebug.css";

// One lazy wrapper per contribution (ADR 0348): the plugins' Play toolbar controls, loaded with the toolbar.
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
        class={`icon-button pause-button${paused ? " active" : ""}`}
        disabled={!playing}
        aria-label={paused ? "Resume" : "Pause"}
        aria-pressed={paused}
        title={paused ? "Resume the game (Ctrl+Shift+P)" : "Pause the game: every World holds still (Ctrl+Shift+P)"}
        onClick={togglePause}
      >
        {paused ? <PlayIcon /> : <PauseIcon />}
      </button>
      <button class="icon-button" disabled={!playing} aria-label="Step" title="Advance every World one frame, with a fixed step when one is due (F10 or Ctrl+Alt+P)" onClick={stepFrame}>
        <StepIcon />
      </button>
      <PlayLanguage playing={playing} />
      {/* The Subtitles overlay toggle (ADR 0357 §6) is the subtitles plugin's Play toolbar item, there while it is on. */}
      {playToolbarItems.list().map((item) => <span key={item.id} class="play-toolbar-item">{lazyItem(item)()}</span>)}
    </div>
  );
}

/** The preview language menu (ADR 0354 §1, 0356 §9): shipped languages and pseudo-languages; a pick while playing switches the game. */
function PlayLanguage(props: { playing: boolean }) {
  const project = currentProject.value;
  docVersion.value; // project.json's languages may change
  if (!project) return null;
  const languages = projectLanguages(project.settings);
  const choices = playLanguageChoices(languages);
  if (choices.filter((c) => !c.pseudo).length === 0) return null;
  return <PlayLanguageMenu choices={choices} value={playLanguageOf(previewLanguage.value, languages)} onChange={(code) => void choosePlayLanguage(code, languages, props.playing)} />;
}
