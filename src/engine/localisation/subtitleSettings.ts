/**
 * `project.json`'s `subtitles` section (ADR 0357 §3, §5): the player settings' first-run defaults, the reading speed
 * and minimum display time, and speakers (a speaker id's display-name string key and colour). Editor-owned (Project
 * Settings > Subtitles), read by the subtitles plugin, the audio runtime (subtitle-only lines), the Studio and the
 * editor. Parsed leniently (never throws) and written back minimal.
 *
 * Pure; no plugin, no DOM.
 */
import { isRecord, Reader, type JsonRecord } from "./lenient";

/** Limits of the section, declared once (ADR 0306). */
export const SUBTITLE_LIMITS = Object.freeze({
  /** Characters per second. */
  readingSpeed: [1, 60] as readonly [number, number],
  /** Seconds. */
  minDisplay: [0, 10] as readonly [number, number],
  speakers: 256,
});

export const SUBTITLE_SIZES = ["small", "medium", "large", "extraLarge"] as const;
export type SubtitleSize = (typeof SUBTITLE_SIZES)[number];

/** The player's subtitle settings (`Subtitles.settings`, 0357 §5); the section holds their first-run values. */
export interface SubtitleSettings {
  /** Speech subtitles. */
  enabled: boolean;
  size: SubtitleSize;
  /** Box opacity, 0..1. */
  background: number;
  speakerNames: boolean;
  /** Sound captions. */
  captions: boolean;
}

/** How a speaker id (a line table row's `speaker`) shows. */
export interface SubtitleSpeaker {
  /** A string key of the shown name; absent: the id as written. */
  name?: string;
  /** `#RRGGBB`; absent: the display's speaker colour. */
  color?: string;
}

/** The section. */
export interface SubtitleProjectSettings {
  defaults: SubtitleSettings;
  /** Characters per second for languages with no reading speed of their own or built in (0357 §3). */
  readingSpeed: number;
  /** Seconds: the shortest a subtitle or page shows. */
  minDisplay: number;
  speakers: Record<string, SubtitleSpeaker>;
}

export const DEFAULT_READING_SPEED = 15;
export const DEFAULT_MIN_DISPLAY = 1.5;

export const defaultSubtitleSettings = (): SubtitleSettings => ({ enabled: true, size: "medium", background: 0.6, speakerNames: true, captions: false });
export const defaultSubtitleProjectSettings = (): SubtitleProjectSettings => ({
  defaults: defaultSubtitleSettings(), readingSpeed: DEFAULT_READING_SPEED, minDisplay: DEFAULT_MIN_DISPLAY, speakers: {},
});

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Player settings over the defaults (`Subtitles.set` patches and stored values read through it too). */
export function parseSubtitlePlayerSettings(raw: unknown, where: string, problems: string[], base: SubtitleSettings = defaultSubtitleSettings()): SubtitleSettings {
  const r = new Reader(problems);
  const o = r.record(raw, where);
  if (!o) return { ...base };
  return {
    enabled: r.bool(o.enabled, `${where}.enabled`, base.enabled),
    size: r.pick(o.size, `${where}.size`, SUBTITLE_SIZES, base.size),
    background: r.num(o.background, `${where}.background`, base.background, 0, 1),
    speakerNames: r.bool(o.speakerNames, `${where}.speakerNames`, base.speakerNames),
    captions: r.bool(o.captions, `${where}.captions`, base.captions),
  };
}

/** `project.json`'s `subtitles` section, leniently. Absent: the defaults. */
export function parseSubtitleSettings(raw: unknown, where = "subtitles"): { subtitles: SubtitleProjectSettings; problems: string[] } {
  const problems: string[] = [];
  const r = new Reader(problems);
  const out = defaultSubtitleProjectSettings();
  if (raw === undefined || raw === null) return { subtitles: out, problems };
  if (!isRecord(raw)) {
    r.problem(where, "must be an object; using the defaults.");
    return { subtitles: out, problems };
  }
  out.defaults = parseSubtitlePlayerSettings(raw.defaults, `${where}.defaults`, problems);
  out.readingSpeed = r.num(raw.readingSpeed, `${where}.readingSpeed`, DEFAULT_READING_SPEED, ...SUBTITLE_LIMITS.readingSpeed);
  out.minDisplay = r.num(raw.minDisplay, `${where}.minDisplay`, DEFAULT_MIN_DISPLAY, ...SUBTITLE_LIMITS.minDisplay);
  const speakers = r.record(raw.speakers, `${where}.speakers`);
  for (const [id, s] of Object.entries(speakers ?? {})) {
    const w = `${where}.speakers.${id}`;
    if (Object.keys(out.speakers).length >= SUBTITLE_LIMITS.speakers) { r.problem(`${where}.speakers`, `at most ${SUBTITLE_LIMITS.speakers} speakers; the rest are dropped.`); break; }
    if (id.trim() === "" || id === "__proto__") { r.problem(w, "a speaker needs an id; dropped."); continue; }
    if (!isRecord(s)) { r.problem(w, "must be an object with name and colour; dropped."); continue; }
    const speaker: SubtitleSpeaker = {};
    const name = r.optStr(s.name, `${w}.name`);
    if (name) speaker.name = name;
    if (s.color !== undefined) {
      if (typeof s.color === "string" && HEX.test(s.color)) speaker.color = s.color;
      else r.problem(`${w}.color`, "must be a colour such as #ffcc00; dropped.");
    }
    out.speakers[id] = speaker;
  }
  return { subtitles: out, problems };
}

/** The section as JSON: defaults left out (an all-default section is `{}`). */
export function subtitleSettingsToJson(s: SubtitleProjectSettings): JsonRecord {
  const out: JsonRecord = {};
  const d = defaultSubtitleSettings();
  const defaults: JsonRecord = {};
  for (const k of Object.keys(d) as (keyof SubtitleSettings)[]) if (s.defaults[k] !== d[k]) defaults[k] = s.defaults[k];
  if (Object.keys(defaults).length) out.defaults = defaults;
  if (s.readingSpeed !== DEFAULT_READING_SPEED) out.readingSpeed = s.readingSpeed;
  if (s.minDisplay !== DEFAULT_MIN_DISPLAY) out.minDisplay = s.minDisplay;
  if (Object.keys(s.speakers).length) out.speakers = Object.fromEntries(Object.entries(s.speakers).map(([id, sp]) => [id, { ...sp }]));
  return out;
}
