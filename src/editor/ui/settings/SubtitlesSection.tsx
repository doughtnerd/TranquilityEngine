// Project Settings > Subtitles (ADR 0357 §3, §5 S5): the player settings' first-run defaults (on, size, background,
// speaker names, captions), the reading speed and minimum display time every subtitle is timed with, and speakers: a
// line table's speaker id with the string key of its shown name and its colour. Edits go through the Project panel's
// undo history; a refused edit says why in the status bar.
import { useState } from "preact/hooks";
import { DEFAULT_MIN_DISPLAY, DEFAULT_READING_SPEED, SUBTITLE_SIZES, type SubtitleSize } from "../../../engine/localisation/subtitleSettings";
import type { ProjectSettingsSectionProps } from "../../sdk/contributions";
import { NumberField, ProblemList, TextField } from "../settingsControls";
import { applySettingsEdit } from "./LanguagesSection";
import {
  addSpeaker, removeSpeaker, setMinDisplay, setReadingSpeed, setSpeakerColor, setSpeakerName, setSubtitleDefault, subtitlesSettings, unlistedSpeakers,
} from "./subtitlesSettingsModel";
import "./settingsSections.css";

const SIZE_LABELS: Record<SubtitleSize, string> = { small: "Small", medium: "Medium", large: "Large", extraLarge: "Extra large" };

export type SubtitlesSectionProps = Pick<ProjectSettingsSectionProps, "draft" | "problems" | "set" | "refresh"> & {
  /** The project's files with their parsed JSON, for the speakers its line tables name. */
  readonly files: Iterable<readonly [string, unknown]>;
};

/** The Project panel's section view (`ProjectSettingsSectionContribution.view`). */
export function SubtitlesSettingsSection(props: ProjectSettingsSectionProps) {
  const files = props.project.files.filter((f) => f.toLowerCase().endsWith(".lines.json")).map((f) => [f, props.project.assets.get(f)] as const);
  return <SubtitlesSection draft={props.draft} problems={props.problems} set={props.set} refresh={props.refresh} files={files} />;
}

export function SubtitlesSection(props: SubtitlesSectionProps) {
  const s = subtitlesSettings.read(props.draft);
  const apply = (label: string, r: Parameters<typeof applySettingsEdit>[2]) => applySettingsEdit(props, label, r);
  const d = s.defaults;
  const suggestions = unlistedSpeakers(props.draft, props.files);
  const [adding, setAdding] = useState("");
  const add = () => {
    if (adding.trim() === "") return;
    const r = addSpeaker(props.draft, adding);
    apply(`Add speaker ${adding.trim()}`, r);
    if ("next" in r) setAdding("");
  };
  return (
    <div class="settings-subtitles">
      {props.problems.length > 0 && <ProblemList list={props.problems} label="Subtitle problems" />}
      <h4 class="settings-subhead">Player defaults</h4>
      <p class="settings-note">What a player's subtitle settings start as on the first run; their own choices are kept after that.</p>
      <div class="settings-grid">
        <label for="sub-enabled">Subtitles on</label>
        <input id="sub-enabled" type="checkbox" checked={d.enabled} onChange={(e) => apply("Set subtitles on", setSubtitleDefault(props.draft, "enabled", (e.currentTarget as HTMLInputElement).checked))} />
        <label for="sub-size">Size</label>
        <select id="sub-size" value={d.size} onChange={(e) => apply("Set the subtitle size", setSubtitleDefault(props.draft, "size", (e.currentTarget as HTMLSelectElement).value as SubtitleSize))}>
          {SUBTITLE_SIZES.map((z) => (
            <option key={z} value={z}>
              {SIZE_LABELS[z]}
            </option>
          ))}
        </select>
        <label for="sub-background">Background</label>
        <span class="settings-inline">
          <input id="sub-background" type="range" min={0} max={100} step={5} value={Math.round(d.background * 100)} onChange={(e) => apply("Set the subtitle background", setSubtitleDefault(props.draft, "background", Number((e.currentTarget as HTMLInputElement).value) / 100))} />
          <output>{Math.round(d.background * 100)}%</output>
        </span>
        <label for="sub-names">Speaker names</label>
        <input id="sub-names" type="checkbox" checked={d.speakerNames} onChange={(e) => apply("Set speaker names", setSubtitleDefault(props.draft, "speakerNames", (e.currentTarget as HTMLInputElement).checked))} />
        <label for="sub-captions">Sound captions</label>
        <input id="sub-captions" type="checkbox" checked={d.captions} onChange={(e) => apply("Set sound captions", setSubtitleDefault(props.draft, "captions", (e.currentTarget as HTMLInputElement).checked))} />
      </div>

      <h4 class="settings-subhead">Timing</h4>
      <div class="settings-grid">
        <label for="sub-speed">Reading speed</label>
        <NumberField id="sub-speed" label="Reading speed" value={s.readingSpeed === DEFAULT_READING_SPEED ? undefined : s.readingSpeed} placeholder={String(DEFAULT_READING_SPEED)} suffix="characters/s" onCommit={(v) => apply("Set the reading speed", setReadingSpeed(props.draft, v ?? DEFAULT_READING_SPEED))} />
        <label for="sub-min">Shortest display</label>
        <NumberField id="sub-min" label="Shortest display" value={s.minDisplay === DEFAULT_MIN_DISPLAY ? undefined : s.minDisplay} placeholder={String(DEFAULT_MIN_DISPLAY)} suffix="s" onCommit={(v) => apply("Set the shortest display", setMinDisplay(props.draft, v ?? DEFAULT_MIN_DISPLAY))} />
      </div>
      <p class="settings-note">A subtitle shows for at least its characters ÷ the reading speed, and never less than the shortest display. Japanese, Chinese and Korean have their own built-in speeds; a language can set its own in project.json.</p>

      <h4 class="settings-subhead">Speakers</h4>
      {Object.keys(s.speakers).length === 0 ? (
        <p class="settings-note">No speakers listed: subtitles show each speaker's id as written, in the display's speaker colour.</p>
      ) : (
        <table class="settings-table speakers-table" aria-label="Speakers">
          <thead>
            <tr>
              <th>Speaker</th>
              <th title="A string key of the shown name; empty: the id as written">Name key</th>
              <th>Colour</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {Object.entries(s.speakers).map(([id, sp]) => (
              <tr key={id} data-speaker={id}>
                <td>{id}</td>
                <td>
                  <TextField label={`${id} name key`} value={sp.name ?? ""} placeholder={id} onCommit={(v) => apply(`Set ${id}'s name`, setSpeakerName(props.draft, id, v))} />
                </td>
                <td class="settings-inline">
                  <input type="color" aria-label={`${id} colour`} value={sp.color ?? "#ffffff"} onChange={(e) => apply(`Set ${id}'s colour`, setSpeakerColor(props.draft, id, (e.currentTarget as HTMLInputElement).value))} />
                  {sp.color && (
                    <button type="button" class="kit-icon-button" aria-label={`Clear ${id}'s colour`} title="Use the display's speaker colour" onClick={() => apply(`Clear ${id}'s colour`, setSpeakerColor(props.draft, id, null))}>
                      ⟲
                    </button>
                  )}
                </td>
                <td>
                  <button type="button" class="kit-icon-button" aria-label={`Remove ${id}`} onClick={() => apply(`Remove speaker ${id}`, removeSpeaker(props.draft, id))}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div class="settings-add-row">
        <input type="text" list="subtitle-speakers" aria-label="New speaker id" placeholder="Speaker id, as line tables name it" value={adding} onInput={(e) => setAdding((e.currentTarget as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <datalist id="subtitle-speakers">
          {suggestions.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        <button type="button" onClick={add} disabled={adding.trim() === ""}>
          + Speaker
        </button>
      </div>
    </div>
  );
}
