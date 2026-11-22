// Project Settings > Subtitles (ADR 0343 §3, §5 S5): `project.json`'s `subtitles` section as part of the settings draft
// (its settings section handle, ADR 0253) and its edits, each refused or next (0313): the player settings' first-run
// defaults, the reading speed and minimum display time, and speakers (a line table's speaker id with the string key of
// its shown name and a colour). Speaker ids the project's line tables use are offered when adding one.
//
// Pure.
import {
  DEFAULT_MIN_DISPLAY, DEFAULT_READING_SPEED, parseSubtitleSettings, SUBTITLE_LIMITS, SUBTITLE_SIZES, subtitleSettingsToJson,
  type SubtitleProjectSettings, type SubtitleSettings, type SubtitleSpeaker,
} from "../../../engine/localisation/subtitleSettings";
import { isStringKey } from "../../../engine/localisation/strings/format";
import { isRecord } from "../../../engine/localisation/lenient";
import type { SettingsDraft, SettingsProblem } from "../../projectSettingsModel";
import { settingsSection } from "../../settingsSection";
import { accept, mapEdit, refuse, type EditResult } from "../localisation/editResult";

/** The `subtitles` key of the draft: read leniently (the defaults when absent), written minimal (removed when all default). */
export const subtitlesSettings = settingsSection<SubtitleProjectSettings>({
  key: "subtitles",
  parse: (written) => {
    const { subtitles, problems } = parseSubtitleSettings(written);
    return { settings: subtitles, problems };
  },
  write: (draft, s) => {
    const json = subtitleSettingsToJson(s);
    return { ...draft, subtitles: Object.keys(json).length ? json : undefined };
  },
});

export const subtitlesProblems = (draft: SettingsDraft): SettingsProblem[] => subtitlesSettings.problems(draft);

type Edit = EditResult<SubtitleProjectSettings>;
const onDraft = (draft: SettingsDraft, edit: (s: SubtitleProjectSettings) => Edit): EditResult<SettingsDraft> =>
  mapEdit(edit(subtitlesSettings.read(draft)), (s) => subtitlesSettings.write(draft, s));

/** One first-run default of the player's settings. */
export function setSubtitleDefault<K extends keyof SubtitleSettings>(draft: SettingsDraft, key: K, value: SubtitleSettings[K]): EditResult<SettingsDraft> {
  return onDraft(draft, (s) => {
    if (key === "size" && !(SUBTITLE_SIZES as readonly unknown[]).includes(value)) return refuse(`the size is ${SUBTITLE_SIZES.join(", ")}`);
    if (key === "background" && !(typeof value === "number" && value >= 0 && value <= 1)) return refuse("the background opacity is 0 to 100%");
    return accept({ ...s, defaults: { ...s.defaults, [key]: value } });
  });
}

/** Characters per second for languages without a reading speed of their own or built in. */
export function setReadingSpeed(draft: SettingsDraft, cps: number): EditResult<SettingsDraft> {
  const [lo, hi] = SUBTITLE_LIMITS.readingSpeed;
  return onDraft(draft, (s) => (Number.isFinite(cps) && cps >= lo && cps <= hi ? accept({ ...s, readingSpeed: cps }) : refuse(`the reading speed is ${lo} to ${hi} characters per second`)));
}

/** The shortest time, in seconds, a subtitle or page shows. */
export function setMinDisplay(draft: SettingsDraft, seconds: number): EditResult<SettingsDraft> {
  const [lo, hi] = SUBTITLE_LIMITS.minDisplay;
  return onDraft(draft, (s) => (Number.isFinite(seconds) && seconds >= lo && seconds <= hi ? accept({ ...s, minDisplay: seconds }) : refuse(`the minimum display time is ${lo} to ${hi} seconds`)));
}

export const resetTiming = (draft: SettingsDraft): EditResult<SettingsDraft> => onDraft(draft, (s) => accept({ ...s, readingSpeed: DEFAULT_READING_SPEED, minDisplay: DEFAULT_MIN_DISPLAY }));

// --- speakers --------------------------------------------------------------------------------------------------------

const speakerRow = (s: SubtitleProjectSettings, id: string, change: (sp: SubtitleSpeaker) => SubtitleSpeaker | string): Edit => {
  const sp = s.speakers[id];
  if (!sp) return refuse(`"${id}" isn't a listed speaker`);
  const next = change(sp);
  return typeof next === "string" ? refuse(next) : accept({ ...s, speakers: { ...s.speakers, [id]: next } });
};

export function addSpeaker(draft: SettingsDraft, rawId: string): EditResult<SettingsDraft> {
  const id = rawId.trim();
  return onDraft(draft, (s) => {
    if (id === "" || id === "__proto__") return refuse("a speaker needs an id (the speaker its line tables name)");
    if (s.speakers[id]) return refuse(`${id} is listed already`);
    if (Object.keys(s.speakers).length >= SUBTITLE_LIMITS.speakers) return refuse(`at most ${SUBTITLE_LIMITS.speakers} speakers`);
    return accept({ ...s, speakers: { ...s.speakers, [id]: {} } });
  });
}

export function removeSpeaker(draft: SettingsDraft, id: string): EditResult<SettingsDraft> {
  return onDraft(draft, (s) => {
    if (!s.speakers[id]) return refuse(`"${id}" isn't a listed speaker`);
    const { [id]: _gone, ...speakers } = s.speakers;
    return accept({ ...s, speakers });
  });
}

/** A speaker's shown name: a string key (empty: the id as written). */
export function setSpeakerName(draft: SettingsDraft, id: string, key: string): EditResult<SettingsDraft> {
  const k = key.trim();
  return onDraft(draft, (s) => speakerRow(s, id, (sp) => {
    if (k === "") {
      const { name: _n, ...rest } = sp;
      return rest;
    }
    return isStringKey(k) ? { ...sp, name: k } : `"${k}" isn't a string key (letters, digits, _ . -)`;
  }));
}

/** A speaker's colour (`#RRGGBB`; null: the display's speaker colour). */
export function setSpeakerColor(draft: SettingsDraft, id: string, color: string | null): EditResult<SettingsDraft> {
  return onDraft(draft, (s) => speakerRow(s, id, (sp) => {
    if (color === null) {
      const { color: _c, ...rest } = sp;
      return rest;
    }
    return /^#[0-9a-fA-F]{6}$/.test(color) ? { ...sp, color: color.toLowerCase() } : `${color} isn't a colour such as #ffcc00`;
  }));
}

/** Speaker ids the project's line tables (`*.lines.json`, parsed JSON by path) name and the section doesn't list yet. */
export function unlistedSpeakers(draft: SettingsDraft, files: Iterable<readonly [string, unknown]>): string[] {
  const listed = subtitlesSettings.read(draft).speakers;
  const out = new Set<string>();
  for (const [path, json] of files) {
    if (!path.toLowerCase().endsWith(".lines.json") || !isRecord(json) || !Array.isArray(json.lines)) continue;
    for (const l of json.lines) if (isRecord(l) && typeof l.speaker === "string" && l.speaker.trim() && !listed[l.speaker]) out.add(l.speaker);
  }
  return [...out].sort();
}
